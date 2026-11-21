import test, { before } from 'node:test';
import { rulesFor } from './helpers/rulesFor.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakePhone, makeTestCert, sha256 } from './helpers/FakePhone.mjs';
import { EventBus } from '../renderer/core/EventBus.js';
import { Registry } from '../renderer/core/Registry.js';
import { Store } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { Item } from '../renderer/modules/workspace/Item.js';
import { ReceivedFile } from '../renderer/modules/receivedfiles/ReceivedFile.js';
import { ReceivedFilesIntake } from '../renderer/modules/receivedfiles/ReceivedFilesIntake.js';
import { ItemSync } from '../renderer/modules/phonesync/ItemSync.js';
import { FolderDestinations } from '../renderer/modules/phonesync/FolderDestinations.js';
import { PhoneRequests } from '../renderer/modules/phonesync/PhoneRequests.js';

const require = createRequire(import.meta.url);
const { ReceiverController } = require('../main/receiver/ReceiverController.js');
const { RendererItemGateway } = require('../main/receiver/RendererItemGateway.js');
const { ReceiverServer } = require('../main/receiver/ReceiverServer.js');
const { PairingManager } = require('../main/receiver/PairingManager.js');
const { FileSink } = require('../main/receiver/FileSink.js');
const { UploadLedger } = require('../main/receiver/UploadLedger.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-dest-'));
const UP = '3f1c1e0e-8f6b-4c53-9d0a-2b1f6f7a9c11';

let cert;
before(async () => { cert = await makeTestCert(); });

function renderer(rows = []) {
  const bus = new EventBus();
  const registry = new Registry();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('items', Item);
  store.define('receivedFiles', ReceivedFile);
  store.collection('items').load(rows);
  const toasts = [];
  bus.on('toast:show', (t) => toasts.push(t));
  return { bus, registry, store, items: store.collection('items'), toasts };
}
const folder = (id, title, extra = {}) => ({ id, kind: 'folder', title, parentId: null, createdAt: '', updatedAt: '', ...extra });

// ── FolderDestinations ───────────────────────────────────────────────────────

test('list: folders with full paths, A to Z; files and notes are not destinations; a task with things inside is', () => {
  const r = renderer([
    folder('f2', 'Math'), folder('f1', 'CSC101'), folder('f3', 'Week 1', { parentId: 'f1' }),
    { id: 'n1', kind: 'note', title: 'A note', parentId: 'f1' }, { id: 'x1', kind: 'file', title: 'pic.png', parentId: 'f1', file: {} },
    { id: 't1', kind: 'task', title: 'Lab report', parentId: null }, { id: 'a1', kind: 'file', title: 'in task.pdf', parentId: 't1', file: {} },
    { id: 't2', kind: 'task', title: 'Empty task', parentId: null }, folder('old', 'Old course', { kind: 'course' }),
  ]);
  const d = new FolderDestinations({ store: r.store, bus: r.bus, attach: async () => ({}) });
  assert.deepEqual(d.list().map((x) => [x.id, x.label, x.name, x.depth]), [
    ['folder:f1', 'CSC101', 'CSC101', 0],
    ['folder:f3', 'CSC101 › Week 1', 'Week 1', 1],
    ['folder:t1', 'Lab report', 'Lab report', 0],
    ['folder:f2', 'Math', 'Math', 0],
    ['folder:old', 'Old course', 'Old course', 0],
  ]);
});

test('list: a missing parent or a loop cannot break it', () => {
  const r = renderer([folder('a', 'A', { parentId: 'b' }), folder('b', 'B', { parentId: 'a' }), folder('c', 'C', { parentId: 'ghost' })]);
  const d = new FolderDestinations({ store: r.store, bus: r.bus, attach: async () => ({}) });
  assert.deepEqual(d.list().map((x) => x.label).sort(), ['A › B', 'B › A', 'C']);
});

test('has: only an existing folder, only with the folder: prefix', () => {
  const r = renderer([folder('f1', 'CSC101'), { id: 'x1', kind: 'file', title: 'p', parentId: null, file: {} }]);
  const d = new FolderDestinations({ store: r.store, bus: r.bus, attach: async () => ({}) });
  assert.equal(d.has('folder:f1'), true);
  for (const no of ['f1', 'folder:nope', 'folder:x1', 'received-files', 'inbox', '', null, undefined, 5]) assert.equal(d.has(no), false, String(no));
});

