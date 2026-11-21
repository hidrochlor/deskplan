import test from 'node:test';
import assert from 'node:assert/strict';
import { rulesFor, noteText } from './helpers/rulesFor.mjs';
import { EventBus } from '../renderer/core/EventBus.js';
import { Store } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { Item } from '../renderer/modules/workspace/Item.js';
import { NoteVersions, COPY_SUFFIX } from '../renderer/modules/workspace/NoteVersions.js';
import { ItemSync } from '../renderer/modules/phonesync/ItemSync.js';
import { ItemPull } from '../renderer/modules/phonesync/ItemPull.js';
import { SyncLog } from '../renderer/modules/phonesync/SyncLog.js';
import { PhoneItemMapper, MAX_DESCRIPTION } from '../renderer/modules/phonesync/PhoneItemMapper.js';

// Notes sync with the phone (docs/protocol.md section 4 "Note text", section 5 ping `features` and pull `kinds`).

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const text = (t, marks) => (marks ? { type: 'text', text: t, marks: marks.map((type) => ({ type })) } : { type: 'text', text: t });
const DOC = {
  type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [text('Week 3')] },
    { type: 'paragraph', content: [text('Read ', ['bold']), text('chapter 3')] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [text('Slides')] }] }] },
  ],
};
// A part the PC editor does not edit: it must come back exactly as sent.
const TABLE = { type: 'table', attrs: { cols: 2 }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [text('a')] }] }] }] };

const row = (id, kind, extra = {}) => ({
  id, kind, title: `${kind} ${id}`, status: 'todo', description: '', parentId: null, deadline: null, doc: null,
  completedAt: null, createdAt: iso(NOW - 99999), updatedAt: iso(NOW - 5000), ...extra,
});

function setup(rows = []) {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('items', Item);
  store.collection('items').load([row('csc', 'folder'), row('hw', 'assignment', { parentId: 'csc', deadline: iso(NOW + 99999) }), row('t', 'task'), ...rows]);
  const log = new SyncLog({ store, bus, now: () => NOW }); log.start();
  const mapper = new PhoneItemMapper({ noteText });
  return {
    store, items: store.collection('items'), log,
    sync: new ItemSync({ rulesFor, store, mapper, now: () => NOW }), pull: new ItemPull({ rulesFor, store, log, mapper, now: () => NOW }),
  };
}

const note = (extra = {}) => ({ id: 'n1', title: 'Week 3', start: null, end: null, done: false, updatedAt: iso(NOW - 1000), kind: 'note', doc: DOC, ...extra });
const put = (s, b) => s.sync.handle({ op: 'put', payload: { body: b } });
const bad = (r, msg) => assert.deepEqual([r.status, r.body.error], [422, 'invalid-request'], msg);

test('a note from the phone is created with its doc, and the PC makes its plain text', () => {
  const s = setup();
  const r = put(s, note({ parentId: 'csc', description: 'ignored on a note' }));
  assert.equal(r.status, 201);
  assert.equal(r.body.result, 'created');
  const item = s.items.get('n1');
  assert.deepEqual([item.kind, item.parentId, item.title], ['note', 'csc', 'Week 3']);
  assert.deepEqual(item.doc, DOC);
  assert.equal(item.description, noteText.toPlainText(DOC));
  assert.deepEqual(r.body, {
    id: 'n1', title: 'Week 3', start: null, end: null, done: false, updatedAt: iso(NOW - 1000), kind: 'note', parentId: 'csc',
    createdAt: iso(NOW - 1000), description: item.description, course: 'folder csc', source: null, repeat: null, doc: DOC, result: 'created',
  });
});

test('a new note without doc is empty; a note can be at Home, in a folder or in an assignment, never in a task', () => {
  const s = setup();
  const r = put(s, note({ doc: undefined }));
  assert.equal(r.status, 201);
  assert.equal(s.items.get('n1').doc, null);
  assert.deepEqual(r.body.doc, { type: 'doc', content: [{ type: 'paragraph' }] }); // sent as a doc all the same
  assert.equal(put(s, note({ id: 'n2', parentId: 'hw' })).status, 201);
  bad(put(s, note({ id: 'n3', parentId: 't' })), 'inside a task');
  bad(put(s, note({ id: 'n4', parentId: 'n1' })), 'inside a note');
  bad(put(s, note({ id: 'n5', parentId: 'nope' })), 'a parent that does not exist');
});

