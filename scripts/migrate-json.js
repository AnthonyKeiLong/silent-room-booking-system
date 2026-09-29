'use strict';

require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const bcryptRounds = 12;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function toUtcDatabaseDateTime(value, label) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`${label} has an invalid timestamp.`);
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function deterministicUuid(namespace, value) {
  const bytes = crypto
    .createHash('sha256')
    .update(`${namespace}\u0000${value}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeId(value, namespace, fallbackKey) {
  const candidate = String(value || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    return candidate.toLowerCase();
  }
  return deterministicUuid(namespace, candidate || fallbackKey);
}

function assertArray(value, label) {
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value || [];
}

async function main() {
  const inputPath = path.resolve(process.argv[2] || 'data.json');
  const raw = await fs.readFile(inputPath, 'utf8');
  const data = JSON.parse(raw);
  if (!isPlainObject(data)) throw new Error('The JSON root must be an object.');

  const users = assertArray(data.users, 'users');
  const bookings = assertArray(data.bookings, 'bookings');
  const cancellations = assertArray(data.cancellations, 'cancellations');
  if (data.modes !== undefined && !isPlainObject(data.modes)) {
    throw new Error('modes must be an object.');
  }
  if (data.calendar !== undefined && !isPlainObject(data.calendar)) {
    throw new Error('calendar must be an object.');
  }

  const counts = {
    usersProcessed: 0,
    bookingsInserted: 0,
    bookingsSkipped: 0,
    cancellationsInserted: 0,
    cancellationsSkipped: 0
  };
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    for (const [index, user] of users.entries()) {
      if (!isPlainObject(user)) throw new Error(`users[${index}] is invalid.`);
      const email = normalizeEmail(user.email);
      const password = String(user.password || '');
      const displayName = String(user.name || '').trim();
      const className = String(user.class || '').trim();
      if (!email || !password || !displayName || !className) {
        throw new Error(`User ${email || `at index ${index}`} has missing fields.`);
      }
      if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 72) {
        throw new Error(`User ${email} must have a password of 10 characters and at most 72 UTF-8 bytes.`);
      }
      if (email.length > 254 || displayName.length > 100 || className.length > 50) {
        throw new Error(`User ${email} has a field that is too long.`);
      }

      const passwordHash = await bcrypt.hash(password, bcryptRounds);
      await connection.execute(
        `INSERT INTO users
           (email, password_hash, display_name, class_name, role, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE
           password_hash = VALUES(password_hash),
           display_name = VALUES(display_name),
           class_name = VALUES(class_name),
           role = VALUES(role),
           active = 1,
           updated_at = UTC_TIMESTAMP(3)`,
        [
          email,
          passwordHash,
          displayName,
          className,
          user.role === 'teacher' ? 'teacher' : 'student'
        ]
      );
      await connection.execute('DELETE FROM sessions WHERE user_email = ?', [email]);
      counts.usersProcessed += 1;
    }

    for (const [modeCode, mode] of Object.entries(data.modes || {})) {
      if (!isPlainObject(mode) || !Array.isArray(mode.slots)) {
        throw new Error(`Mode ${modeCode} is invalid.`);
      }
      if (!modeCode || modeCode.length > 40) throw new Error(`Mode code ${modeCode} is invalid.`);
      const modeName = String(mode.name || modeCode).trim();
      if (!modeName || modeName.length > 100) throw new Error(`Mode ${modeCode} has an invalid name.`);
      await connection.execute(
        `INSERT INTO modes (mode_code, mode_name)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE mode_name = VALUES(mode_name)`,
        [modeCode, modeName]
      );
      await connection.execute('DELETE FROM mode_slots WHERE mode_code = ?', [modeCode]);
      for (const [index, rawSlot] of mode.slots.entries()) {
        const slot = String(rawSlot || '').trim();
        if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(slot) || slot.length > 32) {
          throw new Error(`Mode ${modeCode} contains an invalid slot.`);
        }
        await connection.execute(
          'INSERT INTO mode_slots (mode_code, slot, slot_order) VALUES (?, ?, ?)',
          [modeCode, slot, index + 1]
        );
      }
    }

    for (const [date, modeCode] of Object.entries(data.calendar || {})) {
      if (!isValidDateString(date)) throw new Error(`Calendar date ${date} is invalid.`);
      await connection.execute(
        `INSERT INTO calendar (booking_date, mode_code)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE mode_code = VALUES(mode_code)`,
        [date, String(modeCode)]
      );
    }

    for (const [index, booking] of bookings.entries()) {
      if (!isPlainObject(booking)) throw new Error(`bookings[${index}] is invalid.`);
      if (!isValidDateString(String(booking.date || ''))) {
        throw new Error(`bookings[${index}] has an invalid date.`);
      }
      const fallbackKey = JSON.stringify([
        booking.date,
        booking.slot,
        normalizeEmail(booking.studentEmail),
        booking.createdAt || ''
      ]);
      const id = normalizeId(booking.id, 'legacy-booking', fallbackKey);
      const [existing] = await connection.execute(
        'SELECT id FROM bookings WHERE id = ? LIMIT 1',
        [id]
      );
      if (existing.length > 0) {
        counts.bookingsSkipped += 1;
        continue;
      }

      await connection.execute(
        `INSERT INTO bookings
           (id, booking_date, slot, student_email, student_name, student_class, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          booking.date,
          String(booking.slot || ''),
          normalizeEmail(booking.studentEmail),
          String(booking.studentName || ''),
          String(booking.studentClass || ''),
          toUtcDatabaseDateTime(booking.createdAt, `bookings[${index}]`)
        ]
      );
      counts.bookingsInserted += 1;
    }

    for (const [index, cancellation] of cancellations.entries()) {
      if (!isPlainObject(cancellation)) {
        throw new Error(`cancellations[${index}] is invalid.`);
      }
      if (!isValidDateString(String(cancellation.date || ''))) {
        throw new Error(`cancellations[${index}] has an invalid date.`);
      }
      const fallbackKey = JSON.stringify([
        cancellation.bookingId || '',
        cancellation.date,
        cancellation.slot,
        normalizeEmail(cancellation.studentEmail),
        cancellation.timestamp || ''
      ]);
      const id = normalizeId(cancellation.id, 'legacy-cancellation', fallbackKey);
      const bookingId = normalizeId(
        cancellation.bookingId,
        'legacy-booking',
        fallbackKey
      );
      const [existing] = await connection.execute(
        'SELECT id FROM cancellations WHERE id = ? LIMIT 1',
        [id]
      );
      if (existing.length > 0) {
        counts.cancellationsSkipped += 1;
        continue;
      }

      const reason = String(cancellation.reason || '沒有提供原因').trim();
      if (reason.length > 500) throw new Error(`cancellations[${index}] reason is too long.`);
      await connection.execute(
        `INSERT INTO cancellations
           (id, booking_id, booking_date, slot, student_email, student_name, reason, cancelled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          bookingId,
          cancellation.date,
          String(cancellation.slot || ''),
          normalizeEmail(cancellation.studentEmail),
          String(cancellation.studentName || ''),
          reason,
          toUtcDatabaseDateTime(cancellation.timestamp, `cancellations[${index}]`)
        ]
      );
      counts.cancellationsInserted += 1;
    }

    const [teacherRows] = await connection.query(
      "SELECT COUNT(*) AS teacher_count FROM users WHERE role = 'teacher' AND active = 1"
    );
    if (Number(teacherRows[0].teacher_count) < 1) {
      throw new Error(
        'No active teacher account was imported. Use scripts/create-admin.js instead.'
      );
    }

    await connection.commit();
    console.log(
      `Migration complete: ${counts.usersProcessed} users processed; ` +
      `${counts.bookingsInserted} bookings inserted, ${counts.bookingsSkipped} already present; ` +
      `${counts.cancellationsInserted} cancellations inserted, ` +
      `${counts.cancellationsSkipped} already present.`
    );
    console.log('Passwords were stored only as bcrypt hashes in MariaDB.');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
