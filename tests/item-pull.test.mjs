import test, { before } from 'node:test';
import { rulesFor } from './helpers/rulesFor.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakePhone, makeTestCert } from './helpers/FakePhone.mjs';
import { EventBus } from '../renderer/core/EventBus.js';
import { Registry } from '../renderer/core/Registry.js';
import { Store } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { Item } from '../renderer/modules/workspace/Item.js';
import { ItemSync } from '../renderer/modules/phonesync/ItemSync.js';
import { SyncLog, RETENTION_MS } from '../renderer/modules/phonesync/SyncLog.js';
import { ItemPull } from '../renderer/modules/phonesync/ItemPull.js';
import { PhoneRequests } from '../renderer/modules/phonesync/PhoneRequests.js';

const require = createRequire(import.meta.url);
const { ReceiverServer } = require('../main/receiver/ReceiverServer.js');
const { PairingManager } = require('../main/receiver/PairingManager.js');
const { FileSink } = require('../main/receiver/FileSink.js');
const { UploadLedger } = require('../main/receiver/UploadLedger.js');
const { RendererItemGateway } = require('../main/receiver/RendererItemGateway.js');

let cert;
before(async () => { cert = await makeTestCert(); });

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const row = (id, kind, extra = {}) => ({
  id, kind, title: `${kind} ${id}`, status: 'todo', description: '', parentId: null, deadline: null,
  completedAt: null, createdAt: iso(T0 - 99 * MIN), updatedAt: iso(T0 - 99 * MIN), ...extra,
});

/** A store with items, a log and a pull handler, all on one controllable clock. */
function setup(rows = [], { start = true } = {}) {
  const clock = { t: T0 };
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('items', Item);
  store.collection('items').load(rows);
  const log = new SyncLog({ store, bus, now: () => clock.t });
  if (start) log.start();
  const pull = new ItemPull({ rulesFor, store, log, now: () => clock.t });
  return { clock, bus, store, items: store.collection('items'), log, pull };
}

// ── SyncLog ─────────────────────────────────────────────────────────────────

test('SyncLog: deleting a task, assignment or note is recorded; deleting a folder or file is not', () => {
  const s = setup([row('t1', 'task'), row('a1', 'assignment'), row('f1', 'folder'), row('n1', 'note'), row('x1', 'file')]);
  s.clock.t = T0 + MIN;
  for (const id of ['t1', 'a1', 'f1', 'n1', 'x1']) s.items.remove(id);
  assert.deepEqual(s.log.deletedSince(0).map((d) => d.id).sort(), ['a1', 'n1', 't1']);
  assert.equal(s.log.deletedSince(0)[0].at, iso(T0 + MIN));
});

test('SyncLog: a task that becomes a folder counts as gone; a folder that becomes a task does not', () => {
  const s = setup([row('t1', 'task'), row('f1', 'folder')]);
  s.items.update('t1', { kind: 'folder' });
  s.items.update('f1', { kind: 'task' });
  assert.deepEqual(s.log.deletedSince(0).map((d) => d.id), ['t1']);
  s.items.update('f1', { title: 'renamed' }); // still a task, still known
  s.items.remove('f1');
  assert.deepEqual(s.log.deletedSince(0).map((d) => d.id).sort(), ['f1', 't1']); // a task made on the PC later is tracked too
});

test('SyncLog: an id that exists again is no longer a deletion', () => {
  const s = setup([row('t1', 'task')]);
  s.items.remove('t1');
  assert.equal(s.log.deletedSince(0).length, 1);
  s.items.add({ id: 't1', kind: 'task', title: 'back' }); // the phone sent it again
  assert.equal(s.log.deletedSince(0).length, 0);
  s.items.update('t1', { kind: 'folder' });
  assert.equal(s.log.deletedSince(0).length, 1);          // and can go away again
});

