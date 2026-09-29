'use strict';

const crypto = require('node:crypto');
const { addDays, isValidDateString } = require('./booking-window');

function timetableError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { publicCode: code, publicMessage: message, statusCode });
}

function validRevision(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n;
}

function slotBounds(slot) {
  if (typeof slot !== 'string') return null;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(slot);
  if (!match) return null;
  const [startHour, startMinute, endHour, endMinute] = match.slice(1).map(Number);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return start < end ? { start, end } : null;
}

function normalizeSlots(slots) {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 24) {
    throw timetableError('INVALID_SLOTS', '每個時間表須有 1 至 24 個時段。');
  }
  const result = slots.map((slot) => {
    const bounds = slotBounds(slot);
    if (!bounds) throw timetableError('INVALID_SLOTS', '時段格式須為 HH:MM-HH:MM，並且不可跨越午夜。');
    return { slot, ...bounds };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < result.length; index += 1) {
    if (result[index].start < result[index - 1].end) {
      throw timetableError('OVERLAPPING_SLOTS', '時段不可重複或互相重疊。');
    }
  }
  return result.map((item) => item.slot);
}

function normalizeChange(change, timetable) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    throw timetableError('INVALID_TIMETABLE_CHANGE', '請選擇有效的時間表修改。');
  }
  const modeCode = change.modeCode;
  if (typeof modeCode !== 'string' || !Object.hasOwn(timetable.modes, modeCode)) {
    throw timetableError('INVALID_MODE', '所選時間表不存在。');
  }
  if (change.type === 'replace_mode_slots') {
    return { type: change.type, modeCode, slots: normalizeSlots(change.slots) };
  }
  if (change.type === 'set_calendar_range') {
    const { startDate, endDate } = change;
    if (typeof startDate !== 'string' || typeof endDate !== 'string' ||
        !isValidDateString(startDate) || !isValidDateString(endDate) ||
        startDate < '1000-01-01' || endDate > '9999-12-31' || endDate < startDate ||
        (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 >= 366) {
      throw timetableError('INVALID_DATE_RANGE', '請選擇有效日期範圍（最多 366 日）。');
    }
    return { type: change.type, modeCode, startDate, endDate };
  }
  throw timetableError('INVALID_TIMETABLE_CHANGE', '不支援此時間表修改。');
}

function modeOnDate(timetable, date) {
  return timetable.calendar[date] || 'default';
}

function datesInChange(change) {
  const dates = [];
  for (let date = change.startDate; date <= change.endDate; date = addDays(date, 1)) {
    dates.push(date);
    if (date === change.endDate) break;
  }
  return dates;
}

function changesTimetable(change, timetable) {
  if (change.type === 'replace_mode_slots') {
    return JSON.stringify(change.slots) !== JSON.stringify(timetable.modes[change.modeCode].slots);
  }
  return datesInChange(change).some((date) => modeOnDate(timetable, date) !== change.modeCode);
}

function affectedBookings(change, timetable, bookings, now) {
  return bookings.filter((booking) => {
    const bounds = slotBounds(booking.slot);
    if (!bounds || booking.date < now.date || (booking.date === now.date && bounds.start <= now.minutes)) return false;
    let newSlots;
    if (change.type === 'replace_mode_slots') {
      if (modeOnDate(timetable, booking.date) !== change.modeCode) return false;
      newSlots = change.slots;
    } else {
      if (booking.date < change.startDate || booking.date > change.endDate) return false;
      newSlots = timetable.modes[change.modeCode].slots;
    }
    return !newSlots.includes(booking.slot);
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

function impactHash(bookings) {
  return crypto.createHash('sha256').update(JSON.stringify(bookings.map((booking) => [
    booking.id, booking.date, booking.slot, booking.studentEmail, booking.studentName, booking.studentClass
  ]).sort((left, right) => left[0].localeCompare(right[0], 'en')))).digest('hex');
}

module.exports = {
  affectedBookings, changesTimetable, datesInChange, impactHash, modeOnDate,
  normalizeChange, normalizeSlots, slotBounds, timetableError, validRevision
};
