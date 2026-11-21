import { Entity } from '../../data/Entity.js';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);

// The destination id of the Received files page (protocol.md). Older versions called it "inbox";
// a record saved by one of them may still say so.
export const RECEIVED_FILES = 'received-files';
const LEGACY_RECEIVED_FILES = 'inbox';

/** The destination a record was meant for, with the old name for Received files read as the new one. */
export const destinationOf = (r) => (!r.destination || r.destination === LEGACY_RECEIVED_FILES ? RECEIVED_FILES : r.destination);

// One file that arrived from a phone. The file itself lives in the Received files folder (main process);
// this is only its record, so saving the data file stays fast.
export class ReceivedFile extends Entity {
  static defaults() {
    return {
      id: '',
      uploadId: '',        // the phone's id for this upload; stops the same upload being listed twice
      fileName: '',        // the name the phone sent, as the user knows it
      storedAs: '',        // the name inside the Received files folder (differs when a name was taken: "a (1).pdf")
      size: 0,
      sha256: '',
      receivedAt: '',      // ISO text
      deviceName: '',
      destination: RECEIVED_FILES,
      createdAt: '',
      updatedAt: '',
    };
  }

  /** From the 'received' record the main process sends. */
  static fromReceived(r) {
    return {
      uploadId: r.uploadId, fileName: r.fileName, storedAs: r.storedAs, size: r.size,
      sha256: r.sha256, receivedAt: r.receivedAt, deviceName: r.deviceName ?? '', destination: destinationOf(r),
    };
  }

  get ext() {
    const m = /\.([^.]+)$/.exec(this.fileName);
    return m ? m[1].toLowerCase() : '';
  }

  get isImage() { return IMAGE_EXT.has(this.ext); }

  get receivedDate() {
    const d = new Date(this.receivedAt);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  get sizeLabel() {
    const b = this.size || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }
}
