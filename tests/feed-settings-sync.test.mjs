import test, { before } from 'node:test';
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
import { CourseFilter } from '../renderer/modules/feeds/CourseFilter.js';
import { PhoneRequests } from '../renderer/modules/phonesync/PhoneRequests.js';

// The calendar feed list and course choices shared with the phone (docs/protocol.md section 5, /v1/feed-settings).
const require = createRequire(import.meta.url);
const { FeedStore } = require('../main/calendar/FeedStore.js');
const { FeedSettingsSync } = require('../main/calendar/FeedSettingsSync.js');
const { ReceiverServer } = require('../main/receiver/ReceiverServer.js');
const { PairingManager } = require('../main/receiver/PairingManager.js');
const { FileSink } = require('../main/receiver/FileSink.js');
const { UploadLedger } = require('../main/receiver/UploadLedger.js');

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const TT_URL = 'https://almaty.fh-joanneum.at/stundenplan/search.php?q=Met26';
const DE_URL = 'https://almaty.fh-joanneum.at/stundenplan/search.php?q=Deutsch';

function mainSide() {
  const store = new FeedStore();
  let changes = 0;
  const sync = new FeedSettingsSync({ store, now: () => NOW, onChanged: () => { changes++; } });
  const tt = store.add({ url: TT_URL, name: 'Met26', kind: 'timetable', host: 'almaty.fh-joanneum.at', count: 88, now: NOW - 10 * 60000 });
  return { store, sync, tt, changes: () => changes };
}

test('the PC shares its feeds with their addresses', () => {
  const { sync, tt } = mainSide();
  assert.deepEqual(sync.list(), [{ id: tt.id, url: TT_URL, name: 'Met26', kind: 'timetable', removed: false, updatedAt: iso(NOW - 10 * 60000) }]);
});

test('a feed added on the phone is added on the PC under the phone\'s id, not yet downloaded', () => {
  const { sync, store, changes } = mainSide();
  const reply = sync.apply([{ id: 'phone-de', url: 'webcal://almaty.fh-joanneum.at/stundenplan/search.php?q=Deutsch', name: 'German', removed: false, updatedAt: iso(NOW - 1000) }]);
  assert.equal(changes(), 1);
  const de = reply.find((f) => f.id === 'phone-de');
  assert.deepEqual([de.url, de.name, de.removed], [DE_URL, 'German', false]);
  assert.equal(store.get('phone-de').lastFetched, null); // FeedSync downloads it next
});

test('the same address added on both: the PC\'s feed stays, the phone learns its id', () => {
  const { sync, tt } = mainSide();
  const reply = sync.apply([{ id: 'phone-tt', url: TT_URL, name: 'Timetable', removed: false, updatedAt: iso(NOW - 1000) }]);
  assert.deepEqual(reply.map((f) => f.id), [tt.id]);
});

test('newer wins, feed by feed: a rename, then an older removal that is ignored, then a newer one', () => {
  const { sync, tt, store } = mainSide();
  sync.apply([{ id: tt.id, url: TT_URL, name: 'My timetable', removed: false, updatedAt: iso(NOW - 5000) }]);
  assert.equal(store.get(tt.id).name, 'My timetable');
  sync.apply([{ id: tt.id, removed: true, updatedAt: iso(NOW - 20 * 60000) }]); // older than the rename
  assert.ok(store.get(tt.id));
  const reply = sync.apply([{ id: tt.id, removed: true, updatedAt: iso(NOW - 1000) }]);
  assert.equal(store.get(tt.id), null);
  assert.deepEqual(reply, [{ id: tt.id, url: null, name: 'My timetable', kind: 'timetable', removed: true, updatedAt: iso(NOW - 1000) }]);
  assert.equal(store.list().length, 0); // the page no longer sees it
});

test('a feed removed on the PC is reported as removed; adding it again later brings it back', () => {
  const { sync, tt, store } = mainSide();
  store.remove(tt.id, { now: NOW - 3000 });
  assert.deepEqual(sync.list().map((f) => [f.id, f.removed, f.url]), [[tt.id, true, null]]);
  sync.apply([{ id: tt.id, url: TT_URL, name: 'Met26', removed: false, updatedAt: iso(NOW - 1000) }]);
  assert.deepEqual(sync.list().map((f) => [f.id, f.removed, f.url]), [[tt.id, false, TT_URL]]);
});

