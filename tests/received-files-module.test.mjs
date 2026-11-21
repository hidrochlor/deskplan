import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../renderer/core/EventBus.js';
import { Registry } from '../renderer/core/Registry.js';
import { Store } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { ReceivedFile } from '../renderer/modules/receivedfiles/ReceivedFile.js';
import { ReceivedFilesIntake } from '../renderer/modules/receivedfiles/ReceivedFilesIntake.js';
import { ReceivedFilesModule } from '../renderer/modules/receivedfiles/ReceivedFilesModule.js';
import { PhoneLink } from '../renderer/modules/receivedfiles/PhoneLink.js';
import { deleteReceived } from '../renderer/modules/receivedfiles/deleteReceived.js';
import { phoneState, RECENT_MS } from '../renderer/modules/receivedfiles/phoneState.js';

const record = (n, extra = {}) => ({
  uploadId: `u${n}`, fileName: `file${n}.pdf`, storedAs: `file${n}.pdf`, size: 2048, sha256: 'ab'.repeat(32),
  receivedAt: '2026-10-29T10:00:00.000Z', deviceName: 'Galaxy', destination: 'received-files', ...extra,
});

function setup({ api = null } = {}) {
  const bus = new EventBus();
  const registry = new Registry();
  const store = new Store({ bus, storage: new MemoryStorage() });
  const ctx = { bus, registry, store };
  new ReceivedFilesModule({ api }).install(ctx);
  return ctx;
}

/** A fake window.api.receiver that records what the page asks of it. */
function fakeApi(pending = []) {
  const api = {
    pending, acked: [], handlers: { received: [], devices: [] }, statusValue: { enabled: false, devices: [] },
    status: async () => api.statusValue,
    setEnabled: async (on) => { api.statusValue = { ...api.statusValue, enabled: on }; return api.statusValue; },
    pendingReceived: async () => api.pending,
    acknowledge: async (ids) => { api.acked.push(...ids); },
    onReceived: (fn) => api.handlers.received.push(fn),
    onDevices: (fn) => api.handlers.devices.push(fn),
  };
  return api;
}

test('phoneState: off, ready, ok, attention', () => {
  const NOW = 10_000_000;
  const seen = (msAgo, extra = {}) => ({ approved: true, lastSeen: NOW - msAgo, ...extra });
  assert.equal(phoneState(null, NOW).level, 'off');
  assert.equal(phoneState({ enabled: false, devices: [] }, NOW).level, 'off');
  assert.equal(phoneState({ enabled: true, devices: [] }, NOW).level, 'ready');
  assert.equal(phoneState({ enabled: true, devices: [seen(1000)] }, NOW).level, 'ok');
  assert.equal(phoneState({ enabled: true, devices: [seen(1000), { approved: false }] }, NOW).level, 'attention');
  assert.match(phoneState({ enabled: true, devices: [{ approved: false }, { approved: false }] }, NOW).label, /2 phones/);
  assert.equal(phoneState({ enabled: false, devices: [{ approved: false }] }, NOW).level, 'off'); // off wins
});

test('phoneState: green only while a phone was seen recently; blue (with the reason) otherwise', () => {
  const NOW = 10_000_000;
  const on = (...devices) => phoneState({ enabled: true, devices }, NOW);
  const seen = (msAgo) => ({ approved: true, lastSeen: NOW - msAgo });

  assert.deepEqual([on(seen(5_000)).level, on(seen(5_000)).label], ['ok', 'Connected · last seen just now']);
  assert.equal(on(seen(2 * 60_000)).label, 'Connected · last seen 2m ago');
  assert.equal(on(seen(RECENT_MS)).level, 'ok');                       // right at the edge still counts
  assert.equal(on(seen(RECENT_MS + 1000)).level, 'ready');
  assert.equal(on(seen(25 * 60_000)).label, 'Paired · not seen for 25m');
  assert.equal(on({ approved: true, lastSeen: null }).label, 'Paired · waiting for the phone');
  assert.equal(on().label, 'Receiving is on · no phone paired yet');
  assert.equal(on(seen(60 * 60_000), seen(30_000)).level, 'ok');       // any one recent phone is enough
  assert.equal(on(seen(-5_000)).level, 'ok');                          // a phone clock slightly ahead is not an error
});

