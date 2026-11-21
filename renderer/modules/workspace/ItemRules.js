import { ITEM_KINDS } from './Item.js';
import { readRepeat } from './Repeats.js';

// The rules for tasks and assignments. One place, used by the phone sync (answers 422), the + menu, drag and drop,
// the editor and the calendar's add form, so the PC and the phone can never disagree.
//
//   the type is fixed when an item is created (an item never changes kind)
//   task         a time block: a start AND an end, always given when it is made. May sit at Home, in a folder, or in an
//                assignment (then it is a "step"). It holds nothing.
//   assignment   a deadline only (no start). Must sit in a folder and must have a due time.
//   folder       holds anything, but never goes inside an assignment (an assignment holds tasks, notes and files only)
//   a parent     must exist, and can not be the item itself or something inside it
//   imported     an assignment imported from Moodle keeps Moodle's due time: it follows Moodle, never the PC or the phone
//   repeat       only a task or assignment with a due time repeats, and never an imported one (see Repeats.js)
//
// "A folder" means an item of a folder kind (folder, and the old course / project / job).
// Old data is not touched: a task made before this rule may have only a due time, and stays valid until its times are edited.
const isFolderKind = (kind) => !!ITEM_KINDS[kind]?.folder;

export class ItemRules {
  /** Get one with `new ItemTree(items).rules`. @param {import('../../data/Collection.js').Collection} items @param {import('./ItemTree.js').ItemTree} tree */
  constructor(items, tree) {
    this.items = items;
    this.tree = tree;
  }

  /** A task that sits inside an assignment. */
  isStep(item) {
    return item.kind === 'task' && this.items.get(item.parentId)?.kind === 'assignment';
  }

  /** Can something of kind `child` sit directly inside something of kind `parent` (null = Home)? Only folders and assignments hold things. */
  holds(parent, child) {
    if (parent === null) return child !== 'assignment';
    if (isFolderKind(parent)) return true;
    if (parent === 'assignment') return child === 'task' || child === 'note' || child === 'file';
    return false;
  }

  /**
   * Why this combination is not allowed, or null if it is fine. parentId null = Home.
   * `creating` is true for a brand-new item: a new task must come with its start and end.
   * @param {{id?: string, kind: string, parentId: string|null, deadline: string|null, start?: string|null, creating?: boolean}} want
   */
  problem({ id = null, kind, parentId, deadline, start = null, creating = false }) {
    const timing = this.timeProblem({ kind, start, deadline });
    if (timing) return timing;
    if (creating && kind === 'task' && (!start || !deadline)) return 'A task needs a start and an end.';
    const parent = parentId ? this.items.get(parentId) : null;
    if (parentId && !parent) return 'The parent does not exist.';
    if (id && parent && (parent.id === id || this.tree.descendants(id).some((d) => d.id === parent.id))) {
      return 'An item cannot go inside itself.';
    }
    if (kind === 'assignment') {
      if (!parent) return 'An assignment must be in a folder, not at the top level of Home.';
      if (!isFolderKind(parent.kind)) return 'An assignment must be in a folder.';
      if (!deadline) return 'An assignment needs a due time.';
      return null;
    }
    if (parent && !this.holds(parent.kind, kind)) {
      return kind === 'task' ? 'A task can only be at Home, in a folder or in an assignment.' : 'That item cannot go there.';
    }
    return this.holds(null, kind) ? null : 'That item cannot go there.';
  }

  /**
   * Why this start / deadline pair is not allowed, or null. Only a task can have a start (a time block); an assignment is
   * only ever due at one time. A start needs a deadline and must be earlier than it.
   */
  timeProblem({ kind, start = null, deadline = null }) {
    if (!start) return null;
    if (kind === 'assignment') return 'An assignment has a due time only, no start.';
    if (kind !== 'task') return 'Only a task can have a start.';
    if (!deadline) return 'A start needs an end time.';
    const from = Date.parse(start);
    const to = Date.parse(deadline);
    if (Number.isNaN(from) || Number.isNaN(to)) return 'The times are not valid.';
    return from < to ? null : 'The start must be earlier than the end.';
  }

  /**
   * Why this item's due time can not be changed by hand, or null. An assignment imported from a calendar feed (it has a
   * `source`) is due when Moodle says: a copy that drifted would hide a real change. Own time is planned with steps.
   */
  deadlineLocked(item) {
    return item?.kind === 'assignment' && item.source ? `${item.source.label || 'The calendar'} sets this due date.` : null;
  }

  /** Why this item can not have this repeat rule (null = no repeat, always fine), or null. */
  repeatProblem({ kind, deadline = null, source = null }, repeat) {
    if (repeat === null || repeat === undefined) return null;
    if (readRepeat(repeat) === undefined) return 'That is not a repeat rule.';
    if (kind !== 'task' && kind !== 'assignment') return 'Only a task or an assignment can repeat.';
    if (source) return `${source.label || 'The calendar'} sets this due date: it can not repeat.`;
    return deadline ? null : 'A repeating item needs a due time.';
  }

  /** A task that already has a start keeps one: it is a time block for good. Returns the reason, or null. */
  keepsStart(item, start) {
    return item.kind === 'task' && item.startDate && !start ? 'A task keeps its start and end.' : null;
  }

  /**
   * The parent as the phone sees it: the item's own parent if it may sit there, otherwise the nearest folder (or, for a
   * task, assignment) above it, otherwise null. Old data can hold a task inside a task; the phone never sees that.
   */
  visibleParent(item) {
    const seen = new Set([item.id]);
    for (let id = this.tree.parentOf(item); id && !seen.has(id); id = this.tree.parentOf(this.items.get(id))) {
      seen.add(id);
      const parent = this.items.get(id);
      if ((isFolderKind(parent.kind) || parent.kind === 'assignment') && this.holds(parent.kind, item.kind)) return id;
    }
    return null;
  }
}
