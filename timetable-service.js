'use strict';

const crypto = require('node:crypto');
const {
  affectedBookings, changesTimetable, datesInChange, impactHash, modeOnDate,
  normalizeChange, timetableError, validRevision
} = require('./timetable');

async function lockTimetable(connection, exclusive = false) {
  // Every timetable/booking mutation acquires this row BEFORE other row locks.
  // Readers share it; timetable apply owns it exclusively until commit.
  const [rows] = await connection.query(
    `SELECT CAST(revision AS CHAR) AS revision FROM timetable_state WHERE id = 1
     ${exclusive ? 'FOR UPDATE' : 'LOCK IN SHARE MODE'}`
  );
  if (!rows[0] || !validRevision(rows[0].revision)) {
    throw new Error('Timetable schema is not initialized. Run the 2.4.0 migration.');
  }
  return rows[0].revision;
}

function staleTimetable(revision) {
  return Object.assign(timetableError(
    'TIMETABLE_STALE', '時間表或相關預約已更新，請重新載入及預覽後再確認。', 409
  ), { details: { timetableRevision: revision } });
}

async function readTimetable(connection, revision) {
  const [modeRows] = await connection.query(
    `SELECT m.mode_code, m.mode_name, ms.slot FROM modes m
       LEFT JOIN mode_slots ms ON ms.mode_code = m.mode_code
      ORDER BY m.mode_code, ms.slot_order`
  );
  const [calendarRows] = await connection.query(
    `SELECT DATE_FORMAT(booking_date, '%Y-%m-%d') AS date, mode_code FROM calendar ORDER BY booking_date`
  );
  const modes = Object.create(null);
  for (const row of modeRows) {
    if (!modes[row.mode_code]) modes[row.mode_code] = { name: row.mode_name, slots: [] };
    if (row.slot) modes[row.mode_code].slots.push(row.slot);
  }
  return { revision, modes, calendar: Object.fromEntries(calendarRows.map((row) => [row.date, row.mode_code])) };
}

async function upcomingBookings(connection, now) {
  const [rows] = await connection.execute(
    `SELECT id, booking_date AS date, slot, student_email AS studentEmail,
            student_name AS studentName, student_class AS studentClass
       FROM bookings WHERE booking_date >= ? ORDER BY id`, [now.date]
  );
  return rows;
}

function publicBookings(rows, user) {
  return user.isTeacher ? rows.map((booking) => ({
    ...booking,
    createdAt: booking.createdAt ? `${String(booking.createdAt).replace(' ', 'T')}Z` : undefined
  })) : rows.map((booking) => ({
    date: booking.date, slot: booking.slot, studentName: booking.studentName, studentClass: booking.studentClass
  }));
}

