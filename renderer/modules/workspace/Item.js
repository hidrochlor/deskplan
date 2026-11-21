import { Entity } from '../../data/Entity.js';
import { checklistStats } from './editor/NoteFormat.js';

// Everything in the workspace is an Item. Its kind decides how it looks and behaves:
//   folder      shows as a card and holds other items
//   actionable  has a done checkbox and a status
//   note        opens as a full page for writing
//   file        a copied file or photo
// Any kind except files can carry a deadline.
//   internal  never offered in a picker (files are made by "Files & photos")
//   legacy    no longer offered, but old items of this kind still load and work
export const ITEM_KINDS = {
  folder: { label: 'Folder', color: '#f5b84b', folder: true },
  note: { label: 'Note', color: '#e6c86e', note: true },
  task: { label: 'Task', color: '#7c8cff', actionable: true },
  assignment: { label: 'Assignment', color: '#ff7a8a', actionable: true },
  file: { label: 'File', color: '#8b90a3', file: true, internal: true },
  course: { label: 'Course', color: '#ff9f5a', folder: true, legacy: true },
  project: { label: 'Project', color: '#b57cff', folder: true, legacy: true },
  job: { label: 'Job', color: '#4cc9a4', folder: true, legacy: true },
  reading: { label: 'Reading', color: '#5cb8ff', actionable: true, legacy: true },
};

export const ITEM_STATUSES = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);

export class Item extends Entity {
  static defaults() {
    return {
      id: '',
      title: '',
      kind: 'task',
      status: 'todo',
      description: '',     // details, or a note's text as plain text (previews, word count)
      doc: null,           // notes: the formatted text (Tiptap JSON, see editor/NoteFormat.js)
      parentId: null,      // id of the folder this sits in, null = top level
      deadline: null,      // ISO string or null
      start: null,         // optional start (ISO UTC or null). With a deadline it makes a time block (start to deadline); see ItemRules
      file: null,          // files only: { name, path, size, ext }  (path is relative to the app's files folder)
      source: null,        // imported from a calendar feed: { label, uid, title, deadline } as last imported (see modules/feeds/)
      repeat: null,        // tasks and assignments: { every: 'day'|'week'|'month', interval, until } (see Repeats.js)
      completedAt: null,
      createdAt: '',
      updatedAt: '',
    };
  }

  /** The changes to apply when moving an item to a status. */
  static statusPatch(status) {
    return { status, completedAt: status === 'done' ? new Date().toISOString() : null };
  }

  get isDone() { return this.status === 'done'; }

  get kindInfo() { return ITEM_KINDS[this.kind] ?? ITEM_KINDS.task; }

  /** Folder by kind. ItemTree.isFolder also counts anything that already has children. */
  get isFolderKind() { return !!this.kindInfo.folder; }
  get isActionable() { return !!this.kindInfo.actionable; }
  get isNote() { return !!this.kindInfo.note; }
  get isFile() { return !!this.kindInfo.file; }
  get isImage() { return this.isFile && IMAGE_EXT.has(this.file?.ext ?? ''); }

  /** Ticked / total checklist items in a note: { done, total }. */
  get checklist() { return checklistStats(this.doc); }

  /** The text without list / checkbox / heading markers ("- ", "[x] ", "# "). */
  get bareText() {
    return this.description.replace(/^[ \t]*(?:[-*•] |\[[ xX]?\] ?|#{1,6} )/gm, '');
  }

  get wordCount() {
    const text = this.bareText.trim();
    return text ? text.split(/\s+/).length : 0;
  }

  get preview() {
    return this.bareText.replace(/\s+/g, ' ').trim().slice(0, 140);
  }

  get deadlineDate() {
    if (!this.deadline || this.isFile) return null;
    const d = new Date(this.deadline);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  get startDate() {
    if (!this.start || this.isFile) return null;
    const d = new Date(this.start);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** A time block runs from `start` to `deadline`; without a start it is just due at the deadline. The shape is the fields, not a kind. */
  get isBlock() { return !!this.startDate && !!this.deadlineDate && this.startDate < this.deadlineDate; }
}