test('phoneState: the Public-network warning is separate and never changes the connection colour', () => {
  const NOW = 10_000_000;
  const pub = { category: 'Public' };
  const recent = { approved: true, lastSeen: NOW - 1000 };

  const connected = phoneState({ enabled: true, devices: [recent], network: pub }, NOW);
  assert.equal(connected.level, 'ok');                                  // still green
  assert.match(connected.warning, /Public network/);

  const waiting = phoneState({ enabled: true, devices: [{ approved: false }], network: pub }, NOW);
  assert.deepEqual([waiting.level, !!waiting.warning], ['attention', true]);
  assert.equal(phoneState({ enabled: true, devices: [], network: pub }, NOW).level, 'ready');

  assert.equal(phoneState({ enabled: true, devices: [recent], network: { category: 'Private' } }, NOW).warning, null);
  assert.equal(phoneState({ enabled: true, devices: [recent], network: { category: 'Unknown' } }, NOW).warning, null);
  assert.equal(phoneState({ enabled: true, devices: [recent] }, NOW).warning, null);                 // not looked up yet
  assert.equal(phoneState({ enabled: false, devices: [recent], network: pub }, NOW).warning, null);  // off: nothing to warn about
});

test('ReceivedFile: defaults, ext, image, size label, mapping from a received record', () => {
  const item = new ReceivedFile(ReceivedFile.fromReceived(record(1, { fileName: 'Photo.JPG' })));
  assert.equal(item.ext, 'jpg');
  assert.equal(item.isImage, true);
  assert.equal(item.sizeLabel, '2 KB');
  assert.equal(item.receivedDate.getUTCHours(), 10);
  assert.equal(new ReceivedFile({ size: 5 }).sizeLabel, '5 B');
  assert.equal(new ReceivedFile({ size: 90 * 1024 * 1024 }).sizeLabel, '90.0 MB');
  assert.equal(new ReceivedFile({ fileName: 'noext' }).ext, '');
  assert.equal(new ReceivedFile({ receivedAt: 'garbage' }).receivedDate, null);
});

test('ReceivedFile: a record from an older version (destination "inbox", or none) is read as Received files', () => {
  assert.equal(ReceivedFile.fromReceived(record(1, { destination: 'inbox' })).destination, 'received-files');
  assert.equal(ReceivedFile.fromReceived(record(1, { destination: undefined })).destination, 'received-files');
  assert.equal(ReceivedFile.fromReceived(record(1, { destination: 'folder:f1' })).destination, 'folder:f1');
});

test('ReceivedFile: unknown saved fields are kept (data from a newer version is not dropped)', () => {
  const item = new ReceivedFile({ id: 'x', fileName: 'a', somethingNew: 7 });
  assert.equal(item.toJSON().somethingNew, 7);
});

test('the module registers the Received files page and editor, and the phone parts only with the desktop api', () => {
  const browser = setup({ api: null });
  assert.ok(browser.registry.get('view', 'receivedFiles'));
  assert.ok(browser.registry.get('editor', 'receivedFile'));
  assert.equal(browser.registry.get('settingsSection', 'phones'), null);
  assert.deepEqual(browser.registry.list('topBarItem'), []);

  const desktop = setup({ api: fakeApi() });
  assert.ok(desktop.registry.get('settingsSection', 'phones'));
  assert.equal(desktop.registry.list('topBarItem').length, 1);
  assert.ok(desktop.store.has('receivedFiles'));
});

test('intake: pending files become entries, are saved, then acknowledged', async () => {
  const ctx = setup();
  const api = fakeApi([record(1), record(2)]);
  await new ReceivedFilesIntake({ store: ctx.store, api, ReceivedFile }).start();

  const items = ctx.store.collection('receivedFiles').all();
  assert.deepEqual(items.map((i) => i.fileName).sort(), ['file1.pdf', 'file2.pdf']);
  assert.deepEqual(api.acked.sort(), ['u1', 'u2']);
});