test('SyncLog: deletions survive a restart (they live in the data file)', async () => {
  const s = setup([row('t1', 'task')]);
  s.clock.t = T0 + 5 * MIN;
  s.items.remove('t1');

  const bus2 = new EventBus();
  const store2 = new Store({ bus: bus2, storage: new MemoryStorage(JSON.parse(JSON.stringify(s.store.toJSON()))) });
  store2.define('items', Item);
  await store2.load();
  const log2 = new SyncLog({ store: store2, bus: bus2, now: () => T0 + 60 * MIN });
  log2.start();
  assert.deepEqual(log2.deletedSince(0).map((d) => d.id), ['t1']);
  assert.equal(log2.horizonMs, T0);                       // the horizon is when tracking began, not when we restarted
});

test('SyncLog: horizon starts when tracking starts; 90-day-old records are dropped and move the horizon', () => {
  const s = setup([row('t1', 'task'), row('t2', 'task')]);
  assert.equal(s.log.horizonMs, T0);

  s.items.remove('t1');                                    // recorded at T0
  s.clock.t = T0 + RETENTION_MS + MIN;                     // 90 days and a minute later
  s.items.remove('t2');                                    // recording this prunes the old one
  assert.deepEqual(s.log.deletedSince(0).map((d) => d.id), ['t2']);
  assert.equal(s.log.horizonMs, T0);                       // the dropped record was made exactly at T0
  assert.equal(s.log.deletedSince(0).length, 1);            // t2 is only a minute past the cutoff, so it stays
  s.clock.t = T0 + 3 * RETENTION_MS;                        // much later: now t2 is old too
  s.items.add({ id: 't3', kind: 'task' }); s.items.remove('t3');
  assert.deepEqual(s.log.deletedSince(0).map((d) => d.id), ['t3']);
  assert.equal(s.log.horizonMs, T0 + RETENTION_MS + MIN);  // t2's time: deletions before this may be unknown
});

test('SyncLog: without the workspace data it does nothing and does not throw', () => {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  const log = new SyncLog({ store, bus });
  assert.doesNotThrow(() => log.start());
});

// ── ItemPull ────────────────────────────────────────────────────────────────

test('every answer lists the fields an item can have, from the mapper itself (notes add doc)', () => {
  // No list to keep up to date here: `fields` must match the keys of the items actually sent.
  const keysOf = (items) => [...new Set(items.flatMap((i) => Object.keys(i)))].sort();
  const s = setup([row('t1', 'task'), row('n1', 'note')]);
  const tasks = s.pull.handle({}).body;
  assert.deepEqual(tasks.fields, keysOf(tasks.items));
  assert.deepEqual(s.pull.handle({ since: iso(T0) }).body.fields, tasks.fields); // the same in a change list
  const withNotes = s.pull.handle({ kinds: 'task,note' }).body;
  assert.deepEqual(withNotes.fields, keysOf(withNotes.items));
  assert.ok(withNotes.fields.includes('doc') && !tasks.fields.includes('doc'));
  // A field added to what the phone gets shows up here without anyone listing it.
  const view = s.pull.mapper.view.bind(s.pull.mapper);
  s.pull.mapper.view = (...a) => ({ ...view(...a), priority: null });
  assert.ok(s.pull.handle({}).body.fields.includes('priority'));
});

test('pull with no since: every task and assignment, nothing else, flagged as a full resync', () => {
  const s = setup([
    row('t1', 'task', { status: 'doing', deadline: iso(T0 + 60 * MIN) }), row('a1', 'assignment', { status: 'done' }),
    row('f1', 'folder'), row('n1', 'note'), row('x1', 'file'),
  ]);
  const { status, body } = s.pull.handle({});
  assert.equal(status, 200);
  assert.equal(body.fullResync, true);
  assert.equal(body.serverTime, iso(T0));
  assert.deepEqual(body.items.map((i) => i.id).sort(), ['a1', 't1']);
  assert.deepEqual(body.items.find((i) => i.id === 't1'), {
    id: 't1', title: 'task t1', start: null, end: iso(T0 + 60 * MIN), done: false, updatedAt: iso(T0 - 99 * MIN), // "doing" is not done
    kind: 'task', parentId: null, createdAt: iso(T0 - 99 * MIN), description: '', course: null, source: null, repeat: null,
  });
  assert.equal(body.items.find((i) => i.id === 'a1').done, true);
  assert.ok(body.items.every((i) => !('deleted' in i) && !('result' in i)));
});

