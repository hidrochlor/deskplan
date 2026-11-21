import { mapperFor } from './feedMappers.js';

// Which courses of a feed show on the calendar. The FH timetable link is for the whole year group (q=Met26), so it
// brings both majors; the user unticks the courses that are not theirs in Settings › Data › Calendar feeds.
//   it remembers what is HIDDEN, not what is shown: a course that appears later starts out visible, never silently lost
//   exams follow their course (the exam's course name is the course's name)
//   it remembers which courses were already seen, so new ones (next semester) are announced once (a toast), and which
//   ones the user has looked at in the list, so the newer ones there get a "New" badge
//   the shown / hidden choice is shared with the phone (docs/protocol.md section 5, /v1/feed-settings): each course remembers when it was
//   last changed (changedAt), and the newer choice wins, course by course
// Saved per feed in store.meta.feedCourses: { [feedId]: { hidden: [key], seen: [key], looked?: [key], changedAt?: { [key]: ISO } } }.
// key = the course name, normalised.
export const courseKey = (name) => String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export class CourseFilter {
  constructor({ store, bus, now = Date.now }) {
    this.store = store;
    this.bus = bus;
    this.now = now;
  }

  #state(feedId) {
    const all = (this.store.meta.feedCourses ??= {});
    return (all[feedId] ??= { hidden: [], seen: [] });
  }

  isHidden(feedId, course) {
    const key = courseKey(course);
    return !!key && (this.store.meta.feedCourses?.[feedId]?.hidden ?? []).includes(key);
  }

  /**
   * The courses in a feed's download, A–Z, with how many lectures and exams are still to come.
   * isNew = it appeared after the user last closed the list (never on the first look: then everything is new).
   * @returns {Array<{key: string, name: string, lectures: number, exams: number, hidden: boolean, isNew: boolean}>}
   */
  courses(feed, entries) {
    const mapper = mapperFor(feed.kind);
    const state = this.store.meta.feedCourses?.[feed.id];
    const now = this.now();
    const byKey = new Map();
    for (const entry of entries) {
      const m = mapper.map(entry);
      if ((m.type !== 'lecture' && m.type !== 'exam') || !courseKey(m.course)) continue;
      const key = courseKey(m.course);
      const c = byKey.get(key) ?? { key, name: m.course, lectures: 0, exams: 0 };
      if (Date.parse(entry.end ?? entry.start) > now) c[m.type === 'exam' ? 'exams' : 'lectures']++;
      if (m.type === 'lecture') c.name = m.course; // the lecture's spelling, not the exam's
      byKey.set(key, c);
    }
    return [...byKey.values()]
      .map((c) => ({ ...c, hidden: !!state?.hidden.includes(c.key), isNew: !!state?.looked && !state.looked.includes(c.key) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Show or hide some courses of a feed. The calendar redraws. at: when (the phone's time, for a change made there). */
  setHidden(feedId, keys, hidden, at = new Date(this.now()).toISOString()) {
    const state = this.#state(feedId);
    const set = new Set(state.hidden);
    state.changedAt ??= {};
    for (const key of keys) {
      (hidden ? set.add(key) : set.delete(key));
      state.changedAt[key] = at;
    }
    state.hidden = [...set];
    this.#changed(feedId);
  }

  /**
   * Every choice the phone should know: each hidden course, and each course shown again after being hidden.
   * @returns {Array<{feedId: string, key: string, hidden: boolean, updatedAt: string}>}
   */
  shared() {
    const out = [];
    for (const [feedId, state] of Object.entries(this.store.meta.feedCourses ?? {})) {
      const keys = new Set([...(state.hidden ?? []), ...Object.keys(state.changedAt ?? {})]);
      for (const key of keys) {
        out.push({ feedId, key, hidden: state.hidden.includes(key), updatedAt: state.changedAt?.[key] ?? new Date(0).toISOString() });
      }
    }
    return out;
  }

  /**
   * The phone's choices: each one newer than the PC's wins. Malformed input answers false and changes nothing.
   * @param {unknown} courses  [{ feedId, key, hidden, updatedAt }]
   */
  applyShared(courses) {
    if (!Array.isArray(courses) || courses.length > 2000) return false;
    const ok = courses.every((c) => c && typeof c.feedId === 'string' && c.feedId.length <= 64 && typeof c.key === 'string'
      && c.key.length <= 500 && typeof c.hidden === 'boolean' && typeof c.updatedAt === 'string' && !Number.isNaN(Date.parse(c.updatedAt)));
    if (!ok) return false;
    for (const c of courses) {
      const key = courseKey(c.key);
      const mine = this.store.meta.feedCourses?.[c.feedId]?.changedAt?.[key];
      if (!key || (mine && !(Date.parse(c.updatedAt) > Date.parse(mine)))) continue;
      const stamp = new Date(Math.min(Date.parse(c.updatedAt), this.now() + 60 * 1000)).toISOString();
      this.setHidden(c.feedId, [key], c.hidden, stamp);
    }
    return true;
  }

  /**
   * Courses this download has that were never seen before, now marked as seen. The first download of a feed counts
   * every course as new (that is when the user picks theirs).
   * @returns {{names: string[], first: boolean}}
   */
  takeNew(feed, entries) {
    const first = !this.store.meta.feedCourses?.[feed.id];
    const state = this.#state(feed.id);
    const fresh = this.courses(feed, entries).filter((c) => !state.seen.includes(c.key));
    if (!fresh.length) return { names: [], first };
    state.seen = [...state.seen, ...fresh.map((c) => c.key)];
    this.store.touchMeta();
    return { names: fresh.map((c) => c.name), first };
  }

  /** The user closed the list: what is in it now is no longer "New". */
  markLooked(feed, entries) {
    this.#state(feed.id).looked = this.courses(feed, entries).map((c) => c.key);
    this.store.touchMeta();
  }

  forget(feedId) {
    if (this.store.meta.feedCourses?.[feedId]) { delete this.store.meta.feedCourses[feedId]; this.store.touchMeta(); }
  }

  #changed(feedId) {
    this.store.touchMeta();
    // The calendar and top bar redraw on data changes; the feed rows in Settings on feeds:changed.
    this.bus.emit('data:changed', { collection: 'feedEntries', type: 'filter', id: feedId });
    this.bus.emit('feeds:changed');
  }
}
