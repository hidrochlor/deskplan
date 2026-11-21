import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakePhone } from './helpers/FakePhone.mjs';

const require = createRequire(import.meta.url);
const { ReceiverController } = require('../main/receiver/ReceiverController.js');
const { registerReceiverIpc } = require('../main/receiver/registerReceiverIpc.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-ctl-'));

class FakeAnnouncer {
  constructor() { this.calls = []; }
  start(o) { this.calls.push(['start', o.port]); }
  stop() { this.calls.push(['stop']); }
}

/** A controller on a free port, with a QR factory that records the token it was given. */
function make(dir = tmpDir(), extra = {}) {
  const announcer = new FakeAnnouncer();
  const qr = { tokens: [], lastOptions: null };
  const controller = new ReceiverController({
    dir, name: 'MY-PC', version: '1.2.3', port: 0, announcer,
    network: { current: async () => ({ interfaceName: 'Wi-Fi', address: '192.168.1.50', category: 'Private' }) }, // never run PowerShell in tests
    interfaces: () => ({ 'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.50', internal: false }] }),
    qrFactory: (o) => { qr.lastOptions = o; return { dataUrl: async (token) => { qr.tokens.push(token); return 'data:image/png;base64,QR'; } }; },
    ...extra,
  });
  return { dir, controller, announcer, qr };
}

test('by default receiving is off: no server, no announcement, no files', async () => {
  const { dir, controller, announcer } = make();
  await controller.start();
  const s = controller.status();
  assert.equal(s.enabled, false);
  assert.equal(s.listening, false);
  assert.deepEqual(announcer.calls, []);
  assert.deepEqual(fs.readdirSync(dir), []); // not even a certificate yet
  await assert.rejects(controller.startPairing(), /Switch receiving on/);
});

test('switching on starts the server and announces; switching off stops announcing but keeps answering 403', async (t) => {
  const { controller, announcer, qr } = make();
  t.after(() => controller.stop());
  await controller.start();

  const on = await controller.setEnabled(true);
  assert.equal(on.enabled, true);
  assert.equal(on.listening, true);
  assert.match(on.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(announcer.calls, [['start', on.port]]);

  const { id } = await controller.startPairing();
  const phone = new FakePhone({ port: on.port, token: qr.tokens[0], fp: on.fingerprint });
  assert.equal((await phone.ping()).status, 403); // waiting for approval
  controller.approve(id);
  assert.equal((await phone.ping()).status, 200);

  await controller.setEnabled(false);
  assert.equal(announcer.calls.at(-1)[0], 'stop');
  const off = await phone.ping();
  assert.equal(off.status, 403);
  assert.equal(off.json.error, 'receiving-off');
});

test('the QR carries the port in use, the fingerprint and the LAN address', async (t) => {
  const { controller, qr } = make();
  t.after(() => controller.stop());
  await controller.setEnabled(true);
  const result = await controller.startPairing();
  assert.equal(result.qrDataUrl, 'data:image/png;base64,QR');
  assert.deepEqual(qr.lastOptions, {
    name: 'MY-PC', port: controller.status().port, fingerprint: controller.status().fingerprint, hint: '192.168.1.50',
  });
  assert.ok(!JSON.stringify(result).includes(qr.tokens[0])); // the page never sees the token itself
});

test('the switch is remembered across a restart, and the same certificate is reused', async (t) => {
  const dir = tmpDir();
  const first = make(dir);
  await first.controller.setEnabled(true);
  const fp = first.controller.status().fingerprint;
  await first.controller.stop();

  const second = make(dir);
  t.after(() => second.controller.stop());
  await second.controller.start();
  assert.equal(second.controller.status().enabled, true);
  assert.equal(second.controller.status().fingerprint, fp);
  assert.equal(second.announcer.calls[0][0], 'start');
});

test('a file arrives: it is announced, kept until acknowledged, and survives a restart', async (t) => {
  const dir = tmpDir();
  const { controller, qr } = make(dir);
  t.after(() => controller.stop());
  await controller.setEnabled(true);
  const { id } = await controller.startPairing();
  controller.approve(id);
  const s = controller.status();
  const phone = new FakePhone({ port: s.port, token: qr.tokens[0], fp: s.fingerprint });

  const seen = [];
  controller.on('received', (r) => seen.push(r));
  const up = await phone.upload(Buffer.from('hello'), { name: 'a.txt' });
  assert.equal(up.status, 201);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].storedAs, 'a.txt');
  assert.equal(seen[0].deviceName, 'Test phone');

  // The screen was not open: a fresh controller on the same folder still has the record.
  assert.equal(make(dir).controller.pendingReceived().length, 1);
  controller.acknowledge([seen[0].uploadId]);
  assert.deepEqual(controller.pendingReceived(), []);
});

