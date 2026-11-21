// Tells the home network "DeskPlan is here", so the phone can find this PC without typing an address.
// This uses mDNS (also called Bonjour): a way for devices on one network to announce a named service.
// Some shared Wi-Fi blocks it, which is why the phone also has the QR's IP hint and a manual address.
const { Bonjour } = require('bonjour-service');

class Announcer {
  /**
   * @param {{name: string, createBonjour?: () => {publish: Function, unpublishAll: Function, destroy: Function}}} o
   *   createBonjour is only here so tests can pass a fake instead of using the real network
   */
  constructor({ name, createBonjour = () => new Bonjour() }) {
    this.name = name;
    this.createBonjour = createBonjour;
    this.bonjour = null;
  }

  /** Short id the phone sees in the announcement; it is the start of the certificate fingerprint. */
  static deviceId(fingerprint) { return String(fingerprint).slice(0, 8); }

  start({ port, fingerprint }) {
    this.stop();
    this.bonjour = this.createBonjour();
    this.bonjour.publish({
      name: `DeskPlan (${this.name})`, type: 'deskplan', protocol: 'tcp', port,
      txt: { id: Announcer.deviceId(fingerprint) },
    });
  }

  stop() {
    if (!this.bonjour) return;
    const b = this.bonjour;
    this.bonjour = null;
    b.unpublishAll(() => b.destroy());
  }
}

module.exports = { Announcer };
