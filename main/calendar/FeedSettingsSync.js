// The calendar feed list, shared with the phone (docs/protocol.md section 5, GET and PUT /v1/feed-settings):
// which addresses are subscribed, their names, and which were removed. Each device downloads the feeds itself; only
// this list travels. A change wins over the other side's when it is newer (updatedAt), feed by feed. The addresses
// stay in the main process: the page is told that the list changed (onChanged) and lists it again, without them.
const { FeedFetcher } = require('./FeedFetcher');

const MAX_FEEDS = 50;
const MAX_NAME = 200;
const ID = /^[A-Za-z0-9._-]{1,64}$/;

class FeedSettingsSync {
  /**
   * @param {{store: import('./FeedStore').FeedStore, now?: () => number, onChanged?: () => void}} o
   *   onChanged: a feed was added, renamed or removed from the phone (the page reloads its list and downloads new ones)
   */
  constructor({ store, now = Date.now, onChanged = () => {} }) {
    this.store = store;
    this.now = now;
    this.onChanged = onChanged;
  }

  /** @returns {Array<{id, url, name, kind, removed, updatedAt}>} */
  list() { return this.store.shared(this.now()); }

  /**
   * Applies the phone's changes and answers the list as it now is. Malformed entries make the whole request invalid
   * (null), so the phone never half-applies a list.
   * @param {unknown} feeds  [{ id, url, name, removed, updatedAt }]
   * @returns {Array|null}
   */
  apply(feeds) {
    if (!Array.isArray(feeds) || feeds.length > MAX_FEEDS) return null;
    const entries = feeds.map((f) => this.#read(f));
    if (entries.some((e) => !e)) return null;
    let changed = false;
    for (const e of entries) changed = this.#applyOne(e) || changed;
    if (changed) this.onChanged();
    return this.list();
  }

  #read(f) {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !ID.test(f.id)) return null;
    const updatedAt = typeof f.updatedAt === 'string' ? Date.parse(f.updatedAt) : NaN;
    if (Number.isNaN(updatedAt) || typeof f.removed !== 'boolean') return null;
    if (f.name !== undefined && typeof f.name !== 'string') return null;
    let url = null;
    if (!f.removed) {
      try { url = FeedFetcher.normalizeUrl(String(f.url ?? '').slice(0, 4000)); } catch { return null; }
    }
    // A time far ahead is a wrong phone clock: use this PC's instead, as for items.
    const stamp = Math.min(updatedAt, this.now() + 60 * 1000);
    return { id: f.id, url, name: String(f.name ?? '').trim().slice(0, MAX_NAME), removed: f.removed, updatedAt: new Date(stamp).toISOString() };
  }

  #applyOne({ id, url, name, removed, updatedAt }) {
    const mine = this.store.raw(id);
    if (mine && !(Date.parse(updatedAt) > Date.parse(mine.updatedAt ?? mine.addedAt))) return false; // the PC's is as new or newer
    if (removed) return this.store.remove(id, { updatedAt, now: this.now() });
    if (mine && !mine.removedAt) {
      if (this.store.urlOf(id) === url) return !!(name && name !== mine.name && this.store.rename(id, name, { updatedAt, now: this.now() }));
      this.store.remove(id, { updatedAt, now: this.now() }); // a new address under the same id: replaced below
    }
    // A new feed. The same address under another id is the same feed: the answer gives the phone the PC's id.
    if (this.store.findByUrl(url)) return false;
    const host = new URL(url).host;
    this.store.add({ id, url, name: name || host, kind: 'calendar', host, count: 0, updatedAt, now: this.now(), fetched: false });
    return true;
  }
}

module.exports = { FeedSettingsSync };
