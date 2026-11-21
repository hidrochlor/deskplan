// Builds the pairing QR code that the phone scans (see "Pairing" in docs/protocol.md).
// The QR holds a secret token, so show it only while pairing and never write it to disk.
const QRCode = require('qrcode');

class PairingQr {
  /** @param {{name: string, port: number, fingerprint: string, hint?: string|null}} o */
  constructor({ name, port, fingerprint, hint = null }) {
    Object.assign(this, { name, port, fingerprint, hint });
  }

  /** The JSON text inside the QR: { v, name, port, token, fp, hint }. */
  json(token) {
    return JSON.stringify({ v: 1, name: this.name, port: this.port, token, fp: this.fingerprint, hint: this.hint });
  }

  /** The QR as a "data:image/png;base64,..." address that an <img> can show. */
  dataUrl(token) {
    return QRCode.toDataURL(this.json(token), { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  }
}

module.exports = { PairingQr };
