import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { PairingManager } = createRequire(import.meta.url)('../main/receiver/PairingManager.js');

test('a token works, and the first connection waits for approval', () => {
  const p = new PairingManager();
  const { id, token } = p.startPairing();
  assert.equal(Buffer.from(token, 'base64').length, 32);

  const device = p.authenticate(token);
  assert.equal(device.id, id);
  assert.equal(device.approved, false);

  p.approve(id);
  assert.equal(p.authenticate(token).approved, true);
});

test('with requireApproval off, the first connection is approved at once', () => {
  const p = new PairingManager({ requireApproval: false });
  const { token } = p.startPairing();
  assert.equal(p.authenticate(token).approved, true);
});

test('unknown, empty and revoked tokens are refused', () => {
  const p = new PairingManager({ requireApproval: false });
  const { id, token } = p.startPairing();
  assert.equal(p.authenticate('nope'), null);
  assert.equal(p.authenticate(''), null);
  assert.equal(p.authenticate(undefined), null);
  assert.ok(p.authenticate(token));
  assert.equal(p.revoke(id), true);
  assert.equal(p.authenticate(token), null);
  assert.equal(p.revoke(id), false);
});

test('a QR nobody scanned in time stops working, a scanned one keeps working', () => {
  let t = 1_000;
  const p = new PairingManager({ unclaimedTtlMs: 100, now: () => t });
  const stale = p.startPairing();
  const used = p.startPairing();
  assert.ok(p.authenticate(used.token));
  t += 500;
  assert.equal(p.authenticate(stale.token), null);
  assert.ok(p.authenticate(used.token));
});

test('list shows scanned devices only and never exposes hashes or tokens', () => {
  const p = new PairingManager();
  const a = p.startPairing();
  p.startPairing(); // never scanned
  p.authenticate(a.token);
  p.rename(a.id, 'Galaxy S24');
  p.rename(a.id, 'Other name'); // the first name sticks
  const list = p.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Galaxy S24');
  assert.ok(!('tokenHash' in list[0]) && !JSON.stringify(list).includes(a.token));
});

test('devices survive a restart, and the file holds no plain token', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-pair-')), 'paired.json');
  const first = new PairingManager({ file, requireApproval: false });
  const { token } = first.startPairing();
  first.authenticate(token);

  assert.ok(new PairingManager({ file }).authenticate(token));
  assert.ok(!fs.readFileSync(file, 'utf8').includes(token));
});

test('setName: the user can name a phone, replace a name, and then the phone\'s own name is ignored', () => {
  const p = new PairingManager({ requireApproval: false });
  const { id, token } = p.startPairing();
  p.authenticate(token);

  assert.equal(p.setName(id, '  My Galaxy  '), true);
  assert.equal(p.list()[0].name, 'My Galaxy');
  p.rename(id, 'Name from the phone');             // the phone introduces itself later
  assert.equal(p.list()[0].name, 'My Galaxy');     // the user's name stays
  p.setName(id, 'x'.repeat(200));
  assert.equal(p.list()[0].name.length, 80);
  p.setName(id, '');                               // clearing lets the phone name itself again
  p.rename(id, 'Galaxy S24');
  assert.equal(p.list()[0].name, 'Galaxy S24');
  assert.equal(p.setName('no-such-id', 'x'), false);
});

test('expired unscanned codes are removed from the file, scanned phones are kept', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-pair-')), 'paired.json');
  let t = 1_000;
  const p = new PairingManager({ file, unclaimedTtlMs: 100, now: () => t });
  const stale = p.startPairing();
  const used = p.startPairing();
  p.authenticate(used.token);
  t += 500;
  p.startPairing(); // making a new code tidies the old ones away
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).devices;
  assert.equal(saved.length, 2);
  assert.ok(!saved.some((d) => d.id === stale.id));
  assert.ok(saved.some((d) => d.id === used.id));
  assert.equal(new PairingManager({ file, now: () => t }).list().length, 1); // and after a restart
});

test('"last seen" is written to disk at most every 30 seconds, but a failing disk never breaks authentication', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-pair-')), 'paired.json');
  let t = 1_000_000;
  const p = new PairingManager({ file, requireApproval: false, now: () => t });
  const { token } = p.startPairing();
  p.authenticate(token);
  const writes = () => JSON.parse(fs.readFileSync(file, 'utf8')).devices[0].lastSeen;
  const first = writes();

  t += 5_000; p.authenticate(token);
  assert.equal(writes(), first);                 // not rewritten yet
  assert.equal(p.list()[0].lastSeen, t);         // but the screen sees the live value
  t += 40_000; p.authenticate(token);
  assert.equal(writes(), t);                     // now it is

  // A file that cannot be written (here: the path is a folder) must not make authenticate throw.
  const broken = new PairingManager({ file: os.tmpdir(), requireApproval: false });
  const b = broken.startPairing();
  assert.ok(broken.authenticate(b.token));
});
