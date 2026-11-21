import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakePhone, makeTestCert, sha256 } from './helpers/FakePhone.mjs';

const require = createRequire(import.meta.url);
const { ReceiverServer } = require('../main/receiver/ReceiverServer.js');
const { PairingManager } = require('../main/receiver/PairingManager.js');
const { FileSink } = require('../main/receiver/FileSink.js');
const { UploadLedger } = require('../main/receiver/UploadLedger.js');

let cert;
before(async () => { cert = await makeTestCert(); });

/** A running receiver plus a phone that is already paired and approved. */
async function setup({ receiving = true, maxBytes = 1024 * 1024, maxConcurrent = 4, approved = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-recv-'));
  const state = { receiving };
  const pairing = new PairingManager();
  const server = new ReceiverServer({
    tls: cert, pairing, sink: new FileSink(path.join(dir, 'received'), { maxBytes }), ledger: new UploadLedger(),
    name: 'TEST-PC', version: '0.1.0', isReceiving: () => state.receiving, maxBytes, maxConcurrent,
  });
  const port = await server.listen(0, '127.0.0.1');
  const { id, token } = pairing.startPairing();
  if (approved) { pairing.authenticate(token); pairing.approve(id); }
  const received = [];
  server.on('received', (r) => received.push(r));
  return {
    dir, receivedDir: path.join(dir, 'received'), state, pairing, server, received, deviceId: id,
    phone: new FakePhone({ port, token, fp: cert.fp }),
    stop: () => server.close(),
  };
}

test('ping answers with the PC name and the Received files destination', async (t) => {
  const s = await setup(); t.after(s.stop);
  const r = await s.phone.ping();
  assert.equal(r.status, 200);
  const { allowedExtensions, ...rest } = r.json;
  assert.deepEqual(rest, { name: 'TEST-PC', version: '0.1.0', receiving: true, destinations: [{ id: 'received-files', label: 'Received files' }], features: [] }); // no items gateway: nothing beyond files
  // The phone is told what it may send, so it can say no before queueing. Documents, images and links only.
  for (const ok of ['pdf', 'docx', 'txt', 'png', 'jpg', 'heic', 'url']) assert.ok(allowedExtensions.includes(ok), ok);
  for (const no of ['exe', 'apk', 'bat', 'zip', 'html', 'js', 'svg', 'lnk']) assert.ok(!allowedExtensions.includes(no), no);
  assert.deepEqual(allowedExtensions, [...allowedExtensions].sort());
});

test('an upload is stored, answered with 201, and announced', async (t) => {
  const s = await setup(); t.after(s.stop);
  const bytes = Buffer.from('%PDF pretend');
  const r = await s.phone.upload(bytes, { name: 'My notes.pdf' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { received: true, sha256: sha256(bytes), storedAs: 'My notes.pdf', destination: 'received-files' });
  assert.deepEqual(fs.readFileSync(path.join(s.receivedDir, 'My notes.pdf')), bytes);
  assert.equal(s.received.length, 1);
  assert.equal(s.received[0].deviceName, 'Test phone');
  assert.equal(s.received[0].destination, 'received-files');
});

test('an older phone (old /v1/inbox route, X-Dest-Id: inbox) still lands in Received files, under the new id', async (t) => {
  const s = await setup(); t.after(s.stop);
  const bytes = Buffer.from('%PDF old phone');
  const r = await s.phone.upload(bytes, { name: 'old.pdf', route: 'inbox', headers: { 'X-Dest-Id': 'inbox' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.destination, 'received-files');
  assert.deepEqual(fs.readFileSync(path.join(s.receivedDir, 'old.pdf')), bytes);
  assert.equal(s.received[0].destination, 'received-files');
});

test('the same uploadId again gives 200 with the same body and no second file', async (t) => {
  const s = await setup(); t.after(s.stop);
  const bytes = Buffer.from('once only');
  const uploadId = '3f1c1e0e-8f6b-4c53-9d0a-2b1f6f7a9c11';
  const first = await s.phone.upload(bytes, { uploadId, name: 'a.txt' });
  const again = await s.phone.upload(bytes, { uploadId, name: 'a.txt' });
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, first.json);
  assert.deepEqual(fs.readdirSync(s.receivedDir).filter((f) => f !== '.partial'), ['a.txt']);
  assert.equal(s.received.length, 1);
});

test('two different uploads of the same name are stored as separate files', async (t) => {
  const s = await setup(); t.after(s.stop);
  const a = await s.phone.upload(Buffer.from('x'), { name: 'a.txt' });
  const b = await s.phone.upload(Buffer.from('x'), { name: 'a.txt' });
  assert.equal(a.json.storedAs, 'a.txt');
  assert.equal(b.json.storedAs, 'a (1).txt');
});

test('a wrong or missing token gets 401', async (t) => {
  const s = await setup(); t.after(s.stop);
  const wrong = new FakePhone({ ...s.phone, token: 'not-a-real-token' });
  assert.equal((await wrong.ping()).status, 401);
  assert.equal((await wrong.upload(Buffer.from('x'))).status, 401);
  assert.equal((await s.phone.request('GET', '/v1/ping', { headers: { Authorization: null } })).status, 401);
  assert.equal(s.received.length, 0);
});

test('a bad checksum gets 422 and keeps nothing', async (t) => {
  const s = await setup(); t.after(s.stop);
  const r = await s.phone.upload(Buffer.from('real bytes'), { sha: sha256(Buffer.from('other bytes')) });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'checksum-mismatch');
  assert.deepEqual(fs.existsSync(s.receivedDir) ? fs.readdirSync(s.receivedDir).filter((f) => f !== '.partial') : [], []);
  assert.equal(s.received.length, 0);
});

test('a file over the limit gets 413 and keeps nothing', async (t) => {
  const s = await setup({ maxBytes: 1024 }); t.after(s.stop);
  const r = await s.phone.upload(Buffer.alloc(4096, 7), { name: 'big.pdf' });
  assert.equal(r.status, 413);
  assert.deepEqual(fs.existsSync(s.receivedDir) ? fs.readdirSync(s.receivedDir) : [], []);
});

test('a file exactly at the limit is accepted', async (t) => {
  const s = await setup({ maxBytes: 1024 }); t.after(s.stop);
  assert.equal((await s.phone.upload(Buffer.alloc(1024, 7), { name: 'edge.pdf' })).status, 201);
});

test('path-trick file names are cleaned and stay in Received files', async (t) => {
  const s = await setup(); t.after(s.stop);
  const names = ['..\\..\\evil.txt', '../../evil2.txt', 'CON.txt', 'a<b>.txt'];
  const stored = [];
  for (const name of names) stored.push((await s.phone.upload(Buffer.from(name), { name })).json.storedAs);
  assert.deepEqual(stored, ['evil.txt', 'evil2.txt', '_CON.txt', 'a_b_.txt']);
  assert.ok(!fs.existsSync(path.join(s.dir, 'evil.txt')));
  assert.ok(!fs.existsSync(path.join(s.dir, '..', 'evil2.txt')));
});

test('receiving switched off: every request gets 403, and nothing is stored', async (t) => {
  const s = await setup({ receiving: false }); t.after(s.stop);
  assert.equal((await s.phone.ping()).status, 403);
  const up = await s.phone.upload(Buffer.from('x'));
  assert.equal(up.status, 403);
  assert.equal(up.json.error, 'receiving-off');
  s.state.receiving = true; // switching it back on works without a restart
  assert.equal((await s.phone.ping()).status, 200);
});

test('a device that is not approved yet gets 403 and the app is told', async (t) => {
  const s = await setup({ approved: false }); t.after(s.stop);
  const pending = [];
  s.server.on('pending', (d) => pending.push(d));
  const r = await s.phone.upload(Buffer.from('x'));
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'awaiting-approval');
  assert.equal(pending.length, 1);
  assert.equal(s.received.length, 0);

  s.pairing.approve(s.deviceId);
  assert.equal((await s.phone.upload(Buffer.from('x'))).status, 201);
});

test('revoking the phone makes its uploads fail with 401', async (t) => {
  const s = await setup(); t.after(s.stop);
  assert.equal((await s.phone.upload(Buffer.from('x'))).status, 201);
  s.pairing.revoke(s.deviceId);
  assert.equal((await s.phone.upload(Buffer.from('y'))).status, 401);
});

test('invalid requests get 422: bad uploadId, bad checksum text, missing or broken name, unknown destination', async (t) => {
  const s = await setup(); t.after(s.stop);
  const bytes = Buffer.from('x');
  assert.equal((await s.phone.upload(bytes, { uploadId: 'not-a-uuid' })).status, 422);
  assert.equal((await s.phone.upload(bytes, { sha: 'xyz' })).status, 422);
  assert.equal((await s.phone.upload(bytes, { headers: { 'X-File-Name': null } })).status, 422);
  assert.equal((await s.phone.upload(bytes, { headers: { 'X-File-Name': '%E0%A4%A' } })).status, 422);
  assert.equal((await s.phone.upload(bytes, { headers: { 'X-Dest-Id': 'tasks' } })).status, 422);
  assert.equal(s.received.length, 0);
});

test('too many uploads at once get 503', async (t) => {
  const s = await setup({ maxConcurrent: 0 }); t.after(s.stop);
  assert.equal((await s.phone.upload(Buffer.from('x'))).status, 503);
});

test('unknown paths get 404 and wrong methods 405', async (t) => {
  const s = await setup(); t.after(s.stop);
  assert.equal((await s.phone.request('GET', '/v1/nothing')).status, 404);
  assert.equal((await s.phone.request('POST', '/v1/ping')).status, 405);
});

test('a phone pinned to a different certificate refuses to talk', async (t) => {
  const s = await setup(); t.after(s.stop);
  const impostor = new FakePhone({ ...s.phone, fp: 'ab'.repeat(32) });
  await assert.rejects(impostor.ping(), /fingerprint/);
});
