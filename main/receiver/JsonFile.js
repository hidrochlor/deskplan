// A small JSON file that is read once and replaced whole on every save.
// Writes go to a temp file first, then swap in, so a crash never leaves half a file
// (the same idea as writeData in main.js). With no path it keeps nothing on disk, which tests use.
//
// On Windows the swap can fail for a moment (EPERM / EBUSY) when antivirus or the search indexer
// is looking at the file. So it tries a few times, and only then writes the file directly.
const fs = require('fs');
const path = require('path');

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

class JsonFile {
  constructor(file = null) {
    this.file = file;
  }

  read(fallback) {
    if (!this.file) return fallback;
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[receiver] could not read', this.file, err.message);
      return fallback;
    }
  }

  write(data) {
    if (!this.file) return;
    const text = JSON.stringify(data, null, 2);
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, text);

    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (err) {
        if (!BUSY.has(err.code)) throw err;
        if (attempt < 4) { sleep(15 * (attempt + 1)); continue; }
        fs.writeFileSync(this.file, text); // last resort: not atomic, but better than losing the save
        fs.rmSync(tmp, { force: true });
        return;
      }
    }
  }
}

module.exports = { JsonFile };