test('intake: a file that arrives later is added, and the same upload is never listed twice', async () => {
  const ctx = setup();
  const api = fakeApi([]);
  const intake = new ReceivedFilesIntake({ store: ctx.store, api, ReceivedFile });
  await intake.start();
  assert.deepEqual(api.acked, []); // nothing to acknowledge yet

  await api.handlers.received[0](record(3));
  await intake.take([record(3), record(3)]); // main process re-sends after a restart, or a double event
  assert.equal(ctx.store.collection('receivedFiles').all().length, 1);
  assert.ok(api.acked.every((id) => id === 'u3'));
});

test('intake: an empty list does nothing', async () => {
  const ctx = setup();
  const api = fakeApi([]);
  await new ReceivedFilesIntake({ store: ctx.store, api, ReceivedFile }).take([]);
  assert.deepEqual(api.acked, []);
});

test('PhoneLink: loads status, follows pushed changes, announces them', async () => {
  const bus = new EventBus();
  const api = fakeApi();
  const link = new PhoneLink({ bus, api });
  const seen = [];
  bus.on('phones:changed', (s) => seen.push(s.enabled));

  assert.equal(link.available, true);
  await link.start();
  await link.setEnabled(true);
  api.handlers.devices[0]({ enabled: false, devices: [] }); // pushed from the main process
  assert.deepEqual(seen, [false, true, false]);
  assert.equal(link.status.enabled, false);

  assert.equal(new PhoneLink({ bus, api: null }).available, false);
  await new PhoneLink({ bus, api: null }).start(); // no api: nothing happens
});

// ── Approval toast ──────────────────────────────────────────────────────────
import { PhoneApprovals } from '../renderer/modules/receivedfiles/PhoneApprovals.js';

function approvalsSetup({ focused = true } = {}) {
  const bus = new EventBus();
  const toasts = [];
  const dismissed = [];
  const notes = [];
  bus.on('toast:show', (t) => toasts.push(t));
  bus.on('toast:dismiss', (d) => dismissed.push(d.id));
  const link = { approved: [], revoked: [], approve: async (id) => { link.approved.push(id); }, revoke: async (id) => { link.revoked.push(id); } };
  let focusCalls = 0;
  new PhoneApprovals({ bus, link, notify: (title, body, onClick) => notes.push({ title, body, onClick }), hasFocus: () => focused, focusWindow: () => { focusCalls++; } });
  return { bus, link, toasts, dismissed, notes, focusCalls: () => focusCalls };
}
const dev = (id, extra = {}) => ({ id, name: 'Galaxy S24', approved: false, claimedAt: 1, lastSeen: 1, ...extra });

test('approvals: a phone waiting for approval gets one toast with Approve and Refuse', () => {
  const s = approvalsSetup();
  s.bus.emit('phones:changed', { enabled: true, devices: [dev('d1')] });
  s.bus.emit('phones:changed', { enabled: true, devices: [dev('d1')] }); // the same status again
  assert.equal(s.toasts.length, 1);
  assert.equal(s.toasts[0].title, 'Galaxy S24 wants to connect');
  assert.deepEqual(s.toasts[0].actions.map((a) => a.label), ['Approve', 'Refuse']);
  assert.equal(s.toasts[0].timeout, undefined); // stays until the user decides
  assert.deepEqual(s.notes, []);                // window is focused: no desktop notification
});

test('approvals: unscanned codes and already approved phones are not asked about', () => {
  const s = approvalsSetup();
  s.bus.emit('phones:changed', { enabled: true, devices: [dev('d1', { approved: true }), dev('d2', { claimedAt: null })] });
  assert.deepEqual(s.toasts, []);
  s.bus.emit('phones:changed', null);
  s.bus.emit('phones:changed', { enabled: true });
  assert.deepEqual(s.toasts, []);
});

