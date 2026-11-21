// Applies an item change that came from the phone to DeskPlan's items. The rules are in docs/protocol.md (section 4):
//   - only task, assignment and note items sync; folders and files never do
//   - the names the phone uses (end is the deadline, done is the status) are mapped by PhoneItemMapper
//   - the newer updatedAt wins per item, and the PC wins a tie
//   - only title, start, end, done, kind, parentId and description are replaced, and doc on a note; file and createdAt
//     are never touched (createdAt is sent to the phone to show, never taken from it; description is optional: missing
//     keeps the PC's). A note's description is made here from its doc, never taken from the phone
//   - a note has no times and no tick: a start, an end or done: true on one is refused, and its PC due time is kept
//   - kind ("task" | "assignment" | "note") and parentId are optional: a missing one keeps what the PC has, and a new item is a
//     task at the top level of Home. The type never changes after creation (another kind on an existing item is refused).
//     Where things may live, and the time rules (a new task needs a start and an end, a start is earlier than the end, an
//     assignment has no start, a task keeps its start), are decided by ItemRules (a refusal is 422 invalid-request)
//   - an updatedAt more than 5 minutes in the future is replaced by this PC's clock
//   - any other field in the body is ignored
//
// It knows nothing about the screen or the network. handle() takes what the main process forwards
// and returns { status, body } for the phone. The rules come from `rulesFor(items)` (the workspace module offers it
// through the registry), so this module never imports from another feature.
import { PhoneItemMapper, SYNC_KINDS } from './PhoneItemMapper.js';

export const MAX_CLOCK_SKEW = 5 * 60 * 1000;

class SyncError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const invalid = () => new SyncError(422, 'invalid-request');

export class ItemSync {
  /** @param {{store: object, rulesFor: (items: object) => object, now?: () => number, mapper?: PhoneItemMapper}} o */
  constructor({ store, rulesFor, now = Date.now, mapper = new PhoneItemMapper() }) {
    Object.assign(this, { store, rulesFor, now, mapper });
  }

  get items() { return this.store.collection('items'); }
  get rules() { return this.rulesFor(this.items); }

  /** @param {{op: 'put'|'delete', payload: object}} request  @returns {{status: number, body: object}} */
  handle({ op, payload }) {
    if (!this.store.has('items')) return { status: 503, body: { error: 'unavailable' } };
    try {
      if (op === 'put') return this.put(payload?.body);
      if (op === 'delete') return this.remove(payload?.id);
      return { status: 422, body: { error: 'invalid-request' } };
    } catch (err) {
      if (err instanceof SyncError) return { status: err.status, body: { error: err.code } };
      throw err;
    }
  }

