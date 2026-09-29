'use strict';

const assert = require('node:assert/strict');
const {
  affectedBookings, changesTimetable, datesInChange, impactHash, modeOnDate,
  normalizeChange, normalizeSlots, slotBounds, validRevision
} = require('../timetable');
const { createTimetableService, lockTimetable } = require('../timetable-service');

const initialTimetable = {
  revision: '1',
  modes: {
    default: { name: 'Normal', slots: ['09:00-10:00', '10:00-11:00'] },
    exam: { name: 'Exam', slots: ['09:00-10:00', '11:00-12:00'] },
    f6_study: { name: 'Study', slots: ['08:00-09:00'] }
  },
  calendar: { '2026-09-05': 'exam' }
};
const now = { date: '2026-09-03', minutes: 9 * 60, secondsSinceMidnight: 9 * 3600 };
function booking(id, date, slot, email = 'student@example.test') {
  return { id, date, slot, studentEmail: email, studentName: 'Student', studentClass: '1A' };
}
const bookings = [
  booking('past', '2026-09-02', '10:00-11:00'),
  booking('started', '2026-09-03', '09:00-10:00'),
  booking('today', '2026-09-03', '10:00-11:00'),
  booking('future', '2026-09-04', '10:00-11:00'),
  booking('retained', '2026-09-04', '09:00-10:00'),
  booking('exam', '2026-09-05', '11:00-12:00'),
  booking('legacy_future', '2026-09-14', '10:00-11:00')
];

assert.deepEqual(slotBounds('00:00-00:01'), { start: 0, end: 1 });
for (const value of ['24:00-25:00', '09:60-10:00', '10:00-10:00', '22:00-01:00', '9:00-10:00', ' 09:00-10:00 ', null]) {
  assert.equal(slotBounds(value), null);
}
assert.deepEqual(normalizeSlots(['10:00-11:00', '09:00-10:00']), ['09:00-10:00', '10:00-11:00']);
for (const slots of [[], null, ['09:00-10:00', '09:00-10:00'], ['09:00-10:01', '10:00-11:00'], Array(25).fill('09:00-10:00')]) {
  assert.throws(() => normalizeSlots(slots), { statusCode: 400 });
}
for (const revision of ['1', '9007199254740993', '18446744073709551615']) assert.equal(validRevision(revision), true);
for (const revision of [1, '0', '-1', '01', '1.0', null, '18446744073709551616']) assert.equal(validRevision(revision), false);

const slotChange = normalizeChange({ type: 'replace_mode_slots', modeCode: 'default', slots: ['09:00-10:00'] }, initialTimetable);
assert.equal(changesTimetable(slotChange, initialTimetable), true);
assert.equal(changesTimetable({ ...slotChange, slots: initialTimetable.modes.default.slots }, initialTimetable), false);
assert.deepEqual(affectedBookings(slotChange, initialTimetable, bookings, now).map((row) => row.id), ['future', 'legacy_future', 'today']);
assert.equal(modeOnDate(initialTimetable, '2026-09-05'), 'exam');
assert.equal(modeOnDate(initialTimetable, '2026-09-04'), 'default');
const calendarChange = normalizeChange({ type: 'set_calendar_range', modeCode: 'exam', startDate: '2026-09-03', endDate: '2026-09-05' }, initialTimetable);
assert.deepEqual(affectedBookings(calendarChange, initialTimetable, bookings, now).map((row) => row.id), ['future', 'today']);
assert.deepEqual(datesInChange({ startDate: '2028-02-28', endDate: '2028-03-01' }), ['2028-02-28', '2028-02-29', '2028-03-01']);
assert.deepEqual(datesInChange({ startDate: '9999-12-31', endDate: '9999-12-31' }), ['9999-12-31']);
assert.equal(changesTimetable({ ...calendarChange, startDate: '2026-09-05', endDate: '2026-09-05' }, initialTimetable), false);
assert.throws(() => normalizeChange({ ...calendarChange, modeCode: '__proto__' }, initialTimetable));
assert.throws(() => normalizeChange({ ...calendarChange, startDate: '2026-02-29' }, initialTimetable));
assert.throws(() => normalizeChange({ ...calendarChange, startDate: ['2026-09-03'] }, initialTimetable));
assert.throws(() => normalizeChange({ ...calendarChange, startDate: '0999-01-01' }, initialTimetable));
assert.throws(() => normalizeChange({ ...calendarChange, startDate: '2026-01-01', endDate: '2027-01-02' }, initialTimetable));
assert.doesNotThrow(() => normalizeChange({ ...calendarChange, startDate: '2026-01-01', endDate: '2027-01-01' }, initialTimetable));
assert.equal(impactHash(bookings), impactHash([...bookings].reverse()));
assert.notEqual(impactHash(bookings), impactHash(bookings.slice(1)));
assert.notEqual(impactHash(bookings), impactHash(bookings.map((row) => ({ ...row, studentEmail: 'other@example.test' }))));

