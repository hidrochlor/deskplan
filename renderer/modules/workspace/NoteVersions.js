// Keeps the open note page from writing over a change made on the phone (docs/protocol.md section 4, "Same item
// edited on both devices"). No DOM, so it is easy to test.
//
// The page tells it about every change to the note. A change whose `doc` is not the last one this page saved came from
// somewhere else (the phone sync replaces `doc` with a new object):
//   - nothing typed here since the last save: the page shows the new text ('reload')
//   - typing here not saved yet: the phone's text stays in the note, and from now on this page's saves go into a new
//     note "<title> (PC copy)" until the user reloads ('conflict'). Neither side's text is ever lost.
export const COPY_SUFFIX = ' (PC copy)';
const MAX_TITLE = 500;

export class NoteVersions {
  /** @param {import('../../data/Collection.js').Collection} items  @param {string} id */
  constructor(items, id) {
    this.items = items;
    this.id = id;
    this.last = items.get(id)?.doc ?? null; // the doc this page last saw or saved
    this.waiting = false;                    // a phone change is waiting for the user to reload
    this.copyId = null;
  }

  /** Call on every change to this note. dirty = the editor has unsaved typing. @returns {'none'|'reload'|'conflict'} */
  changed(dirty) {
    const note = this.items.get(this.id);
    if (!note || note.doc === this.last) return 'none'; // our own save, or only the title or place changed
    this.last = note.doc;
    if (!dirty && !this.waiting) return 'reload';
    this.waiting = true;
    return 'conflict';
  }

  /**
   * Where the editor's text goes: the note itself, or (while a phone change waits) its PC copy, made on the first save.
   * @returns {string} the id to save into
   */
  target(doc) {
    if (!this.waiting) { this.last = doc; return this.id; }
    if (this.copyId && this.items.get(this.copyId)) return this.copyId;
    const note = this.items.get(this.id);
    const title = (note?.title || 'Untitled').slice(0, MAX_TITLE - COPY_SUFFIX.length) + COPY_SUFFIX;
    this.copyId = this.items.add({ kind: 'note', title, parentId: note?.parentId ?? null, doc: null, description: '' }).id;
    return this.copyId;
  }

  /** The user chose to see the phone's text: later saves go to the note again. @returns {object|null} the note's doc */
  reload() {
    this.waiting = false;
    this.copyId = null;
    this.last = this.items.get(this.id)?.doc ?? null;
    return this.last;
  }
}
