'use strict';

const assert = require('node:assert/strict');
const {
  addDays,
  classifyBookingDate,
  createSchoolClock,
  currentBookingWindow,
  isValidDateString
} = require('../booking-window');

assert.equal(isValidDateString('2026-08-26'), true);
assert.equal(isValidDateString('2026-02-29'), false);
assert.equal(isValidDateString('26/08/2026'), false);
assert.equal(addDays('2026-12-31', 1), '2027-01-01');
assert.equal(addDays('2028-02-28', 1), '2028-02-29');

assert.deepEqual(currentBookingWindow('2026-08-26'), {
  schoolDate: '2026-08-26',
  weekday: 3,
  weekStart: '2026-08-24',
  weekEnd: '2026-08-29',
  open: true,
  bookableFrom: '2026-08-26',
  bookableThrough: '2026-08-29',
  nextWeekStart: '2026-08-31',
  nextWeekEnd: '2026-09-05'
});

const monday = currentBookingWindow('2026-08-31');
assert.equal(monday.bookableFrom, '2026-08-31');
assert.equal(monday.bookableThrough, '2026-09-05');

const saturday = currentBookingWindow('2026-09-05');
assert.equal(saturday.bookableFrom, '2026-09-05');
assert.equal(saturday.bookableThrough, '2026-09-05');

const sunday = currentBookingWindow('2026-08-30');
assert.equal(sunday.open, false);
assert.equal(sunday.bookableFrom, null);
assert.equal(sunday.bookableThrough, null);
assert.equal(sunday.nextWeekStart, '2026-08-31');
assert.equal(sunday.nextWeekEnd, '2026-09-05');

assert.equal(classifyBookingDate('2026-08-26', '2026-08-26').status, 'allowed');
assert.equal(classifyBookingDate('2026-08-29', '2026-08-26').status, 'allowed');
assert.equal(classifyBookingDate('2026-08-25', '2026-08-26').status, 'past');
assert.equal(classifyBookingDate('2026-08-30', '2026-08-26').status, 'outside');
assert.equal(classifyBookingDate('2026-08-31', '2026-08-26').status, 'outside');
assert.equal(classifyBookingDate('2026-08-30', '2026-08-30').status, 'closed');
assert.equal(classifyBookingDate('2026-08-31', '2026-08-30').status, 'closed');
assert.equal(classifyBookingDate('not-a-date', '2026-08-26').status, 'invalid');

const yearBoundary = currentBookingWindow('2026-12-31');
assert.equal(yearBoundary.weekStart, '2026-12-28');
assert.equal(yearBoundary.weekEnd, '2027-01-02');

const hongKongClock = createSchoolClock('Asia/Hong_Kong');
const beforeMonday = hongKongClock(new Date('2026-08-30T15:59:59Z'));
assert.deepEqual(beforeMonday, {
  date: '2026-08-30',
  minutes: 23 * 60 + 59,
  secondsSinceMidnight: 86399
});
assert.equal(currentBookingWindow(beforeMonday.date).open, false);

const atMonday = hongKongClock(new Date('2026-08-30T16:00:00Z'));
assert.deepEqual(atMonday, {
  date: '2026-08-31',
  minutes: 0,
  secondsSinceMidnight: 0
});
assert.equal(currentBookingWindow(atMonday.date).open, true);
assert.equal(currentBookingWindow(atMonday.date).bookableThrough, '2026-09-05');

assert.throws(() => currentBookingWindow('2026-02-29'), TypeError);
assert.throws(() => createSchoolClock('Not/A_Time_Zone'), RangeError);

console.log('Current-school-week booking window checks passed.');
