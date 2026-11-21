import { addDays, startOfDay } from '../core/dates.js';

// Asks every registered CalendarSource for its events and answers questions about them.
// Used by the top bar, the calendar and the reminders.
export class DeadlineService {
  constructor(ctx) {
    this.registry = ctx.registry;
  }

  /** Every event from every source, soonest first. A failing source is skipped and logged. */
  events() {
    const all = [];
    for (const source of this.registry.list('calendarSource')) {
      try {
        all.push(...source.events());
      } catch (err) {
        console.error(`[calendar source "${source.id}"] events() failed`, err);
      }
    }
    return all.sort((a, b) => a.start - b.start);
  }

  /**
   * The event for the top bar: the next not-done one, or the latest overdue one if nothing is left.
   * A time block that is running counts as next even though its start is past; it matters until it ends.
   * Overdue means after the end of a block, or after the due time of a deadline. Quiet events (lectures) never count.
   */
  next(now = Date.now()) {
    const open = this.events().filter((e) => !e.done && !e.quiet);
    const live = open.filter((e) => !e.isOver(now));
    const matters = (e) => (e.isRunning(now) ? e.end : e.start).getTime(); // when it needs you
    if (live.length) return live.reduce((best, e) => (matters(e) < matters(best) ? e : best));
    return open.reduce((latest, e) => (!latest || e.dueAt > latest.dueAt ? e : latest), null);
  }

  /** Events inside from <= t < to: a deadline by its time, a block when any part of it falls in the range. */
  inRange(from, to) {
    return this.events().filter((e) => (e.isBlock ? e.start < to && e.end > from : e.start >= from && e.start < to));
  }

  onDay(date) {
    const from = startOfDay(date);
    return this.inRange(from, addDays(from, 1));
  }
}