function createTimetableService({ pool, schoolNowParts, publicBookingWindow }) {
  async function transaction(handler, exclusive = false) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const revision = await lockTimetable(connection, exclusive);
      const result = await handler(connection, revision);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function getConfig() {
    return transaction(async (connection, revision) => ({
      ...await readTimetable(connection, revision),
      timetableRevision: revision,
      bookingWindow: publicBookingWindow()
    }));
  }

  async function getSchedule(date, user) {
    return transaction(async (connection, revision) => {
      const timetable = await readTimetable(connection, revision);
      const [rows] = await connection.execute(
        `SELECT id, booking_date AS date, slot, student_email AS studentEmail,
                student_name AS studentName, student_class AS studentClass, created_at AS createdAt
           FROM bookings WHERE booking_date = ? ORDER BY slot`, [date]
      );
      const modeCode = modeOnDate(timetable, date);
      return {
        date, modeCode, mode: timetable.modes[modeCode], bookings: publicBookings(rows, user),
        timetableRevision: revision, bookingWindow: publicBookingWindow()
      };
    });
  }

  async function preview({ revision: requestedRevision, change, actorEmail, sessionTokenHash }) {
    return transaction(async (connection, revision) => {
      if (!validRevision(requestedRevision) || requestedRevision !== revision) throw staleTimetable(revision);
      const timetable = await readTimetable(connection, revision);
      const normalized = normalizeChange(change, timetable);
      if (!changesTimetable(normalized, timetable)) {
        throw timetableError('NO_TIMETABLE_CHANGE', '設定與目前時間表相同，沒有需要儲存的修改。');
      }
      const now = schoolNowParts();
      const affected = affectedBookings(normalized, timetable, await upcomingBookings(connection, now), now);
      const previewId = crypto.randomUUID();
      await connection.execute(
        `INSERT INTO timetable_change_previews
          (id, actor_email, session_token_hash, base_revision, proposal_json, impact_hash, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE))`,
        [previewId, actorEmail, sessionTokenHash, revision, JSON.stringify(normalized), impactHash(affected)]
      );
      const [[expiry]] = await connection.execute(
        `SELECT DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expiresAt
           FROM timetable_change_previews WHERE id = ?`, [previewId]
      );
      return {
        previewId, revision, expiresAt: new Date(expiry.expiresAt).toISOString(),
        affectedCount: affected.length,
        affectedStudentCount: new Set(affected.map((booking) => booking.studentEmail)).size,
        affectedBookings: affected.map(({ id, date, slot, studentEmail, studentName }) => ({
          id, date, slot, studentEmail, studentName
        })),
        notificationConfigured: false
      };
    });
  }

  async function apply({ previewId, confirmAffectedBookings, actorEmail, sessionTokenHash }) {
    if (typeof previewId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(previewId)) {
      throw timetableError('INVALID_PREVIEW', '請先預覽時間表修改。');
    }
    return transaction(async (connection, revision) => {
      // Recheck permissions while holding the same user lock as account editing.
      const [[actor]] = await connection.execute(
        'SELECT role, active FROM users WHERE email = ? FOR UPDATE', [actorEmail]
      );
      const [[session]] = await connection.execute(
        `SELECT token_hash FROM sessions WHERE token_hash = ? AND user_email = ?
           AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE`, [sessionTokenHash, actorEmail]
      );
      if (!actor || actor.role !== 'teacher' || Number(actor.active) !== 1 || !session) {
        throw timetableError('AUTHENTICATION_REQUIRED', '管理員登入已失效，請重新登入。', 401);
      }
      const [[proposal]] = await connection.execute(
        `SELECT actor_email, session_token_hash, CAST(base_revision AS CHAR) AS base_revision,
                proposal_json, impact_hash, consumed_at, result_json,
                (expires_at <= UTC_TIMESTAMP(3)) AS expired
           FROM timetable_change_previews WHERE id = ? FOR UPDATE`, [previewId]
      );
      if (!proposal || proposal.actor_email !== actorEmail || proposal.session_token_hash !== sessionTokenHash) {
        throw timetableError('PREVIEW_NOT_FOUND', '找不到此登入階段的預覽，請重新預覽。', 404);
      }
      // A retried request returns the original result, without a second cancellation.
      if (proposal.consumed_at && proposal.result_json) return JSON.parse(proposal.result_json);
      if (proposal.expired) throw timetableError('PREVIEW_EXPIRED', '預覽已超過 10 分鐘，請重新預覽。', 409);
      if (proposal.base_revision !== revision) throw staleTimetable(revision);
      const timetable = await readTimetable(connection, revision);
      const change = normalizeChange(JSON.parse(proposal.proposal_json), timetable);
      const now = schoolNowParts();
      const originalBookings = await upcomingBookings(connection, now);
      const affected = affectedBookings(change, timetable, originalBookings, now);
      if (impactHash(affected) !== proposal.impact_hash) throw staleTimetable(revision);
      if (affected.length > 0 && confirmAffectedBookings !== true) {
        throw timetableError('CONFIRMATION_REQUIRED', '請確認取消受影響預約；此操作不會發送電郵，亦不會扣罰學生。', 409);
      }
      const nextRevision = (BigInt(revision) + 1n).toString();
      if (!validRevision(nextRevision)) throw new Error('Timetable revision limit reached.');
      const changeId = crypto.randomUUID();
      await connection.execute(
        `INSERT INTO timetable_changes (id, actor_email, revision_before, revision_after, change_json, affected_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [changeId, actorEmail, revision, nextRevision, JSON.stringify(change), affected.length]
      );
      for (const booking of affected) {
        await connection.execute(
          `INSERT INTO administrative_cancellations
            (id, change_id, booking_id, booking_date, slot, student_email, student_name, student_class, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), changeId, booking.id, booking.date, booking.slot,
            booking.studentEmail, booking.studentName, booking.studentClass,
            '學校已調整時間表，此預約時段不再提供；不計入取消次數，亦不會暫停預約權限。']
        );
        await connection.execute('DELETE FROM bookings WHERE id = ?', [booking.id]);
      }
      if (change.type === 'replace_mode_slots') {
        await connection.execute('DELETE FROM mode_slots WHERE mode_code = ?', [change.modeCode]);
        for (const [index, slot] of change.slots.entries()) {
          await connection.execute('INSERT INTO mode_slots (mode_code, slot, slot_order) VALUES (?, ?, ?)',
            [change.modeCode, slot, index + 1]);
        }
      } else {
        for (const date of datesInChange(change)) {
          if (change.modeCode === 'default') {
            await connection.execute('DELETE FROM calendar WHERE booking_date = ?', [date]);
          } else {
            await connection.execute(
              `INSERT INTO calendar (booking_date, mode_code) VALUES (?, ?)
               ON DUPLICATE KEY UPDATE mode_code = VALUES(mode_code)`, [date, change.modeCode]
            );
          }
        }
      }
      await connection.execute('UPDATE timetable_state SET revision = ? WHERE id = 1', [nextRevision]);
      const result = {
        success: true, changeId, revision: nextRevision, timetableRevision: nextRevision,
        affectedCount: affected.length,
        cancelledCount: affected.length,
        affectedStudentCount: new Set(affected.map((booking) => booking.studentEmail)).size,
        emailsQueued: 0
      };
      await connection.execute(
        `UPDATE timetable_change_previews SET consumed_at = UTC_TIMESTAMP(3), result_json = ? WHERE id = ?`,
        [JSON.stringify(result), previewId]
      );
      // Large calendar ranges can take long enough to cross a slot's start.
      // Recheck immediately before commit; rolling back also restores every
      // booking and leaves this preview unconsumed if its impact changed.
      const finalImpact = affectedBookings(change, timetable, originalBookings, schoolNowParts());
      if (impactHash(finalImpact) !== proposal.impact_hash) throw staleTimetable(revision);
      return result;
    }, true);
  }

  return { getConfig, getSchedule, preview, apply };
}

module.exports = { createTimetableService, lockTimetable, staleTimetable };