test('without the workspace data there are no folders', () => {
  const bus = new EventBus();
  const d = new FolderDestinations({ store: new Store({ bus, storage: new MemoryStorage() }), bus, attach: async () => ({}) });
  assert.deepEqual(d.list(), []);
  assert.equal(d.has('folder:f1'), false);
});

test('accept: adds a file item inside the folder, once, and says so', async () => {
  const r = renderer([folder('f1', 'CSC101')]);
  const attached = [];
  const d = new FolderDestinations({
    store: r.store, bus: r.bus,
    attach: async (storedAs, uploadId) => { attached.push([storedAs, uploadId]); return { name: storedAs, path: `${uploadId}/${storedAs}`, size: 9, ext: 'png' }; },
  });
  const record = { uploadId: UP, storedAs: 'diagram.png', destination: 'folder:f1', deviceName: 'Galaxy' };

  assert.equal(await d.accept(record), true);
  const file = r.items.all().find((i) => i.kind === 'file');
  assert.deepEqual([file.title, file.parentId, file.file.path, file.isFile], ['diagram.png', 'f1', `${UP}/diagram.png`, true]);
  assert.match(r.toasts[0].text, /Saved in CSC101, from Galaxy/);

  assert.equal(await d.accept(record), true); // handled again after a restart
  assert.equal(r.items.all().filter((i) => i.kind === 'file').length, 1);
  assert.deepEqual(attached.length, 2);
});

test('accept: false (so the file stays in Received files) if the folder is gone or the move fails', async () => {
  const r = renderer([folder('f1', 'CSC101')]);
  const quiet = console.error; console.error = () => {};
  try {
    const gone = new FolderDestinations({ store: r.store, bus: r.bus, attach: async () => ({ name: 'a', path: 'x/a' }) });
    assert.equal(await gone.accept({ uploadId: UP, storedAs: 'a', destination: 'folder:deleted' }), false);
    const broken = new FolderDestinations({ store: r.store, bus: r.bus, attach: async () => { throw new Error('disk full'); } });
    assert.equal(await broken.accept({ uploadId: UP, storedAs: 'a', destination: 'folder:f1' }), false);
  } finally { console.error = quiet; }
  assert.equal(r.items.all().filter((i) => i.kind === 'file').length, 0);
});

// ── PhoneRequests ────────────────────────────────────────────────────────────

test('PhoneRequests answers destinations and exists from the providers, and passes tasks to ItemSync', () => {
  const r = renderer([folder('f1', 'CSC101')]);
  r.registry.register('destination', new FolderDestinations({ store: r.store, bus: r.bus, attach: async () => ({}) }));
  const router = new PhoneRequests({ sync: new ItemSync({ rulesFor, store: r.store }), registry: r.registry });

  assert.deepEqual(router.handle({ op: 'destinations', payload: {} }).body.destinations.map((d) => d.id), ['folder:f1']);
  assert.equal(router.handle({ op: 'destination-exists', payload: { id: 'folder:f1' } }).body.exists, true);
  assert.equal(router.handle({ op: 'destination-exists', payload: { id: 'folder:zz' } }).body.exists, false);
  assert.equal(router.handle({ op: 'destination-exists', payload: {} }).body.exists, false);
  assert.equal(router.handle({ op: 'delete', payload: { id: 'nothing' } }).status, 200); // went to ItemSync

  const none = new PhoneRequests({ sync: { handle: () => ({}) }, registry: new Registry() });
  assert.deepEqual(none.handle({ op: 'destinations' }).body.destinations, []);
});

// ── ReceivedFilesIntake with destinations ────────────────────────────────────────────

