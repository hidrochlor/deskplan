// The list of calendar feeds the user subscribed to (Settings › Data › Calendar feeds), kept in its own file next to
// the data file. The addresses are encrypted with the Windows account (Electron safeStorage): a Moodle address holds a
// token that lets anyone read the user's Moodle calendar. The page only ever sees the host name. The paired phone gets
// the addresses too (FeedSettingsSync), over its pinned, encrypted connection, so both fetch the same calendars.
// A removed feed is kept for a while as a marker (removedAt), so the phone learns it is gone instead of adding it back.
const crypto = require('crypto');
const { JsonFile } = require('../receiver/JsonFile');

/** No encryption, for tests and for systems without a key store. */
const PLAIN = { available: false, encrypt: (s) => s, decrypt: (s) => s };
const KEEP_REMOVED = 90 * 24 * 60 * 60 * 1000; // how long a removal is remembered for the phone

class FeedStore {
  /** @param {{file?: JsonFile, cipher?: {available: boolean, encrypt: (s: string) => string, decrypt: (s: string) => string}}} [o] */
  constructor({ file = new JsonFile(null), cipher = PLAIN } = {}) {
    this.file = file;
    this.cipher = cipher;
    this.feeds = (file.read({ feeds: [] }).feeds ?? []).filter((f) => f && f.id && (f.url || f.removedAt));
  }

  /** What the page may see: everything except the address. Removed feeds are left out. */
  list() {
    return this.feeds.filter((f) => !f.removedAt).map(({ url, encrypted, removedAt, ...pub }) => ({ ...pub }));
  }

  /**
   * What the phone shares: every feed with its address, and the removal markers of the last 90 days.
   * updatedAt = when its address, name or removal last changed (an older feed: when it was added).
   * @returns {Array<{id: string, url: string|null, name: string, kind: string, removed: boolean, updatedAt: string}>}
   */
  shared(now = Date.now()) {
    return this.feeds
      .filter((f) => !f.removedAt || now - Date.parse(f.removedAt) < KEEP_REMOVED)
      .map((f) => ({
        id: f.id, url: f.removedAt ? null : this.urlOf(f.id), name: f.name, kind: f.kind,
        removed: !!f.removedAt, updatedAt: f.updatedAt ?? f.addedAt,
      }));
  }

  /** The stored feed (removed or not), without its address. */
  raw(id) {
    const feed = this.feeds.find((f) => f.id === id);
    if (!feed) return null;
    const { url, encrypted, ...rest } = feed;
    return rest;
  }

  get(id) { return this.list().find((f) => f.id === id) ?? null; }

  /** The feed (not removed) with this address, or null. */
  findByUrl(url) {
    return this.feeds.find((f) => !f.removedAt && this.urlOf(f.id) === url) ?? null;
  }

  /** The real address, or null. */
  urlOf(id) {
    const feed = this.feeds.find((f) => f.id === id);
    if (!feed) return null;
    try {
      return feed.encrypted ? this.cipher.decrypt(feed.url) : feed.url;
    } catch {
      return null; // encrypted under another Windows account: the user has to add it again
    }
  }

  /** Is this address already subscribed? */
  has(url) {
    return !!this.findByUrl(url);
  }

  /**
   * @param {{url: string, name: string, kind: string, host: string, count: number, now?: number, id?: string,
   *   updatedAt?: string, fetched?: boolean}} o  id and updatedAt: kept as the phone sent them (a feed added there).
   *   fetched false: not downloaded yet (FeedSync downloads it next).
   */
  add({ url, name, kind, host, count, now = Date.now(), id = crypto.randomUUID(), updatedAt = null, fetched = true }) {
    const encrypted = this.cipher.available;
    const at = new Date(now).toISOString();
    this.feeds = this.feeds.filter((f) => f.id !== id); // a removal marker with this id is replaced
    const feed = {
      id, name, kind, host, url: encrypted ? this.cipher.encrypt(url) : url, encrypted,
      addedAt: at, updatedAt: updatedAt ?? at, lastFetched: fetched ? at : null, lastError: null, count,
    };
    this.feeds.push(feed);
    this.#save();
    return this.get(feed.id);
  }

  /** Record the result of a refresh: { lastFetched, count } on success, { lastError } on failure. */
  mark(id, patch) {
    const feed = this.feeds.find((f) => f.id === id);
    if (!feed) return null;
    Object.assign(feed, patch);
    this.#save();
    return this.get(id);
  }

  /** Remove a feed, keeping a marker for the phone. updatedAt: when (the phone's time, for a removal made there). */
  remove(id, { now = Date.now(), updatedAt = null } = {}) {
    const feed = this.feeds.find((f) => f.id === id && !f.removedAt);
    if (!feed) return false;
    const at = updatedAt ?? new Date(now).toISOString();
    for (const key of Object.keys(feed)) if (!['id', 'name', 'kind', 'host', 'addedAt'].includes(key)) delete feed[key];
    Object.assign(feed, { url: '', encrypted: false, removedAt: at, updatedAt: at });
    this.#prune(now);
    this.#save();
    return true;
  }

  /** Rename a feed. updatedAt: when (the phone's time, for a change made there). */
  rename(id, name, { now = Date.now(), updatedAt = null } = {}) {
    const feed = this.feeds.find((f) => f.id === id && !f.removedAt);
    if (!feed) return null;
    Object.assign(feed, { name, updatedAt: updatedAt ?? new Date(now).toISOString() });
    this.#save();
    return this.get(id);
  }

  #prune(now) {
    this.feeds = this.feeds.filter((f) => !f.removedAt || now - Date.parse(f.removedAt) < KEEP_REMOVED);
  }

  #save() { this.file.write({ feeds: this.feeds }); }
}

module.exports = { FeedStore, PLAIN };
