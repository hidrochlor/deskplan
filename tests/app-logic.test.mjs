import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../renderer/core/EventBus.js';
import { Registry } from '../renderer/core/Registry.js';
import { Store, migrate, SCHEMA_VERSION } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { SelectionService } from '../renderer/services/Selection.js';
import { DeadlineService } from '../renderer/services/DeadlineService.js';
import { ReminderService, reachedSteps, GRACE } from '../renderer/services/ReminderService.js';
import { CalendarEvent, CalendarSource } from '../renderer/services/CalendarSource.js';
import { HOUR, DAY } from '../renderer/core/dates.js';
import { FeatureModule } from '../renderer/core/FeatureModule.js';
import { Entity } from '../renderer/data/Entity.js';
import { WorkspaceModule } from '../renderer/modules/workspace/WorkspaceModule.js';
import { CalendarModule } from '../renderer/modules/calendar/CalendarModule.js';
import { Item } from '../renderer/modules/workspace/Item.js';
import { ItemTree } from '../renderer/modules/workspace/ItemTree.js';
import { Attachments } from '../renderer/modules/workspace/Attachments.js';
import { SettingsService } from '../renderer/services/SettingsService.js';
import { SettingsModule } from '../renderer/modules/settings/SettingsModule.js';

// A tiny extra module, to check that removing a module keeps its data.
class Scrap extends Entity { static defaults() { return { id: '', text: '' }; } }
class ScrapsModule extends FeatureModule {
  constructor() { super('scraps'); }
  install({ store, registry }) {
    store.define('scraps', Scrap);
    registry.register('view', { id: 'scraps', label: 'Scraps', icon: 'notes', create: () => null }, 50);
  }
}

function makeCtx(initial = null, modules = [new WorkspaceModule(), new CalendarModule(), new ScrapsModule()]) {
  const bus = new EventBus();
  const registry = new Registry();
  const storage = new MemoryStorage(initial);
  const store = new Store({ bus, storage, saveDelay: 5 });
  const ctx = { bus, registry, store, storage };
  ctx.selection = new SelectionService(ctx);
  ctx.deadlines = new DeadlineService(ctx);
  for (const m of modules) m.install(ctx);
  return ctx;
}

test('modules register their pieces; removing one removes only its pieces', () => {
  const all = makeCtx();
  assert.deepEqual(all.registry.list('view').map((v) => v.id), ['home', 'calendar', 'scraps']);
  assert.ok(all.registry.get('editor', 'item'));

  const fewer = makeCtx(null, [new WorkspaceModule(), new CalendarModule()]);
  assert.deepEqual(fewer.registry.list('view').map((v) => v.id), ['home', 'calendar']);
  assert.equal(fewer.store.has('scraps'), false);
});

