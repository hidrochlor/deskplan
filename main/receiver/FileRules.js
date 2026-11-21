// Which files DeskPlan accepts from a phone. Its one job: say yes or no.
//
// DeskPlan keeps documents, images and links, so that is all it takes. Anything else (programs such as .exe or
// .apk, scripts, archives, web pages, files with no extension) is refused before the upload even starts.
//
// The test is on the name as it will really be stored (after FileSink.cleanName), never on the raw text from the
// phone. That closes the usual tricks: "invoice.pdf.exe", "a.exe." (Windows ignores the trailing dot) and
// "a.pdf:evil.exe" are all seen as .exe. Matching is a whitelist, so unknown types are refused, not allowed.
//
// A link file (.url) is also read, because a Windows Internet Shortcut can point at a local program
// ("URL=file:///C:/...").  It is only accepted if every URL in it starts with http:// or https://.
const fs = require('fs');
const path = require('path');
const { FileSink } = require('./FileSink');

const GROUPS = {
  documents: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'ods', 'csv', 'epub'],
  images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tif', 'tiff'],
  links: ['url'],
};
const MAX_LINK_BYTES = 16 * 1024;

class FileRules {
  /** @param {{groups?: Record<string, string[]>}} [o]  extension groups (without dots), replaced in tests */
  constructor({ groups = GROUPS } = {}) {
    this.allowed = new Set(Object.values(groups).flat().map((e) => e.toLowerCase()));
  }

  /** Every accepted extension, A to Z, without dots. The phone gets this list in the ping answer. */
  get extensions() { return [...this.allowed].sort(); }

  /** The extension the file would be stored with (lowercase, no dot, '' if none). */
  extensionOf(rawName) {
    return path.extname(FileSink.cleanName(rawName)).slice(1).toLowerCase();
  }

  /** @returns {boolean} true if a file with this name may be received */
  allows(rawName) {
    return this.allowed.has(this.extensionOf(rawName));
  }

  /** Looks inside a stored file where the type needs it (links). @returns {boolean} true if it is fine to keep */
  contentOk(fullPath, storedName) {
    if (path.extname(storedName).toLowerCase() !== '.url') return true;
    try {
      if (fs.statSync(fullPath).size > MAX_LINK_BYTES) return false;
      const urls = [...fs.readFileSync(fullPath, 'utf8').matchAll(/^\s*URL\s*=\s*(.*?)\s*$/gim)].map((m) => m[1]);
      return urls.length > 0 && urls.every((u) => /^https?:\/\//i.test(u));
    } catch {
      return false;
    }
  }
}

module.exports = { FileRules, GROUPS };
