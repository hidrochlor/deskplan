import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakePhone, makeTestCert } from './helpers/FakePhone.mjs';
import { rulesFor } from './helpers/rulesFor.mjs';
import { EventBus } from '../renderer/core/EventBus.js';
import { Registry } from '../renderer/core/Registry.js';
import { Store } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { DAY } from '../renderer/core/dates.js';
import { Item } from '../renderer/modules/workspace/Item.js';
import { ItemTree } from '../renderer/modules/workspace/ItemTree.js';
import { SettingsService } from '../renderer/services/SettingsService.js';
import { ItemSync } from '../renderer/modules/phonesync/ItemSync.js';
import { ItemPull } from '../renderer/modules/phonesync/ItemPull.js';
import { SyncLog } from '../renderer/modules/phonesync/SyncLog.js';
import { PhoneRequests } from '../renderer/modules/phonesync/PhoneRequests.js';
import { CalendarPull } from '../renderer/modules/phonesync/CalendarPull.js';
import { FeedCache, FeedEntry } from '../renderer/modules/feeds/FeedCache.js';
import { FeedCalendarSource } from '../renderer/modules/feeds/FeedCalendarSource.js';
import { CourseFilter, courseKey } from '../renderer/modules/feeds/CourseFilter.js';
import { CourseFolders } from '../renderer/modules/feeds/CourseFolders.js';
import { AssignmentImporter } from '../renderer/modules/feeds/AssignmentImporter.js';
import { MoodleMapper } from '../renderer/modules/feeds/feedMappers.js';

// The phone's calendar (docs/protocol.md section 5 "GET /v1/calendar") and the item fields it relies on
// (section 4: `course`, `source`).
const require = createRequire(import.meta.url);
const { ReceiverServer } = require('../main/receiver/ReceiverServer.js');
const { PairingManager } = require('../main/receiver/PairingManager.js');
const { FileSink } = require('../main/receiver/FileSink.js');
const { UploadLedger } = require('../main/receiver/UploadLedger.js');
const { IcsParser } = require('../main/calendar/IcsParser.js');

let cert;
before(async () => { cert = await makeTestCert(); });

