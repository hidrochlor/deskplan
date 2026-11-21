// Remembers which uploads were already stored, by the phone's uploadId.
// This is what makes a retry safe: the same uploadId gets the same answer and no second copy.
const { JsonFile } = require('./JsonFile');

class UploadLedger {
  /** @param {{file?: string, keep?: number}} [options] keep = how many recent uploads to remember */
  constructor({ file = null, keep = 5000 } = {}) {
    this.store = new JsonFile(file);
    this.keep = keep;
    this.entries = new Map(Object.entries(this.store.read({})));
  }

  get(uploadId) { return this.entries.get(uploadId) ?? null; }

  set(uploadId, record) {
    this.entries.set(uploadId, record);
    while (this.entries.size > this.keep) this.entries.delete(this.entries.keys().next().value); // oldest first
    this.store.write(Object.fromEntries(this.entries));
  }
}

module.exports = { UploadLedger };
