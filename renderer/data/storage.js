// Storage adapters. The Store only needs load() and save(); swap the adapter to
// change where data lives (file, memory, cloud later) without touching anything else.

/** Saves through the Electron main process into the user's app-data folder. */
export class ElectronStorage {
  async load() { return window.api.load(); }
  async save(data) { await window.api.save(data); }
  saveSync(data) { window.api.saveSync(data); }
}

/** Keeps data in memory only. Used by tests and when the page runs in a plain browser. */
export class MemoryStorage {
  constructor(initial = null) { this.data = initial; }
  async load() { return this.data ? JSON.parse(JSON.stringify(this.data)) : null; }
  async save(data) { this.data = JSON.parse(JSON.stringify(data)); }
  saveSync(data) { this.data = JSON.parse(JSON.stringify(data)); }
}