function intakeSetup(rows, attach) {
  const r = renderer(rows);
  r.registry.register('destination', new FolderDestinations({ store: r.store, bus: r.bus, attach }));
  const acked = [];
  const api = { acknowledge: async (ids) => { acked.push(...ids); }, onReceived() {}, pendingReceived: async () => [] };
  return { ...r, acked, intake: new ReceivedFilesIntake({ store: r.store, api, ReceivedFile, registry: r.registry }) };
}
const rec = (extra = {}) => ({ uploadId: UP, fileName: 'a.png', storedAs: 'a.png', size: 5, sha256: 'ab'.repeat(32), receivedAt: '2026-10-29T10:00:00Z', deviceName: 'Galaxy', destination: 'received-files', ...extra });
const okAttach = async (s, u) => ({ name: s, path: `${u}/${s}`, size: 5, ext: 'png' });

test('intake: a file addressed to a folder is filed there, not listed in Received files, and acknowledged', async () => {
  const s = intakeSetup([folder('f1', 'CSC101')], okAttach);
  await s.intake.take([rec({ destination: 'folder:f1' })]);
  assert.equal(s.store.collection('receivedFiles').all().length, 0);
  assert.equal(s.items.all().filter((i) => i.kind === 'file' && i.parentId === 'f1').length, 1);
  assert.deepEqual(s.acked, [UP]);
});

test('intake: a folder that was deleted meanwhile, or a failed move, puts the file in Received files instead', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const gone = intakeSetup([], okAttach);
    await gone.intake.take([rec({ destination: 'folder:deleted' })]);
    assert.equal(gone.store.collection('receivedFiles').all().length, 1);
    assert.equal(gone.store.collection('receivedFiles').all()[0].destination, 'folder:deleted'); // kept, so it is clear where it was meant to go

    const broken = intakeSetup([folder('f1', 'X')], async () => { throw new Error('nope'); });
    await broken.intake.take([rec({ destination: 'folder:f1' })]);
    assert.equal(broken.store.collection('receivedFiles').all().length, 1);
    assert.deepEqual(broken.acked, [UP]); // acknowledged: it is safe in Received files
  } finally { console.error = quiet; }
});

test('intake: with no destination providers (module removed) a folder upload goes to Received files', async () => {
  const r = renderer([folder('f1', 'X')]);
  const api = { acknowledge: async () => {}, onReceived() {}, pendingReceived: async () => [] };
  await new ReceivedFilesIntake({ store: r.store, api, ReceivedFile, registry: r.registry }).take([rec({ destination: 'folder:f1' })]);
  assert.equal(r.store.collection('receivedFiles').all().length, 1);
});

// ── ReceiverController.attachReceivedFile ───────────────────────────────────────

function controllerWithReceived() {
  const dir = tmpDir();
  const controller = new ReceiverController({ dir, port: 0, announcer: { start() {}, stop() {} }, network: { current: async () => ({ category: 'Private' }) } });
  fs.mkdirSync(controller.receivedDir, { recursive: true });
  return { dir, controller };
}

test('attachReceivedFile moves the file into files/<uploadId>/ and returns the item file shape', () => {
  const { dir, controller } = controllerWithReceived();
  fs.writeFileSync(path.join(controller.receivedDir, 'Diagram.PNG'), 'pixels');
  const info = controller.attachReceivedFile('Diagram.PNG', UP);
  assert.deepEqual(info, { name: 'Diagram.PNG', path: `${UP}/Diagram.PNG`, size: 6, ext: 'png' });
  assert.equal(fs.readFileSync(path.join(dir, 'files', UP, 'Diagram.PNG'), 'utf8'), 'pixels');
  assert.ok(!fs.existsSync(path.join(controller.receivedDir, 'Diagram.PNG'))); // moved, not copied
});

test('attachReceivedFile is safe to repeat, and never grabs a different file that took the same name', () => {
  const { controller } = controllerWithReceived();
  fs.writeFileSync(path.join(controller.receivedDir, 'a.txt'), 'first');
  const once = controller.attachReceivedFile('a.txt', UP);
  fs.writeFileSync(path.join(controller.receivedDir, 'a.txt'), 'second upload, same name'); // a later upload reuses the freed name
  assert.deepEqual(controller.attachReceivedFile('a.txt', UP), once);                          // the retry for the first one
  assert.equal(fs.readFileSync(path.join(controller.receivedDir, 'a.txt'), 'utf8'), 'second upload, same name'); // untouched
});