test('an unapproved device wakes the screen once, not on every retry', async (t) => {
  const { controller, qr } = make();
  t.after(() => controller.stop());
  await controller.setEnabled(true);
  await controller.startPairing();
  const s = controller.status();
  const phone = new FakePhone({ port: s.port, token: qr.tokens[0], fp: s.fingerprint });

  let changes = 0;
  controller.on('devices', () => { changes++; });
  await phone.ping(); await phone.ping(); await phone.ping();
  assert.equal(changes, 1);
});

test('revoking removes the device and stops its uploads', async (t) => {
  const { controller, qr } = make();
  t.after(() => controller.stop());
  await controller.setEnabled(true);
  const { id } = await controller.startPairing();
  controller.approve(id);
  const s = controller.status();
  const phone = new FakePhone({ port: s.port, token: qr.tokens[0], fp: s.fingerprint });
  assert.equal((await phone.ping()).status, 200);
  controller.revoke(id);
  assert.equal((await phone.ping()).status, 401);
  assert.deepEqual(controller.status().devices, []);
});

test('if the first port is taken, the next free one is used', async (t) => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '0.0.0.0', r));
  t.after(() => blocker.close());
  const taken = blocker.address().port;

  const { controller } = make(tmpDir(), { port: taken });
  t.after(() => controller.stop());
  await controller.setEnabled(true);
  assert.notEqual(controller.status().port, taken);
  assert.ok(controller.status().port > taken && controller.status().port < taken + 10);
});

test('files are stored in "Received files"; an old "inbox" folder is renamed with its files', () => {
  assert.equal(path.basename(make().controller.receivedDir), 'Received files');

  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'inbox'));
  fs.writeFileSync(path.join(dir, 'inbox', 'old.pdf'), 'kept');
  const { controller } = make(dir);
  assert.equal(controller.receivedDir, path.join(dir, 'Received files'));
  assert.ok(!fs.existsSync(path.join(dir, 'inbox')));
  assert.equal(fs.readFileSync(controller.resolveReceivedFile('old.pdf'), 'utf8'), 'kept'); // entries received before still open
});

test('resolveReceivedFile refuses anything outside the Received files folder', async () => {
  const { controller } = make();
  fs.mkdirSync(controller.receivedDir, { recursive: true });
  fs.writeFileSync(path.join(controller.receivedDir, 'ok.txt'), 'x');
  assert.equal(controller.resolveReceivedFile('ok.txt'), path.join(controller.receivedDir, 'ok.txt'));
  assert.throws(() => controller.resolveReceivedFile('..\\receiver-settings.json'));
  assert.throws(() => controller.resolveReceivedFile('../../x'));
  assert.throws(() => controller.resolveReceivedFile('missing.txt'));
  assert.throws(() => controller.resolveReceivedFile(undefined));
});

