import { SYNC_KINDS } from './PhoneItemMapper.js';

// Remembers which tasks went away on the PC, so the phone can be told ("pull", see docs/protocol.md section 5).
//
// An item goes away when it is deleted, or when it stops being a task, assignment or note (for example it is turned into a folder).
// The data itself cannot say that afterwards, so this class keeps:
//   - a map of which items are syncable right now (so it knows what an item WAS when it changes or is removed)
//   - a list of { id, at } for everything that went away, saved in the data file under meta.phoneSync
// Entries are kept 90 days. Pruning moves the "horizon": the time before which deletions may be unknown. A phone that
// asks for changes since before the horizon must be sent everything instead (a "full resync").
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class SyncLog {
  /** @param {{store: object, bus: object, now?: () => number}} o */
  constructor({ store, bus, now = Date.now }) {
    Object.assign(this, { store, bus, now });
    this.known = new Map(); // id -> kind, for every item that currently syncs
    this.started = false;
  }

  get items() { return this.store.has('items') ? this.store.collection('items') : null; }

  /** Call once the saved data is loaded. Starts watching changes. */
  start() {
    const items = this.items;
    if (!items || this.started) return;
    this.started = true;
    this.known = new Map(items.all().filter((i) => SYNC_KINDS.has(i.kind)).map((i) => [i.id, i.kind]));
    this.#state();
    this.#prune();
    this.store.touchMeta();
    this.bus.on('data:changed', (e) => this.#onChange(e));
  }

  /** Time before which deletions may be missing, in ms. Anything asked for from before this needs a full resync. */
  get horizonMs() { return Date.parse(this.#state().horizon); }

  /** Ids that went away at or after `sinceMs` (inclusive). */
  deletedSince(sinceMs) {
    return this.#state().deleted.filter((d) => !(Date.parse(d.at) < sinceMs)).map((d) => ({ id: d.id, at: d.at }));
  }

  #onChange({ collection, type, id }) {
    if (collection !== 'items') return;
    const item = type === 'remove' ? null : this.items.get(id);
    const syncsNow = !!item && SYNC_KINDS.has(item.kind);
    if (syncsNow) {
      this.known.set(id, item.kind);
      this.#forget(id); // it exists again (for example the phone sent it once more): it is not a deletion any more
    } else if (this.known.has(id)) {
      this.known.delete(id);
      this.#record(id);
    }
  }

  #record(id) {
    const state = this.#state();
    state.deleted = state.deleted.filter((d) => d.id !== id);
    state.deleted.push({ id, at: new Date(this.now()).toISOString() });
    this.#prune();
    this.store.touchMeta();
  }

  #forget(id) {
    const state = this.#state();
    if (!state.deleted.some((d) => d.id === id)) return;
    state.deleted = state.deleted.filter((d) => d.id !== id);
    this.store.touchMeta();
  }

  #prune() {
    const state = this.#state();
    const cutoff = this.now() - RETENTION_MS;
    const old = state.deleted.filter((d) => Date.parse(d.at) < cutoff);
    if (!old.length) return;
    state.deleted = state.deleted.filter((d) => !(Date.parse(d.at) < cutoff));
    const newest = Math.max(...old.map((d) => Date.parse(d.at)));
    if (newest > Date.parse(state.horizon)) state.horizon = new Date(newest).toISOString();
  }

  /** The saved part. Looked up each time because the store replaces its meta when the data is loaded. */
  #state() {
    const state = (this.store.meta.phoneSync ??= {});
    if (typeof state.horizon !== 'string' || Number.isNaN(Date.parse(state.horizon))) state.horizon = new Date(this.now()).toISOString();
    if (!Array.isArray(state.deleted)) state.deleted = [];
    return state;
  }
}