test('attachReceivedFile refuses odd ids and names, and files that are not there', () => {
  const { controller } = controllerWithReceived();
  fs.writeFileSync(path.join(controller.receivedDir, 'a.txt'), 'x');
  for (const [name, id] of [['a.txt', 'not-a-uuid'], ['a.txt', '../../x'], ['..\\a.txt', UP], ['../a.txt', UP], ['sub/a.txt', UP], ['', UP], [undefined, UP]]) {
    assert.throws(() => controller.attachReceivedFile(name, id), undefined, `${name} / ${id}`);
  }
  assert.throws(() => controller.attachReceivedFile('missing.txt', UP), /Not a received file/);
  assert.ok(fs.existsSync(path.join(controller.receivedDir, 'a.txt')));
});

// ── The server side ──────────────────────────────────────────────────────────

async function serverSetup({ items }) {
  const dir = tmpDir();
  const pairing = new PairingManager();
  const server = new ReceiverServer({
    tls: cert, pairing, sink: new FileSink(path.join(dir, 'received')), ledger: new UploadLedger(),
    name: 'TEST-PC', version: '0.1.0', isReceiving: () => true, items,
  });
  const port = await server.listen(0, '127.0.0.1');
  const { id, token } = pairing.startPairing();
  pairing.authenticate(token); pairing.approve(id);
  return { phone: new FakePhone({ port, token, fp: cert.fp }), stop: () => server.close(), dir };
}
/** An items gateway stand-in that knows some folders. */
function folderGateway(folders, { notReady = false } = {}) {
  const calls = [];
  return {
    calls,
    request: async (op, payload) => {
      calls.push([op, payload?.id]);
      if (notReady) return { status: 503, body: { error: 'app-not-ready' } };
      if (op === 'destinations') return { status: 200, body: { destinations: folders.map((f) => ({ id: `folder:${f}`, label: f, name: f, depth: 0 })) } };
      if (op === 'destination-exists') return { status: 200, body: { exists: folders.includes(String(payload.id).slice(7)) } };
      return { status: 200, body: {} };
    },
  };
}

test('ping lists Received files plus the folders; if the page does not answer it lists Received files only', async (t) => {
  const s = await serverSetup({ items: folderGateway(['f1', 'f2']) }); t.after(s.stop);
  assert.deepEqual((await s.phone.ping()).json.destinations.map((d) => d.id), ['received-files', 'folder:f1', 'folder:f2']);
  assert.deepEqual((await s.phone.ping()).json.destinations[1], { id: 'folder:f1', label: 'f1', name: 'f1', depth: 0 });

  const quiet = await serverSetup({ items: folderGateway([], { notReady: true }) }); t.after(quiet.stop);
  assert.deepEqual((await quiet.phone.ping()).json.destinations, [{ id: 'received-files', label: 'Received files' }]);
});

