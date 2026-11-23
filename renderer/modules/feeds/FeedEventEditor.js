import { Component } from '../../core/Component.js';
import { h, clear } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { formatDate, formatDateTime, formatTime, sameDay } from '../../core/dates.js';
import { CourseSessions } from './CourseSessions.js';
import { FeedCalendarSource } from './FeedCalendarSource.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Right panel for a lecture, exam or other feed event (read-only: it belongs to the feed). Under its details, a lecture
// or exam shows its course's whole timetable: the weekly slots it meets in, then every session month by month, past ones
// dimmed and the next one marked. Clicking a session opens it here.
export class FeedEventEditor extends Component {
  /** @param {FeedCalendarSource} source */
  constructor(ctx, id, source, now = Date.now) {
    super(ctx);
    this.id = id;
    this.source = source;
    this.now = now;
  }

  build() { return h('div', { class: 'editor' }); }

  onMount() {
    // A new download or a course hidden in Settings changes what is shown.
    this.on('data:changed', (e) => { if (e.collection === 'feedEntries') this.render(); });
  }

  render() {
    clear(this.el);
    const found = this.source.session(this.id);
    if (!found) { this.el.append(h('div', { class: 'empty' }, 'This event is no longer in your calendar.')); return; }
    const { session, kind, color, course } = found;
    this.bus.emit('panel:title', { text: kind, color });

    // filter: the DOM's own append() would print a missing timetable as the text "null".
    this.el.append(...[
      h('div', { class: 'field' },
        h('div', { class: 'feed-ev-title' }, session.title),
        h('div', { class: 'feed-ev-line' }, icon('clock', 14), this.when(session)),
        session.context ? h('div', { class: 'feed-ev-line' }, icon('info', 14), session.context) : null,
        h('div', { class: 'set-hint' }, 'From your calendar feeds. Read-only.')),
      course && course.sessions.length ? this.timetable(course, session) : null,
    ].filter(Boolean));
  }

  /** "Nov 3, 09:00–12:15", or one time for a moment. */
  when(s) {
    if (!s.end || s.end <= s.start) return formatDateTime(s.start);
    return sameDay(s.start, s.end)
      ? `${formatDate(s.start)}, ${formatTime(s.start)}–${formatTime(s.end)}`
      : `${formatDateTime(s.start)} – ${formatDateTime(s.end)}`;
  }

  timetable(course, current) {
    const now = this.now();
    const next = course.next(now);
    const left = course.sessions.filter((s) => !CourseSessions.isPast(s, now)).length;
    const lectures = course.lectures.length;
    const exams = course.exams.length;
    const slots = course.weekly;
    const irregular = course.irregular;

    const rows = [];
    let month = null;
    for (const s of course.sessions) {
      const key = s.start.getFullYear() * 12 + s.start.getMonth();
      if (key !== month) {
        month = key;
        rows.push(h('div', { class: 'course-month' }, `${MONTHS[s.start.getMonth()]} ${s.start.getFullYear()}`));
      }
      rows.push(this.sessionRow(s, { past: CourseSessions.isPast(s, now), next: s === next, current: s.id === current.id }));
    }

    return h('div', { class: 'field' },
      h('label', { class: 'field-label' }, `${course.course}: all sessions`),
      h('div', { class: 'course-summary' },
        h('div', { class: 'muted' }, [
          `${lectures} ${lectures === 1 ? 'lecture' : 'lectures'}`,
          exams ? `${exams} ${exams === 1 ? 'exam' : 'exams'}` : null,
          `${left} still to come`,
        ].filter(Boolean).join(' · ')),
        slots.length
          ? h('div', { class: 'course-slots' }, slots.map((slot) => h('span', { class: 'course-slot' },
            CourseSessions.slotLabel(slot, formatTime), h('span', { class: 'muted' }, ` ×${slot.count}`))))
          : h('div', {}, 'No weekly pattern: the dates are listed below.'),
        slots.length && irregular ? h('div', { class: 'muted' }, `+ ${irregular} at other times`) : null),
      h('div', { class: 'course-sessions' }, rows));
  }

  sessionRow(s, { past, next, current }) {
    const exam = s.type === 'exam';
    const time = !s.end || s.end <= s.start ? formatTime(s.start) : `${formatTime(s.start)}–${formatTime(s.end)}`;
    const { color } = FeedCalendarSource.look(s.type);
    return h('button', {
      type: 'button',
      class: `course-session${past ? ' past' : ''}${next ? ' upcoming' : ''}${current ? ' current' : ''}`,
      style: { '--c': color },
      title: current ? 'Shown above' : 'Open this session',
      onClick: () => { if (!current) this.ctx.selection.select('feedEvent', s.id); },
    },
    h('span', { class: 'course-date' },
      h('span', { class: 'course-day' }, String(s.start.getDate())),
      h('span', { class: 'muted' }, WEEKDAYS[s.start.getDay()])),
    h('span', { class: 'course-info' },
      h('span', { class: `course-time${exam ? ' exam' : ''}` }, exam ? `Exam · ${time}` : time,
        next ? h('span', { class: 'course-next' }, 'Next') : null),
      s.context ? h('span', { class: 'muted course-context' }, s.context) : null));
  }
}
