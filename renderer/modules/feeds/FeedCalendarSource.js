import { CalendarEvent, CalendarSource } from '../../services/CalendarSource.js';
import { mapperFor } from './feedMappers.js';
import { CourseSessions } from './CourseSessions.js';

// Lectures, exams and other feed events on the calendar. They are read-only: there is nothing to tick off, so one
// that is over counts as done (it never shows as overdue in the top bar).
//   lecture  quiet: on the calendar only, no reminders, never "next" in the top bar
//   exam     reminded a day and an hour before it starts
//   event    anything else from a feed: quiet, like a lecture
// Moodle due dates are not here: they are assignment items (AssignmentImporter) and come in through the workspace.
// Courses the user unticked in Settings (CourseFilter) are left out, with their exams.
// Clicking one opens it in the right panel ('feedEvent', FeedEventEditor): its details and its course's whole timetable.
const LOOKS = {
  lecture: { kind: 'Lecture', color: '#5c9ce6', quiet: true },
  exam: { kind: 'Exam', color: '#ff5c7a', remind: 'exam' },
  event: { kind: 'Event', color: '#8b90a3', quiet: true },
};

export class FeedCalendarSource extends CalendarSource {
  /** @param {import('./FeedCache.js').FeedCache} cache @param {{now?: () => number, filter?: import('./CourseFilter.js').CourseFilter|null}} [o] */
  constructor(cache, { now = Date.now, filter = null } = {}) {
    super('feeds');
    this.cache = cache;
    this.now = now;
    this.filter = filter;
  }

  events() {
    const now = this.now();
    return this.#shown().map(({ entry, mapped }) => {
      const event = new CalendarEvent({
        id: `feed:${entry.id}`, title: mapped.title, context: mapped.context ?? '',
        start: entry.startDate, end: entry.endDate, ...LOOKS[mapped.type], ref: { type: 'feedEvent', id: `feed:${entry.id}` },
      });
      event.done = event.isOver(now);
      return event;
    });
  }

  /**
   * The same events for the phone (GET /v1/calendar, see phonesync/CalendarPull.js), touching from..to.
   * kind is 'lecture' | 'exam' | 'event'; a moment (no length) has end = start. course names the course a lecture or
   * exam belongs to (the same for both, so the phone can list a course's sessions), or null.
   */
  phoneEvents(from, to) {
    return this.#shown()
      .filter(({ entry }) => entry.startDate < to && (entry.endDate ?? entry.startDate) >= from)
      .map(({ entry, mapped }) => ({
        id: `feed:${entry.id}`, kind: mapped.type, title: mapped.title || 'Untitled', context: mapped.context ?? '',
        course: mapped.course || null,
        start: entry.startDate.toISOString(), end: (entry.endDate ?? entry.startDate).toISOString(),
      }));
  }

  /**
   * One event as the panel shows it, and every session of its course (null for an event of no course).
   * @returns {{session: object, kind: string, color: string, course: CourseSessions|null}|null}
   */
  session(id) {
    const all = this.#shown().map(({ entry, mapped }) => ({
      id: `feed:${entry.id}`, type: mapped.type, title: mapped.title || 'Untitled', context: mapped.context ?? '',
      course: mapped.course ?? '', start: entry.startDate, end: entry.endDate ?? null,
    }));
    const session = all.find((s) => s.id === id);
    if (!session) return null;
    const { kind, color } = LOOKS[session.type];
    return { session, kind, color, course: session.course ? CourseSessions.of(session.course, all) : null };
  }

  /** The kind label and colour of a session's type ('lecture', 'exam'). */
  static look(type) { return LOOKS[type] ?? LOOKS.event; }

  /** Feed entries that are drawn: a kind the calendar shows, a start, and not a course the user unticked. */
  #shown() {
    const out = [];
    for (const entry of this.cache.all()) {
      const mapped = mapperFor(entry.kind).map(entry);
      if (!LOOKS[mapped.type] || !entry.startDate) continue;
      if (mapped.course && this.filter?.isHidden(entry.feedId, mapped.course)) continue;
      out.push({ entry, mapped });
    }
    return out;
  }
}
