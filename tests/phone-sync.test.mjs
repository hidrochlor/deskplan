import test, { before } from 'node:test';
import { rulesFor } from './helpers/rulesFor.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakePhone, makeTestCert } from './helpers/FakePhone.mjs';
import { EventBus } from '../renderer/core/EventBus.js';
import { Store } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { Item } from '../renderer/modules/workspace/Item.js';
import { ItemSync } from '../renderer/modules/phonesync/ItemSync.js';

const require = createRequire(import.meta.url);
const { ReceiverServer } = require('../main/receiver/ReceiverServer.js');
const { PairingManager } = require('../main/receiver/PairingManager.js');
const { FileSink } = require('../main/receiver/FileSink.js');
const { UploadLedger } = require('../main/receiver/UploadLedger.js');
const { RendererItemGateway } = require('../main/receiver/RendererItemGateway.js');

let cert;
before(async () => { cert = await makeTestCert(); });

/** A receiver whose task changes go to `items`, plus an approved phone. */
async function setup({ items, receiving = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-sync-'));
  const pairing = new PairingManager();
  const state = { receiving };
  const server = new ReceiverServer({
    tls: cert, pairing, sink: new FileSink(path.join(dir, 'received')), ledger: new UploadLedger(),
    name: 'TEST-PC', version: '0.1.0', isReceiving: () => state.receiving, items,
  });
  const port = await server.listen(0, '127.0.0.1');
  const { id, token } = pairing.startPairing();
  pairing.authenticate(token);
  pairing.approve(id);
  return { state, server, pairing, phone: new FakePhone({ port, token, fp: cert.fp }), stop: () => server.close() };
}

const json = (o) => Buffer.from(JSON.stringify(o));
const taskBody = (extra = {}) => ({ id: 'a1', title: 'Task', start: null, end: null, done: false, updatedAt: '2026-10-29T10:00:00.000Z', ...extra });

/** A gateway stand-in that records the calls and answers with a fixed reply. */
function fakeItems(reply = { status: 200, body: { ok: true } }) {
  const calls = [];
  return { calls, request: async (op, payload) => { calls.push({ op, payload }); return reply; } };
}

test('PUT /v1/items/{id} is handed to the items gateway and its answer is returned unchanged', async (t) => {
  const items = fakeItems({ status: 201, body: { id: 'a1', result: 'created' } });
  const s = await setup({ items }); t.after(s.stop);
  const r = await s.phone.request('PUT', '/v1/items/a1', { body: json(taskBody()) });
  assert.deepEqual([r.status, r.json], [201, { id: 'a1', result: 'created' }]);
  assert.deepEqual(items.calls, [{ op: 'put', payload: { body: taskBody() } }]);
});

test('DELETE /v1/items/{id} is handed over too', async (t) => {
  const items = fakeItems({ status: 200, body: { id: 'a1', deleted: true } });
  const s = await setup({ items }); t.after(s.stop);
  const r = await s.phone.request('DELETE', '/v1/items/a1');
  assert.deepEqual([r.status, r.json.deleted], [200, true]);
  assert.deepEqual(items.calls, [{ op: 'delete', payload: { id: 'a1' } }]);
});

test('task requests: bad json, id mismatch, odd ids, huge bodies and wrong methods are refused before the page is asked', async (t) => {
  const items = fakeItems();
  const s = await setup({ items }); t.after(s.stop);
  const put = (p, body) => s.phone.request('PUT', p, { body });

  assert.equal((await put('/v1/items/a1', Buffer.from('{not json'))).status, 422);
  assert.equal((await put('/v1/items/a1', Buffer.from('[1,2]'))).status, 422);
  assert.equal((await put('/v1/items/a1', json(taskBody({ id: 'other' })))).status, 422);
  assert.equal((await put('/v1/items/a%2F..%2Fb', json(taskBody({ id: 'a/../b' })))).status, 422);
  assert.equal((await put('/v1/items/%E0%A4%A', json(taskBody()))).status, 422);
  assert.equal((await put('/v1/items/a1', Buffer.alloc(1024 * 1024 + 1, 0x20))).status, 413); // over 1 MB
  assert.equal((await s.phone.request('POST', '/v1/items/a1')).status, 405);
  assert.equal((await s.phone.request('GET', '/v1/items/a1')).status, 405);
  assert.deepEqual(items.calls, []);
});

test('task requests need the same token, approval and receive switch as everything else', async (t) => {
  const items = fakeItems();
  const s = await setup({ items }); t.after(s.stop);
  const wrong = new FakePhone({ ...s.phone, token: 'nope' });
  assert.equal((await wrong.request('PUT', '/v1/items/a1', { body: json(taskBody()) })).status, 401);

  s.state.receiving = false;
  const off = await s.phone.request('PUT', '/v1/items/a1', { body: json(taskBody()) });
  assert.deepEqual([off.status, off.json.error], [403, 'receiving-off']);
  assert.deepEqual(items.calls, []);
});

test('without an items gateway the task routes do not exist (404) but files still work', async (t) => {
  const s = await setup({ items: null }); t.after(s.stop);
  assert.equal((await s.phone.request('PUT', '/v1/items/a1', { body: json(taskBody()) })).status, 404);
  assert.equal((await s.phone.ping()).status, 200);
});

test('gateway: sends the request to the window and resolves with the page\'s answer', async () => {
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (ch, msg) => sent.push([ch, msg]) } };
  const gateway = new RendererItemGateway({ getWindow: () => win });

  const pending = gateway.request('put', { body: { id: 'a1' } });
  assert.equal(sent[0][0], 'receiver:item-request');
  const { requestId, op, payload } = sent[0][1];
  assert.deepEqual([op, payload], ['put', { body: { id: 'a1' } }]);

  gateway.reply(requestId, { status: 201, body: { id: 'a1' } });
  assert.deepEqual(await pending, { status: 201, body: { id: 'a1' } });
  assert.equal(gateway.pending.size, 0);
});