test('pull with since: only what changed at or after it, the edge included, plus deletions', () => {
  const s = setup([row('old', 'task'), row('edge', 'task'), row('new', 'task'), row('gone', 'task'), row('turned', 'task')]);
  s.clock.t = T0 + 10 * MIN;
  s.items.update('edge', { title: 'edited at the edge' });
  s.items.get('edge').updatedAt = iso(T0 + 5 * MIN);       // exactly `since`
  s.clock.t = T0 + 20 * MIN;
  s.items.update('new', { title: 'edited later' });
  s.items.get('new').updatedAt = iso(T0 + 20 * MIN);       // (Collection stamps the real clock; pin it to the fake one)
  s.items.remove('gone');
  s.items.update('turned', { kind: 'folder' });

  s.clock.t = T0 + 30 * MIN;
  const { body } = s.pull.handle({ since: iso(T0 + 5 * MIN) });
  assert.equal(body.fullResync, false);
  assert.equal(body.serverTime, iso(T0 + 30 * MIN));
  assert.deepEqual(body.items.map((i) => i.id), ['edge', 'new', 'gone', 'turned']);   // changes by edit time, then deletions
  assert.deepEqual(body.items.slice(2), [{ id: 'gone', deleted: true }, { id: 'turned', deleted: true }]);
  assert.equal(body.items[0].title, 'edited at the edge');
});

test('pull: a deletion before since is not repeated; nothing new gives an empty list', () => {
  const s = setup([row('t1', 'task')]);
  s.clock.t = T0 + MIN;
  s.items.remove('t1');
  s.clock.t = T0 + 10 * MIN;
  const { body } = s.pull.handle({ since: iso(T0 + 2 * MIN) });
  assert.deepEqual([body.items, body.fullResync], [[], false]);
});

test('pull: a task deleted and then made again is returned as a task, not as deleted', () => {
  const s = setup([row('t1', 'task')]);
  s.clock.t = T0 + MIN;
  s.items.remove('t1');
  s.clock.t = T0 + 2 * MIN;
  s.items.add({ id: 't1', kind: 'task', title: 'again', updatedAt: iso(T0 + 2 * MIN) });
  const { body } = s.pull.handle({ since: iso(T0) });
  assert.deepEqual(body.items.map((i) => [i.id, i.deleted ?? false]), [['t1', false]]);
});

test('pull: a since from before the log began gets a full resync (deletions in between are unknown)', () => {
  const s = setup([row('t1', 'task')]);
  const { body } = s.pull.handle({ since: iso(T0 - 5 * MIN) });
  assert.equal(body.fullResync, true);
  assert.equal(body.items.length, 1);
  assert.equal(s.pull.handle({ since: iso(T0) }).body.fullResync, false); // exactly at the horizon is fine
});

test('pull: a bad since is 422, and an offset is not accepted (UTC with Z only)', () => {
  const s = setup([row('t1', 'task')]);
  for (const bad of ['', 'x', '2026-11-02', '2026-11-02T10:00:00', '2026-11-02T10:00:00+00:00', '2026-13-45T10:00:00Z', 5, {}, true]) {
    const r = s.pull.handle({ since: bad });
    assert.deepEqual([r.status, r.body.error], [422, 'invalid-request'], JSON.stringify(bad));
  }
  assert.equal(s.pull.handle({ since: '2026-11-02T10:00:00Z' }).status, 200);      // no milliseconds is fine
  assert.equal(s.pull.handle({ since: '2026-11-02T10:00:00.123456Z' }).status, 200);
  assert.equal(s.pull.handle({ since: null }).body.fullResync, true);
  assert.equal(s.pull.handle().body.fullResync, true);
});

