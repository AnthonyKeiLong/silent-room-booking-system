'use strict';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(value) {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(dateString, days) {
  if (!isValidDateString(dateString) || !Number.isInteger(days)) {
    throw new TypeError('A valid ISO date and whole-number day offset are required.');
  }
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function currentBookingWindow(schoolDate) {
  if (!isValidDateString(schoolDate)) {
    throw new TypeError('A valid school date is required.');
  }

  // The parsed Date is used only for Gregorian weekday/date arithmetic. The
  // YYYY-MM-DD value has already been derived in the configured school zone.
  const weekday = new Date(`${schoolDate}T00:00:00Z`).getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const weekStart = addDays(schoolDate, mondayOffset);
  const weekEnd = addDays(weekStart, 5);
  const nextWeekStart = addDays(weekStart, 7);
  const nextWeekEnd = addDays(nextWeekStart, 5);
  const open = weekday >= 1 && weekday <= 6;

  return {
    schoolDate,
    weekday,
    weekStart,
    weekEnd,
    open,
    bookableFrom: open ? schoolDate : null,
    bookableThrough: open ? weekEnd : null,
    nextWeekStart,
    nextWeekEnd
  };
}

function classifyBookingDate(targetDate, schoolDate) {
  const window = currentBookingWindow(schoolDate);
  if (!isValidDateString(targetDate)) {
    return { status: 'invalid', window };
  }
  if (targetDate < schoolDate) {
    return { status: 'past', window };
  }
  if (!window.open) {
    return { status: 'closed', window };
  }
  if (
    targetDate < window.bookableFrom ||
    targetDate > window.bookableThrough
  ) {
    return { status: 'outside', window };
  }
  return { status: 'allowed', window };
}

function createSchoolClock(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  formatter.format(new Date());

  return function schoolNowParts(date = new Date()) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new TypeError('A valid Date is required.');
    }
    const parts = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value])
    );
    const hour = Number(parts.hour) % 24;
    const minute = Number(parts.minute);
    const second = Number(parts.second);
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      minutes: hour * 60 + minute,
      secondsSinceMidnight: hour * 3600 + minute * 60 + second
    };
  };
}

module.exports = {
  addDays,
  classifyBookingDate,
  createSchoolClock,
  currentBookingWindow,
  isValidDateString
};