test('gateway: no window, a silent page, or a nonsense answer all end as 503 for the phone', async () => {
  assert.equal((await new RendererItemGateway({ getWindow: () => null }).request('put', {})).status, 503);
  const closed = { isDestroyed: () => true, webContents: { send() {} } };
  assert.equal((await new RendererItemGateway({ getWindow: () => closed }).request('put', {})).status, 503);

  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (_c, m) => sent.push(m) } };
  const gateway = new RendererItemGateway({ getWindow: () => win, timeoutMs: 30 });
  const pending = gateway.request('put', {});
  for (const junk of [null, {}, { status: 'ok', body: {} }, { status: 200 }, { status: 99, body: {} }]) gateway.reply(sent[0].requestId, junk);
  gateway.reply('unknown-id', { status: 200, body: {} }); // nobody is waiting for this
  const r = await pending;
  assert.deepEqual([r.status, r.body.error], [503, 'app-not-ready']);
  assert.equal(gateway.pending.size, 0);
});

test('end to end: a phone creates, edits, loses a conflict, and deletes a task in the real store', async (t) => {
  // The real pieces, joined the way the app joins them: server -> gateway -> (IPC) -> ItemSync -> store.
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('items', Item);
  const sync = new ItemSync({ rulesFor, store });
  let gateway;
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch, { requestId, op, payload }) => setImmediate(() => gateway.reply(requestId, sync.handle({ op, payload }))) },
  };
  gateway = new RendererItemGateway({ getWindow: () => win });
  const s = await setup({ items: gateway }); t.after(s.stop);

  const created = await s.phone.request('PUT', '/v1/items/a1', { body: json(taskBody({ title: 'Buy ink', start: '2026-11-02T08:00:00Z', end: '2026-11-02T09:00:00Z' })) });
  assert.deepEqual([created.status, created.json.result], [201, 'created']);
  assert.equal(store.collection('items').get('a1').deadline, '2026-11-02T09:00:00.000Z');

  const edited = await s.phone.request('PUT', '/v1/items/a1', { body: json(taskBody({ title: 'Buy ink and paper', start: '2026-11-02T08:00:00Z', end: '2026-11-02T09:00:00Z', updatedAt: new Date().toISOString() })) });
  assert.deepEqual([edited.status, edited.json.result], [200, 'updated']);
  assert.equal(store.collection('items').get('a1').title, 'Buy ink and paper');

  const stale = await s.phone.request('PUT', '/v1/items/a1', { body: json(taskBody({ title: 'Old edit', updatedAt: '2020-01-01T00:00:00Z' })) });
  assert.equal(stale.json.result, 'kept-newer');
  assert.equal(stale.json.title, 'Buy ink and paper'); // the phone learns the PC version

  const removed = await s.phone.request('DELETE', '/v1/items/a1');
  assert.deepEqual([removed.status, removed.json.deleted], [200, true]);
  assert.equal(store.collection('items').get('a1'), null);
  assert.equal((await s.phone.request('DELETE', '/v1/items/a1')).status, 200); // a retry is safe
});
