import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCountdown, formatDateTime, formatSpan, monthGrid, startOfMonth, toInputValue, fromInputValue, urgency, HOUR, DAY, MINUTE,
  formatTime, setClockFormat, setWeekStart, weekdayLabels,
} from '../renderer/core/dates.js';

test('formatSpan', () => {
  assert.equal(formatSpan(20 * 1000), '<1m');
  assert.equal(formatSpan(42 * MINUTE), '42m');
  assert.equal(formatSpan(4 * HOUR + 12 * MINUTE), '4h 12m');
  assert.equal(formatSpan(5 * HOUR), '5h');
  assert.equal(formatSpan(3 * DAY + 5 * HOUR), '3d 5h');
  assert.equal(formatSpan(12 * DAY + 3 * HOUR), '12d');
});

test('formatCountdown: left and overdue', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatCountdown(now + 4 * HOUR, now), '4h left');
  assert.equal(formatCountdown(now - 2 * HOUR, now), 'overdue 2h');
});

test('urgency bands', () => {
  const now = 1_000_000_000_000;
  assert.equal(urgency(now - 1, now), 'overdue');
  assert.equal(urgency(now + HOUR, now), 'soon');
  assert.equal(urgency(now + 3 * DAY, now), 'week');
  assert.equal(urgency(now + 30 * DAY, now), 'later');
});

test('formatDateTime matches the top-bar style', () => {
  assert.equal(formatDateTime(new Date(2026, 9, 6, 23, 59)), 'Oct 6, 23:59');
});

test('monthGrid: 42 days, starts Monday, contains the whole month', () => {
  const grid = monthGrid(startOfMonth(new Date(2026, 9, 15))); // October 2026
  assert.equal(grid.length, 42);
  assert.equal(grid[0].getDay(), 1);
  assert.ok(grid.some((d) => d.getMonth() === 9 && d.getDate() === 1));
  assert.ok(grid.some((d) => d.getMonth() === 9 && d.getDate() === 31));
});

test('12-hour clock and Sunday week start (then back to the defaults)', () => {
  try {
    setClockFormat('12h');
    assert.equal(formatTime(new Date(2026, 9, 6, 23, 59)), '11:59 pm');
    assert.equal(formatTime(new Date(2026, 9, 6, 0, 5)), '12:05 am');
    setWeekStart('sun');
    assert.equal(monthGrid(startOfMonth(new Date(2026, 9, 15)))[0].getDay(), 0);
    assert.equal(weekdayLabels()[0], 'Sun');
  } finally {
    setClockFormat('24h');
    setWeekStart('mon');
  }
  assert.equal(formatTime(new Date(2026, 9, 6, 23, 59)), '23:59');
  assert.equal(weekdayLabels()[0], 'Mon');
});

test('input value round trip', () => {
  const d = new Date(2026, 9, 6, 23, 59);
  assert.equal(toInputValue(d), '2026-10-06T23:59');
  assert.equal(fromInputValue('2026-10-06T23:59').getTime(), d.getTime());
  assert.equal(fromInputValue(''), null);
});
