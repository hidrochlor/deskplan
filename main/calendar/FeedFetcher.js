// Downloads one calendar feed. Runs in the main process: the page can not fetch other sites (CORS), and the Moodle
// address contains a secret token that should never reach the page.

const MAX_BYTES = 2 * 1024 * 1024; // a term's timetable is ~100 KB; anything this big is not a calendar
const TIMEOUT_MS = 20000;

class FeedFetcher {
  /** @param {{fetch?: typeof fetch, timeoutMs?: number, maxBytes?: number}} [o]  fetch = Electron's net.fetch in the app */
  constructor({ fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
    this.fetchFn = fetch;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
  }

  /**
   * The address to download: webcal:// becomes https://. Only https is accepted, so a token is never sent in the clear.
   * @throws with a message for the user
   */
  static normalizeUrl(input) {
    const text = String(input ?? '').trim().replace(/^webcals?:\/\//i, 'https://');
    let url;
    try { url = new URL(text); } catch { throw new Error('That is not a web address.'); }
    if (url.protocol !== 'https:') throw new Error('Use an https:// or webcal:// address.');
    return url.toString();
  }

  /** @returns {Promise<string>} the feed text  @throws with a message for the user */
  async fetchText(input) {
    const url = FeedFetcher.normalizeUrl(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res;
      try {
        res = await this.fetchFn(url, { signal: controller.signal, redirect: 'follow', headers: { accept: 'text/calendar, */*' } });
      } catch (err) {
        if (controller.signal.aborted) throw new Error('The calendar server did not answer in time.');
        throw new Error(`Could not reach the calendar server (${err.message}).`);
      }
      if (res.status === 401 || res.status === 403) throw new Error('The server refused this address. The link may have expired: copy a new one.');
      if (!res.ok) throw new Error(`The calendar server answered with error ${res.status}.`);
      if (Number(res.headers.get('content-length')) > this.maxBytes) throw new Error('This is too large to be a calendar.');
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > this.maxBytes) throw new Error('This is too large to be a calendar.');
      return new TextDecoder('utf-8').decode(bytes);
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { FeedFetcher };
