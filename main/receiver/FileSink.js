// Writes one received file into the Received files folder. Its only job is to do that safely:
//   - the name from the phone is never trusted (cleanName)
//   - the bytes go to a temporary file first, are counted and hashed on the way in,
//     and only move to their real name once the SHA-256 matches
//   - a name that is already taken becomes "name (1).ext"
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i; // names Windows will not accept for a file
const MAX_NAME = 150;

/** Error with a `code` the server turns into an HTTP status: TOO_LARGE (413), CHECKSUM (422). */
class SinkError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

class FileSink {
  /**
   * @param {string} dir        the Received files folder (created if missing)
   * @param {{maxBytes?: number}} [options]
   */
  constructor(dir, { maxBytes = 100 * 1024 * 1024 } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.partialDir = path.join(dir, '.partial');
  }

  /** Turns any text into a safe single file name: no folders, no "..", nothing Windows rejects. */
  static cleanName(raw) {
    let name = String(raw ?? '').split(/[\\/]/).pop();            // drop any folder part
    name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '_');          // control and Windows-forbidden characters
    name = name.replace(/\.{2,}/g, '.').replace(/[. ]+$/, '').trim(); // no "..", no trailing dot or space
    if (!name || name === '.') return 'file';

    const ext = path.extname(name);
    let stem = ext ? name.slice(0, -ext.length) : name;
    if (RESERVED.test(stem)) stem = `_${stem}`;
    const room = Math.max(1, MAX_NAME - ext.length);
    return stem.slice(0, room) + ext.slice(0, MAX_NAME - 1);
  }

  /**
   * Stores the bytes of `source` (any readable stream) under a clean name.
   * @returns {Promise<{storedAs: string, size: number, sha256: string}>}
   */
  async write(source, { name, sha256 }) {
    fs.mkdirSync(this.partialDir, { recursive: true });
    const tmp = path.join(this.partialDir, crypto.randomUUID());
    const hash = crypto.createHash('sha256');
    let size = 0;

    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        out.on('error', reject);
        out.on('finish', resolve);
        source.on('error', reject);
        source.on('data', (chunk) => {
          size += chunk.length;
          if (size > this.maxBytes) {
            source.destroy();
            out.destroy();
            reject(new SinkError('TOO_LARGE', `More than ${this.maxBytes} bytes`));
            return;
          }
          hash.update(chunk);
        });
        source.pipe(out);
      });

      const actual = hash.digest('hex');
      if (String(sha256 ?? '').toLowerCase() !== actual) {
        throw new SinkError('CHECKSUM', 'SHA-256 does not match the bytes received');
      }
      return { storedAs: this.#claim(tmp, FileSink.cleanName(name)), size, sha256: actual };
    } finally {
      fs.rmSync(tmp, { force: true }); // gone already after a successful claim
    }
  }

  /** Gives the temp file its final name without ever overwriting an existing file. */
  #claim(tmp, name) {
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let n = 0; ; n++) {
      const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
      try {
        fs.linkSync(tmp, path.join(this.dir, candidate)); // fails if the name is taken
        return candidate;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  }
}

module.exports = { FileSink, SinkError };
