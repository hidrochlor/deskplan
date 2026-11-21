import test from 'node:test';
import { rulesFor } from './helpers/rulesFor.mjs';
import assert from 'node:assert/strict';
import { EventBus } from '../renderer/core/EventBus.js';
import { Store, migrate, SCHEMA_VERSION } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { Item } from '../renderer/modules/workspace/Item.js';
import { ItemTree } from '../renderer/modules/workspace/ItemTree.js';
import { ItemSync } from '../renderer/modules/phonesync/ItemSync.js';
import { ItemPull } from '../renderer/modules/phonesync/ItemPull.js';
import { SyncLog } from '../renderer/modules/phonesync/SyncLog.js';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const DUE = '2026-11-05T09:00:00.000Z';

const row = (id, kind, extra = {}) => ({
  id, kind, title: `${kind} ${id}`, status: 'todo', description: '', parentId: null, deadline: null,
  completedAt: null, createdAt: iso(NOW - 99999), updatedAt: iso(NOW - 5000), ...extra,
});

// A course folder "csc", an assignment "hw" in it (with a step), a plain task "t" at Home, and a note.
const world = () => [
  row('csc', 'folder', { title: 'CSC101' }),
  row('week1', 'folder', { title: 'Week 1', parentId: 'csc' }),
  row('hw', 'assignment', { parentId: 'csc', deadline: DUE }),
  row('step', 'task', { parentId: 'hw' }),
  row('t', 'task'),
  row('n', 'note', { parentId: 'csc' }),
];

function setup(rows = world()) {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('items', Item);
  store.collection('items').load(rows);
  const log = new SyncLog({ store, bus, now: () => NOW }); log.start();
  return {
    store, bus, items: store.collection('items'), tree: new ItemTree(store.collection('items')), log,
    sync: new ItemSync({ rulesFor, store, now: () => NOW }), pull: new ItemPull({ rulesFor, store, log, now: () => NOW }),
  };
}

const body = (extra = {}) => ({ id: 'new1', title: 'From phone', start: null, end: null, done: false, updatedAt: iso(NOW - 1000), ...extra });
const S = '2026-11-05T08:00:00.000Z';
const E = '2026-11-05T09:00:00.000Z';
// A new task is a time block: it needs a start and an end.
const task = (extra = {}) => body({ start: S, end: E, ...extra });
const put = (s, b) => s.sync.handle({ op: 'put', payload: { body: b } });
const bad = (r, msg) => assert.deepEqual([r.status, r.body.error], [422, 'invalid-request'], msg);

// ── The phone creates and changes kind and parent ───────────────────────────────

test('kind and parentId: a new item defaults to a task at the top level of Home, and the reply says so', () => {
  const s = setup();
  const r = put(s, task());
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.kind, r.body.parentId], ['task', null]);
  assert.deepEqual([s.items.get('new1').kind, s.items.get('new1').parentId], ['task', null]);
});

test('an assignment from the phone: needs a folder as parent and an end time', () => {
  const s = setup();
  const r = put(s, body({ kind: 'assignment', parentId: 'csc', end: DUE }));
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.kind, r.body.parentId, r.body.end], ['assignment', 'csc', DUE]);
  assert.equal(s.items.get('new1').kind, 'assignment');

  bad(put(setup(), body({ kind: 'assignment', end: DUE })), 'no parent: the top level of Home');
  bad(put(setup(), body({ kind: 'assignment', parentId: null, end: DUE })), 'parent null is Home too');
  bad(put(setup(), body({ kind: 'assignment', parentId: 'csc' })), 'no end');
  bad(put(setup(), body({ kind: 'assignment', parentId: 'ghost', end: DUE })), 'parent does not exist');
  bad(put(setup(), body({ kind: 'assignment', parentId: 'hw', end: DUE })), 'inside another assignment');
  bad(put(setup(), body({ kind: 'assignment', parentId: 't', end: DUE })), 'inside a task');
  bad(put(setup(), body({ kind: 'assignment', parentId: 'n', end: DUE })), 'inside a note');
  assert.equal(setup().items.get('new1'), null);
});

