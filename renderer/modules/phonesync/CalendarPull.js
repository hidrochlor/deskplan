import { DAY } from '../../core/dates.js';

// GET /v1/calendar?from=&to= (docs/protocol.md section 5): the read-only events the phone shows next to its own items:
// lectures, exams and other events from the calendar feeds. They come from every registered 'phoneCalendar' provider
// (the feeds module offers one), so this file knows nothing about feeds, Moodle or courses.
// Items are not in it: the phone has those from GET /v1/items.
export const DEFAULT_BACK = 14 * DAY;
export const DEFAULT_AHEAD = 180 * DAY;
export const MAX_RANGE = 400 * DAY;
export const EVENT_KINDS = new Set(['lecture', 'exam', 'event']);
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

export class CalendarPull {
  /** @param {{registry: {list: Function}, now?: () => number}} o */
  constructor({ registry, now = Date.now }) {
    this.registry = registry;
    this.now = now;
  }

  /** @param {{from?: string|null, to?: string|null}} payload  @returns {{status: number, body: object}} */
  handle({ from = null, to = null } = {}) {
    const now = this.now();
    const start = this.#time(from, now - DEFAULT_BACK);
    const end = this.#time(to, now + DEFAULT_AHEAD);
    if (start === undefined || end === undefined || !(end > start) || end - start > MAX_RANGE) {
      return { status: 422, body: { error: 'invalid-request' } };
    }
    const events = [];
    for (const provider of this.registry.list('phoneCalendar')) {
      try {
        events.push(...provider.events(new Date(start), new Date(end)).filter((e) => this.#valid(e)));
      } catch (err) {
        console.error(`[phone calendar "${provider.id}"] events() failed`, err);
      }
    }
    events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return {
      status: 200,
      body: { events, from: new Date(start).toISOString(), to: new Date(end).toISOString(), serverTime: new Date(now).toISOString() },
    };
  }

  /** Missing or empty -> the default. UTC text ending in Z -> ms. Anything else -> undefined (422). */
  #time(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (!UTC.test(value)) return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }

  #valid(e) {
    return e && typeof e.id === 'string' && EVENT_KINDS.has(e.kind) && typeof e.title === 'string'
      && typeof e.start === 'string' && typeof e.end === 'string';
  }
}
