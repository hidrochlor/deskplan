// The one object main.js talks to. It owns the receiver parts and the receive switch,
// and knows nothing about Electron, so tests can run it directly.
//
// Receiving is OFF until the user switches it on. The HTTPS server is not even created before the first
// time it is switched on (so Windows does not ask about the firewall for a feature nobody uses). After
// that it stays up: while switched off it answers every request with 403, so the phone can say why
// the file is waiting. The mDNS announcement follows the switch exactly.
//
// Emits:
//   'received' (record)   a file was stored; also kept until the screen acknowledges it (see acknowledge)
//   'devices'             the device list changed or a device is waiting for approval
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { JsonFile } = require('./JsonFile');
const { CertificateStore } = require('./CertificateStore');
const { PairingManager } = require('./PairingManager');
const { FileSink } = require('./FileSink');
const { UploadLedger } = require('./UploadLedger');
const { ReceiverServer } = require('./ReceiverServer');
const { Announcer } = require('./Announcer');
const { LanAddress } = require('./LanAddress');
const { PairingQr } = require('./PairingQr');
const { NetworkProfile } = require('./NetworkProfile');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PORT_TRIES = 10;
const SEEN_EMIT_MS = 10 * 1000; // tell the screen about a phone's activity at most this often // 47800, 47801, ... if the first is taken by another program