test('a task may sit at Home, in a folder, or in an assignment (a step); nowhere else', () => {
  for (const parentId of [null, 'csc', 'week1', 'hw']) {
    const s = setup();
    assert.equal(put(s, task({ parentId })).status, 201, String(parentId));
    assert.equal(s.items.get('new1').parentId, parentId);
  }
  bad(put(setup(), task({ parentId: 't' })), 'inside a task');
  bad(put(setup(), task({ parentId: 'n' })), 'inside a note');
  bad(put(setup(), task({ parentId: 'ghost' })), 'parent does not exist');
  bad(put(setup(), task({ kind: 'task', parentId: 'step' })), 'inside a step');
});

test('a missing kind or parentId keeps what the PC has; null moves a task to Home', () => {
  const s = setup();
  const keep = put(s, body({ id: 'step', title: 'Renamed', updatedAt: iso(NOW - 100) }));
  assert.equal(keep.status, 200);
  assert.deepEqual([keep.body.kind, keep.body.parentId], ['task', 'hw']);
  assert.equal(s.items.get('step').parentId, 'hw');

  put(s, body({ id: 'step', updatedAt: iso(NOW - 90), parentId: null }));
  assert.equal(s.items.get('step').parentId, null);               // explicit null = Home

  put(s, body({ id: 'step', updatedAt: iso(NOW - 80), parentId: 'week1' }));
  assert.equal(s.items.get('step').parentId, 'week1');
  assert.equal(s.items.get('step').kind, 'task');
});

test('an assignment can not go to Home or lose its end', () => {
  const s = setup();
  bad(put(s, body({ id: 'hw', parentId: null, end: DUE, updatedAt: iso(NOW - 5) })), 'assignment to Home');
  bad(put(s, body({ id: 'hw', end: null, updatedAt: iso(NOW - 5) })), 'an assignment edit with no end');
  assert.equal(s.items.get('hw').parentId, 'csc');
});

test('the type is fixed after creation: another kind on an existing item is 422, the same kind is fine', () => {
  const s = setup();
  bad(put(s, body({ id: 't', kind: 'assignment', parentId: 'csc', end: DUE, updatedAt: iso(NOW - 10) })), 'task to assignment');
  bad(put(s, body({ id: 'hw', kind: 'task', parentId: 'csc', end: DUE, updatedAt: iso(NOW - 10) })), 'assignment to task');
  assert.deepEqual([s.items.get('t').kind, s.items.get('hw').kind], ['task', 'assignment']);
  assert.equal(put(s, body({ id: 'hw', kind: 'assignment', parentId: 'csc', end: DUE, updatedAt: iso(NOW - 5) })).status, 200);
  // a stale edit loses before any rule is looked at: the PC's version comes back and nothing changes
  assert.equal(put(s, body({ id: 'hw', kind: 'task', parentId: 'csc', end: DUE, updatedAt: iso(NOW - 60000) })).body.result, 'kept-newer');
});

test('nothing can be moved inside itself or what it holds', () => {
  const s = setup([...world(), row('big', 'task', { parentId: 'week1' }), row('inner', 'folder', { parentId: 'big' })]); // old data: a folder inside a task
  bad(put(s, body({ id: 'big', parentId: 'inner', updatedAt: iso(NOW - 5) })), 'into its own folder');
  bad(put(s, body({ id: 'big', parentId: 'big', updatedAt: iso(NOW - 5) })), 'into itself');
});

