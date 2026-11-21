import { DAY } from '../../core/dates.js';

// Turns Moodle due dates into real assignment items, so they get a done box, notes, files, phone sync and the usual
// deadline reminders. Each one is matched to its item by Moodle's event uid (store.meta.feedImports: uid -> item id).
//
//   new uid             a new assignment in its course folder (CourseFolders); due dates long past are skipped
//   known uid           the due time always follows Moodle (it can not be edited: ItemRules.deadlineLocked); title and
//                       details follow too, but only while the user has not changed them
//   item deleted        hidden: not added again by a refresh. restore() brings it back while the feed still has it
//   gone from the feed  the item stays. Moodle's export only covers a window of time, so past deadlines drop out.
// It never moves an item: once filed, where it lives is up to the user.
const STALE = DAY; // a due date more than a day old when first seen is history from before DeskPlan knew about it

export class AssignmentImporter {
  /** @param {{store: object, folders: import('./CourseFolders.js').CourseFolders, now?: () => number}} o */
  constructor({ store, folders, now = Date.now }) {
    this.store = store;
    this.folders = folders;
    this.now = now;
  }

  get items() { return this.store.collection('items'); }
  get imports() { return (this.store.meta.feedImports ??= {}); }

  /**
   * @param {{name: string}} feed
   * @param {Array<{uid: string, start: string, mapped: {title: string, course: string, semester: string, description: string}}>} deadlines
   * @param {{force?: boolean}} [o]  force: import even when long past (the user asked for it, see restore)
   * @returns {{added: number, updated: number}}
   */
  import(feed, deadlines, { force = false } = {}) {
    const imports = this.imports;
    let added = 0;
    let updated = 0;
    for (const { uid, start, mapped } of deadlines) {
      const deadline = new Date(start).toISOString();
      const fresh = { label: feed.name, uid, title: mapped.title, deadline, description: mapped.description };
      if (uid in imports) {
        const item = this.items.get(imports[uid]);
        if (item && this.#follow(item, fresh)) updated++;
        continue;
      }
      if (!force && Date.parse(deadline) < this.now() - STALE) continue;
      const item = this.items.add({
        kind: 'assignment', title: fresh.title, description: fresh.description, deadline,
        parentId: this.folders.folderFor(mapped), source: fresh,
      });
      imports[uid] = item.id;
      added++;
    }
    if (added) this.store.touchMeta();
    return { added, updated };
  }

  /** The due dates in this download whose assignment the user deleted. */
  hidden(deadlines) {
    const imports = this.imports;
    return deadlines.filter((d) => d.uid in imports && !this.items.get(imports[d.uid]));
  }

  /** Bring back the deleted ones, in their course folders (made again if those were deleted too). @returns {number} how many */
  restore(feed, deadlines) {
    const back = this.hidden(deadlines);
    for (const d of back) delete this.imports[d.uid];
    return this.import(feed, back, { force: true }).added;
  }

  /** Apply Moodle's changes. The due time always; title and details only when the user left them as imported. True when anything changed. */
  #follow(item, fresh) {
    const was = item.source ?? {};
    const patch = {};
    if (item.deadline !== fresh.deadline) patch.deadline = fresh.deadline; // also repairs a time edited before it was locked
    for (const field of ['title', 'description']) {
      if (fresh[field] !== was[field] && item[field] === was[field]) patch[field] = fresh[field];
    }
    const sourceChanged = ['label', 'title', 'deadline', 'description'].some((f) => fresh[f] !== was[f]);
    if (!sourceChanged && !('deadline' in patch)) return false;
    this.items.update(item.id, { ...patch, source: { ...was, ...fresh } });
    return true;
  }
}
