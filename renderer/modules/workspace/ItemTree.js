import { ItemRules } from './ItemRules.js';

// Folder structure over the items collection (items point to their folder via parentId).
// Items whose folder no longer exists are treated as top level, so nothing is ever lost.
// An assignment holds its steps (tasks), so it counts as a folder here too; the canvas still draws it as a row.
// A folder named like a semester (the calendar feeds make these, see feeds/feedMappers.js semesterOf).
export const SEMESTER = /^(WS|SS)\s?\d{4}$/i;

export class ItemTree {
  constructor(items) {
    this.items = items;
    this.rules = new ItemRules(items, this); // where things may live (see ItemRules.js)
  }

  /** The folder an item really sits in: its parentId if that item exists, else null. */
  parentOf(item) {
    return item.parentId && this.items.get(item.parentId) ? item.parentId : null;
  }

  children(folderId = null) {
    return this.items.all().filter((i) => this.parentOf(i) === (folderId ?? null));
  }

  hasChildren(id) {
    return this.items.all().some((i) => i.parentId === id);
  }

  isFolder(item) {
    return item.isFolderKind || item.kind === 'assignment' || this.hasChildren(item.id);
  }

  /**
   * The course an item belongs to: the top-level folder of its path (null at the top level of Home). When that folder
   * is a semester ("WS 2026", "SS 2027": imported Moodle assignments are filed in "<semester> › <course>"), the folder
   * inside it is the course. The phone gets this as `course` (docs/protocol.md section 4).
   */
  course(id) {
    const [top, next] = this.path(id);
    return top && next && SEMESTER.test(top.title ?? '') ? next : top ?? null;
  }

  /** An assignment still sitting in the "Unsorted" folder (store.meta.unsortedId) has no course yet. */
  needsCourse(item, unsortedId) {
    return !!unsortedId && item.kind === 'assignment' && this.course(item.id)?.id === unsortedId;
  }

  /** The steps of an assignment: the tasks directly inside it. */
  steps(id) {
    return this.children(id).filter((i) => i.kind === 'task');
  }

  /** Progress of an assignment: finished steps out of all steps. */
  progress(id) {
    const steps = this.steps(id);
    return { done: steps.filter((s) => s.isDone).length, total: steps.length };
  }

  /** Folders above the item, top level first. */
  path(id) {
    const out = [];
    const seen = new Set([id]);
    let cur = this.items.get(id);
    while (cur) {
      const pid = this.parentOf(cur);
      if (!pid || seen.has(pid)) break;
      seen.add(pid);
      cur = this.items.get(pid);
      out.unshift(cur);
    }
    return out;
  }

  /** Everything inside a folder, at any depth. */
  descendants(id) {
    const out = [];
    const queue = [id];
    const seen = new Set(queue);
    while (queue.length) {
      for (const child of this.children(queue.shift())) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        queue.push(child.id);
      }
    }
    return out;
  }

  /** Folders as { id, label } with their full path ("CSC101 › Week 1"), A–Z. Skips one item and everything in it. */
  folderOptions({ excludeId = null, openOnly = false } = {}) {
    const hidden = excludeId ? new Set([excludeId, ...this.descendants(excludeId).map((d) => d.id)]) : new Set();
    const label = (f) => [...this.path(f.id), f].map((x) => x.title || 'Untitled').join(' › ');
    return this.items.all()
      .filter((i) => this.isFolder(i) && !hidden.has(i.id) && !(openOnly && i.isDone))
      .map((f) => ({ id: f.id, label: label(f) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Can this item go into that folder (null = Home)? Not into a non-folder, itself, its own contents, or where it already is. */
  canMove(id, targetId = null) {
    const item = this.items.get(id);
    if (!item) return false;
    if (targetId) {
      const target = this.items.get(targetId);
      if (!target || !this.isFolder(target)) return false;
      if (targetId === id || this.descendants(id).some((d) => d.id === targetId)) return false;
    }
    if (this.rules.problem({ id, kind: item.kind, parentId: targetId ?? null, deadline: item.deadline })) return false;
    return (targetId ?? null) !== this.parentOf(item);
  }

  /** Move an item (with everything inside it) into a folder. Returns whether it moved. */
  move(id, targetId = null) {
    if (!this.canMove(id, targetId)) return false;
    this.items.update(id, { parentId: targetId ?? null });
    return true;
  }

  /** Delete an item and everything inside it. Returns what was removed (e.g. to clean up files). */
  removeTree(id) {
    const self = this.items.get(id);
    const removed = this.descendants(id).reverse();
    for (const d of removed) this.items.remove(d.id);
    if (self) { this.items.remove(id); removed.push(self); }
    return removed;
  }

  /** Counts and the nearest open deadline for a folder card (includes the folder's own deadline). */
  summary(id) {
    const all = this.descendants(id);
    // Progress counts things to do, not notes or files. A step counts through its assignment, not on its own.
    const inside = all.filter((i) => i.isActionable && !this.rules.isStep(i));
    const done = inside.filter((i) => i.isDone).length;
    const self = this.items.get(id);
    const next = [self, ...all]
      .filter((i) => i && !i.isDone && i.deadlineDate)
      .sort((a, b) => a.deadlineDate - b.deadlineDate)[0] ?? null;
    return { total: inside.length, done, open: inside.length - done, items: all.length, next };
  }
}
