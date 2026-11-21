import { RECEIVED_FILES, destinationOf } from './ReceivedFile.js';

// Turns files that arrived from a phone into Received files entries.
//
// The main process keeps every received file on a list until this class says "saved" (acknowledge).
// So at start-up it first asks for that list, which also covers files that arrived while the page
// was not open yet, or just before a crash. It never lists the same upload twice.
//
// A file the phone addressed to a DeskPlan folder is handed to whichever 'destination' provider owns that
// folder (see phonesync/FolderDestinations.js), which files it there. If nobody can (the folder was deleted
// meanwhile, or that module is not installed) it is listed in Received files instead, so nothing is lost.
export class ReceivedFilesIntake {
  /** @param {{store: object, api: object, ReceivedFile: Function, registry?: object}} o */
  constructor({ store, api, ReceivedFile, registry = null }) {
    this.store = store;
    this.api = api;
    this.ReceivedFile = ReceivedFile;
    this.registry = registry;
  }

  get items() { return this.store.collection('receivedFiles'); }

  async start() {
    this.api.onReceived((record) => this.take([record]));
    await this.take(await this.api.pendingReceived());
  }

  /** True when a destination provider took the file (so it must not also appear in Received files). */
  async fileElsewhere(record) {
    const destination = destinationOf(record);
    if (destination === RECEIVED_FILES) return false;
    const owner = this.registry?.list('destination').find((p) => p.has(destination));
    if (!owner) return false;
    try { return (await owner.accept(record)) === true; } catch { return false; }
  }

  /** @param {object[]} records  as sent by the receiver ('received' event) */
  async take(records) {
    if (!records.length) return;
    const known = new Set(this.items.all().map((i) => i.uploadId));
    for (const r of records) {
      if (known.has(r.uploadId)) continue;
      known.add(r.uploadId);
      if (await this.fileElsewhere(r)) continue;
      this.items.add(this.ReceivedFile.fromReceived(r));
    }
    await this.store.saveNow(); // on disk before the main process forgets them
    await this.api.acknowledge(records.map((r) => r.uploadId));
  }
}