test('kind and parentId follow last-edit-wins: older loses, equal ties to the PC, newer wins', () => {
  const s = setup();
  const older = put(s, body({ id: 'step', parentId: 'week1', updatedAt: iso(NOW - 60000) }));
  assert.equal(older.body.result, 'kept-newer');
  assert.equal(older.body.parentId, 'hw');                         // the reply carries the PC's version
  assert.equal(s.items.get('step').parentId, 'hw');

  const tie = put(s, body({ id: 'step', parentId: 'week1', updatedAt: iso(NOW - 5000) }));
  assert.equal(tie.body.result, 'kept-newer');

  const newer = put(s, body({ id: 'step', parentId: 'week1', updatedAt: iso(NOW - 100) }));
  assert.equal(newer.body.result, 'updated');
  assert.equal(newer.body.parentId, 'week1');
});

test('a stale phone edit is not refused for rules: nothing changes, the PC version comes back', () => {
  const s = setup();
  const r = put(s, body({ id: 'hw', parentId: null, updatedAt: iso(NOW - 60000) })); // would break the rules if applied
  assert.deepEqual([r.status, r.body.result, r.body.parentId], [200, 'kept-newer', 'csc']);
});

test('bad shapes for kind and parentId are 422', () => {
  for (const extra of [{ kind: 'folder' }, { kind: 'file' }, { kind: 5 }, { kind: null }, { kind: '' }, { kind: 'Task' },
    { parentId: 5 }, { parentId: '' }, { parentId: 'has space' }, { parentId: 'x'.repeat(65) }, { parentId: ['csc'] }, { parentId: {} }]) {
    bad(put(setup(), body(extra)), JSON.stringify(extra));
  }
});

test('the PC ignores JSON fields it does not know, and never takes PC-only fields from the phone', () => {
  const s = setup([...world(), row('mine', 'task', { description: 'my notes', doc: { type: 'doc' } })]);
  const r = put(s, body({ id: 'mine', updatedAt: iso(NOW - 10), createdAt: '1999-01-01T00:00:00Z', doc: null, file: { x: 1 }, status: 'done', foo: 'bar', priority: 3 }));
  assert.equal(r.status, 200);
  const item = s.items.get('mine');
  assert.equal(item.description, 'my notes');        // not sent: kept
  assert.equal(item.createdAt, iso(NOW - 99999));    // read-only: the phone's value is ignored
  assert.deepEqual(item.doc, { type: 'doc' });
  assert.equal(item.status, 'todo');                 // only "done" decides status
  assert.equal('foo' in item || 'priority' in item, false);
  assert.equal('foo' in r.body, false);

  const created = put(s, task({ id: 'fresh', foo: 'bar', createdAt: '1999-01-01T00:00:00Z' }));
  assert.equal(created.status, 201);
  assert.equal(s.items.get('fresh').createdAt, iso(NOW - 1000));   // when the PC first heard of it, never the phone's claim
});

// ── Details (description) and created time ─────────────────────────────────────

test('description: optional on PUT, missing keeps the PC text, empty clears it, a new item starts with it', () => {
  const s = setup([...world(), row('mine', 'task', { description: 'my notes' })]);
  const created = put(s, task({ id: 'fresh', description: 'Read pages 3-9' }));
  assert.deepEqual([created.status, created.body.description], [201, 'Read pages 3-9']);
  assert.equal(s.items.get('fresh').description, 'Read pages 3-9');

  assert.equal(put(s, body({ id: 'mine', title: 'only the title', updatedAt: iso(NOW - 30) })).body.description, 'my notes'); // left out: kept
  assert.equal(put(s, body({ id: 'mine', description: 'phone text\nline 2', updatedAt: iso(NOW - 20) })).body.description, 'phone text\nline 2');
  assert.equal(s.items.get('mine').description, 'phone text\nline 2');
  assert.equal(put(s, body({ id: 'mine', description: '', updatedAt: iso(NOW - 10) })).body.description, '');
  assert.equal(s.items.get('mine').description, '');
});

