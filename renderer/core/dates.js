// Date helpers. Pure functions, no DOM, so they are easy to test.
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const MINUTE = 60000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const pad = (n) => String(n).padStart(2, '0');

// Display preferences (set from Settings). Defaults: 24-hour clock, weeks start on Monday.
let clock24 = true;
let weekStart = 1; // 1 = Monday, 0 = Sunday

/** '24h' | '12h' */
export function setClockFormat(format) { clock24 = format !== '12h'; }
/** 'mon' | 'sun' */
export function setWeekStart(day) { weekStart = day === 'sun' ? 0 : 1; }

/** Short weekday names in display order (depends on the week start). */
export function weekdayLabels() {
  return weekStart === 1 ? WEEKDAYS : ['Sun', ...WEEKDAYS.slice(0, 6)];
}

/** "23:59", or "11:59 pm" with the 12-hour clock. */
export function formatTime(d) {
  if (clock24) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'am' : 'pm'}`;
}
export function formatDate(d) { return `${MONTHS[d.getMonth()]} ${d.getDate()}`; }
export function formatDateTime(d) { return `${formatDate(d)}, ${formatTime(d)}`; }

/** "42m", "4h 12m", "3d 5h", "12d" */
export function formatSpan(ms) {
  const mins = Math.floor(Math.abs(ms) / MINUTE);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7 && hours % 24) return `${days}d ${hours % 24}h`;
  return `${days}d`;
}

/** "4h 12m left" or "overdue 2h" */
export function formatCountdown(target, now = Date.now()) {
  const diff = target - now;
  return diff < 0 ? `overdue ${formatSpan(diff)}` : `${formatSpan(diff)} left`;
}

/** 'overdue' | 'soon' (under 24h) | 'week' (under 7 days) | 'later' */
export function urgency(target, now = Date.now()) {
  const diff = target - now;
  if (diff < 0) return 'overdue';
  if (diff < DAY) return 'soon';
  if (diff < 7 * DAY) return 'week';
  return 'later';
}

export function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function sameDay(a, b) { return dayKey(a) === dayKey(b); }
export function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
export function endOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59); }
export function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
export function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

/** Add whole days, keeping the clock time (safe across daylight-saving changes). */
export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}

/** 42 days (6 weeks) covering the month, starting on the chosen week start day. */
export function monthGrid(monthStart) {
  const offset = (monthStart.getDay() - weekStart + 7) % 7;
  const first = addDays(startOfDay(monthStart), -offset);
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

/** Date -> value for <input type="datetime-local"> */
export function toInputValue(d) { return `${dayKey(d)}T${formatTime(d)}`; }

/** <input type="datetime-local"> value -> Date (local time) or null */
export function fromInputValue(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
