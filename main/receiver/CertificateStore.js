// DeskPlan's own HTTPS certificate. Its one job: make it once, keep it, and tell its fingerprint.
//
// Why a certificate we make ourselves: the phone talks to this PC on the home network, where no public
// authority can vouch for it. Instead the QR code carries the certificate's fingerprint (a short hash that
// identifies it), and the phone accepts only a server whose certificate has exactly that fingerprint ("pinning").
//
// The certificate lasts ten years so phones do not need to pair again. If it is replaced (file deleted,
// damaged or about to expire) the fingerprint changes, and every phone must scan a new QR code.
const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('crypto');
const selfsigned = require('selfsigned');

const DAY = 24 * 60 * 60 * 1000;

class CertificateStore {
  /**
   * @param {string} dir  folder for cert.pem and key.pem (DeskPlan's data folder)
   * @param {{commonName?: string, validDays?: number, renewDays?: number, now?: () => number}} [options]
   */
  constructor(dir, { commonName = 'DeskPlan', validDays = 3650, renewDays = 30, now = Date.now } = {}) {
    this.certFile = path.join(dir, 'receiver-cert.pem');
    this.keyFile = path.join(dir, 'receiver-key.pem');
    Object.assign(this, { dir, commonName, validDays, renewDays, now });
    this.current = null;
  }

  /** @returns {Promise<{key: string, cert: string, fingerprint: string}>} fingerprint = SHA-256 of the certificate, lowercase hex */
  async load() {
    this.current ??= this.#read() ?? await this.#create();
    return this.current;
  }

  /** The fingerprint, once load() has run. */
  get fingerprint() { return this.current?.fingerprint ?? null; }

  #read() {
    try {
      const cert = fs.readFileSync(this.certFile, 'utf8');
      const key = fs.readFileSync(this.keyFile, 'utf8');
      const parsed = new X509Certificate(cert);
      if (Date.parse(parsed.validTo) - this.now() < this.renewDays * DAY) return null; // about to expire
      return { key, cert, fingerprint: CertificateStore.fingerprintOf(cert) };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[receiver] certificate unusable, making a new one:', err.message);
      return null;
    }
  }

  async #create() {
    const start = new Date(this.now());
    const pems = await selfsigned.generate([{ name: 'commonName', value: this.commonName }], {
      keySize: 2048, algorithm: 'sha256', notBeforeDate: start, notAfterDate: new Date(start.getTime() + this.validDays * DAY),
    });
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.certFile, pems.cert);
    fs.writeFileSync(this.keyFile, pems.private, { mode: 0o600 }); // the private key is the secret part
    return { key: pems.private, cert: pems.cert, fingerprint: CertificateStore.fingerprintOf(pems.cert) };
  }

  static fingerprintOf(certPem) {
    return new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();
  }
}

module.exports = { CertificateStore };
