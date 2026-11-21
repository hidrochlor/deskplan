// The HTTPS door of DeskPlan: protocol v1, see docs/protocol.md.
// It only does the talking (check, route, answer). Who is allowed is PairingManager's job,
// writing files is FileSink's job, and remembering finished uploads is UploadLedger's job.
//
// Emits 'received' with the stored file's details, 'pending' when an unapproved device knocks,
// and 'seen' for every request from an approved phone.
// Routes: GET /v1/ping, PUT /v1/received-files/{id} (also /v1/inbox/{id}, its name before), PUT|DELETE /v1/items/{id}, GET /v1/items?since=, GET /v1/calendar?from=&to=,
// GET|PUT /v1/feed-settings.
const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { FileRules } = require('./FileRules');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const ITEM_ID = /^[A-Za-z0-9._-]{1,64}$/;
const FOLDER_DEST = /^folder:[A-Za-z0-9._-]{1,64}$/; // "folder:<id of a DeskPlan folder>"
const RECEIVED_FILES = 'received-files'; // the destination id of the Received files page
const LEGACY_RECEIVED_FILES = 'inbox';   // its id before; phones on an older Companion still send it, so it stays accepted
const TOO_BIG = Symbol('too-big');
const MAX_ITEM_BODY = 1024 * 1024; // a note's formatted text can be long; a task's details stay at 16,000 characters
const FEATURES = ['notes', 'calendar', 'repeat'];
const MAX_SETTINGS_BODY = 512 * 1024;

class ReceiverServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {{key: string, cert: string}} o.tls   the certificate (from CertificateStore, or a test one)
   * @param {PairingManager} o.pairing
   * @param {FileSink} o.sink
   * @param {UploadLedger} o.ledger
   * @param {string} o.name                        this PC's name, shown on the phone
   * @param {string} o.version
   * @param {() => boolean} o.isReceiving          the receive switch in Settings
   * @param {number} [o.maxBytes]
   * @param {number} [o.maxConcurrent]             uploads at the same time before answering 503
   * @param {{request: (op: string, payload: object) => Promise<{status: number, body: object}>}} [o.items]
   *   where task changes go (RendererItemGateway). Without it the /v1/items routes do not exist (404)
   * @param {FileRules} [o.rules]                   which file types are accepted (documents, images, links)
   * @param {import('../calendar/FeedSettingsSync').FeedSettingsSync} [o.feedSettings]
   *   the calendar feed list shared with the phone. With items, /v1/feed-settings exists and ping lists "feeds"
   */
  constructor({ tls, pairing, sink, ledger, name, version, isReceiving, maxBytes = 100 * 1024 * 1024, maxConcurrent = 4, items = null, rules = new FileRules(), feedSettings = null }) {
    super();
    Object.assign(this, { pairing, sink, ledger, name, version, isReceiving, maxBytes, maxConcurrent, items, rules, feedSettings });
    this.inFlight = new Set();
    this.server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
      this.#handle(req, res).catch((err) => {
        console.error('[receiver]', err);
        this.#send(res, 500, { error: 'server-error' });
      });
    });
  }

  listen(port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve(this.server.address().port));
    });
  }

  close() {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  async #handle(req, res) {
    const url = new URL(req.url, 'https://x');
    const upload = /^\/v1\/(?:received-files|inbox)\/([^/]+)$/.exec(url.pathname); // inbox: older phones
    const item = this.items ? /^\/v1\/items\/([^/]+)$/.exec(url.pathname) : null;
    const pull = this.items && url.pathname === '/v1/items'; // no id: "what changed since ...?"
    const calendar = this.items && url.pathname === '/v1/calendar'; // lectures and exams from the calendar feeds
    const settings = this.items && this.feedSettings && url.pathname === '/v1/feed-settings'; // the shared feed list
    const known = url.pathname === '/v1/ping' || upload || item || pull || calendar || settings;
    if (!known) return this.#reject(req, res, 404, 'not-found');

    // Order matters: switch off first (so nothing leaks), then who, then approved.
    if (!this.isReceiving()) return this.#reject(req, res, 403, 'receiving-off');
    const device = this.pairing.authenticate(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);
    if (!device) return this.#reject(req, res, 401, 'bad-token');
    const deviceName = this.#header(req, 'x-device-name');
    if (deviceName) this.pairing.rename(device.id, deviceName);
    if (!device.approved) {
      this.emit('pending', device);
      return this.#reject(req, res, 403, 'awaiting-approval');
    }
    this.emit('seen', device); // an approved phone just made a request

    if (url.pathname === '/v1/ping') {
      if (req.method !== 'GET') return this.#reject(req, res, 405, 'method');
      return this.#send(res, 200, {
        name: this.name, version: this.version, receiving: true, destinations: await this.#destinations(), allowedExtensions: this.rules.extensions,
        // What syncs beyond tasks and assignments (needs the page, like every item route).
        features: this.items ? [...FEATURES, ...(this.feedSettings ? ['feeds'] : [])] : [],
      });
    }
    if (item) return this.#item(req, res, item[1]);
    if (pull) return this.#pull(req, res, url);
    if (calendar) return this.#calendar(req, res, url);
    if (settings) return this.#feedSettings(req, res);
    if (req.method !== 'PUT') return this.#reject(req, res, 405, 'method');
    return this.#receive(req, res, upload[1], device.name || deviceName);
  }

  async #receive(req, res, uploadId, deviceName) {
    const sha256 = String(req.headers['x-file-sha256'] ?? '').toLowerCase();
    const name = this.#header(req, 'x-file-name');
    let destination = req.headers['x-dest-id'] || RECEIVED_FILES;
    if (destination === LEGACY_RECEIVED_FILES) destination = RECEIVED_FILES; // so the rest of DeskPlan only sees the new id
    const toFolder = FOLDER_DEST.test(destination);
    const length = Number(req.headers['content-length']);
    if (!UUID.test(uploadId) || !SHA256.test(sha256) || name === null || !name
      || !Number.isInteger(length) || length < 0) {
      return this.#reject(req, res, 422, 'invalid-request');
    }
    if (destination !== RECEIVED_FILES && !(toFolder && this.items)) return this.#reject(req, res, 422, 'unknown-destination');

    const done = this.ledger.get(uploadId);
    if (done) { req.resume(); return this.#send(res, 200, done.response); }
    // Only documents, images and links. Refused from the name alone, before any of the file is read.
    if (!this.rules.allows(name)) return this.#reject(req, res, 422, 'unsupported-type');
    if (toFolder) { // does that DeskPlan folder still exist? Only the page knows.
      const asked = await this.items.request('destination-exists', { id: destination }, { timeoutMs: 3000 });
      if (asked.status !== 200) return this.#reject(req, res, 503, 'app-not-ready');
      if (!asked.body?.exists) return this.#reject(req, res, 422, 'unknown-destination');
    }
    if (length > this.maxBytes) return this.#reject(req, res, 413, 'too-large');
    if (this.inFlight.has(uploadId) || this.inFlight.size >= this.maxConcurrent) return this.#reject(req, res, 503, 'busy');

    this.inFlight.add(uploadId);
    try {
      const stored = await this.sink.write(req, { name, sha256 });
      const keptAt = path.join(this.sink.dir, stored.storedAs);
      if (!this.rules.contentOk(keptAt, stored.storedAs)) { // e.g. a link file that points at a local program
        fs.rmSync(keptAt, { force: true });
        return this.#send(res, 422, { error: 'unsupported-type' });
      }
      const response = { received: true, sha256: stored.sha256, storedAs: stored.storedAs, destination };
      this.ledger.set(uploadId, { response });
      this.emit('received', {
        uploadId, fileName: name, storedAs: stored.storedAs, size: stored.size, sha256: stored.sha256,
        receivedAt: new Date().toISOString(), deviceName, destination,
      });
      this.#send(res, 201, response);
    } catch (err) {
      if (err.code === 'TOO_LARGE') this.#send(res, 413, { error: 'too-large' });
      else if (err.code === 'CHECKSUM') this.#send(res, 422, { error: 'checksum-mismatch' });
      else if (!req.complete) { /* the phone went away mid-upload: nobody to answer, the temp file is already gone */ }
      else throw err;
    } finally {
      this.inFlight.delete(uploadId);
    }
  }

  /** Received files, plus the DeskPlan folders the page lists (if it answers quickly). */
  async #destinations() {
    const list = [{ id: RECEIVED_FILES, label: 'Received files' }];
    if (!this.items) return list;
    const asked = await this.items.request('destinations', {}, { timeoutMs: 1500 });
    if (asked.status === 200 && Array.isArray(asked.body?.destinations)) list.push(...asked.body.destinations.slice(0, 500));
    return list;
  }

  /** GET /v1/items?since=<time>&kinds=<list>: the page owns the items and the deletion log, so it builds the answer. */
  async #pull(req, res, url) {
    if (req.method !== 'GET') return this.#reject(req, res, 405, 'method');
    req.resume();
    const reply = await this.items.request('pull', { since: url.searchParams.get('since'), kinds: url.searchParams.get('kinds') });
    this.#send(res, reply.status, reply.body);
  }

  /** GET /v1/calendar?from=&to=: the page owns the calendar feeds (and which courses are hidden), so it builds the answer. */
  async #calendar(req, res, url) {
    if (req.method !== 'GET') return this.#reject(req, res, 405, 'method');
    req.resume();
    const reply = await this.items.request('calendar', { from: url.searchParams.get('from'), to: url.searchParams.get('to') });
    this.#send(res, reply.status, reply.body);
  }

  /**
   * GET / PUT /v1/feed-settings: the feed list lives here in the main process (with the addresses); which courses are
   * hidden lives in the page. PUT applies the phone's changes to both, then both answer what they hold now.
   */
  async #feedSettings(req, res) {
    let courses;
    if (req.method === 'GET') {
      req.resume();
      courses = await this.items.request('feed-courses', {});
    } else if (req.method === 'PUT') {
      const body = await this.#json(req, MAX_SETTINGS_BODY);
      if (body === TOO_BIG) return this.#reject(req, res, 413, 'too-large');
      if (!body || typeof body !== 'object') return this.#reject(req, res, 422, 'invalid-request');
      if (body.feeds !== undefined && this.feedSettings.apply(body.feeds) === null) return this.#reject(req, res, 422, 'invalid-request');
      courses = await this.items.request('feed-courses', { courses: body.courses });
    } else {
      return this.#reject(req, res, 405, 'method');
    }
    if (courses.status !== 200) return this.#send(res, courses.status, courses.body);
    this.#send(res, 200, { feeds: this.feedSettings.list(), courses: courses.body.courses, serverTime: new Date().toISOString() });
  }

  /** PUT / DELETE /v1/items/{id}: the page owns the tasks, so the gateway asks it to apply the change. */
  async #item(req, res, rawId) {
    let id = null;
    try { id = decodeURIComponent(rawId); } catch { /* stays null */ }
    if (!id || !ITEM_ID.test(id)) return this.#reject(req, res, 422, 'invalid-request');

    let reply;
    if (req.method === 'PUT') {
      const body = await this.#json(req, MAX_ITEM_BODY);
      if (body === TOO_BIG) return this.#reject(req, res, 413, 'too-large');
      if (!body || typeof body !== 'object' || body.id !== id) return this.#reject(req, res, 422, 'invalid-request');
      reply = await this.items.request('put', { body });
    } else if (req.method === 'DELETE') {
      req.resume();
      reply = await this.items.request('delete', { id });
    } else {
      return this.#reject(req, res, 405, 'method');
    }
    this.#send(res, reply.status, reply.body);
  }

  /** The request body as a parsed object (null if it is not valid JSON, TOO_BIG if over the small limit). */
  #json(req, limit) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { chunks.length = 0; resolve(TOO_BIG); req.removeAllListeners('data'); req.resume(); } else chunks.push(c);
      });
      req.on('end', () => {
        if (size > limit) return;
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
      });
      req.on('error', () => resolve(null));
    });
  }

  /** URL-decoded header text, or null when it is not valid encoding. Missing gives ''. */
  #header(req, key) {
    const raw = req.headers[key];
    if (raw === undefined) return '';
    try { return decodeURIComponent(String(raw)); } catch { return null; }
  }

  /** Answers with an error and closes the connection, throwing away any body the phone is still sending. */
  #reject(req, res, status, error) {
    req.resume();
    this.#send(res, status, { error }, { Connection: 'close' });
  }

  #send(res, status, body, headers = {}) {
    if (res.writableEnded || res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }
}

module.exports = { ReceiverServer };
