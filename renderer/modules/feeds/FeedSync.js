import { HOUR } from '../../core/dates.js';
import { mapperFor } from './feedMappers.js';

// Keeps the calendar feeds up to date: downloads each one at startup and every hour (the FH timetable says its data
// is good for an hour), and when the user presses refresh. Downloading happens in the main process (window.api.feeds).
// Every change is announced as 'feeds:changed' so Settings › Data can redraw, and courses a download brings for the first
// time as 'feeds:new-courses' { feed, names, first } (FeedsModule shows a toast).
export class FeedSync {
  /**
   * @param {{api: object, bus: object, cache: import('./FeedCache.js').FeedCache,
   *          importer: import('./AssignmentImporter.js').AssignmentImporter, filter?: import('./CourseFilter.js').CourseFilter|null,
   *          intervalMs?: number}} o
   */
  constructor({ api, bus, cache, importer, filter = null, intervalMs = HOUR }) {
    this.filter = filter;
    this.api = api;
    this.bus = bus;
    this.cache = cache;
    this.importer = importer;
    this.intervalMs = intervalMs;
    this.feeds = [];         // as the main process lists them: { id, name, kind, host, lastFetched, lastError, count }
    this.busy = new Set();   // ids being downloaded right now
    this.timer = null;
  }

  async start() {
    this.feeds = await this.api.list();
    this.#changed();
    this.timer = setInterval(() => this.refreshAll(), this.intervalMs);
    await this.refreshAll();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  /**
   * The list changed in the main process (the phone added, renamed or removed a feed): list it again. A feed that is new
   * here is downloaded; one that is gone loses its lectures and exams, as when it is removed on the PC.
   */
  async reload() {
    const before = new Set(this.feeds.map((f) => f.id));
    this.feeds = await this.api.list();
    const now = new Set(this.feeds.map((f) => f.id));
    for (const id of before) {
      if (!now.has(id)) { this.cache.removeFeed(id); this.filter?.forget(id); }
    }
    this.#changed();
    for (const feed of this.feeds) if (!before.has(feed.id)) await this.refresh(feed.id);
  }

  async refreshAll() {
    for (const feed of [...this.feeds]) await this.refresh(feed.id); // one at a time: two feeds are quick enough
  }

  /** @returns {Promise<{ok: boolean, error?: string}>} */
  async refresh(id) {
    if (this.busy.has(id)) return { ok: true };
    this.busy.add(id);
    this.#changed();
    try {
      const res = await this.api.refresh(id);
      if (res.feed) this.feeds = this.feeds.map((f) => (f.id === id ? res.feed : f));
      if (res.ok && this.feeds.some((f) => f.id === id)) this.apply(res.feed, res.events);
      return res;
    } finally {
      this.busy.delete(id);
      this.#changed();
    }
  }

  /** Subscribe to a new address. Nothing is saved when it can not be downloaded or is not a calendar. */
  async add(url) {
    const res = await this.api.add(url);
    if (res.ok) {
      this.feeds = [...this.feeds, res.feed];
      this.apply(res.feed, res.events);
      this.#changed();
    }
    return res;
  }

  /** Lectures and exams from this feed go away; assignments it imported stay where they are. */
  async remove(id) {
    await this.api.remove(id);
    this.feeds = this.feeds.filter((f) => f.id !== id);
    this.cache.removeFeed(id);
    this.filter?.forget(id);
    this.#changed();
  }

  /** Keep the download for the calendar, and turn Moodle due dates into assignments. */
  apply(feed, events) {
    this.cache.replace(feed, events);
    const deadlines = this.#deadlines(feed, events);
    if (deadlines.length) this.importer.import(feed, deadlines);
    const fresh = this.filter?.takeNew(feed, this.cache.forFeed(feed.id));
    if (fresh?.names.length) this.bus.emit('feeds:new-courses', { feed, ...fresh });
  }

  /** The courses in a feed's last download, for the checklist in Settings (see CourseFilter.courses). */
  courses(feed) {
    return this.filter ? this.filter.courses(feed, this.cache.forFeed(feed.id)) : [];
  }

  /** The user closed the checklist: its courses are no longer "New". */
  lookedAtCourses(feed) {
    this.filter?.markLooked(feed, this.cache.forFeed(feed.id));
    this.#changed();
  }

  /** How many of this feed's due dates the user deleted (and could bring back), from the last download. */
  hiddenCount(feed) {
    return this.importer.hidden(this.#deadlines(feed, this.cache.forFeed(feed.id))).length;
  }

  /** Bring back this feed's deleted assignments. Works from the last download: no network needed. @returns {number} how many */
  restore(feedId) {
    const feed = this.feeds.find((f) => f.id === feedId);
    if (!feed) return 0;
    const count = this.importer.restore(feed, this.#deadlines(feed, this.cache.forFeed(feed.id)));
    this.#changed();
    return count;
  }

  #deadlines(feed, events) {
    const mapper = mapperFor(feed.kind);
    return events
      .map((e) => ({ uid: e.uid, start: e.start, mapped: mapper.map(e) }))
      .filter((d) => d.mapped.type === 'deadline');
  }

  /** How many due dates / lectures / events a feed brought, for its row in Settings. */
  summary(feed) {
    const mapper = mapperFor(feed.kind);
    const counts = {};
    for (const e of this.cache.forFeed(feed.id)) {
      const type = mapper.map(e).type;
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  }

  #changed() { this.bus.emit('feeds:changed'); }
}