test('description follows last-edit-wins like the other fields', () => {
  const s = setup([row('mine', 'task', { description: 'PC text' })]);
  const old = put(s, body({ id: 'mine', description: 'stale phone text', updatedAt: iso(NOW - 60000) }));
  assert.deepEqual([old.body.result, old.body.description], ['kept-newer', 'PC text']);
  assert.equal(s.items.get('mine').description, 'PC text');
  const tie = put(s, body({ id: 'mine', description: 'tie', updatedAt: iso(NOW - 5000) }));
  assert.equal(tie.body.result, 'kept-newer');
});

test('description: wrong type or too long is 422; a PC edit of the details shows up in the pull', () => {
  for (const description of [5, null, ['x'], {}, 'x'.repeat(16001)]) bad(put(setup(), body({ description })), String(description).slice(0, 10));
  assert.equal(put(setup(), task({ description: 'x'.repeat(16000) })).status, 201);

  const s = setup([row('mine', 'task')]);
  s.items.update('mine', { description: 'written on the PC' });           // the Details box
  s.items.get('mine').updatedAt = iso(NOW + 1000);                         // (pinned to this test's clock)
  const entry = s.pull.handle({ since: iso(NOW) }).body.items.find((i) => i.id === 'mine');
  assert.equal(entry.description, 'written on the PC');
});

test('createdAt is sent for display and never changed by a phone edit; push and pull never wipe PC data', () => {
  const s = setup([row('mine', 'task', { description: 'keep me', doc: { type: 'doc' }, createdAt: '2026-09-01T08:00:00.000Z' })]);
  const reply = put(s, body({ id: 'mine', title: 'phone edit', updatedAt: iso(NOW - 10) }));
  assert.equal(reply.body.createdAt, '2026-09-01T08:00:00.000Z');
  assert.equal(s.pull.handle({}).body.items.find((i) => i.id === 'mine').createdAt, '2026-09-01T08:00:00.000Z');
  const item = s.items.get('mine');
  assert.deepEqual([item.description, item.doc, item.createdAt], ['keep me', { type: 'doc' }, '2026-09-01T08:00:00.000Z']);
  assert.equal(s.pull.handle({}).body.items.find((i) => i.id === 'mine').description, 'keep me');
});

// ── The PC side: moving, the pull, deletions ────────────────────────────────────

test('moving an item on the PC bumps updatedAt, and the pull reports the new parent', () => {
  const s = setup();
  const before = s.items.get('step').updatedAt;
  assert.equal(s.tree.move('step', 'week1'), true);
  assert.notEqual(s.items.get('step').updatedAt, before);   // Collection.update stamps the real clock...
  s.items.get('step').updatedAt = iso(NOW + 1000);          // ...so pin it to this test's clock
  const { body: pulled } = s.pull.handle({ since: iso(NOW) });
  assert.equal(pulled.fullResync, false);
  assert.deepEqual(pulled.items.filter((i) => i.id === 'step').map((i) => [i.kind, i.parentId]), [['task', 'week1']]);
});

test('every pull entry carries kind and parentId', () => {
  const { pull } = setup();
  const items = pull.handle({}).body.items;
  assert.deepEqual(items.map((i) => [i.id, i.kind, i.parentId]).sort(), [
    ['hw', 'assignment', 'csc'], ['step', 'task', 'hw'], ['t', 'task', null],
  ]);
});

test('deleting an assignment on the PC deletes its steps too, and the pull reports each as deleted', () => {
  const s = setup();
  s.tree.removeTree('hw');
  const gone = s.pull.handle({ since: iso(NOW) }).body.items;
  assert.deepEqual(gone.filter((i) => i.deleted).map((i) => i.id).sort(), ['hw', 'step']);
  assert.equal(s.items.get('step'), null);
});

test('deleting a folder takes the assignments, steps and notes inside it along', () => {
  const s = setup();
  s.tree.removeTree('csc');
  assert.deepEqual(s.pull.handle({ since: iso(NOW) }).body.items.filter((i) => i.deleted).map((i) => i.id).sort(), ['hw', 'n', 'step']);
});

