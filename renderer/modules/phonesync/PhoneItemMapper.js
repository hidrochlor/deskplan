import { readRepeat } from '../workspace/Repeats.js';

// The one place that knows how the phone's words map onto DeskPlan's item fields (docs/protocol.md, section 4):
//   phone start      = item start        (a time block runs from start to end)
//   phone end        = item deadline     (an item with only an end is a deadline item)
//   phone done       = item status       (decided by the caller: it needs the item's current status)
//   phone kind, parentId, description    same names
//   phone doc        = item doc          (notes only: the formatted text, Tiptap JSON)
//   phone repeat     = item repeat       (tasks and assignments: { every, interval, until } or null; see workspace/Repeats.js)
// A note has no times on the phone: it is always sent with start and end null, and a due time set on the PC stays
// on the PC (the phone can not change it).
// It reads what the phone sent (parse), says which item fields that sets (fields), and builds what the phone is shown
// (view). It knows nothing about rules (ItemRules), conflicts (ItemSync) or the network.
export const SYNC_KINDS = new Set(['task', 'assignment', 'note']);
export const DEFAULT_PULL_KINDS = ['task', 'assignment']; // a phone that does not ask for notes never sees one
export const MAX_TITLE = 500;
export const MAX_DESCRIPTION = 16000; // characters, for a task's or assignment's details (a note's text is in doc)
export const MAX_DOC_DEPTH = 50;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i; // a time without a zone is the phone's "local time" bug: refuse it
const ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

export class PhoneItemMapper {
  /**
   * @param {{noteText?: {toPlainText: (doc: object) => string, fromPlainText: (text: string) => object}|null}} [o]
   *   how a note's formatted text becomes plain text and back (the workspace offers it as 'noteFormat')
   */
  constructor({ noteText = null } = {}) {
    this.noteText = noteText;
  }

  /**
   * The phone's body as plain values, or null when it is malformed.
   * `kind`, `parentId`, `description`, `doc` and `repeat` are undefined when left out ("keep what the PC has"); parentId null = top level of Home.
   * `start` and `end` are UTC text or null. `description` and `doc` are checked once the kind is known (validDescription,
   * validDoc): a note ignores `description` and the others ignore `doc`. Any other field is ignored.
   */
  parse(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const { id, title, start = null, end = null, done, updatedAt } = raw;
    if (typeof id !== 'string' || !id || id.length > 64) return null;
    if (typeof title !== 'string' || title.length > MAX_TITLE) return null;
    if (typeof done !== 'boolean') return null;
    if (raw.kind !== undefined && !SYNC_KINDS.has(raw.kind)) return null;
    if (raw.parentId !== undefined && raw.parentId !== null && !(typeof raw.parentId === 'string' && ID_SHAPE.test(raw.parentId))) return null;
    const repeat = raw.repeat === undefined ? undefined : readRepeat(raw.repeat);
    if (raw.repeat !== undefined && repeat === undefined) return null;

    const times = { start: this.time(start), end: this.time(end), updatedAt: this.time(updatedAt, false) };
    if (Object.values(times).some((t) => t === undefined)) return null;
    return { id, title, done, ...times, kind: raw.kind, parentId: raw.parentId, description: raw.description, doc: raw.doc, repeat };
  }

  /** The item fields a parsed body sets (the names differ: phone end is the deadline). A note sets only its title here. */
  fields(body, kind) {
    if (kind === 'note') return { title: body.title };
    return { title: body.title, start: body.start, deadline: body.end };
  }

  /** A task's or assignment's details: left out, or text of at most MAX_DESCRIPTION characters. */
  validDescription(description) {
    return description === undefined || (typeof description === 'string' && description.length <= MAX_DESCRIPTION);
  }

  /**
   * Is this a note text the PC will store? Only the shape is checked (docs/protocol.md "Note text"): node types it does not
   * know are fine and kept as they are.
   */
  validDoc(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.type !== 'doc' || !Array.isArray(doc.content)) return false;
    const node = (n, depth) => {
      if (depth > MAX_DOC_DEPTH || !n || typeof n !== 'object' || Array.isArray(n) || typeof n.type !== 'string') return false;
      if (n.text !== undefined && typeof n.text !== 'string') return false;
      if (n.marks !== undefined && !(Array.isArray(n.marks) && n.marks.every((m) => m && typeof m === 'object' && typeof m.type === 'string'))) return false;
      if (n.content === undefined) return true;
      return Array.isArray(n.content) && n.content.every((c) => node(c, depth + 1));
    };
    return doc.content.every((c) => node(c, 2));
  }

  /** A note's plain text, made from its formatted text (previews and search on the PC). */
  plainText(doc) {
    return this.noteText ? this.noteText.toPlainText(doc) : '';
  }

  /**
   * An item as the phone knows it. The same shape in every answer (the PUT reply adds "result").
   * `parentId` is what the phone should show: pass ItemRules.visibleParent(item). `course` is the course's name
   * (ItemTree.course), or null. `source` says the item was imported from a calendar feed (its due time is the feed's).
   */
  view(item, parentId = item.parentId ?? null, course = null) {
    const view = {
      id: item.id, title: item.title, start: item.start ?? null, end: item.deadline ?? null,
      done: item.status === 'done', updatedAt: item.updatedAt, kind: item.kind, parentId,
      createdAt: item.createdAt || null, description: item.description ?? '',
      course, source: item.source ? { label: String(item.source.label ?? '') } : null, repeat: item.repeat ?? null,
    };
    if (item.kind !== 'note') return view;
    // A note saved before the rich editor has only plain text: send it as formatted text, so the phone reads one format.
    const doc = item.doc ?? (this.noteText ? this.noteText.fromPlainText(item.description ?? '') : { type: 'doc', content: [{ type: 'paragraph' }] });
    return { ...view, start: null, end: null, done: false, repeat: null, doc };
  }

  /** UTC (or offset) ISO text -> normalised UTC text. null is fine when allowed. Returns undefined for a bad value. */
  time(value, nullable = true) {
    if (value === null && nullable) return null;
    if (typeof value !== 'string' || !HAS_ZONE.test(value) || Number.isNaN(Date.parse(value))) return undefined;
    return new Date(value).toISOString();
  }
}
