// Who may talk to DeskPlan. Its one job: hand out secrets, recognise them, and forget them again.
//
// How pairing works, in plain words:
//   1. startPairing() makes a random secret (the "token") for the QR code. Only a hash of it is kept,
//      so a copy of the data file does not reveal working secrets.
//   2. The phone scans the QR and sends the token with every request.
//   3. A device that has never connected before must be approved here by the user (approve()),
//      unless requireApproval is switched off.
//   4. revoke() forgets the device; its token stops working at once.
// A QR that nobody scans within `unclaimedTtlMs` stops working, so a forgotten QR is not a standing key.
const crypto = require('crypto');
const { JsonFile } = require('./JsonFile');

const SEEN_SAVE_MS = 30 * 1000;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

class PairingManager {
  /**
   * @param {{file?: string, requireApproval?: boolean, unclaimedTtlMs?: number, now?: () => number}} [options]
   */
  constructor({ file = null, requireApproval = true, unclaimedTtlMs = 10 * 60 * 1000, now = Date.now } = {}) {
    this.store = new JsonFile(file);
    this.requireApproval = requireApproval;
    this.unclaimedTtlMs = unclaimedTtlMs;
    this.now = now;
    this.devices = this.store.read({ devices: [] }).devices ?? [];
    this.seenSavedAt = 0;
    this.#dropExpired();
  }

  /** Makes a new secret for a QR code. Show it once; it can not be read back later. */
  startPairing() {
    const token = crypto.randomBytes(32).toString('base64');
    const device = {
      id: crypto.randomUUID(), name: '', tokenHash: sha256(token),
      approved: false, createdAt: this.now(), claimedAt: null, lastSeen: null,
    };
    this.#dropExpired();
    this.devices.push(device);
    this.#save();
    return { id: device.id, token };
  }

  /** The device that owns this token, or null (unknown, revoked or an expired unscanned QR). */
  authenticate(token) {
    const hash = sha256(String(token ?? ''));
    const device = this.devices.find((d) => d.tokenHash === hash);
    if (!device) return null;
    let important = false;
    if (device.claimedAt === null) {
      if (this.now() - device.createdAt > this.unclaimedTtlMs) return null;
      device.claimedAt = this.now();
      if (!this.requireApproval) device.approved = true;
      important = true;
    }
    device.lastSeen = this.now();
    // "Last seen" changes on every request, so it is written at most every 30 seconds (it is only shown on screen).
    if (important || this.now() - this.seenSavedAt >= SEEN_SAVE_MS) this.#save();
    return this.#view(device);
  }

  /** Remembers the name the phone calls itself, the first time it tells us. */
  rename(id, name) {
    const device = this.devices.find((d) => d.id === id);
    if (!device || device.name || !name) return;
    device.name = String(name).slice(0, 80);
    this.#save();
  }

  /** The user's own name for a phone. Unlike rename(), it replaces any name, and once set the phone's own is ignored. */
  setName(id, name) {
    return this.#update(id, (d) => { d.name = String(name ?? '').trim().slice(0, 80); });
  }

  approve(id) { return this.#update(id, (d) => { d.approved = true; }); }

  revoke(id) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    this.#save();
    return this.devices.length < before;
  }

  /** Devices for the settings page. Never includes the hashes. Unscanned QR codes are not listed. */
  list() {
    return this.devices.filter((d) => d.claimedAt !== null).map((d) => this.#view(d));
  }

  #update(id, change) {
    const device = this.devices.find((d) => d.id === id);
    if (!device) return false;
    change(device);
    this.#save();
    return true;
  }

  #view({ id, name, approved, createdAt, claimedAt, lastSeen }) {
    return { id, name, approved, createdAt, claimedAt, lastSeen };
  }

  /** Forgets codes that were never scanned and have expired, so they do not pile up in the file. */
  #dropExpired() {
    const keep = this.devices.filter((d) => d.claimedAt !== null || this.now() - d.createdAt <= this.unclaimedTtlMs);
    if (keep.length !== this.devices.length) { this.devices = keep; this.#save(); }
  }

  /** A disk hiccup must never turn a phone's request into an error: the change stays in memory and is saved next time. */
  #save() {
    this.seenSavedAt = this.now();
    try { this.store.write({ devices: this.devices }); } catch (err) { console.error('[receiver] could not save paired devices:', err.message); }
  }
}

module.exports = { PairingManager };
