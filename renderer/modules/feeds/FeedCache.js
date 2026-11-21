import { Entity } from '../../data/Entity.js';

// The last download of every calendar feed, kept in the data file so the calendar still shows lectures and exams
// when the PC is offline. One row per event, exactly as the main process parsed it (times are ISO UTC text).
export class FeedEntry extends Entity {
  static defaults() {
    return {
      id: '',            // "<feedId>|<uid>"
      feedId: '',
      kind: 'calendar',  // the feed's kind: 'timetable' | 'moodle' | 'calendar' (picks the mapper, see feedMappers.js)
      uid: '',
      summary: '',
      description: '',
      location: '',
      categories: '',
      start: null,
      end: null,
    };
  }

  get startDate() { return this.start ? new Date(this.start) : null; }
  get endDate() { return this.end ? new Date(this.end) : null; }
}

export class FeedCache {
  constructor({ store, bus }) {
    this.store = store;
    this.bus = bus;
  }

  get entries() { return this.store.collection('feedEntries'); }

  all() { return this.entries.all(); }

  forFeed(feedId) { return this.all().filter((e) => e.feedId === feedId); }

  /** Swap one feed's rows for a fresh download. One change announcement for the whole swap, not one per event. */
  replace(feed, events) {
    const others = this.all().filter((e) => e.feedId !== feed.id).map((e) => e.toJSON());
    const fresh = events.map((e) => ({ ...e, id: `${feed.id}|${e.uid}`, feedId: feed.id, kind: feed.kind }));
    this.entries.load([...others, ...fresh]);
    this.bus.emit('data:changed', { collection: 'feedEntries', type: 'replace', id: feed.id });
  }

  removeFeed(feedId) {
    const keep = this.all().filter((e) => e.feedId !== feedId);
    if (keep.length === this.all().length) return;
    this.entries.load(keep.map((e) => e.toJSON()));
    this.bus.emit('data:changed', { collection: 'feedEntries', type: 'replace', id: feedId });
  }
}