test('pull: an item with no usable edit time is still sent rather than lost', () => {
  const s = setup([row('odd', 'task', { updatedAt: '' })]);
  assert.deepEqual(s.pull.handle({ since: iso(T0 + 50 * MIN) }).body.items.map((i) => i.id), ['odd']);
});

test('pull: without the workspace data the answer is 503', () => {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  const r = new ItemPull({ rulesFor, store, log: { horizonMs: 0, deletedSince: () => [] } }).handle({});
  assert.deepEqual([r.status, r.body.error], [503, 'unavailable']);
});

test('pull shows a task exactly as the PUT reply does (same fields, minus result)', () => {
  const s = setup();
  const put = new ItemSync({ rulesFor, store: s.store, now: () => T0 }).put({ id: 'p1', title: 'From phone', start: '2026-11-03T08:00:00Z', end: '2026-11-03T09:00:00Z', done: false, updatedAt: iso(T0 - MIN) });
  const { result, ...asPut } = put.body;
  assert.equal(result, 'created');
  assert.deepEqual(s.pull.handle({}).body.items[0], asPut);
});

test('PhoneRequests passes pull to ItemPull, and answers 404 if there is none', () => {
  const s = setup([row('t1', 'task')]);
  const router = new PhoneRequests({ sync: new ItemSync({ rulesFor, store: s.store }), registry: new Registry(), pull: s.pull });
  assert.equal(router.handle({ op: 'pull', payload: { since: null } }).body.items.length, 1);
  assert.equal(router.handle({ op: 'pull', payload: { since: 'junk' } }).status, 422);
  const bare = new PhoneRequests({ sync: { handle: () => ({}) }, registry: new Registry() });
  assert.deepEqual([bare.handle({ op: 'pull' }).status, bare.handle({ op: 'pull' }).body.error], [404, 'not-found']);
});

// ── The route ───────────────────────────────────────────────────────────────