test('malformed lists change nothing', () => {
  const { sync, store } = mainSide();
  for (const bad of [null, {}, [{ id: 'x' }], [{ id: 'x', url: 'http://plain.example/cal', removed: false, updatedAt: iso(NOW) }],
    [{ id: 'bad id', url: TT_URL, removed: false, updatedAt: iso(NOW) }]]) {
    assert.equal(sync.apply(bad), null, JSON.stringify(bad));
  }
  assert.equal(store.list().length, 1);
});

test('course choices: shared with when they changed; the newer choice wins', () => {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  let now = NOW - 60000;
  const filter = new CourseFilter({ store, bus, now: () => now });
  filter.setHidden('tt', ['mobility infrastructure'], true);
  assert.deepEqual(filter.shared(), [{ feedId: 'tt', key: 'mobility infrastructure', hidden: true, updatedAt: iso(NOW - 60000) }]);

  now = NOW;
  assert.equal(filter.applyShared([
    { feedId: 'tt', key: 'Mobility Infrastructure', hidden: false, updatedAt: iso(NOW - 120000) }, // older: ignored
    { feedId: 'tt', key: 'Renewable Energy Generation', hidden: true, updatedAt: iso(NOW - 1000) },
  ]), true);
  assert.equal(filter.isHidden('tt', 'Mobility Infrastructure'), true);
  assert.equal(filter.isHidden('tt', 'Renewable Energy Generation'), true);

  filter.applyShared([{ feedId: 'tt', key: 'mobility infrastructure', hidden: false, updatedAt: iso(NOW - 500) }]);
  assert.equal(filter.isHidden('tt', 'Mobility Infrastructure'), false);
  // Shown again, it is still shared, so the phone learns it too.
  assert.deepEqual(filter.shared().find((c) => c.key === 'mobility infrastructure'),
    { feedId: 'tt', key: 'mobility infrastructure', hidden: false, updatedAt: iso(NOW - 500) });
  assert.equal(filter.applyShared([{ feedId: 'tt', key: 'x' }]), false);
});

let cert;
before(async () => { cert = await makeTestCert(); });

async function serverSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-feeds-'));
  const { sync, tt } = mainSide();
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  const filter = new CourseFilter({ store, bus, now: () => NOW });
  const registry = new Registry();
  registry.register('phoneFeedCourses', {
    id: 'feeds',
    handle: ({ courses } = {}) => (courses !== undefined && !filter.applyShared(courses)
      ? { status: 422, body: { error: 'invalid-request' } }
      : { status: 200, body: { courses: filter.shared() } }),
  });
  const requests = new PhoneRequests({ sync: { handle: () => ({ status: 404, body: {} }) }, registry });
  const pairing = new PairingManager();
  const server = new ReceiverServer({
    tls: cert, pairing, sink: new FileSink(path.join(dir, 'received')), ledger: new UploadLedger(),
    name: 'TEST-PC', version: '0.1.0', isReceiving: () => true,
    items: { request: async (op, payload) => requests.handle({ op, payload }) }, feedSettings: sync,
  });
  const port = await server.listen(0, '127.0.0.1');
  const { id, token } = pairing.startPairing();
  pairing.authenticate(token); pairing.approve(id);
  return { tt, filter, phone: new FakePhone({ port, token, fp: cert.fp }), stop: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('GET and PUT /v1/feed-settings over the wire; ping lists "feeds"', async (t) => {
  const s = await serverSetup(); t.after(s.stop);
  assert.deepEqual((await s.phone.request('GET', '/v1/ping')).json.features, ['notes', 'calendar', 'repeat', 'feeds']);

  const got = await s.phone.request('GET', '/v1/feed-settings');
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.feeds.map((f) => f.url), [TT_URL]);
  assert.deepEqual(got.json.courses, []);

  const body = Buffer.from(JSON.stringify({
    feeds: [{ id: 'phone-de', url: DE_URL, name: 'German', removed: false, updatedAt: iso(NOW - 1000) }],
    courses: [{ feedId: s.tt.id, key: 'renewable energy generation', hidden: true, updatedAt: iso(NOW - 1000) }],
  }));
  const put = await s.phone.request('PUT', '/v1/feed-settings', { body, headers: { 'Content-Type': 'application/json' } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.feeds.map((f) => f.id).sort(), [s.tt.id, 'phone-de'].sort());
  assert.deepEqual(put.json.courses.map((c) => [c.key, c.hidden]), [['renewable energy generation', true]]);
  assert.equal(s.filter.isHidden(s.tt.id, 'Renewable Energy Generation'), true);

  const bad = await s.phone.request('PUT', '/v1/feed-settings', { body: Buffer.from('{"feeds": 3}') });
  assert.equal(bad.status, 422);
});