  put(raw) {
    const body = this.mapper.parse(raw);
    if (!body) throw invalid();
    // A time too far ahead means the phone's clock is wrong: use this PC's clock instead.
    const sent = Date.parse(body.updatedAt);
    const stamp = new Date(sent > this.now() + MAX_CLOCK_SKEW ? this.now() : sent).toISOString();

    const rules = this.rules;
    const existing = this.items.get(body.id);
    if (!existing) {
      const kind = body.kind ?? 'task';
      const parentId = body.parentId ?? null;
      this.#checkContent(kind, body);
      if (rules.problem({ id: body.id, kind, parentId, deadline: body.end, start: body.start, creating: true })) throw invalid();
      if (rules.repeatProblem({ kind, deadline: body.end }, body.repeat)) throw invalid();
      const text = kind === 'note'
        ? { doc: body.doc ?? null, description: body.doc ? this.mapper.plainText(body.doc) : '' }
        : { description: body.description ?? '' };
      const item = this.items.add({
        id: body.id, kind, ...this.mapper.fields(body, kind), ...text, repeat: body.repeat ?? null, status: body.done ? 'done' : 'todo',
        completedAt: body.done ? stamp : null, parentId, createdAt: stamp, updatedAt: stamp,
      });
      return { status: 201, body: this.#view(item, 'created') };
    }
    if (!SYNC_KINDS.has(existing.kind)) throw new SyncError(422, 'not-syncable');

    if (!(Date.parse(stamp) > Date.parse(existing.updatedAt))) { // older, or equal: the PC wins (its rules are not checked: nothing changes)
      return { status: 200, body: this.#view(existing, 'kept-newer') };
    }
    // The type is fixed when an item is made: naming a different kind is refused (the same kind is fine).
    if (body.kind !== undefined && body.kind !== existing.kind) throw invalid();
    const kind = existing.kind;
    const parentId = body.parentId === undefined ? existing.parentId ?? null : body.parentId;
    this.#checkContent(kind, body);
    // The times are always sent, so they are always checked: an assignment needs a due time and no start, a start needs an
    // end, and a task that already has a start keeps it.
    if (kind === 'assignment' && !body.end) throw invalid();
    if (rules.timeProblem({ kind, start: body.start, deadline: body.end }) || rules.keepsStart(existing, body.start)) throw invalid();
    // Where it lives is checked when the phone says something about it, so a plain title edit of an old item
    // (still at the top level, say) is not refused for something the phone did not touch.
    if (body.kind !== undefined || body.parentId !== undefined) {
      if (rules.problem({ id: existing.id, kind, parentId, deadline: body.end, start: body.start })) throw invalid();
    }

    const patch = { ...this.mapper.fields(body, kind), kind, parentId };
    // An imported assignment keeps the due time its calendar gave it (ItemRules.deadlineLocked). The phone's copy of the
    // time is ignored, not refused, so a title edit from a phone that still shows an older time goes through.
    if (rules.deadlineLocked(existing)) patch.deadline = existing.deadline;
    if (kind === 'note') {
      // A note has no tick and no times on the phone: only its title, place and text change (a PC due time stays).
      if (body.doc !== undefined) Object.assign(patch, { doc: body.doc, description: this.mapper.plainText(body.doc) });
    } else {
      const status = body.done ? 'done' : (existing.status === 'doing' ? 'doing' : 'todo');
      // A rule the item can not have (an imported assignment) is ignored, not refused, like the locked due time.
      if (body.repeat !== undefined && !rules.repeatProblem({ ...existing, deadline: patch.deadline }, body.repeat)) {
        patch.repeat = body.repeat;
      }
      Object.assign(patch, {
        status,
        ...(body.description === undefined ? {} : { description: body.description }),
        completedAt: status === 'done' ? (existing.status === 'done' && existing.completedAt ? existing.completedAt : stamp) : null,
      });
    }
    this.items.update(existing.id, patch);
    existing.updatedAt = stamp; // keep the phone's edit time, so the next comparison is fair
    return { status: 200, body: this.#view(existing, 'updated') };
  }

  /** What the phone sent for the text and times of this kind of item, or 422. A note has no times and no tick. */
  #checkContent(kind, body) {
    if (kind === 'note') {
      if (body.start || body.end || body.done) throw invalid();
      if (body.doc !== undefined && !this.mapper.validDoc(body.doc)) throw invalid();
    } else if (!this.mapper.validDescription(body.description)) {
      throw invalid();
    }
  }

  remove(id) {
    if (typeof id !== 'string' || !id) throw invalid();
    const existing = this.items.get(id);
    if (!existing) return { status: 200, body: { id, deleted: true } }; // already gone: retries are safe
    if (!SYNC_KINDS.has(existing.kind)) throw new SyncError(422, 'not-syncable');
    if (this.items.all().some((i) => i.parentId === id)) { // something is filed inside it: keep it
      return { status: 200, body: { id, deleted: false, result: 'kept-has-contents' } };
    }
    this.items.remove(id);
    return { status: 200, body: { id, deleted: true } };
  }

  #view(item, result) {
    const rules = this.rules;
    return { ...this.mapper.view(item, rules.visibleParent(item), rules.tree.course(item.id)?.title ?? null), result };
  }
}
