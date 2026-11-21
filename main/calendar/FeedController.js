// Calendar feeds, main-process side: add, refresh and remove subscriptions. Every call answers
// { ok: true, feed, events } or { ok: false, error, feed? } (error = a sentence for the user), never throws,
// and never hands the address back to the page.
const { FeedFetcher } = require('./FeedFetcher');
const { FeedStore } = require('./FeedStore');
const { IcsParser } = require('./IcsParser');

class FeedController {
  /** @param {{store?: FeedStore, fetcher?: FeedFetcher, now?: () => number}} [o] */
  constructor({ store = new FeedStore(), fetcher = new FeedFetcher(), now = Date.now } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.now = now;
  }

  /** What the feed is, from the program that made it: picks how the page reads its events. */
  static kindOf(producer) {
    if (/moodle/i.test(producer)) return 'moodle';
    if (/FH JOANNEUM/i.test(producer) && /Stundenplan/i.test(producer)) return 'timetable';
    return 'calendar';
  }

  static nameOf(kind, calName, host) {
    if (kind === 'moodle') return 'Moodle';
    return calName || host;
  }

  list() { return this.store.list(); }

  async add(input) {
    try {
      const url = FeedFetcher.normalizeUrl(input);
      if (this.store.has(url)) return { ok: false, error: 'This calendar is already added.' };
      const parsed = IcsParser.parse(await this.fetcher.fetchText(url), { now: this.now() });
      const kind = FeedController.kindOf(parsed.producer);
      const host = new URL(url).host;
      const feed = this.store.add({ url, kind, host, name: FeedController.nameOf(kind, parsed.name, host), count: parsed.events.length, now: this.now() });
      return { ok: true, feed, events: parsed.events };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async refresh(id) {
    const url = this.store.urlOf(id);
    if (!url) {
      const feed = this.store.get(id) ? this.store.mark(id, { lastError: 'This address can not be read on this Windows account. Remove it and add it again.' }) : null;
      return { ok: false, error: feed?.lastError ?? 'This calendar no longer exists.', feed };
    }
    try {
      const parsed = IcsParser.parse(await this.fetcher.fetchText(url), { now: this.now() });
      // A feed added on the phone arrives before it was ever downloaded here: its kind (and a name, if it has none) come now.
      const kind = FeedController.kindOf(parsed.producer);
      const name = this.store.get(id)?.name || FeedController.nameOf(kind, parsed.name, new URL(url).host);
      const feed = this.store.mark(id, { kind, name, lastFetched: new Date(this.now()).toISOString(), lastError: null, count: parsed.events.length });
      if (!feed) return { ok: false, error: 'This calendar no longer exists.' }; // removed while it was downloading
      return { ok: true, feed, events: parsed.events };
    } catch (err) {
      return { ok: false, error: err.message, feed: this.store.mark(id, { lastError: err.message }) };
    }
  }

  remove(id) {
    return { ok: this.store.remove(id) };
  }
}

module.exports = { FeedController };