test('old data with a task inside a task: the phone is shown the nearest folder or assignment instead', () => {
  const s = setup([...world(), row('outer', 'task', { parentId: 'week1' }), row('nested', 'task', { parentId: 'outer' })]);
  const view = Object.fromEntries(s.pull.handle({}).body.items.map((i) => [i.id, i.parentId]));
  assert.equal(view.outer, 'week1');
  assert.equal(view.nested, 'week1');                 // outer is a task, so the phone sees week1
});

// ── Rules in the PC's own screens ───────────────────────────────────────────────

test('canMove: an assignment never goes to Home or into a non-folder; a folder never goes into an assignment', () => {
  const { tree } = setup([...world(), row('hw2', 'assignment', { parentId: 'week1', deadline: DUE }), row('other', 'folder')]);
  assert.equal(tree.canMove('hw', null), false);      // Home
  assert.equal(tree.canMove('hw', 'week1'), true);    // another folder
  assert.equal(tree.canMove('hw', 'hw2'), false);     // another assignment
  assert.equal(tree.canMove('week1', 'hw'), false);   // folder into an assignment
  assert.equal(tree.canMove('t', 'hw'), true);        // a task becomes a step
  assert.equal(tree.canMove('n', 'hw'), true);        // notes and files may go in an assignment too
  assert.equal(tree.canMove('t', null), false);       // already at Home
  assert.equal(tree.canMove('hw2', 'other'), true);
});

test('rules.problem: a new task needs a start and an end; only folders and assignments hold things', () => {
  const { tree } = setup();
  const { rules } = tree;
  const task = (extra) => ({ kind: 'task', parentId: null, start: S, deadline: E, creating: true, ...extra });
  assert.equal(rules.problem(task()), null);
  assert.match(rules.problem(task({ start: null })), /start and an end/);
  assert.match(rules.problem(task({ deadline: null, start: null })), /start and an end/);
  assert.match(rules.problem(task({ deadline: null })), /needs an end/);
  assert.equal(rules.problem(task({ start: null, creating: false })), null);          // an old task keeps working when edited
  assert.equal(rules.problem(task({ parentId: 'hw' })), null);                        // a step
  assert.match(rules.problem(task({ parentId: 't' })), /only be at Home/);            // a task holds nothing
  assert.match(rules.problem({ kind: 'note', parentId: 't', deadline: null }), /cannot go there/);
  assert.match(rules.problem({ kind: 'note', parentId: null, start: S, deadline: E }), /Only a task/);
  assert.equal(rules.holds('task', 'note'), false);
  assert.equal(rules.holds('folder', 'task'), true);
  assert.equal(rules.holds('assignment', 'folder'), false);
});

test('keepsStart: a task that has a start can not lose it', () => {
  const { tree, items } = setup([row('b', 'task', { start: S, deadline: E }), row('o', 'task', { deadline: E })]);
  const { rules } = tree;
  assert.match(rules.keepsStart(items.get('b'), null), /keeps its start/);
  assert.equal(rules.keepsStart(items.get('b'), S), null);
  assert.equal(rules.keepsStart(items.get('o'), null), null);                          // an old due-time task has none to keep
});

test('steps and progress: tasks directly inside an assignment; folder cards do not count them twice', () => {
  const { tree, items } = setup([...world(), row('step2', 'task', { parentId: 'hw', status: 'done' }), row('note-in', 'note', { parentId: 'hw' })]);
  assert.deepEqual(tree.progress('hw'), { done: 1, total: 2 });          // notes are not steps
  assert.deepEqual(tree.progress('csc'), { done: 0, total: 0 });         // not an assignment
  assert.equal(tree.rules.isStep(items.get('step')), true);
  assert.equal(tree.rules.isStep(items.get('t')), false);
  const s = tree.summary('csc');
  assert.equal(s.total, 1);                                              // just the assignment, not its 2 steps
  assert.equal(s.done, 0);
  items.update('hw', { status: 'done' });                                // submitted
  assert.equal(tree.summary('csc').done, 1);
});