test('a note has no times and no tick: a start, an end or done: true is refused', () => {
  const s = setup();
  bad(put(s, note({ end: '2026-11-01T09:00:00Z' })), 'end');
  bad(put(s, note({ start: '2026-11-01T08:00:00Z', end: '2026-11-01T09:00:00Z' })), 'start');
  bad(put(s, note({ done: true })), 'done');
  assert.equal(s.items.get('n1'), null);
});

test('a bad doc is refused; an unknown node type is fine', () => {
  const s = setup();
  let deep = { type: 'paragraph' };
  for (let i = 0; i < 60; i++) deep = { type: 'blockquote', content: [deep] };
  for (const doc of [null, 'text', [], { type: 'nope', content: [] }, { type: 'doc' }, { type: 'doc', content: {} },
    { type: 'doc', content: [5] }, { type: 'doc', content: [{}] }, { type: 'doc', content: [{ type: 3 }] },
    { type: 'doc', content: [{ type: 'paragraph', content: 'x' }] }, { type: 'doc', content: [{ type: 'text', text: 5 }] },
    { type: 'doc', content: [{ type: 'text', text: 'a', marks: [{}] }] }, { type: 'doc', content: [deep] }]) {
    bad(put(s, note({ doc })), JSON.stringify(doc).slice(0, 60));
  }
  assert.equal(put(s, note({ doc: { type: 'doc', content: [{ type: 'mystery', attrs: { x: 1 } }] } })).status, 201);
});

test('a phone edit of a note replaces title, place and doc; the table is kept unchanged; a PC due time stays', () => {
  const pcDue = iso(NOW + 5000);
  const s = setup([row('n1', 'note', { doc: DOC, description: 'old', deadline: pcDue, parentId: 'csc' })]);
  const doc = { type: 'doc', content: [...DOC.content, TABLE] };
  const r = put(s, note({ title: 'Edited', doc, parentId: 'hw' }));
  assert.equal(r.body.result, 'updated');
  const item = s.items.get('n1');
  assert.deepEqual([item.title, item.parentId, item.deadline], ['Edited', 'hw', pcDue]);
  assert.deepEqual(item.doc.content.at(-1), TABLE);
  assert.match(item.description, /a$/);              // the table's text is in the plain copy
  assert.deepEqual([r.body.start, r.body.end, r.body.done], [null, null, false]); // the phone never sees the PC due time
  assert.equal(item.updatedAt, iso(NOW - 1000));

  // Left out: the doc is kept. Times on an existing note are refused too.
  assert.equal(put(s, note({ title: 'Again', doc: undefined, updatedAt: iso(NOW - 500) })).body.result, 'updated');
  assert.deepEqual(s.items.get('n1').doc, doc);
  bad(put(s, note({ end: pcDue, updatedAt: iso(NOW - 100) })), 'end on an existing note');
});

test('an older phone edit of a note gets kept-newer with the PC doc, and nothing changes', () => {
  const s = setup([row('n1', 'note', { doc: DOC, updatedAt: iso(NOW - 10) })]);
  const r = put(s, note({ doc: { type: 'doc', content: [] }, updatedAt: iso(NOW - 1000) }));
  assert.equal(r.body.result, 'kept-newer');
  assert.deepEqual(r.body.doc, DOC);
  assert.deepEqual(s.items.get('n1').doc, DOC);
});

test('the kind of a note is fixed, and a task cannot become a note', () => {
  const s = setup([row('n1', 'note')]);
  bad(put(s, note({ kind: 'task', updatedAt: iso(NOW - 10) })), 'note to task');
  bad(put(s, { id: 't', title: 'x', start: null, end: null, done: false, updatedAt: iso(NOW - 10), kind: 'note' }), 'task to note');
  assert.equal(s.items.get('t').kind, 'task');
});

test('description: checked on tasks (max 16,000), ignored on notes; doc is ignored on a task', () => {
  const s = setup();
  const task = (extra) => ({ id: 'x1', title: 'T', start: '2026-11-01T08:00:00Z', end: '2026-11-01T09:00:00Z', done: false, updatedAt: iso(NOW - 1000), ...extra });
  bad(put(s, task({ description: 3 })), 'not text');
  bad(put(s, task({ description: 'x'.repeat(MAX_DESCRIPTION + 1) })), 'too long');
  assert.equal(put(s, task({ doc: { junk: true } })).status, 201);
  assert.equal(s.items.get('x1').doc, null);
  assert.equal(put(s, note({ description: 'x'.repeat(MAX_DESCRIPTION + 1) })).status, 201);
});