test('version 1 files: old notes move onto the Home canvas as note items', async () => {
  const ctx = makeCtx({
    version: 1, meta: {},
    collections: {
      items: [{ id: 't', title: 'Old task' }],
      notes: [{ id: 'n', title: 'Lecture 1', body: 'loops and lists', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z' }],
    },
  });
  await ctx.store.load();
  const note = ctx.store.collection('items').get('n');
  assert.equal(note.kind, 'note');
  assert.equal(note.description, 'loops and lists');
  assert.equal(note.wordCount, 3);
  assert.equal(ctx.store.collection('items').get('t').title, 'Old task');
  await ctx.store.saveNow();
  assert.equal(ctx.storage.data.version, SCHEMA_VERSION);
  assert.equal(ctx.storage.data.collections.notes, undefined);
});

test('reveal: opens the folder an item lives in and selects it', () => {
  const ctx = makeCtx();
  const items = ctx.store.collection('items');
  const course = items.add({ title: 'Python Basics', kind: 'folder' });
  const hw = items.add({ title: 'GPA calculator', kind: 'assignment', parentId: course.id });
  const note = items.add({ title: 'Week 1', kind: 'note', parentId: course.id });
  const seen = [];
  ctx.bus.on('view:open', (e) => seen.push(`view:${e.id}`));
  ctx.bus.on('workspace:open', (e) => seen.push(`open:${e.id}`));

  ctx.bus.emit('reveal', { type: 'item', id: hw.id });
  assert.deepEqual(seen, ['view:home', `open:${course.id}`]);
  assert.ok(ctx.selection.is('item', hw.id));

  ctx.bus.emit('reveal', { type: 'item', id: note.id }); // notes open themselves
  assert.equal(ctx.store.meta.ui.open, note.id);
});

test('deleting a folder deletes the stored copies of files inside it', async () => {
  const deleted = [];
  const api = { import: async (paths) => paths.map((p) => ({ name: p, path: `id-${p}/${p}`, size: 10, ext: p.split('.').pop() })), delete: async (rel) => deleted.push(rel) };
  const attachments = new Attachments(api);
  const ctx = makeCtx(null, [new WorkspaceModule({ attachments }), new CalendarModule()]);
  const items = ctx.store.collection('items');
  const tree = new ItemTree(items);
  const folder = items.add({ title: 'Python Basics', kind: 'folder' });
  const [photo] = await attachments.addTo(items, folder.id, ['board.jpg', 'syllabus.pdf']);

  assert.ok(photo.isImage);
  assert.equal(attachments.url(photo), 'deskplan-file://files/id-board.jpg/board.jpg');
  assert.equal(tree.summary(folder.id).items, 2);

  attachments.forget(tree.removeTree(folder.id));
  assert.deepEqual(deleted.sort(), ['id-board.jpg/board.jpg', 'id-syllabus.pdf/syllabus.pdf']);
  assert.equal(items.all().length, 0);
});

test('deadline on an item shows up in events, top-bar next, and day lookup', () => {
  const ctx = makeCtx();
  const items = ctx.store.collection('items');
  const now = Date.now();
  const soon = items.add({ title: 'Thesis draft', kind: 'project', deadline: new Date(now + 4 * HOUR).toISOString() });
  items.add({ title: 'No deadline' });
  items.add({ title: 'Later', deadline: new Date(now + 5 * DAY).toISOString() });

  const events = ctx.deadlines.events();
  assert.equal(events.length, 2);
  assert.equal(ctx.deadlines.next(now).ref.id, soon.id);
  assert.equal(ctx.deadlines.onDay(new Date(now + 4 * HOUR)).some((e) => e.ref.id === soon.id), true);

  items.update(soon.id, Item.statusPatch('done'));
  assert.equal(ctx.deadlines.next(now).title, 'Later'); // done items drop out of the top bar
});

test('folders: children, path, summary, deadlines inside reach the calendar, delete cascades', () => {
  const ctx = makeCtx();
  const items = ctx.store.collection('items');
  const tree = new ItemTree(items);
  const now = Date.now();
  const course = items.add({ title: 'Python Basics', kind: 'course' });
  const week = items.add({ title: 'Week 1', kind: 'project', parentId: course.id });
  const hw = items.add({ title: 'Assignment 1', kind: 'assignment', parentId: week.id, deadline: new Date(now + 4 * HOUR).toISOString() });
  items.add({ title: 'Read ch. 1', kind: 'reading', parentId: course.id, status: 'done' });
  const orphan = items.add({ title: 'Lost', parentId: 'missing' });

  assert.ok(tree.isFolder(course));
  assert.deepEqual(tree.children(course.id).map((i) => i.title).sort(), ['Read ch. 1', 'Week 1']);
  assert.ok(tree.children(null).some((i) => i.id === orphan.id)); // orphans show at top level
  assert.deepEqual(tree.path(hw.id).map((i) => i.title), ['Python Basics', 'Week 1']);

  const s = tree.summary(course.id);
  assert.deepEqual([s.items, s.total, s.done, s.open, s.next.id], [3, 2, 1, 1, hw.id]); // total = things to do

  const next = ctx.deadlines.next(now);
  assert.equal(next.ref.id, hw.id);
  assert.equal(next.context, 'Python Basics › Week 1');

  tree.removeTree(course.id);
  assert.deepEqual(items.all().map((i) => i.id), [orphan.id]);
});

test('top bar falls back to latest overdue when nothing is ahead', () => {
  const ctx = makeCtx();
  const items = ctx.store.collection('items');
  items.add({ title: 'Old', deadline: new Date(Date.now() - 3 * DAY).toISOString() });
  items.add({ title: 'Newer overdue', deadline: new Date(Date.now() - HOUR).toISOString() });
  assert.equal(ctx.deadlines.next().title, 'Newer overdue');
});

test('a failing calendar source is skipped, not fatal', () => {
  const ctx = makeCtx();
  class Broken extends CalendarSource { constructor() { super('broken'); } events() { throw new Error('boom'); } }
  ctx.registry.register('calendarSource', new Broken());
  const orig = console.error; console.error = () => {};
  try { assert.deepEqual(ctx.deadlines.events(), []); } finally { console.error = orig; }
});

test('store saves and reloads, and keeps data of modules that are not installed', async () => {
  const a = makeCtx();
  a.store.collection('items').add({ title: 'Keep me' });
  a.store.collection('scraps').add({ text: 'hello world' });
  await a.store.saveNow();
  const saved = a.storage.data;
  assert.equal(saved.version, SCHEMA_VERSION);

  // Reload without the scraps module: its data must survive a round trip.
  const b = makeCtx(saved, [new WorkspaceModule(), new CalendarModule()]);
  await b.store.load();
  assert.equal(b.store.collection('items').all()[0].title, 'Keep me');
  await b.store.saveNow();
  assert.equal(b.storage.data.collections.scraps.length, 1);

  // And come back when the module returns.
  const c = makeCtx(b.storage.data);
  await c.store.load();
  assert.equal(c.store.collection('scraps').all()[0].text, 'hello world');
});

test('unknown fields in saved data are preserved; missing fields get defaults', async () => {
  const ctx = makeCtx({ version: 1, meta: {}, collections: { items: [{ id: 'x', title: 'Old', futureField: 42 }] } });
  await ctx.store.load();
  const item = ctx.store.collection('items').get('x');
  assert.equal(item.kind, 'task');
  assert.equal(item.futureField, 42);
  assert.equal(item.toJSON().futureField, 42);
});

test('migrate handles empty and newer files', () => {
  assert.equal(migrate(null).version, SCHEMA_VERSION);
  assert.equal(migrate({ version: SCHEMA_VERSION + 3, collections: {} }).version, SCHEMA_VERSION + 3);
});

test('migrate 3 -> 4: the old "inbox" list, its destination id and a last-open "inbox" page become Received files', () => {
  const data = migrate({
    version: 3,
    meta: { ui: { view: 'inbox', other: 1 } },
    collections: {
      items: [{ id: 'i1' }],
      inbox: [{ id: 'r1', destination: 'inbox' }, { id: 'r2', destination: 'folder:gone' }],
    },
  });
  assert.equal(data.version, SCHEMA_VERSION);
  assert.equal(data.collections.inbox, undefined);
  assert.deepEqual(data.collections.receivedFiles, [{ id: 'r1', destination: 'received-files' }, { id: 'r2', destination: 'folder:gone' }]);
  assert.deepEqual(data.collections.items, [{ id: 'i1' }]);
  assert.deepEqual(data.meta.ui, { view: 'receivedFiles', other: 1 });
  // nothing to move: untouched
  const plain = migrate({ version: 3, meta: { ui: { view: 'home' } }, collections: { items: [] } });
  assert.deepEqual(plain.collections, { items: [] });
  assert.deepEqual(plain.meta.ui, { view: 'home' });
});

test('moving items between folders, and what is refused', () => {
  const ctx = makeCtx();
  const items = ctx.store.collection('items');
  const tree = new ItemTree(items);
  const python = items.add({ title: 'python basics', kind: 'folder' });
  const design = items.add({ title: 'Intro to design', kind: 'folder' });
  const week = items.add({ title: 'Week 1', kind: 'folder', parentId: design.id });
  const pdf = items.add({ title: 'Porters Five Forces.pdf', kind: 'file' });
  const task = items.add({ title: 'do this now', kind: 'task' });

  assert.ok(tree.move(pdf.id, python.id));                       // a file into a folder
  assert.equal(items.get(pdf.id).parentId, python.id);
  assert.deepEqual(tree.children(null).map((i) => i.title).sort(), ['Intro to design', 'do this now', 'python basics']);

  assert.ok(tree.move(pdf.id, null));                            // and back to Home
  assert.equal(tree.parentOf(items.get(pdf.id)), null);

  assert.equal(tree.canMove(pdf.id, null), false);               // already there
  assert.equal(tree.canMove(design.id, design.id), false);       // into itself
  assert.equal(tree.canMove(design.id, week.id), false);         // into its own contents
  assert.equal(tree.canMove(pdf.id, task.id), false);            // into something that isn't a folder
  assert.equal(tree.canMove('nope', python.id), false);

  assert.ok(tree.move(design.id, python.id));                    // whole folder moves with its contents
  assert.deepEqual(tree.path(week.id).map((i) => i.title), ['python basics', 'Intro to design']);

  assert.deepEqual(tree.folderOptions({ excludeId: design.id }).map((o) => o.label), ['python basics']);
  assert.deepEqual(tree.folderOptions().map((o) => o.label),
    ['python basics', 'python basics › Intro to design', 'python basics › Intro to design › Week 1']);
});

test('calendar creator: lists folders and adds a dated item into the chosen one', () => {
  const ctx = makeCtx();
  const items = ctx.store.collection('items');
  const course = items.add({ title: 'CSC101', kind: 'folder' });
  items.add({ title: 'Week 1', kind: 'folder', parentId: course.id });
  const creator = ctx.registry.list('creator')[0];

  assert.deepEqual(creator.places().map((p) => p.label), ['Home', 'CSC101', 'CSC101 › Week 1']);
  const due = new Date(Date.now() + 2 * DAY);
  const hw = creator.create({ kind: 'assignment', title: 'GPA calc', due, placeId: course.id });
  assert.equal(hw.parentId, course.id);
  assert.equal(ctx.deadlines.next().ref.id, hw.id);
  assert.ok(ctx.selection.is('item', hw.id));
});

test('settings: defaults, saving, merging new sub-options, reset', () => {
  const ctx = makeCtx();
  const settings = new SettingsService(ctx);
  const seen = [];
  ctx.bus.on('settings:changed', (e) => seen.push(e.key));

  assert.equal(settings.get('theme'), 'dark');
  settings.set('theme', 'light');
  assert.equal(ctx.store.meta.settings.theme, 'light');
  ctx.store.meta.settings.reminders = { enabled: false }; // an older file without the per-step flags
  assert.deepEqual(settings.get('reminders'), { enabled: false, '24h': true, '1h': true, due: true });
  settings.patch('reminders', { '1h': false });
  assert.equal(settings.get('reminders')['1h'], false);
  settings.reset();
  assert.equal(settings.get('theme'), 'dark');
  assert.deepEqual(seen, ['theme', 'reminders', '*']);
});

test('settings module registers its pages in order', () => {
  const ctx = makeCtx(null, [new SettingsModule()]);
  assert.deepEqual(ctx.registry.list('settingsSection').map((s) => s.id),
    ['appearance', 'datetime', 'notifications', 'data', 'about']);
});

test('reminders respect Settings: off entirely, or a single step off', () => {
  const ctx = makeCtx();
  ctx.settings = new SettingsService(ctx);
  const sent = [];
  ctx.reminders = new ReminderService(ctx, { notifier: (t) => sent.push(t) });
  const now = Date.now();
  ctx.store.collection('items').add({ title: 'Lab', deadline: new Date(now + 2 * HOUR).toISOString() });
  ctx.reminders.tick(now);

  ctx.settings.patch('reminders', { '1h': false });
  ctx.reminders.tick(now + 1.5 * HOUR);   // 1h step reached, but switched off
  assert.equal(sent.length, 0);
  ctx.reminders.tick(now + 2 * HOUR + 1000); // due step still on
  assert.equal(sent.length, 1);
});

test('selecting the already-selected thing still announces a pick (re-opens the panel)', () => {
  const ctx = makeCtx();
  const events = [];
  ctx.bus.on('selection:changed', () => events.push('changed'));
  ctx.bus.on('selection:picked', () => events.push('picked'));
  ctx.selection.select('item', 'a');
  ctx.selection.select('item', 'a');
  assert.deepEqual(events, ['changed', 'picked', 'picked']);
});

test('selection clears when the selected thing is deleted', () => {
  const ctx = makeCtx();
  const item = ctx.store.collection('items').add({ title: 'x' });
  ctx.selection.select('item', item.id);
  assert.ok(ctx.selection.is('item', item.id));
  ctx.store.collection('items').remove(item.id);
  assert.equal(ctx.selection.current, null);
});

test('a throwing bus handler does not stop the others', () => {
  const bus = new EventBus();
  let ran = false;
  bus.on('x', () => { throw new Error('bad'); });
  bus.on('x', () => { ran = true; });
  const orig = console.error; console.error = () => {};
  try { bus.emit('x'); } finally { console.error = orig; }
  assert.equal(ran, true);
});

test('reminders: steps, first-sight muting, no repeats, moving the deadline resets', () => {
  const ctx = makeCtx();
  const sent = [];
  ctx.reminders = new ReminderService(ctx, { notifier: (title, body) => sent.push(title) });
  const items = ctx.store.collection('items');
  const now = Date.now();
  const due = now + 2 * HOUR;
  const item = items.add({ title: 'Report', deadline: new Date(due).toISOString() });

  assert.deepEqual(reachedSteps({ start: new Date(due) }, now).map((s) => s.key), ['24h']);

  ctx.reminders.tick(now);                       // first sight: mutes the 24h step
  assert.equal(sent.length, 0);
  ctx.reminders.tick(now + 1.5 * HOUR);          // 30 min left: the 1h step fires
  assert.equal(sent.length, 1);
  ctx.reminders.tick(now + 1.6 * HOUR);          // nothing new
  assert.equal(sent.length, 1);
  ctx.reminders.tick(due + 1000);                // due now
  assert.equal(sent.length, 2);

  items.update(item.id, { deadline: new Date(due + 3 * DAY).toISOString() });
  ctx.reminders.tick(due + 2000);                // moved: treated as a new deadline
  assert.equal(sent.length, 2);
  ctx.reminders.tick(due + 3 * DAY - 30 * 60000);
  assert.equal(sent.length, 3);                  // 1h step for the new time
});

test('reminders: no nagging long after the due time, done items stay quiet', () => {
  const ctx = makeCtx();
  const sent = [];
  ctx.reminders = new ReminderService(ctx, { notifier: (t) => sent.push(t) });
  const items = ctx.store.collection('items');
  const now = Date.now();
  const a = items.add({ title: 'Late', deadline: new Date(now + HOUR).toISOString() });
  const b = items.add({ title: 'Finished', deadline: new Date(now + HOUR).toISOString() });
  ctx.reminders.tick(now);
  items.update(b.id, Item.statusPatch('done'));
  ctx.reminders.tick(now + HOUR + GRACE + 1000);
  assert.equal(sent.length, 0);
});
