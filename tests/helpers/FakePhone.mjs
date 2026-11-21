// A stand-in for the Flutter app, used only by tests. It does what the real phone must do:
// talk HTTPS, accept only the certificate whose fingerprint it was paired with, send the token.
import https from 'node:https';
import crypto from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';

const selfsigned = createRequire(import.meta.url)('selfsigned');

/** A throw-away certificate for tests. The real one comes from CertificateStore. */
export async function makeTestCert() {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'DeskPlan test' }], { keySize: 2048 });
  return { key: pems.private, cert: pems.cert, fp: new X509Certificate(pems.cert).fingerprint256.replace(/:/g, '').toLowerCase() };
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export class FakePhone {
  constructor({ port, token, fp, deviceName = 'Test phone' }) {
    Object.assign(this, { port, token, fp, deviceName });
  }

  /** Raw request. Returns { status, json }. `headers` override the defaults, a null value removes one. */
  request(method, path, { body = null, headers = {} } = {}) {
    const all = { Authorization: `Bearer ${this.token}`, 'X-Device-Name': encodeURIComponent(this.deviceName), ...headers };
    if (body) all['Content-Length'] ??= body.length;
    for (const k of Object.keys(all)) if (all[k] === null) delete all[k];

    return new Promise((resolve, reject) => {
      const req = https.request({
        host: '127.0.0.1', port: this.port, method, path, headers: all, agent: false,
        rejectUnauthorized: false, // a self-signed certificate has no authority to check; pinning below replaces that check
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject);
      // Pinning: right after the handshake, and before anything is sent, accept only the paired fingerprint.
      req.on('socket', (socket) => socket.once('secureConnect', () => {
        const seen = socket.getPeerCertificate().fingerprint256.replace(/:/g, '').toLowerCase();
        if (seen !== this.fp) req.destroy(new Error('certificate does not match the paired fingerprint'));
      }));
      req.end(body);
    });
  }

  ping() { return this.request('GET', '/v1/ping'); }

  upload(bytes, { uploadId = crypto.randomUUID(), name = 'file.txt', sha = sha256(bytes), headers = {}, route = 'received-files' } = {}) {
    return this.request('PUT', `/v1/${route}/${uploadId}`, {
      body: bytes,
      headers: { 'X-File-Name': encodeURIComponent(name), 'X-File-Sha256': sha, ...headers },
    });
  }
}