test('deleting a note works like a task; an assignment holding only a note is kept', () => {
  const s = setup([row('n1', 'note'), row('n2', 'note', { parentId: 'hw' })]);
  assert.deepEqual(s.sync.handle({ op: 'delete', payload: { id: 'n1' } }).body, { id: 'n1', deleted: true });
  assert.equal(s.items.get('n1'), null);
  s.items.remove('t');
  assert.equal(s.sync.handle({ op: 'delete', payload: { id: 'hw' } }).body.result, 'kept-has-contents');
  assert.deepEqual(s.log.deletedSince(0).map((d) => d.id).sort(), ['n1', 't']);
});

test('pull: notes only when asked for with kinds; deletions are never filtered', () => {
  const s = setup([row('n1', 'note', { doc: DOC })]);
  const ids = (r) => r.body.items.map((i) => i.id).sort();
  assert.deepEqual(ids(s.pull.handle({})), ['hw', 't']);                              // left out: tasks and assignments
  assert.deepEqual(ids(s.pull.handle({ kinds: 'task,assignment,note' })), ['hw', 'n1', 't']);
  assert.deepEqual(ids(s.pull.handle({ kinds: 'note' })), ['n1']);
  const full = s.pull.handle({ kinds: 'note' }).body;
  assert.equal(full.fullResync, true);
  assert.deepEqual(full.items[0].doc, DOC);
  assert.deepEqual([full.items[0].start, full.items[0].end, full.items[0].done], [null, null, false]);

  s.items.remove('n1');
  assert.deepEqual(s.pull.handle({ since: iso(NOW), kinds: 'task' }).body.items, [{ id: 'n1', deleted: true }]);
  for (const k of ['', 'task,', 'folder', 'Task', 'task,nope']) bad(s.pull.handle({ kinds: k }), JSON.stringify(k));
});

test('pull: an old note with only plain text is sent as a doc built from that text', () => {
  const s = setup([row('old', 'note', { description: '- milk\n[x] eggs' })]);
  const item = s.pull.handle({ kinds: 'note' }).body.items[0];
  assert.deepEqual(item.doc, noteText.fromPlainText('- milk\n[x] eggs'));
  assert.equal(item.description, '- milk\n[x] eggs');
});

// ── The open note page (NoteVersions) ───────────────────────────────────────

test('note page: its own saves are not outside changes; a phone change with nothing typed reloads', () => {
  const s = setup([row('n1', 'note', { doc: DOC })]);
  const v = new NoteVersions(s.items, 'n1');
  const mine = { type: 'doc', content: [] };
  assert.equal(v.target(mine), 'n1');
  s.items.update('n1', { doc: mine });
  assert.equal(v.changed(false), 'none');
  s.items.update('n1', { title: 'renamed' });
  assert.equal(v.changed(true), 'none');               // only the title changed

  s.items.update('n1', { doc: structuredClone(DOC) }); // what the phone sync does: a new doc object
  assert.equal(v.changed(false), 'reload');
  assert.equal(v.target(mine), 'n1');                  // saving after a reload goes to the note
});

test('note page: a phone change while typing keeps both: typing goes into one "(PC copy)" until reload', () => {
  const s = setup([row('n1', 'note', { doc: DOC, parentId: 'csc', title: 'Week 3' })]);
  const v = new NoteVersions(s.items, 'n1');
  const phoneDoc = { type: 'doc', content: [{ type: 'paragraph', content: [text('from the phone')] }] };
  s.items.update('n1', { doc: phoneDoc });
  assert.equal(v.changed(true), 'conflict');

  const typed = { type: 'doc', content: [{ type: 'paragraph', content: [text('typed on the PC')] }] };
  const copyId = v.target(typed);
  assert.notEqual(copyId, 'n1');
  const copy = s.items.get(copyId);
  assert.deepEqual([copy.kind, copy.parentId, copy.title], ['note', 'csc', `Week 3${COPY_SUFFIX}`]);
  assert.equal(v.target(typed), copyId);               // later saves go to the same copy
  assert.deepEqual(s.items.get('n1').doc, phoneDoc);   // the phone's text is untouched

  assert.deepEqual(v.reload(), phoneDoc);
  assert.equal(v.target(typed), 'n1');
});

test('note page: the copy title stays within the 500-character limit', () => {
  const s = setup([row('n1', 'note', { title: 'x'.repeat(500) })]);
  const v = new NoteVersions(s.items, 'n1');
  s.items.update('n1', { doc: structuredClone(DOC) });
  v.changed(true);
  const title = s.items.get(v.target(DOC)).title;
  assert.equal(title.length, 500);
  assert.ok(title.endsWith(COPY_SUFFIX));
});
