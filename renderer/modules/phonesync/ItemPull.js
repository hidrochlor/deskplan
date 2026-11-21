import { DEFAULT_PULL_KINDS, PhoneItemMapper, SYNC_KINDS } from './PhoneItemMapper.js';

// Answers the phone's "what changed on the PC since ...?" (GET /v1/items?since=&kinds=, docs/protocol.md section 5).
//   - only the kinds asked for are returned (task, assignment, note; left out = task and assignment, so a phone that
//     does not know notes never gets one), each with its kind and parentId (as the phone should see it). Deletions
//     are not filtered by kind: the phone ignores one for an id it never had
//   - a folder or assignment that is deleted takes what is inside it along (the PC deletes the whole tree), so
//     every child comes back as { id, deleted: true } like any other deletion
//   - a change is anything edited at or after `since`, by the PC's own edit time (inclusive on purpose: the phone
//     applies a repeated item safely, but a missed one would be lost)
//   - a task that was deleted, or stopped being a task, is returned as { id, deleted: true } (needs the SyncLog)
//   - serverTime is this PC's clock, which the phone sends back next time; the phone's clock is never used
//   - with no `since`, or one from before the log's horizon, everything is returned and fullResync is true
//   - `fields` lists every field an item can have in this answer, taken from the mapper itself. When it gains one the
//     phone reads, the phone asks for everything once, so items that did not change still learn it. Nobody has to
//     remember to say so: adding a field to PhoneItemMapper.view is enough
const UTC_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export class ItemPull {
  /** @param {{store: object, log: import('./SyncLog.js').SyncLog, rulesFor: (items: object) => object, now?: () => number, mapper?: PhoneItemMapper}} o */
  constructor({ store, log, rulesFor, now = Date.now, mapper = new PhoneItemMapper() }) {
    Object.assign(this, { store, log, rulesFor, now, mapper });
  }

  /** @param {{since?: string|null, kinds?: string|null}} [request]  @returns {{status: number, body: object}} */
  handle({ since, kinds } = {}) {
    if (!this.store.has('items')) return { status: 503, body: { error: 'unavailable' } };

    let sinceMs = null;
    if (since !== undefined && since !== null) {
      sinceMs = typeof since === 'string' && UTC_Z.test(since) ? Date.parse(since) : NaN;
      if (Number.isNaN(sinceMs)) return { status: 422, body: { error: 'invalid-request' } };
    }
    const wanted = this.#kinds(kinds);
    if (!wanted) return { status: 422, body: { error: 'invalid-request' } };

    const serverTime = new Date(this.now()).toISOString();
    const fields = this.#fields(wanted);
    const items = this.store.collection('items');
    const rules = this.rulesFor(items);
    const view = (i) => this.mapper.view(i, rules.visibleParent(i), rules.tree.course(i.id)?.title ?? null);
    const syncable = items.all().filter((i) => wanted.has(i.kind));
    const byTime = (a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)) || String(a.id).localeCompare(String(b.id));

    if (sinceMs === null || sinceMs < this.log.horizonMs) {
      return { status: 200, body: { items: syncable.sort(byTime).map(view), serverTime, fullResync: true, fields } };
    }

    // `!(a < b)` so an item with a missing or odd time is sent rather than silently never sent.
    const changed = syncable.filter((i) => !(Date.parse(i.updatedAt) < sinceMs)).sort(byTime).map(view);
    const deleted = this.log.deletedSince(sinceMs).sort((a, b) => a.at.localeCompare(b.at)).map((d) => ({ id: d.id, deleted: true }));
    return { status: 200, body: { items: [...changed, ...deleted], serverTime, fullResync: false, fields } };
  }

  /** The fields an item can have in an answer for these kinds, A to Z (a note adds `doc`). */
  #fields(wanted) {
    const keys = new Set();
    for (const kind of wanted) for (const key of Object.keys(this.mapper.view({ kind }))) keys.add(key);
    return [...keys].sort();
  }

  /** `kinds=task,note` as a set, the default when left out, or null when it names an unknown or empty kind. */
  #kinds(kinds) {
    if (kinds === undefined || kinds === null) return new Set(DEFAULT_PULL_KINDS);
    const list = String(kinds).split(',');
    return list.every((k) => SYNC_KINDS.has(k)) ? new Set(list) : null;
  }
}