class ReceiverController extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir        DeskPlan's data folder; everything below lives inside it
   * @param {string} [o.name]     this PC's name
   * @param {string} [o.version]
   * @param {number} [o.port]     first port to try (0 = any free port, for tests)
   * @param {number} [o.maxBytes]
   * @param {Announcer} [o.announcer]
   * @param {(o: object) => {json: Function, dataUrl: Function}} [o.qrFactory]
   * @param {() => object} [o.interfaces]  network interfaces, replaced in tests
   * @param {{request: Function}} [o.items]  where the phone's task changes go (RendererItemGateway)
   * @param {{current: () => Promise<object>}} [o.network]  tells which kind of network this is (NetworkProfile)
   * @param {number} [o.networkCheckMs]  how often to look again while receiving is on (the user may switch Wi-Fi)
   */
  constructor({
    dir, name = os.hostname(), version = '0.0.0', port = 47800, maxBytes = 100 * 1024 * 1024,
    announcer = new Announcer({ name }), qrFactory = (o) => new PairingQr(o), interfaces = os.networkInterfaces, items = null,
    network = new NetworkProfile({ interfaces }), networkCheckMs = 60 * 1000, feedSettings = null,
  }) {
    super();
    Object.assign(this, { dir, name, version, port, maxBytes, announcer, qrFactory, interfaces, items, network, networkCheckMs, feedSettings });
    this.networkInfo = null; // { interfaceName, address, category } once looked up
    this.networkTimer = null;
    this.receivedDir = ReceiverController.#findReceivedDir(dir);
    this.filesDir = path.join(dir, 'files'); // where DeskPlan keeps files attached to folders (one sub-folder per file)
    this.settings = new JsonFile(path.join(dir, 'receiver-settings.json'));
    this.unacked = new JsonFile(path.join(dir, 'receiver-unacknowledged.json'));
    this.pairing = new PairingManager({ file: path.join(dir, 'receiver-devices.json') });
    this.enabled = false;
    this.server = null;
    this.listeningPort = null;
    this.fingerprint = null;
    this.lastSeenEmit = 0;
    this.warned = new Set(); // devices already reported as waiting, so the screen is not poked on every retry
  }

  /**
   * Where received files are stored: "Received files" in the data folder. Older versions called it "inbox";
   * that folder is renamed once. If it cannot be (a file in it is open in another program), it is used as it is
   * and the rename is tried again at the next start.
   */
  static #findReceivedDir(dir) {
    const current = path.join(dir, 'Received files');
    const old = path.join(dir, 'inbox');
    if (!fs.existsSync(current) && fs.existsSync(old)) {
      try { fs.renameSync(old, current); } catch { return old; }
    }
    return current;
  }

  /** Call once at app start. Brings the receiver back up only if it was left switched on. */
  async start() {
    this.enabled = this.settings.read({ enabled: false }).enabled === true;
    if (this.enabled) await this.#bringUp();
  }

  async stop() {
    this.#stopWatchingNetwork();
    this.announcer.stop();
    await this.server?.close();
    this.server = null;
    this.listeningPort = null;
  }

  async setEnabled(on) {
    this.enabled = on === true;
    this.settings.write({ enabled: this.enabled });
    if (this.enabled) await this.#bringUp();
    else { this.announcer.stop(); this.#stopWatchingNetwork(); }
    this.emit('devices');
    return this.status();
  }

  /** Looks up the network type again. Tells the screen only when the answer changed. */
  async refreshNetwork() {
    let info;
    try { info = await this.network.current(); } catch { info = null; }
    if (info?.category === this.networkInfo?.category && info?.address === this.networkInfo?.address) return;
    this.networkInfo = info;
    this.emit('devices');
  }

  /** Plain data for the Settings page. Never contains a token or a hash. */
  status() {
    return {
      enabled: this.enabled, listening: this.listeningPort !== null, name: this.name, port: this.listeningPort,
      fingerprint: this.fingerprint, devices: this.pairing.list(), receivedDir: this.receivedDir, network: this.networkInfo,
    };
  }

  /** New secret and its QR image. Receiving must be on first, because the QR names the port in use. */
  async startPairing() {
    if (!this.enabled || this.listeningPort === null) throw new Error('Switch receiving on before pairing a phone');
    const { id, token } = this.pairing.startPairing();
    const qr = this.qrFactory({
      name: this.name, port: this.listeningPort, fingerprint: this.fingerprint, hint: LanAddress.pick(this.interfaces()),
    });
    return { id, qrDataUrl: await qr.dataUrl(token) };
  }

  renameDevice(id, name) { const ok = this.pairing.setName(id, name); this.emit('devices'); return ok; }
  approve(id) { const ok = this.pairing.approve(id); this.emit('devices'); return ok; }
  revoke(id) { const ok = this.pairing.revoke(id); this.emit('devices'); return ok; }

  /** Files stored but not yet saved by the screen (it was not open yet, or the app crashed in between). */
  pendingReceived() { return this.unacked.read([]); }

  /** The screen saved these uploads as Received files entries; forget them. */
  acknowledge(uploadIds) {
    const done = new Set(uploadIds);
    this.unacked.write(this.pendingReceived().filter((r) => !done.has(r.uploadId)));
  }

  /** Absolute path of a stored file. Refuses anything outside the Received files folder. */
  resolveReceivedFile(storedAs) {
    const full = path.resolve(this.receivedDir, String(storedAs ?? ''));
    if (!full.startsWith(this.receivedDir + path.sep) || !fs.existsSync(full)) throw new Error(`Not a received file: ${storedAs}`);
    return full;
  }

  /**
   * Moves a received file out of Received files into DeskPlan's own files area, ready to become a file item
   * inside a folder. Safe to call again for the same upload (after a crash): it finds the file already there.
   * @returns {{name: string, path: string, size: number, ext: string}}  the shape of an item's "file" field
   */
  attachReceivedFile(storedAs, uploadId) {
    const name = String(storedAs ?? '');
    if (!UUID.test(String(uploadId)) || !name || name !== path.basename(name)) throw new Error('Not a received file');
    const target = path.join(this.filesDir, uploadId, name);
    if (!fs.existsSync(target)) { // (checked first: the Received files folder may meanwhile hold a different file of the same name)
      const source = this.resolveReceivedFile(name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.renameSync(source, target);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        fs.copyFileSync(source, target); // another drive: copy, then remove the original
        fs.rmSync(source, { force: true });
      }
    }
    return { name, path: `${uploadId}/${name}`, size: fs.statSync(target).size, ext: path.extname(name).slice(1).toLowerCase() };
  }

  /** Deletes a stored file. Already gone counts as done, so removing a Received files entry never gets stuck. */
  deleteReceivedFile(storedAs) {
    const full = path.resolve(this.receivedDir, String(storedAs ?? ''));
    if (!full.startsWith(this.receivedDir + path.sep)) throw new Error(`Not a received file: ${storedAs}`);
    fs.rmSync(full, { force: true });
  }

  async #bringUp() {
    if (!this.server) await this.#createServer();
    this.announcer.start({ port: this.listeningPort, fingerprint: this.fingerprint });
    this.#watchNetwork();
  }

  /** Checks the network now (without making the switch wait for it) and then once a minute while receiving is on. */
  #watchNetwork() {
    this.refreshNetwork();
    if (this.networkTimer) return;
    this.networkTimer = setInterval(() => this.refreshNetwork(), this.networkCheckMs);
    this.networkTimer.unref?.();
  }

  #stopWatchingNetwork() {
    clearInterval(this.networkTimer);
    this.networkTimer = null;
  }

  async #createServer() {
    const tls = await new CertificateStore(this.dir, { commonName: `DeskPlan (${this.name})` }).load();
    this.fingerprint = tls.fingerprint;
    const server = new ReceiverServer({
      tls, pairing: this.pairing, sink: new FileSink(this.receivedDir, { maxBytes: this.maxBytes }),
      ledger: new UploadLedger({ file: path.join(this.dir, 'receiver-uploads.json') }),
      name: this.name, version: this.version, isReceiving: () => this.enabled, maxBytes: this.maxBytes, items: this.items,
      feedSettings: this.feedSettings,
    });
    server.on('received', (record) => {
      this.unacked.write([...this.pendingReceived(), record]); // saved before anyone is told, so it cannot be lost
      this.emit('received', record);
    });
    server.on('seen', () => { // a phone synced: the screen shows "last seen", so it needs to hear about it
      const t = Date.now();
      if (t - this.lastSeenEmit < SEEN_EMIT_MS) return;
      this.lastSeenEmit = t;
      this.emit('devices');
    });
    server.on('pending', (device) => {
      if (this.warned.has(device.id)) return;
      this.warned.add(device.id);
      this.emit('devices');
    });
    this.listeningPort = await this.#listen(server);
    this.server = server;
  }

  async #listen(server) {
    for (let i = 0; i < PORT_TRIES; i++) {
      try {
        return await server.listen(this.port === 0 ? 0 : this.port + i);
      } catch (err) {
        if (err.code !== 'EADDRINUSE' || this.port === 0) throw err;
      }
    }
    throw new Error(`No free port from ${this.port} to ${this.port + PORT_TRIES - 1}`);
  }
}

module.exports = { ReceiverController };
