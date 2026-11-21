// Files and photos inside folders. The main process copies each added file into the
// app's own files folder; an Item of kind "file" points at the copy.
// Without the Electron bridge (plain browser, tests) everything here is a safe no-op.
export class Attachments {
  constructor(api = globalThis.window?.api?.files ?? null) {
    this.api = api;
  }

  get available() { return !!this.api; }

  /** Show the file picker. Returns the chosen paths. */
  async pick() {
    return this.available ? this.api.pick() : [];
  }

  /** Paths of files dropped on the window (from a DataTransfer). */
  pathsFromDrop(dataTransfer) {
    if (!this.available) return [];
    return [...(dataTransfer?.files ?? [])].map((f) => this.api.pathOf(f)).filter(Boolean);
  }

  /** Copy files in and create one item per file inside the folder. Returns the new items. */
  async addTo(items, parentId, paths) {
    if (!this.available || !paths.length) return [];
    const copied = await this.api.import(paths);
    return copied.map((file) => items.add({ title: file.name, kind: 'file', parentId, file }));
  }

  url(item) {
    const rel = item.file?.path;
    if (!rel) return null;
    return `deskplan-file://files/${rel.split('/').map(encodeURIComponent).join('/')}`;
  }

  open(item) { if (this.available && item.file) this.api.open(item.file.path); }
  reveal(item) { if (this.available && item.file) this.api.reveal(item.file.path); }

  /** Delete the stored copies for items that were removed. */
  forget(removedItems) {
    if (!this.available) return;
    for (const item of removedItems) {
      if (item.isFile && item.file) {
        this.api.delete(item.file.path).catch((err) => console.error('[files] delete failed', err));
      }
    }
  }
}

export function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
