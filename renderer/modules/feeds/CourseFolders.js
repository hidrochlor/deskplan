// Where an imported assignment goes. A folder is made only when a course actually has an assignment, and courses
// are grouped under one folder per semester:  WS 2026 › Climate Change and Dynamics
//   1. a folder made for this course before (remembered by id, so renaming it does not make a second one)
//   2. any folder of the user's with the same name as the course (open ones first)
//   3. a new "<semester> › <course>" folder (the course at the top level of Home if the semester is unknown)
// With filing switched off (Settings › Data), or no course at all, everything goes into Unsorted ("Needs a course").
// Ids are remembered in store.meta.feedFolders: { "<semester>|<course>": folderId, "semester|<semester>": folderId }.
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export class CourseFolders {
  constructor({ store, settings }) {
    this.store = store;
    this.settings = settings;
  }

  get items() { return this.store.collection('items'); }
  get memo() { return (this.store.meta.feedFolders ??= {}); }

  /** @param {{course: string, semester: string}} o  @returns {string} the folder's id */
  folderFor({ course, semester }) {
    if (this.settings?.get('feedFiling') === false || !norm(course)) return this.unsorted();
    const key = `${semester}|${norm(course)}`;
    const known = this.#folder(this.memo[key]);
    if (known) return known.id;

    const same = this.#folders().filter((f) => norm(f.title) === norm(course)).sort((a, b) => Number(a.isDone) - Number(b.isDone))[0];
    const folder = same ?? this.items.add({ kind: 'folder', title: course, parentId: semester ? this.#semester(semester) : null });
    return this.#remember(key, folder.id);
  }

  /** The Unsorted folder that migration 2 introduced (see data/Store.js), made now if there is none. */
  unsorted() {
    const known = this.#folder(this.store.meta.unsortedId);
    if (known) return known.id;
    const folder = this.items.add({ kind: 'folder', title: 'Unsorted', parentId: null });
    this.store.meta.unsortedId = folder.id;
    this.store.touchMeta();
    return folder.id;
  }

  #semester(semester) {
    const key = `semester|${semester}`;
    const known = this.#folder(this.memo[key]);
    if (known) return known.id;
    const same = this.#folders().find((f) => !f.parentId && norm(f.title) === norm(semester));
    return this.#remember(key, (same ?? this.items.add({ kind: 'folder', title: semester, parentId: null })).id);
  }

  #remember(key, id) {
    this.memo[key] = id;
    this.store.touchMeta();
    return id;
  }

  #folders() { return this.items.all().filter((i) => i.isFolderKind); }

  #folder(id) {
    const item = id ? this.items.get(id) : null;
    return item?.isFolderKind ? item : null;
  }
}
