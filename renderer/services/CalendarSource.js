// Anything with a date can appear on the calendar and the top bar by registering
// a CalendarSource. The calendar and top bar know nothing about tasks, notes, etc.
import { addDays, formatTime, startOfDay } from '../core/dates.js';

export class CalendarEvent {
  /**
   * @param {object} o
   * @param {string} o.id      unique across all sources
   * @param {string} o.title
   * @param {string} [o.context]  where it lives, e.g. "Python Basics"
   * @param {Date}   o.start   the due time, or for a time block the moment it begins
   * @param {Date}   [o.end]   only for a time block: when it ends (after start). Without it the event is a deadline at `start`.
   * @param {string} [o.kind]  label such as "Project"
   * @param {string} [o.color]
   * @param {boolean} [o.done]
   * @param {{type:string,id:string}} [o.ref]  what to select when clicked
   * @param {boolean} [o.quiet]  only drawn on the calendar: no reminders and never "next" in the top bar (e.g. a lecture)
   * @param {'auto'|'exam'} [o.remind]  'exam': warn 1 day and 1 hour before it starts, instead of the usual steps
   */
  constructor({ id, title, context = '', start, end = null, kind = '', color = '#7c8cff', done = false, ref = null, quiet = false, remind = 'auto' }) {
    this.id = id;
    this.title = title;
    this.context = context;
    this.start = start;
    this.end = end && end > start ? end : null; // an end that is not after the start is ignored: it is a deadline
    this.kind = kind;
    this.color = color;
    this.done = done;
    this.ref = ref;
    this.quiet = quiet;
    this.remind = remind;
  }

  /** Runs from start to end (rather than being due at one moment). */
  get isBlock() { return this.end !== null; }

  /** The moment that counts as "due": the end of a block, otherwise the due time. */
  get dueAt() { return this.end ?? this.start; }

  /** A block that has begun and not yet ended. */
  isRunning(now = Date.now()) { return this.isBlock && this.start.getTime() <= now && now < this.end.getTime(); }

  /** Past its end (block) or its due time (deadline). */
  isOver(now = Date.now()) { return now > this.dueAt.getTime(); }

  /** "15:00-19:00" for a block, "23:59" for a deadline. */
  timeLabel() { return this.isBlock ? `${formatTime(this.start)}-${formatTime(this.end)}` : formatTime(this.start); }

  /** The days this event touches, as start-of-day dates: one for a deadline, every day a block overlaps (a block that ends at midnight sharp does not touch the new day). */
  days() {
    const first = startOfDay(this.start);
    if (!this.isBlock) return [first];
    const last = startOfDay(new Date(this.end.getTime() - 1));
    const out = [];
    for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
    return out;
  }
}

export class CalendarSource {
  constructor(id) {
    this.id = id;
  }

  /** @returns {CalendarEvent[]} */
  events() {
    return [];
  }
}