async function serverSetup({ items, receiving = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-pull-'));
  const pairing = new PairingManager();
  const state = { receiving };
  const server = new ReceiverServer({
    tls: cert, pairing, sink: new FileSink(path.join(dir, 'received')), ledger: new UploadLedger(),
    name: 'TEST-PC', version: '0.1.0', isReceiving: () => state.receiving, items,
  });
  const port = await server.listen(0, '127.0.0.1');
  const { id, token } = pairing.startPairing();
  pairing.authenticate(token); pairing.approve(id);
  return { state, pairing, phone: new FakePhone({ port, token, fp: cert.fp }), stop: () => server.close() };
}

test('GET /v1/items hands since to the page and returns its answer unchanged', async (t) => {
  const calls = [];
  const items = { request: async (op, payload) => { calls.push([op, payload]); return { status: 200, body: { items: [], serverTime: 'T', fullResync: false } }; } };
  const s = await serverSetup({ items }); t.after(s.stop);

  const withSince = await s.phone.request('GET', '/v1/items?since=2026-11-02T10:00:00.000Z');
  assert.deepEqual([withSince.status, withSince.json.serverTime], [200, 'T']);
  await s.phone.request('GET', '/v1/items');
  await s.phone.request('GET', '/v1/items?since=');
  await s.phone.request('GET', '/v1/items?since=2026-11-02T10:00:00+02:00'); // the + arrives as a space
  assert.deepEqual(calls, [
    ['pull', { since: '2026-11-02T10:00:00.000Z', kinds: null }], ['pull', { since: null, kinds: null }], ['pull', { since: '', kinds: null }],
    ['pull', { since: '2026-11-02T10:00:00 02:00', kinds: null }],
  ]);
  await s.phone.request('GET', '/v1/items?kinds=task,note');
  assert.deepEqual(calls.at(-1), ['pull', { since: null, kinds: 'task,note' }]);
});

test('GET /v1/items: other methods are 405, no items gateway is 404, and it needs the same token, approval and switch', async (t) => {
  const items = { calls: 0, request: async () => { items.calls++; return { status: 200, body: {} }; } };
  const s = await serverSetup({ items }); t.after(s.stop);

  assert.equal((await s.phone.request('POST', '/v1/items')).status, 405);
  assert.equal((await s.phone.request('PUT', '/v1/items')).status, 405);
  assert.equal((await new FakePhone({ ...s.phone, token: 'nope' }).request('GET', '/v1/items')).status, 401);
  s.state.receiving = false;
  const off = await s.phone.request('GET', '/v1/items');
  assert.deepEqual([off.status, off.json.error], [403, 'receiving-off']);
  assert.equal(items.calls, 0);

  const bare = await serverSetup({ items: null }); t.after(bare.stop);
  assert.equal((await bare.phone.request('GET', '/v1/items')).status, 404);
});

test('GET /v1/items for a phone that is not approved yet gets 403 awaiting-approval', async (t) => {
  const s = await serverSetup({ items: { request: async () => ({ status: 200, body: {} }) } }); t.after(s.stop);
  const { id, token } = s.pairing.startPairing();
  s.pairing.authenticate(token);
  const waiting = new FakePhone({ ...s.phone, token });
  const r = await waiting.request('GET', '/v1/items');
  assert.deepEqual([r.status, r.json.error], [403, 'awaiting-approval']);
  void id;
});

// ── Everything together ─────────────────────────────────────────────────────

test('end to end: the phone sends a task, the PC edits and deletes things, and the phone pulls each change', async (t) => {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('items', Item);
  const items = store.collection('items');
  const log = new SyncLog({ store, bus }); log.start();
  const requests = new PhoneRequests({ sync: new ItemSync({ rulesFor, store }), registry: new Registry(), pull: new ItemPull({ rulesFor, store, log }) });
  let gateway;
  const win = { isDestroyed: () => false, webContents: { send: (_c, { requestId, op, payload }) => setImmediate(() => gateway.reply(requestId, requests.handle({ op, payload }))) } };
  gateway = new RendererItemGateway({ getWindow: () => win });
  const s = await serverSetup({ items: gateway }); t.after(s.stop);
  const json = (o) => Buffer.from(JSON.stringify(o));
  const pull = (since) => s.phone.request('GET', since ? `/v1/items?since=${encodeURIComponent(since)}` : '/v1/items');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // The phone creates two tasks, then makes its first pull (no since).
  for (const id of ['a1', 'b2']) {
    await s.phone.request('PUT', `/v1/items/${id}`, { body: json({ id, title: `Task ${id}`, start: '2026-11-03T08:00:00Z', end: '2026-11-03T09:00:00Z', done: false, updatedAt: new Date().toISOString() }) });
  }
  const first = (await pull()).json;
  assert.deepEqual([first.fullResync, first.items.map((i) => i.id).sort()], [true, ['a1', 'b2']]);

  // On the PC: edit one task, delete the other, and add one by hand.
  await wait(15);
  items.update('a1', { title: 'Edited on the PC' });
  items.remove('b2');
  items.add({ id: 'c3', kind: 'assignment', title: 'Made on the PC', deadline: '2026-12-01T09:00:00.000Z' });

  const second = (await pull(first.serverTime)).json;
  assert.equal(second.fullResync, false);
  assert.deepEqual(second.items.filter((i) => !i.deleted).map((i) => [i.id, i.title]).sort(), [['a1', 'Edited on the PC'], ['c3', 'Made on the PC']]);
  assert.deepEqual(second.items.filter((i) => i.deleted), [{ id: 'b2', deleted: true }]);
  assert.equal(second.items.find((i) => i.id === 'c3').end, '2026-12-01T09:00:00.000Z');

  // Pulling again from the new serverTime shows nothing new, and a task turned into a folder is reported as gone.
  await wait(15);
  assert.deepEqual((await pull(second.serverTime)).json.items, []);
  items.update('a1', { kind: 'folder' });
  const third = (await pull(second.serverTime)).json;
  assert.deepEqual(third.items, [{ id: 'a1', deleted: true }]);

  assert.equal((await pull('not a time')).status, 422);
});