// A transactional database double exercises preview/apply authorization,
// rollback, idempotency and zero-penalty semantics without accessing real data.
function createFixture(options = {}) {
  const clock = { ...now };
  let state = {
    timetable: structuredClone(initialTimetable), bookings: structuredClone(bookings),
    previews: {}, changes: [], administrative: [], actorActive: 1
  };
  let backup;
  const queries = [];
  const connection = {
    async beginTransaction() { queries.push('BEGIN'); backup = structuredClone(state); },
    async commit() { queries.push('COMMIT'); backup = null; },
    async rollback() { queries.push('ROLLBACK'); state = backup; backup = null; },
    release() {},
    async query(sql, params = []) { return this.execute(sql, params); },
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queries.push(normalized);
      if (options.failOnSql && normalized.startsWith(options.failOnSql)) throw new Error('Simulated database failure');
      if (options.advanceOnSql && normalized.startsWith(options.advanceOnSql)) {
        clock.minutes = 10 * 60;
        clock.secondsSinceMidnight = 10 * 3600;
      }
      if (normalized.includes('FROM timetable_state')) return [[{ revision: state.timetable.revision }]];
      if (normalized.includes('FROM modes m')) {
        return [Object.entries(state.timetable.modes).flatMap(([mode_code, mode]) => mode.slots.map((slot) => ({ mode_code, mode_name: mode.name, slot })))];
      }
      if (normalized.includes('FROM calendar ORDER')) return [Object.entries(state.timetable.calendar).map(([date, mode_code]) => ({ date, mode_code }))];
      if (normalized.includes('FROM bookings WHERE booking_date >= ?')) return [structuredClone(state.bookings.filter((row) => row.date >= params[0]))];
      if (normalized.includes('FROM bookings WHERE booking_date = ?')) return [structuredClone(state.bookings.filter((row) => row.date === params[0]))];
      if (normalized.startsWith('INSERT INTO timetable_change_previews')) {
        const [id, actor_email, session_token_hash, base_revision, proposal_json, impact_hash] = params;
        state.previews[id] = { actor_email, session_token_hash, base_revision, proposal_json, impact_hash, expired: 0, consumed_at: null, result_json: null };
        return [{}];
      }
      if (normalized.startsWith('SELECT DATE_FORMAT(expires_at')) return [[{ expiresAt: '2026-09-03T01:10:00.000000Z' }]];
      if (normalized.startsWith('SELECT role, active')) return [[{ role: 'teacher', active: state.actorActive }]];
      if (normalized.startsWith('SELECT token_hash')) return [[{ token_hash: params[0] }]];
      if (normalized.includes('FROM timetable_change_previews WHERE')) return [[state.previews[params[0]]].filter(Boolean)];
      if (normalized.startsWith('INSERT INTO timetable_changes')) { state.changes.push(params); return [{}]; }
      if (normalized.startsWith('INSERT INTO administrative_cancellations')) { state.administrative.push(params); return [{}]; }
      if (normalized.startsWith('DELETE FROM bookings')) { state.bookings = state.bookings.filter((row) => row.id !== params[0]); return [{}]; }
      if (normalized.startsWith('DELETE FROM mode_slots')) { state.timetable.modes[params[0]].slots = []; return [{}]; }
      if (normalized.startsWith('INSERT INTO mode_slots')) { state.timetable.modes[params[0]].slots.push(params[1]); return [{}]; }
      if (normalized.startsWith('DELETE FROM calendar')) { delete state.timetable.calendar[params[0]]; return [{}]; }
      if (normalized.startsWith('INSERT INTO calendar')) { state.timetable.calendar[params[0]] = params[1]; return [{}]; }
      if (normalized.startsWith('UPDATE timetable_state')) { state.timetable.revision = params[0]; return [{}]; }
      if (normalized.startsWith('UPDATE timetable_change_previews')) {
        Object.assign(state.previews[params[1]], { result_json: params[0], consumed_at: '2026-09-03 01:01:00.000' });
        return [{}];
      }
      throw new Error(`Unexpected SQL in test: ${normalized}`);
    }
  };
  const service = createTimetableService({
    pool: { async getConnection() { return connection; } }, schoolNowParts: () => ({ ...clock }),
    publicBookingWindow: () => ({ schoolDate: now.date, open: true })
  });
  return { service, queries, connection, get state() { return state; } };
}

