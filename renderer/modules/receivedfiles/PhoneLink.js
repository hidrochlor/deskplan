// The page's view of the phone receiver: the latest status, and the commands to change it.
// It wraps window.api.receiver (see preload.js) and announces every change on the bus:
//   'phones:changed' (status)
// Everything that shows phone state (top-bar icon, Settings page, Received files) reads it from here.
export class PhoneLink {
  /** @param {{bus: object, api: object|null}} o  api is null in a plain browser (no desktop app) */
  constructor({ bus, api }) {
    this.bus = bus;
    this.api = api;
    this.status = null;
  }

  get available() { return !!this.api; }

  async start() {
    if (!this.api) return;
    this.api.onDevices((status) => this.#set(status));
    this.#set(await this.api.status());
  }

  async setEnabled(on) { this.#set(await this.api.setEnabled(on)); }

  /** @returns {Promise<{id: string, qrDataUrl: string}>} */
  startPairing() { return this.api.startPairing(); }

  async approve(id) { await this.api.approve(id); this.#set(await this.api.status()); }
  async rename(id, name) { await this.api.rename(id, name); this.#set(await this.api.status()); }
  async revoke(id) { await this.api.revoke(id); this.#set(await this.api.status()); }

  #set(status) {
    this.status = status;
    this.bus.emit('phones:changed', status);
  }
}