test('course = the top-level folder of the path', () => {
  const { tree } = setup([...world(), row('deep', 'assignment', { parentId: 'week1', deadline: DUE })]);
  assert.equal(tree.course('deep').id, 'csc');
  assert.equal(tree.course('hw').id, 'csc');
  assert.equal(tree.course('week1').id, 'csc');
  assert.equal(tree.course('csc'), null);
  assert.equal(tree.course('t'), null);
});

// ── Migration: old assignments with no folder ───────────────────────────────────

const v2 = (items, meta = {}) => ({ version: 2, meta, collections: { items } });

test('migration: assignments with no folder move into one "Unsorted" folder and need a course', () => {
  const data = migrate(v2([
    row('a-home', 'assignment', { deadline: DUE }),
    row('a-task', 'assignment', { parentId: 't' }),
    row('t', 'task'),
    row('a-ok', 'assignment', { parentId: 'f', deadline: DUE }),
    row('f', 'folder'),
    row('a-gone', 'assignment', { parentId: 'deleted-folder' }),
  ]));
  assert.equal(data.version, SCHEMA_VERSION);
  const byId = Object.fromEntries(data.collections.items.map((i) => [i.id, i]));
  const unsorted = data.collections.items.filter((i) => i.title === 'Unsorted');
  assert.equal(unsorted.length, 1);
  assert.deepEqual([unsorted[0].kind, unsorted[0].parentId], ['folder', null]);
  assert.equal(data.meta.unsortedId, unsorted[0].id);
  for (const id of ['a-home', 'a-task', 'a-gone']) {
    assert.equal(byId[id].parentId, unsorted[0].id, id);
    assert.notEqual(byId[id].updatedAt, iso(NOW - 5000), `${id} was touched, so the phone sees it move`);
  }
  assert.equal(byId['a-ok'].parentId, 'f');                    // already in a folder: untouched
  assert.equal(byId['a-ok'].updatedAt, iso(NOW - 5000));
  assert.equal(byId.t.parentId, null);

  const s = setup(data.collections.items);
  s.store.meta.unsortedId = data.meta.unsortedId;
  assert.equal(s.tree.needsCourse(s.items.get('a-home'), s.store.meta.unsortedId), true);
  assert.equal(s.tree.needsCourse(s.items.get('a-ok'), s.store.meta.unsortedId), false);
  s.tree.move('a-home', 'f');                                  // once it has a course, the flag goes away
  assert.equal(s.tree.needsCourse(s.items.get('a-home'), s.store.meta.unsortedId), false);
});

test('migration: nothing to do means no Unsorted folder, and a newer file is left alone', () => {
  const none = migrate(v2([row('f', 'folder'), row('a', 'assignment', { parentId: 'f', deadline: DUE }), row('t', 'task')]));
  assert.equal(none.collections.items.some((i) => i.title === 'Unsorted'), false);
  assert.equal(none.meta.unsortedId, undefined);

  const current = migrate({ version: SCHEMA_VERSION, meta: {}, collections: { items: [row('a-home', 'assignment')] } });
  assert.equal(current.collections.items.length, 1);           // already migrated files are not touched again
  assert.equal(current.collections.items[0].parentId, null);
});

test('migration: reuses the Unsorted folder it made before', () => {
  const data = migrate(v2([row('u', 'folder', { title: 'Unsorted' }), row('a', 'assignment')], { unsortedId: 'u' }));
  assert.equal(data.collections.items.filter((i) => i.title === 'Unsorted').length, 1);
  assert.equal(data.collections.items.find((i) => i.id === 'a').parentId, 'u');
});