async function main() {
  const actor = { actorEmail: 'teacher@example.test', sessionTokenHash: 'a'.repeat(64) };
  const fixture = createFixture();
  const config = await fixture.service.getConfig();
  assert.equal(config.timetableRevision, '1');
  assert.ok(fixture.queries[1].endsWith('LOCK IN SHARE MODE'));
  const schedule = await fixture.service.getSchedule('2026-09-04', { isTeacher: false });
  assert.equal(schedule.modeCode, 'default');
  assert.equal(schedule.timetableRevision, '1');
  assert.equal(Object.hasOwn(schedule.bookings[0], 'studentEmail'), false);
  assert.equal(Object.hasOwn(schedule.bookings[0], 'id'), false);
  await assert.rejects(() => fixture.service.preview({ ...actor, revision: '0', change: slotChange }), { publicCode: 'TIMETABLE_STALE' });
  const preview = await fixture.service.preview({ ...actor, revision: '1', change: slotChange });
  assert.equal(preview.affectedCount, 3);
  assert.equal(preview.affectedStudentCount, 1);
  assert.equal(preview.notificationConfigured, false);
  await assert.rejects(() => fixture.service.apply({ ...actor, previewId: preview.previewId }), { publicCode: 'CONFIRMATION_REQUIRED' });
  assert.equal(fixture.state.changes.length, 0);
  await assert.rejects(() => fixture.service.apply({ ...actor, actorEmail: 'other@example.test', previewId: preview.previewId, confirmAffectedBookings: true }), { publicCode: 'PREVIEW_NOT_FOUND' });
  await assert.rejects(() => fixture.service.apply({ ...actor, sessionTokenHash: 'b'.repeat(64), previewId: preview.previewId, confirmAffectedBookings: true }), { publicCode: 'PREVIEW_NOT_FOUND' });
  const beforeApply = fixture.queries.length;
  const result = await fixture.service.apply({ ...actor, previewId: preview.previewId, confirmAffectedBookings: true });
  assert.ok(fixture.queries[beforeApply + 1].endsWith('FOR UPDATE'), 'exclusive timetable lock must precede actor and booking locks');
  assert.equal(result.revision, '2');
  assert.equal(result.cancelledCount, 3);
  assert.equal(result.emailsQueued, 0);
  assert.equal(fixture.state.administrative.length, 3);
  assert.equal(fixture.state.changes.length, 1);
  assert.ok(fixture.state.bookings.some((row) => row.id === 'started'));
  assert.ok(fixture.state.bookings.some((row) => row.id === 'past'));
  assert.ok(fixture.state.bookings.some((row) => row.id === 'retained'));
  fixture.state.previews[preview.previewId].expired = 1;
  fixture.state.timetable.revision = '99';
  const repeated = await fixture.service.apply({ ...actor, previewId: preview.previewId, confirmAffectedBookings: true });
  assert.deepEqual(repeated, result);
  assert.equal(fixture.state.administrative.length, 3);
  assert.equal(fixture.state.changes.length, 1);
  assert.equal(fixture.queries.some((sql) => /INSERT INTO cancellations\b/.test(sql)), false);

  for (const invalidation of ['booking', 'cancelled', 'revision', 'expiry', 'permission']) {
    const test = createFixture();
    const proposal = await test.service.preview({ ...actor, revision: '1', change: slotChange });
    if (invalidation === 'booking') test.state.bookings.push(booking('new', '2026-09-04', '10:00-11:00', 'new@example.test'));
    if (invalidation === 'cancelled') test.state.bookings = test.state.bookings.filter((row) => row.id !== 'today');
    if (invalidation === 'revision') test.state.timetable.revision = '2';
    if (invalidation === 'expiry') test.state.previews[proposal.previewId].expired = 1;
    if (invalidation === 'permission') test.state.actorActive = 0;
    await assert.rejects(() => test.service.apply({ ...actor, previewId: proposal.previewId, confirmAffectedBookings: true }), {
      publicCode: invalidation === 'expiry' ? 'PREVIEW_EXPIRED' : invalidation === 'permission' ? 'AUTHENTICATION_REQUIRED' : 'TIMETABLE_STALE'
    });
    assert.equal(test.state.changes.length, 0);
    assert.equal(test.state.administrative.length, 0);
  }
  const clear = createFixture();
  const clearPreview = await clear.service.preview({ ...actor, revision: '1', change: {
    type: 'set_calendar_range', startDate: '2026-09-05', endDate: '2026-09-05', modeCode: 'default'
  } });
  assert.equal(clearPreview.affectedCount, 1);
  await clear.service.apply({ ...actor, previewId: clearPreview.previewId, confirmAffectedBookings: true });
  assert.equal(Object.hasOwn(clear.state.timetable.calendar, '2026-09-05'), false);
  const harmless = createFixture();
  const harmlessPreview = await harmless.service.preview({ ...actor, revision: '1', change: {
    type: 'replace_mode_slots', modeCode: 'f6_study', slots: ['08:30-09:00']
  } });
  assert.equal(harmlessPreview.affectedCount, 0);
  const harmlessResult = await harmless.service.apply({ ...actor, previewId: harmlessPreview.previewId });
  assert.equal(harmlessResult.cancelledCount, 0);
  assert.equal(harmless.state.timetable.revision, '2');
  assert.equal(harmless.state.administrative.length, 0);
  for (const options of [
    { failOnSql: 'INSERT INTO mode_slots' },
    { advanceOnSql: 'INSERT INTO timetable_changes' }
  ]) {
    const test = createFixture(options);
    const proposal = await test.service.preview({ ...actor, revision: '1', change: slotChange });
    const stateBefore = structuredClone(test.state);
    await assert.rejects(() => test.service.apply({ ...actor, previewId: proposal.previewId, confirmAffectedBookings: true }),
      options.failOnSql ? /Simulated database failure/ : { publicCode: 'TIMETABLE_STALE' });
    assert.deepEqual(test.state, stateBefore, 'failure/slot-start rollover must roll back every table and preview consumption');
  }
  await assert.rejects(() => lockTimetable({ query: async () => [[]] }), /not initialized/);
  console.log('Timetable validation, snapshots, preview binding, stale-impact rejection, idempotency and zero-penalty checks passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
