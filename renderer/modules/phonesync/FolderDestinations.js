// Lets the phone send a file straight into one of DeskPlan's folders (for example "CSC101").
//
// It plays two parts, both through the registry kind 'destination':
//   list() / has()   tell the receiver which folders exist, so the phone can offer them and the PC can
//                    refuse an upload to a folder that was deleted
//   accept(record)   puts a received file inside the folder as a normal file item, the same as dropping
//                    the file on the folder in DeskPlan
// The received file first lands in the Received files folder like any other. accept() then moves it into DeskPlan's
// files area (the main process does the move) and adds the file item. If anything about that fails, it
// returns false and the file simply stays in Received files, so nothing is ever lost.
//
// Folders are found the way the Home canvas finds them: items of a folder kind, or anything with things inside.
const FOLDER_KINDS = new Set(['folder', 'course', 'project', 'job']);
const PREFIX = 'folder:';

export class FolderDestinations {
  /**
   * @param {{store: object, bus: object, attach: (storedAs: string, uploadId: string) => Promise<object>}} o
   *   attach = ask the main process to move a received file into DeskPlan's files area
   */
  constructor({ store, bus, attach }) {
    this.id = 'folders';
    Object.assign(this, { store, bus, attach });
  }

  get items() { return this.store.has('items') ? this.store.collection('items') : null; }

  /** @returns {{id: string, label: string, name: string, depth: number}[]}  label = full path, e.g. "CSC101 › Week 1" */
  list() {
    const items = this.items;
    if (!items) return [];
    return items.all()
      .filter((i) => this.#isFolder(i))
      .map((f) => {
        const chain = this.#chain(f);
        return { id: PREFIX + f.id, label: chain.map((x) => x.title || 'Untitled').join(' › '), name: f.title || 'Untitled', depth: chain.length - 1 };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  has(destination) {
    if (typeof destination !== 'string' || !destination.startsWith(PREFIX)) return false;
    const folder = this.items?.get(destination.slice(PREFIX.length));
    return !!folder && this.#isFolder(folder);
  }

  /** @returns {Promise<boolean>} true when the file now lives in the folder (and must not also be listed in Received files) */
  async accept(record) {
    if (!this.has(record.destination)) return false;
    const folderId = record.destination.slice(PREFIX.length);
    try {
      const file = await this.attach(record.storedAs, record.uploadId);
      const items = this.items;
      // Already filed (this upload is being handled again after a restart): do not add it twice.
      if (!items.all().some((i) => i.kind === 'file' && i.file?.path === file.path)) {
        items.add({ title: file.name, kind: 'file', parentId: folderId, file });
      }
      this.bus.emit('toast:show', {
        id: `filed-${record.uploadId}`, title: `${file.name} added`,
        text: `Saved in ${items.get(folderId).title || 'Untitled'}, from ${record.deviceName || 'your phone'}.`, timeout: 4000,
      });
      return true;
    } catch (err) {
      console.error('[phonesync] could not file the received file in its folder, leaving it in Received files', err);
      return false;
    }
  }

  #isFolder(item) {
    if (item.kind === 'file') return false;
    return FOLDER_KINDS.has(item.kind) || this.items.all().some((i) => i.parentId === item.id);
  }

  /** The folder and the folders above it, top level first. Stops at a missing parent or a loop. */
  #chain(folder) {
    const chain = [folder];
    const seen = new Set([folder.id]);
    for (let cur = folder; cur.parentId && !seen.has(cur.parentId);) {
      const parent = this.items.get(cur.parentId);
      if (!parent) break;
      seen.add(parent.id);
      chain.unshift(parent);
      cur = parent;
    }
    return chain;
  }
}