test('an upload to an existing folder is accepted and the answer says where it was addressed', async (t) => {
  const items = folderGateway(['f1']);
  const s = await serverSetup({ items }); t.after(s.stop);
  const bytes = Buffer.from('image bytes');
  const r = await s.phone.upload(bytes, { name: 'pic.png', headers: { 'X-Dest-Id': 'folder:f1' } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { received: true, sha256: sha256(bytes), storedAs: 'pic.png', destination: 'folder:f1' });
  assert.deepEqual(items.calls.at(-1), ['destination-exists', 'folder:f1']);
});

test('an upload to a folder that does not exist, or a made-up destination, gets 422 and keeps nothing', async (t) => {
  const s = await serverSetup({ items: folderGateway(['f1']) }); t.after(s.stop);
  const bytes = Buffer.from('x');
  for (const dest of ['folder:gone', 'folder:', 'folder:../x', 'folder:a b', 'tasks', 'Inbox', 'folder:' + 'x'.repeat(65)]) {
    const r = await s.phone.upload(bytes, { headers: { 'X-Dest-Id': dest } });
    assert.deepEqual([r.status, r.json.error], [422, 'unknown-destination'], dest);
  }
  const receivedDir = path.join(s.dir, 'received');
  assert.deepEqual(fs.existsSync(receivedDir) ? fs.readdirSync(receivedDir).filter((f) => f !== '.partial') : [], []);
});

test('a folder upload while the page is not ready gets 503 (retry), and without the items gateway it is 422', async (t) => {
  const busy = await serverSetup({ items: folderGateway(['f1'], { notReady: true }) }); t.after(busy.stop);
  const r = await busy.phone.upload(Buffer.from('x'), { headers: { 'X-Dest-Id': 'folder:f1' } });
  assert.deepEqual([r.status, r.json.error], [503, 'app-not-ready']);

  const bare = await serverSetup({ items: null }); t.after(bare.stop);
  assert.equal((await bare.phone.upload(Buffer.from('x'), { headers: { 'X-Dest-Id': 'folder:f1' } })).status, 422);
});

test('a retry of a finished upload still gets 200 even if its folder was deleted since', async (t) => {
  const folders = ['f1'];
  const s = await serverSetup({ items: folderGateway(folders) }); t.after(s.stop);
  const bytes = Buffer.from('once');
  const first = await s.phone.upload(bytes, { uploadId: UP, headers: { 'X-Dest-Id': 'folder:f1' } });
  folders.length = 0; // the folder is deleted on the PC
  const again = await s.phone.upload(bytes, { uploadId: UP, headers: { 'X-Dest-Id': 'folder:f1' } });
  assert.deepEqual([first.status, again.status], [201, 200]);
  assert.deepEqual(again.json, first.json);
});

// ── Everything together ──────────────────────────────────────────────────────

test('end to end: a phone sends an image to the CSC folder and it ends up as a file item there, on disk, not in Received files', async (t) => {
  const dir = tmpDir();
  const r = renderer([folder('csc', 'CSC101')]);
  const requests = new PhoneRequests({ sync: new ItemSync({ rulesFor, store: r.store }), registry: r.registry });

  // The pieces as the app joins them: server -> gateway -> (IPC) -> page requests, and page -> controller for the file move.
  let gateway;
  const win = { isDestroyed: () => false, webContents: { send: (_ch, { requestId, op, payload }) => setImmediate(() => gateway.reply(requestId, requests.handle({ op, payload }))) } };
  gateway = new RendererItemGateway({ getWindow: () => win });
  let token = null;
  const controller = new ReceiverController({
    dir, port: 0, items: gateway, announcer: { start() {}, stop() {} }, network: { current: async () => ({ category: 'Private' }) },
    qrFactory: () => ({ dataUrl: async (t2) => { token = t2; return 'x'; } }),
  });
  t.after(() => controller.stop());
  r.registry.register('destination', new FolderDestinations({ store: r.store, bus: r.bus, attach: async (s, u) => controller.attachReceivedFile(s, u) }));
  const intake = new ReceivedFilesIntake({ store: r.store, api: { acknowledge: async (ids) => controller.acknowledge(ids), onReceived() {}, pendingReceived: async () => [] }, ReceivedFile, registry: r.registry });
  controller.on('received', (record) => { intake.take([record]); });

  await controller.setEnabled(true);
  const { id } = await controller.startPairing();
  controller.approve(id);
  const s = controller.status();
  const phone = new FakePhone({ port: s.port, token, fp: s.fingerprint });

  const ping = await phone.ping();
  assert.deepEqual(ping.json.destinations.map((d) => d.id), ['received-files', 'folder:csc']);

  const image = Buffer.from('not really a png');
  const up = await phone.upload(image, { uploadId: UP, name: 'whiteboard.png', headers: { 'X-Dest-Id': 'folder:csc' } });
  assert.deepEqual([up.status, up.json.destination], [201, 'folder:csc']);
  await new Promise((resolve) => setTimeout(resolve, 150)); // the page files it right after the event

  const file = r.items.all().find((i) => i.kind === 'file');
  assert.deepEqual([file.title, file.parentId, file.file.size, file.file.ext], ['whiteboard.png', 'csc', image.length, 'png']);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'files', file.file.path)), image);       // where the app looks for attached files
  assert.ok(!fs.existsSync(path.join(controller.receivedDir, 'whiteboard.png')));              // not left behind in Received files
  assert.equal(r.store.collection('receivedFiles').all().length, 0);                                 // and not listed there
  assert.deepEqual(controller.pendingReceived(), []);                                        // acknowledged
});
