import { courseKey } from './CourseFilter.js';

// One course's whole timetable: every lecture and exam of it, and the weekly slots its lectures meet in. The same
// rules as the phone's course timetable (lib/ui/calendar/course_sessions.dart), so both show the same pattern.
//   a session    { id, type: 'lecture' | 'exam', title, context, start: Date, end: Date|null }
//   a slot       a local weekday plus start and end time that at least two lectures share
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export class CourseSessions {
  /** @param {string} course  @param {Array<{id: string, type: string, title: string, context: string, start: Date, end: Date|null, course: string}>} sessions */
  constructor(course, sessions) {
    this.course = course;
    this.sessions = [...sessions].sort((a, b) => a.start - b.start);
  }

  /** The lectures and exams of `course` (compared as CourseFilter does) among `sessions`. */
  static of(course, sessions) {
    const key = courseKey(course);
    return new CourseSessions(course, sessions.filter((s) => (s.type === 'lecture' || s.type === 'exam') && courseKey(s.course) === key));
  }

  get lectures() { return this.sessions.filter((s) => s.type === 'lecture'); }
  get exams() { return this.sessions.filter((s) => s.type === 'exam'); }

  /** Over: its end (or, for a moment, its start) is past. */
  static isPast(s, now) { return (s.end ?? s.start).getTime() < now; }

  /** The first session that has not ended, or null. */
  next(now) { return this.sessions.find((s) => !CourseSessions.isPast(s, now)) ?? null; }

  /**
   * The slots at least two lectures share, most used first, then by weekday and time.
   * @returns {Array<{weekday: number, startMinute: number, endMinute: number, count: number}>}  weekday 1 = Monday
   */
  get weekly() {
    const counts = new Map();
    for (const s of this.lectures) {
      const end = s.end ?? s.start;
      const weekday = ((s.start.getDay() + 6) % 7) + 1;
      const key = `${weekday}|${s.start.getHours() * 60 + s.start.getMinutes()}|${end.getHours() * 60 + end.getMinutes()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts]
      .filter(([, n]) => n >= 2)
      .map(([key, count]) => {
        const [weekday, startMinute, endMinute] = key.split('|').map(Number);
        return { weekday, startMinute, endMinute, count };
      })
      .sort((a, b) => b.count - a.count || a.weekday - b.weekday || a.startMinute - b.startMinute);
  }

  /** Lectures outside every weekly slot. */
  get irregular() { return this.lectures.length - this.weekly.reduce((n, s) => n + s.count, 0); }

  /** "Tue 09:00–12:15" (times in the user's clock format via `time`). */
  static slotLabel(slot, time) {
    const at = (m) => time(new Date(2000, 0, 1, Math.floor(m / 60), m % 60));
    const day = DAYS[slot.weekday - 1];
    return slot.startMinute === slot.endMinute ? `${day} ${at(slot.startMinute)}` : `${day} ${at(slot.startMinute)}–${at(slot.endMinute)}`;
  }
}