test('approvals: Approve approves, then confirms; Refuse revokes', async () => {
  const s = approvalsSetup();
  s.bus.emit('phones:changed', { enabled: true, devices: [dev('d1'), dev('d2', { name: '' })] });
  assert.equal(s.toasts[1].title, 'A new phone wants to connect');

  await s.toasts[0].actions[0].onClick();
  assert.deepEqual(s.link.approved, ['d1']);
  const confirm = s.toasts.at(-1);
  assert.equal(confirm.title, 'Galaxy S24 is connected');
  assert.equal(confirm.id, s.toasts[0].id);   // replaces the question
  assert.ok(confirm.timeout > 0);             // and goes away by itself

  s.toasts[1].actions[1].onClick();
  assert.deepEqual(s.link.revoked, ['d2']);
});

test('approvals: a failed approval says so instead of staying silent', async () => {
  const s = approvalsSetup();
  s.link.approve = async () => { throw new Error('boom'); };
  s.bus.emit('phones:changed', { enabled: true, devices: [dev('d1')] });
  await s.toasts[0].actions[0].onClick();
  assert.equal(s.toasts.at(-1).title, 'Could not approve the phone');
});

test('approvals: approving elsewhere (pop-up, Settings) takes the toast away; a new phone gets its own', () => {
  const s = approvalsSetup();
  s.bus.emit('phones:changed', { enabled: true, devices: [dev('d1')] });
  s.bus.emit('phones:changed', { enabled: true, devices: [dev('d1', { approved: true })] });
  assert.deepEqual(s.dismissed, [s.toasts[0].id]);
  s.bus.emit('phones:changed', { enabled: true, devices: [dev('d1', { approved: true }), dev('d3')] });
  assert.equal(s.toasts.length, 2);
  assert.equal(s.toasts[1].title, 'Galaxy S24 wants to connect');
});

test('approvals: when DeskPlan is not in front, a desktop notification brings the user back', () => {
  const s = approvalsSetup({ focused: false });
  s.bus.emit('phones:changed', { enabled: true, devices: [dev('d1')] });
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0].body, /Galaxy S24 is waiting for your approval/);
  s.notes[0].onClick();
  assert.equal(s.focusCalls(), 1);
});

import { deviceLabel } from '../renderer/modules/receivedfiles/phoneState.js';

test('deviceLabel: the phone\'s own name, or a placeholder that says when it was paired', () => {
  const fmt = (d) => `T${d.getTime()}`;
  assert.equal(deviceLabel({ name: 'Galaxy S24', claimedAt: 5 }, fmt), 'Galaxy S24');
  assert.equal(deviceLabel({ name: '', claimedAt: 5 }, fmt), 'Unnamed phone (paired T5)');
  assert.equal(deviceLabel({ name: '', claimedAt: null }, fmt), 'Unnamed phone');
});

test('approvals: opening the pop-up or Settings takes the toast away, and it does not come back', () => {
  for (const event of ['phones:attend', 'settings:open']) {
    const s = approvalsSetup();
    s.bus.emit('phones:changed', { enabled: true, devices: [dev('d1')] });
    s.bus.emit(event);
    assert.deepEqual(s.dismissed, [s.toasts[0].id], event);
    s.bus.emit('phones:changed', { enabled: true, devices: [dev('d1')] }); // still waiting, but already asked
    assert.equal(s.toasts.length, 1, event);
  }
});

test('deleteReceived: deletes each stored file and its entry; one that fails keeps its entry', async () => {
  const ctx = setup();
  const items = ctx.store.collection('receivedFiles');
  for (const n of [1, 2, 3]) items.add({ id: `i${n}`, ...ReceivedFile.fromReceived(record(n)) });
  const deletedFiles = [];
  const api = { deleteFile: async (storedAs) => { if (storedAs === 'file2.pdf') throw new Error('locked'); deletedFiles.push(storedAs); } };
  const quiet = console.error; console.error = () => {};
  try {
    const r = await deleteReceived({ items, api }, ['i1', 'i2', 'i3', 'gone']);
    assert.deepEqual(r, { deleted: ['i1', 'i3'], failed: ['i2'] });
  } finally { console.error = quiet; }
  assert.deepEqual(deletedFiles, ['file1.pdf', 'file3.pdf']);
  assert.deepEqual(items.all().map((i) => i.id), ['i2']);
});