const TIMETABLE = fs.readFileSync(new URL('./fixtures/stundenplan-sample.ics', import.meta.url), 'utf8');
const MOODLE = fs.readFileSync(new URL('./fixtures/moodle-sample.ics', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const TT = { id: 'tt', kind: 'timetable', name: 'Met26' };

/** The page side: items, the feeds (with the course filter) and the phone's request router, on one clock. */
function page() {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('items', Item);
  store.define('feedEntries', FeedEntry);
  const registry = new Registry();
  const ctx = { bus, store, registry };
  const settings = new SettingsService(ctx);
  const cache = new FeedCache({ store, bus });
  const filter = new CourseFilter({ store, bus, now: () => NOW });
  const source = new FeedCalendarSource(cache, { now: () => NOW, filter });
  registry.register('phoneCalendar', { id: 'feeds', events: (from, to) => source.phoneEvents(from, to) });
  cache.replace(TT, IcsParser.parse(TIMETABLE, { now: NOW }).events);
  const importer = new AssignmentImporter({ store, folders: new CourseFolders({ store, settings }), now: () => NOW });
  const deadlines = IcsParser.parse(MOODLE, { now: NOW }).events
    .map((e) => ({ uid: e.uid, start: e.start, mapped: MoodleMapper.map(e) })).filter((d) => d.mapped.type === 'deadline');
  importer.import({ name: 'Moodle' }, deadlines);
  const log = new SyncLog({ store, bus, now: () => NOW }); log.start();
  const requests = new PhoneRequests({
    sync: new ItemSync({ store, rulesFor, now: () => NOW }), registry,
    pull: new ItemPull({ store, log, rulesFor, now: () => NOW }), calendar: new CalendarPull({ registry, now: () => NOW }),
  });
  return { store, filter, requests, items: store.collection('items') };
}

async function serverSetup(requests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-cal-'));
  const pairing = new PairingManager();
  const server = new ReceiverServer({
    tls: cert, pairing, sink: new FileSink(path.join(dir, 'received')), ledger: new UploadLedger(),
    name: 'TEST-PC', version: '0.1.0', isReceiving: () => true,
    items: requests ? { request: async (op, payload) => requests.handle({ op, payload }) } : null,
  });
  const port = await server.listen(0, '127.0.0.1');
  const { id, token } = pairing.startPairing();
  pairing.authenticate(token); pairing.approve(id);
  return { phone: new FakePhone({ port, token, fp: cert.fp }), stop: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('ping lists "calendar" in features (with an items gateway only)', async (t) => {
  const s = await serverSetup(page().requests); t.after(s.stop);
  assert.deepEqual((await s.phone.request('GET', '/v1/ping')).json.features, ['notes', 'calendar', 'repeat']);
  const bare = await serverSetup(null); t.after(bare.stop);
  assert.deepEqual((await bare.phone.request('GET', '/v1/ping')).json.features, []);
  assert.equal((await bare.phone.request('GET', '/v1/calendar')).status, 404);
});

test('GET /v1/calendar: lectures and exams in the default window, sorted, in the documented shape', async (t) => {
  const s = await serverSetup(page().requests); t.after(s.stop);
  const r = await s.phone.request('GET', '/v1/calendar');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.from, r.json.to, r.json.serverTime], [
    new Date(NOW - 14 * DAY).toISOString(), new Date(NOW + 180 * DAY).toISOString(), new Date(NOW).toISOString()]);
  assert.deepEqual(r.json.events.map((e) => e.kind), ['lecture', 'exam', 'exam', 'lecture', 'lecture']); // 30 Sep and 5 Oct are before the window
  assert.deepEqual(r.json.events[1], {
    id: 'feed:tt|MET2026_1071313', kind: 'exam', title: 'Exam: Climate Change and Dynamics', context: 'WS46a.02.212 · Awan',
    course: 'Climate Change and Dynamics', start: '2026-12-02T09:00:00.000Z', end: '2026-12-02T10:30:00.000Z',
  });
  const starts = r.json.events.map((e) => Date.parse(e.start));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.ok(!r.json.events.some((e) => e.title.includes('Final presentations'))); // Moodle due dates are items, not events
});

test('GET /v1/calendar: from/to choose the window; a bad or too long window is 422; POST is 405', async (t) => {
  const s = await serverSetup(page().requests); t.after(s.stop);
  const sep = await s.phone.request('GET', '/v1/calendar?from=2026-09-01T00:00:00Z&to=2026-10-10T00:00:00Z');
  assert.deepEqual(sep.json.events.map((e) => e.id), ['feed:tt|MET2026_1021327', 'feed:tt|MET2026_1042925']);
  const touching = await s.phone.request('GET', '/v1/calendar?from=2026-12-02T10:00:00Z&to=2026-12-02T10:10:00Z'); // inside the exam
  assert.deepEqual(touching.json.events.map((e) => e.kind), ['exam']);
  for (const q of ['from=yesterday', 'from=2026-11-01T00:00:00%2B02:00', 'from=2026-12-01T00:00:00Z&to=2026-11-01T00:00:00Z',
    'from=2026-01-01T00:00:00Z&to=2027-03-01T00:00:00Z']) {
    const bad = await s.phone.request('GET', `/v1/calendar?${q}`);
    assert.deepEqual([bad.status, bad.json.error], [422, 'invalid-request'], q);
  }
  assert.equal((await s.phone.request('POST', '/v1/calendar')).status, 405);
});

test('GET /v1/calendar leaves out the courses unticked on the PC, with their exams', async (t) => {
  const p = page();
  p.filter.setHidden('tt', [courseKey('Climate Change and Dynamics'), courseKey('Energy Networks and Hybrid Technologies')], true);
  const s = await serverSetup(p.requests); t.after(s.stop);
  const r = await s.phone.request('GET', '/v1/calendar');
  assert.ok(!r.json.events.some((e) => /Climate Change|Energy Networks/.test(e.title)));
  assert.equal(r.json.events.length, 3);
});

test('items carry `course` (past a semester folder) and `source` (imported from Moodle)', async (t) => {
  const p = page();
  const s = await serverSetup(p.requests); t.after(s.stop);
  const own = p.items.add({ kind: 'folder', title: 'CSC101' });
  const week = p.items.add({ kind: 'folder', title: 'Week 1', parentId: own.id });
  p.items.add({ kind: 'assignment', title: 'Homework', parentId: week.id, deadline: new Date(NOW + DAY).toISOString() });
  p.items.add({ kind: 'task', title: 'Loose', start: new Date(NOW).toISOString(), deadline: new Date(NOW + 3600e3).toISOString() });

  const { items } = (await s.phone.request('GET', '/v1/items')).json;
  const by = (title) => items.find((i) => i.title === title);
  assert.deepEqual([by('Final presentations').course, by('Final presentations').source], ['Environmental Process Engineering', { label: 'Moodle' }]);
  assert.equal(by('Report submission for second attempt').course, 'Digital Signal Processing'); // in "SS 2026 › Digital Signal Processing"
  assert.deepEqual([by('Homework').course, by('Homework').source], ['CSC101', null]); // the old rule: the top-level folder
  assert.equal(by('Loose').course, null);

});

test('ItemTree.course: a semester folder is skipped only when there is a folder inside it', () => {
  const p = page();
  const ws = p.items.all().find((i) => i.title === 'WS 2026');
  const loose = p.items.add({ kind: 'task', title: 'Plan semester', parentId: ws.id, start: new Date(NOW).toISOString(), deadline: new Date(NOW + 3600e3).toISOString() });
  const tree = new ItemTree(p.items);
  assert.equal(tree.course(loose.id).title, 'WS 2026');
  const notSemester = p.items.add({ kind: 'folder', title: 'WS 2026 extras' });
  const inner = p.items.add({ kind: 'folder', title: 'Inner', parentId: notSemester.id });
  const t2 = p.items.add({ kind: 'note', title: 'n', parentId: inner.id });
  assert.equal(tree.course(t2.id).title, 'WS 2026 extras');
});
