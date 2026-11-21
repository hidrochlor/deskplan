import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakePhone } from './helpers/FakePhone.mjs';

const require = createRequire(import.meta.url);
const { CertificateStore } = require('../main/receiver/CertificateStore.js');
const { Announcer } = require('../main/receiver/Announcer.js');
const { LanAddress } = require('../main/receiver/LanAddress.js');
const { PairingQr } = require('../main/receiver/PairingQr.js');
const { ReceiverServer } = require('../main/receiver/ReceiverServer.js');
const { PairingManager } = require('../main/receiver/PairingManager.js');
const { FileSink } = require('../main/receiver/FileSink.js');
const { UploadLedger } = require('../main/receiver/UploadLedger.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-parts-'));
const DAY = 24 * 60 * 60 * 1000;

test('CertificateStore makes a certificate once and reuses it (same fingerprint) after a restart', async () => {
  const dir = tmpDir();
  const first = await new CertificateStore(dir).load();
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(first.cert.includes('BEGIN CERTIFICATE') && first.key.includes('PRIVATE KEY'));

  const second = await new CertificateStore(dir).load();
  assert.equal(second.fingerprint, first.fingerprint);
});

test('CertificateStore replaces a damaged certificate and one that is about to expire', async () => {
  const dir = tmpDir();
  const first = await new CertificateStore(dir).load();

  fs.writeFileSync(path.join(dir, 'receiver-cert.pem'), 'not a certificate');
  const afterDamage = await new CertificateStore(dir).load();
  assert.notEqual(afterDamage.fingerprint, first.fingerprint);

  const soon = Date.now() + 3640 * DAY; // 10 years minus 10 days: inside the 30-day renewal window
  const renewed = await new CertificateStore(dir, { now: () => soon }).load();
  assert.notEqual(renewed.fingerprint, afterDamage.fingerprint);
});

test('Announcer publishes _deskplan._tcp with a short id, and stops cleanly', () => {
  const calls = [];
  const fake = {
    publish: (svc) => calls.push(['publish', svc]),
    unpublishAll: (done) => { calls.push(['unpublishAll']); done(); },
    destroy: () => calls.push(['destroy']),
  };
  const a = new Announcer({ name: 'MY-PC', createBonjour: () => fake });
  a.start({ port: 47800, fingerprint: 'abcdef0123456789'.repeat(4) });
  assert.deepEqual(calls[0], ['publish', {
    name: 'DeskPlan (MY-PC)', type: 'deskplan', protocol: 'tcp', port: 47800, txt: { id: 'abcdef01' },
  }]);
  a.stop();
  a.stop(); // stopping twice is harmless
  assert.deepEqual(calls.slice(1), [['unpublishAll'], ['destroy']]);
});

test('LanAddress prefers a real home-network address over virtual adapters and ignores public/loopback ones', () => {
  const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal });
  assert.equal(LanAddress.pick({
    'vEthernet (WSL)': [v4('172.20.0.1')],
    Loopback: [v4('127.0.0.1', true)],
    'Wi-Fi': [{ family: 'IPv6', address: 'fe80::1', internal: false }, v4('192.168.1.23')],
  }), '192.168.1.23');
  assert.equal(LanAddress.pick({ 'vEthernet (WSL)': [v4('172.20.0.1')] }), '172.20.0.1'); // better than nothing
  assert.equal(LanAddress.pick({ Ethernet: [v4('8.8.8.8')], lo: [v4('127.0.0.1', true)] }), null);
  assert.equal(LanAddress.pick({}), null);
});

test('PairingQr carries exactly the fields of protocol v1 and renders a PNG', async () => {
  const qr = new PairingQr({ name: 'MY-PC', port: 47800, fingerprint: 'ab'.repeat(32), hint: '192.168.1.23' });
  assert.deepEqual(JSON.parse(qr.json('TOKEN')), {
    v: 1, name: 'MY-PC', port: 47800, token: 'TOKEN', fp: 'ab'.repeat(32), hint: '192.168.1.23',
  });
  assert.ok((await qr.dataUrl('TOKEN')).startsWith('data:image/png;base64,'));
});

test('end to end: scan the QR, pin its fingerprint, approve, upload', async (t) => {
  const dir = tmpDir();
  const tls = await new CertificateStore(dir).load();
  const pairing = new PairingManager();
  const server = new ReceiverServer({
    tls, pairing, sink: new FileSink(path.join(dir, 'received')), ledger: new UploadLedger(),
    name: 'MY-PC', version: '0.1.0', isReceiving: () => true,
  });
  const port = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());

  const { id, token } = pairing.startPairing();
  const scanned = JSON.parse(new PairingQr({ name: 'MY-PC', port, fingerprint: tls.fingerprint }).json(token));
  const phone = new FakePhone({ port: scanned.port, token: scanned.token, fp: scanned.fp });

  assert.equal((await phone.ping()).status, 403); // new device: waiting for approval
  pairing.approve(id);
  assert.equal((await phone.upload(Buffer.from('hello'), { name: 'hi.txt' })).status, 201);
  assert.equal(fs.readFileSync(path.join(dir, 'received', 'hi.txt'), 'utf8'), 'hello');
});
