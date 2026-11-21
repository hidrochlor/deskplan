import { MINUTE, formatCountdown, formatDateTime, formatSpan, formatTime } from '../core/dates.js';

// The second line of the top bar for the next CalendarEvent. Four states:
//   deadline          "Oct 6, 23:59 · 4h 12m left"        (overdue: "... · overdue 2h")
//   block, not begun  "starts in 2h"
//   block, running    "ends 19:00 · 1h 20m left"
//   block, over       "ended Oct 6, 19:00 · overdue 2h"   (just "ended Oct 6, 19:00" in the first minute)
export class NextEventLabel {
  /** @param {import('./CalendarSource.js').CalendarEvent} event @param {number} [now] ms */
  static text(event, now = Date.now()) {
    if (!event.isBlock) return `${formatDateTime(event.start)} · ${formatCountdown(event.start.getTime(), now)}`;
    if (now < event.start.getTime()) return `starts in ${formatSpan(event.start.getTime() - now)}`;
    if (now < event.end.getTime()) return `ends ${formatTime(event.end)} · ${formatSpan(event.end.getTime() - now)} left`;
    const late = now - event.end.getTime();
    return `ended ${formatDateTime(event.end)}${late >= MINUTE ? ` · overdue ${formatSpan(late)}` : ''}`; // (the "at the end" reminder: just "ended")
  }

  /** The moment the bar's colour (urgency) follows: the start of a block that has not begun, otherwise the due time or end. */
  static urgencyAt(event, now = Date.now()) {
    return (event.isBlock && now < event.start.getTime() ? event.start : event.dueAt).getTime();
  }
}