test('deleteReceivedFile removes a stored file, tolerates one already gone, refuses paths outside the Received files folder', () => {
  const { dir, controller } = make();
  fs.mkdirSync(controller.receivedDir, { recursive: true });
  fs.writeFileSync(path.join(controller.receivedDir, 'a.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'receiver-settings.json'), '{}');

  controller.deleteReceivedFile('a.txt');
  assert.ok(!fs.existsSync(path.join(controller.receivedDir, 'a.txt')));
  controller.deleteReceivedFile('a.txt'); // again: no error
  assert.throws(() => controller.deleteReceivedFile('..\\receiver-settings.json'), /Not a received file/);
  assert.throws(() => controller.deleteReceivedFile(undefined), /Not a received file/);
  assert.ok(fs.existsSync(path.join(dir, 'receiver-settings.json')));
});

test('IPC: handlers are registered, arguments are checked, events reach the window', async () => {
  const { controller } = make();
  const handlers = new Map();
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (ch, payload) => sent.push([ch, payload]) } };
  const opened = [];
  registerReceiverIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    shell: { openPath: async (p) => opened.push(p), showItemInFolder: (p) => opened.push(p) },
    controller, getWindow: () => win,
  });

  assert.deepEqual([...handlers.keys()].sort(), [
    'receiver:acknowledge', 'receiver:approve', 'receiver:attach-file', 'receiver:delete-file', 'receiver:item-reply', 'receiver:open-file', 'receiver:open-folder', 'receiver:pending-received',
    'receiver:rename', 'receiver:reveal-file', 'receiver:revoke', 'receiver:set-enabled', 'receiver:start-pairing', 'receiver:status',
  ]);

  // Only a real `true` switches receiving on; anything else counts as off.
  const on = await handlers.get('receiver:set-enabled')({}, 'yes');
  assert.equal(on.enabled, false);
  await handlers.get('receiver:set-enabled')({}, true);
  assert.equal(controller.status().enabled, true);
  assert.ok(sent.some(([ch]) => ch === 'receiver:devices'));

  await handlers.get('receiver:open-folder')({});
  assert.deepEqual(opened, [controller.receivedDir]);
  await assert.rejects(async () => handlers.get('receiver:open-file')({}, '..\\..\\Windows\\notepad.exe'));

  controller.emit('received', { uploadId: 'u1' });
  assert.deepEqual(sent.at(-1), ['receiver:received', { uploadId: 'u1' }]);

  win.isDestroyed = () => true; // a closed window must not throw
  controller.emit('received', { uploadId: 'u2' });
  await controller.stop();
});

test('a phone syncing tells the screen (so "last seen" is live), but no more than every 10 seconds', async (t) => {
  const { controller, qr } = make();
  t.after(() => controller.stop());
  await controller.setEnabled(true);
  const { id } = await controller.startPairing();
  controller.approve(id);
  const s = controller.status();
  const phone = new FakePhone({ port: s.port, token: qr.tokens[0], fp: s.fingerprint });

  let changes = 0;
  controller.on('devices', () => { changes++; });
  await phone.ping(); await phone.ping(); await phone.ping();
  assert.equal(changes, 1);                                                 // three requests, one announcement
  assert.ok(controller.status().devices[0].lastSeen >= Date.now() - 5000);  // and the status carries the live time

  controller.lastSeenEmit -= 11_000;                                        // ten seconds later...
  await phone.ping();
  assert.equal(changes, 2);
});

test('a phone that is not approved yet does not count as "seen" (it gets the waiting-for-approval path only)', async (t) => {
  const { controller, qr } = make();
  t.after(() => controller.stop());
  await controller.setEnabled(true);
  await controller.startPairing();
  const s = controller.status();
  const phone = new FakePhone({ port: s.port, token: qr.tokens[0], fp: s.fingerprint });

  let seen = 0;
  controller.server.on('seen', () => { seen++; });
  assert.equal((await phone.ping()).status, 403);
  assert.equal(seen, 0);
});

test('renameDevice names a paired phone, tells the screen, and refuses unknown ids', async (t) => {
  const { controller, qr } = make();
  t.after(() => controller.stop());
  await controller.setEnabled(true);
  const { id } = await controller.startPairing();
  const s = controller.status();
  await new FakePhone({ port: s.port, token: qr.tokens[0], fp: s.fingerprint, deviceName: '' }).ping(); // a phone that sends no name
  assert.equal(controller.status().devices[0].name, '');

  let changes = 0;
  controller.on('devices', () => { changes++; });
  assert.equal(controller.renameDevice(id, 'Mum\'s phone'), true);
  assert.equal(controller.status().devices[0].name, 'Mum\'s phone');
  assert.equal(changes, 1);
  assert.equal(controller.renameDevice('nope', 'x'), false);
});
