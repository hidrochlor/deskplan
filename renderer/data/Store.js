import { Collection } from './Collection.js';
import { uid } from '../core/util.js';

export const SCHEMA_VERSION = 4;

// Kinds that are folders (the same list as ITEM_KINDS in the workspace module; kept here so the data layer stays on its own).
const FOLDER_KINDS = new Set(['folder', 'course', 'project', 'job']);

// Upgrade steps for old save files: MIGRATIONS[n] turns a version-n file into version n+1.
// Add an entry here when the saved shape changes; old files then keep working.
export const MIGRATIONS = {
  // 1 -> 2: Notes stop being a separate page. Each note becomes a "note" item on the Home canvas.
  1: (data) => {
    const { notes = [], ...rest } = data.collections;
    const moved = notes.map(({ body = '', ...note }) => ({ ...note, kind: 'note', description: body, parentId: null }));
    return { collections: { ...rest, items: [...(rest.items ?? []), ...moved] } };
  },
  // 2 -> 3: An assignment must live in a folder. Old assignments at the top level of Home (or in something that is not
  // a folder) move into one top-level folder called "Unsorted", and show "Needs a course" until moved into a course.
  // They get a new updatedAt, so the phone sees them move. meta.unsortedId remembers which folder is Unsorted.
  2: (data) => {
    const items = data.collections.items ?? [];
    const byId = new Map(items.map((i) => [i.id, i]));
    const homeless = items.filter((i) => i.kind === 'assignment' && !FOLDER_KINDS.has(byId.get(i.parentId)?.kind));
    if (!homeless.length) return {};
    const now = new Date().toISOString();
    let unsorted = items.find((i) => i.id === data.meta?.unsortedId && FOLDER_KINDS.has(i.kind));
    const added = [];
    if (!unsorted) {
      unsorted = { id: uid(), kind: 'folder', title: 'Unsorted', parentId: null, status: 'todo', description: '', createdAt: now, updatedAt: now };
      added.push(unsorted);
    }
    const moved = homeless.map((i) => ({ ...i, parentId: unsorted.id, updatedAt: now }));
    const movedIds = new Set(moved.map((i) => i.id));
    return {
      meta: { ...data.meta, unsortedId: unsorted.id },
      collections: { ...data.collections, items: [...items.filter((i) => !movedIds.has(i.id)), ...moved, ...added] },
    };
  },
  // 3 -> 4: The Received files page stops being called "inbox" inside DeskPlan. Its list moves to the
  // "receivedFiles" collection, its destination id becomes "received-files", and a last-open page of "inbox" follows.
  3: (data) => {
    const { inbox, ...rest } = data.collections;
    if (!inbox && data.meta?.ui?.view !== 'inbox') return {};
    const renamed = (inbox ?? []).map((r) => (r.destination === 'inbox' ? { ...r, destination: 'received-files' } : r));
    const ui = data.meta?.ui?.view === 'inbox' ? { ...data.meta.ui, view: 'receivedFiles' } : data.meta?.ui;
    return {
      meta: ui ? { ...data.meta, ui } : data.meta,
      collections: inbox ? { ...rest, receivedFiles: [...(rest.receivedFiles ?? []), ...renamed] } : data.collections,
    };
  },
};

export function migrate(raw) {
  if (!raw || typeof raw !== 'object') {
    return { version: SCHEMA_VERSION, meta: {}, collections: {} };
  }
  const data = { version: raw.version ?? 1, meta: raw.meta ?? {}, collections: raw.collections ?? {} };
  while (data.version < SCHEMA_VERSION) {
    const step = MIGRATIONS[data.version];
    if (!step) throw new Error(`No migration from data version ${data.version}`);
    Object.assign(data, step(data));
    data.version += 1;
  }
  return data;
}

// Owns all collections plus a small "meta" bag (UI state, reminder log).
// Saves itself shortly after any change.
export class Store {
  constructor({ bus, storage, saveDelay = 400 }) {
    this.bus = bus;
    this.storage = storage;
    this.saveDelay = saveDelay;
    this.collections = new Map();
    this.meta = {};
    this._unclaimed = {};   // saved collections whose module isn't installed: kept untouched
    this._version = SCHEMA_VERSION;
    this._timer = null;
    bus.on('data:changed', () => this.scheduleSave());
  }

  /** Called by a module's install() to claim a collection name. */
  define(name, Model) {
    const collection = new Collection(name, Model, this.bus);
    this.collections.set(name, collection);
    return collection;
  }

  collection(name) {
    const c = this.collections.get(name);
    if (!c) throw new Error(`Unknown collection "${name}". Is its module installed?`);
    return c;
  }

  has(name) { return this.collections.has(name); }

  async load() {
    const data = migrate(await this.storage.load());
    this._version = Math.max(data.version, SCHEMA_VERSION); // never downgrade a newer file
    this.meta = data.meta;
    this._unclaimed = {};
    for (const [name, rows] of Object.entries(data.collections)) {
      if (this.collections.has(name)) this.collections.get(name).load(rows);
      else this._unclaimed[name] = rows;
    }
  }

  toJSON() {
    const collections = { ...this._unclaimed };
    for (const [name, c] of this.collections) collections[name] = c.toJSON();
    return { version: this._version, meta: this.meta, collections };
  }

  /** Call after changing this.meta directly. */
  touchMeta() { this.scheduleSave(); }

  scheduleSave() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), this.saveDelay);
  }

  async saveNow() {
    clearTimeout(this._timer);
    this._timer = null;
    try {
      await this.storage.save(this.toJSON());
    } catch (err) {
      console.error('[store] save failed', err);
    }
  }

  /** Write immediately and synchronously. For window close. */
  flushSync() {
    if (this._timer === null) return;
    clearTimeout(this._timer);
    this._timer = null;
    try {
      this.storage.saveSync?.(this.toJSON());
    } catch (err) {
      console.error('[store] final save failed', err);
    }
  }
}
