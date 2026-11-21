import test from 'node:test';
import { rulesFor } from './helpers/rulesFor.mjs';
import assert from 'node:assert/strict';
import { EventBus } from '../renderer/core/EventBus.js';
import { Store } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { Item } from '../renderer/modules/workspace/Item.js';
import { ItemSync, MAX_CLOCK_SKEW } from '../renderer/modules/phonesync/ItemSync.js';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function setup(rows = []) {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('items', Item);
  store.collection('items').load(rows);
  return { store, items: store.collection('items'), sync: new ItemSync({ rulesFor, store, now: () => NOW }) };
}

const body = (extra = {}) => ({
  id: 'a1', title: 'Read chapter 3', start: null, end: '2026-11-01T09:00:00.000Z', done: false, updatedAt: iso(NOW - 1000), ...extra,
});
const put = (sync, b) => sync.handle({ op: 'put', payload: { body: b } });

const pcItem = (extra = {}) => ({
  id: 'a1', kind: 'assignment', title: 'PC title', status: 'todo', description: 'my private notes', parentId: 'folder1',
  deadline: '2026-11-05T00:00:00.000Z', completedAt: null, createdAt: iso(NOW - 99999), updatedAt: iso(NOW - 5000), ...extra,
});

test('a new task from the phone is created at top level as a task', () => {
  const { sync, items } = setup();
  const r = put(sync, body({ start: '2026-11-01T08:00:00Z' }));
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, {
    id: 'a1', title: 'Read chapter 3', start: '2026-11-01T08:00:00.000Z', end: '2026-11-01T09:00:00.000Z',
    done: false, updatedAt: iso(NOW - 1000), kind: 'task', parentId: null, createdAt: iso(NOW - 1000), description: '', course: null, source: null, repeat: null, result: 'created',
  });
  const item = items.get('a1');
  assert.equal(item.kind, 'task');
  assert.equal(item.parentId, null);
  assert.equal(item.deadline, '2026-11-01T09:00:00.000Z'); // phone "end" is the deadline
  assert.equal(item.status, 'todo');
});

test('a newer phone edit replaces the shared fields only; the PC keeps its own', () => {
  const { sync, items } = setup([pcItem({ doc: { type: 'doc' } })]);
  const r = put(sync, body({ title: 'Phone title', end: '2026-11-09T10:00:00Z', updatedAt: iso(NOW - 100) })); // (an assignment: no start)
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'updated');
  const item = items.get('a1');
  assert.equal(item.title, 'Phone title');
  assert.equal(item.deadline, '2026-11-09T10:00:00.000Z');
  assert.equal(item.start, null);
  assert.equal(item.kind, 'assignment');             // untouched
  assert.equal(item.description, 'my private notes'); // untouched
  assert.equal(item.parentId, 'folder1');            // untouched
  assert.deepEqual(item.doc, { type: 'doc' });       // untouched
  assert.equal(item.updatedAt, iso(NOW - 100));      // the phone's edit time is kept
});

test('an older phone edit loses and the reply carries the PC version', () => {
  const { sync, items } = setup([pcItem()]);
  const r = put(sync, body({ title: 'Stale phone title', updatedAt: iso(NOW - 60000) }));
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'kept-newer');
  assert.equal(r.body.title, 'PC title');
  assert.equal(r.body.end, '2026-11-05T00:00:00.000Z');
  assert.equal(items.get('a1').title, 'PC title');
});

test('an equal time is a tie and the PC wins', () => {
  const { sync, items } = setup([pcItem({ updatedAt: iso(NOW - 1000) })]);
  const r = put(sync, body({ title: 'Phone title', updatedAt: iso(NOW - 1000) }));
  assert.equal(r.body.result, 'kept-newer');
  assert.equal(items.get('a1').title, 'PC title');
});

test('phone clock too far ahead: this PC clock is used instead', () => {
  const { sync, items } = setup([pcItem({ updatedAt: iso(NOW - 5000) })]);
  const r = put(sync, body({ title: 'From the future', updatedAt: iso(NOW + 3 * 60 * 60 * 1000) }));
  assert.equal(r.body.result, 'updated');
  assert.equal(items.get('a1').updatedAt, iso(NOW)); // not the phone's 3-hours-ahead time

  // ...so a real later PC edit still beats it, and a slightly-ahead (within 5 min) time is trusted as sent
  const { sync: s2, items: i2 } = setup([pcItem({ updatedAt: iso(NOW - 5000) })]);
  put(s2, body({ updatedAt: iso(NOW + MAX_CLOCK_SKEW - 1000) }));
  assert.equal(i2.get('a1').updatedAt, iso(NOW + MAX_CLOCK_SKEW - 1000));
});

test('done maps onto the 3-value status: doing stays doing, done sets and clears completedAt', () => {
  const { sync, items } = setup([pcItem({ status: 'doing' })]);
  put(sync, body({ done: false, updatedAt: iso(NOW - 100) }));
  assert.equal(items.get('a1').status, 'doing');           // not-done must not flatten "in progress"

  put(sync, body({ done: true, updatedAt: iso(NOW - 90) }));
  assert.equal(items.get('a1').status, 'done');
  assert.equal(items.get('a1').completedAt, iso(NOW - 90));

  put(sync, body({ done: true, title: 'again', updatedAt: iso(NOW - 80) }));
  assert.equal(items.get('a1').completedAt, iso(NOW - 90)); // already done: the first completion time stays

  put(sync, body({ done: false, updatedAt: iso(NOW - 70) }));
  assert.equal(items.get('a1').status, 'todo');            // done -> not done goes back to todo
  assert.equal(items.get('a1').completedAt, null);
});

test('times with an offset are stored as UTC; a time with no zone is refused', () => {
  const { sync, items } = setup();
  assert.equal(put(sync, body({ start: '2026-11-01T08:00:00Z', end: '2026-11-01T11:00:00+02:00' })).status, 201);
  assert.equal(items.get('a1').deadline, '2026-11-01T09:00:00.000Z');

  for (const bad of ['2026-11-01T09:00:00', '2026-11-01', 'tomorrow', 12345, '']) {
    assert.equal(put(setup().sync, body({ end: bad })).status, 422, `end: ${bad}`);
  }
});

test('invalid bodies get 422 and change nothing', () => {
  const { sync, items } = setup();
  const bads = [
    null, 'text', {}, body({ id: '' }), body({ id: 5 }), body({ id: 'x'.repeat(65) }), body({ title: 7 }),
    body({ title: 'x'.repeat(501) }), body({ done: 'yes' }), body({ done: undefined }), body({ updatedAt: null }), body({ updatedAt: 'nope' }),
  ];
  for (const b of bads) assert.equal(put(sync, b).status, 422, JSON.stringify(b)?.slice(0, 60));
  assert.equal(items.all().length, 0);
  assert.equal(sync.handle({ op: 'frobnicate', payload: {} }).status, 422);
});

test('only task, assignment and note sync: a folder or file with that id is refused', () => {
  for (const kind of ['folder', 'file', 'project']) {
    const { sync, items } = setup([pcItem({ kind })]);
    const r = put(sync, body({ updatedAt: iso(NOW) }));
    assert.deepEqual([r.status, r.body.error], [422, 'not-syncable'], kind);
    assert.equal(items.get('a1').title, 'PC title');
    assert.equal(sync.handle({ op: 'delete', payload: { id: 'a1' } }).status, 422);
    assert.ok(items.get('a1'));
  }
});

test('delete: removes the task, is safe to repeat, and keeps one that has things filed inside', () => {
  const { sync, items } = setup([pcItem(), pcItem({ id: 'b2', kind: 'task' }), pcItem({ id: 'child', kind: 'note', parentId: 'b2' })]);
  assert.deepEqual(sync.handle({ op: 'delete', payload: { id: 'a1' } }), { status: 200, body: { id: 'a1', deleted: true } });
  assert.equal(items.get('a1'), null);
  assert.equal(sync.handle({ op: 'delete', payload: { id: 'a1' } }).status, 200); // already gone

  const kept = sync.handle({ op: 'delete', payload: { id: 'b2' } });
  assert.deepEqual(kept.body, { id: 'b2', deleted: false, result: 'kept-has-contents' });
  assert.ok(items.get('b2') && items.get('child'));
  assert.equal(sync.handle({ op: 'delete', payload: { id: '' } }).status, 422);
});

test('without the workspace data, task requests get 503', () => {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  const r = new ItemSync({ rulesFor, store, now: () => NOW }).handle({ op: 'put', payload: { body: body() } });
  assert.equal(r.status, 503);
});

test('a phone edit shows up in the calendar and top bar through the normal deadline field', () => {
  const { sync, items } = setup();
  put(sync, body({ start: '2026-11-03T07:00:00Z', end: '2026-11-03T08:00:00Z' }));
  assert.equal(items.get('a1').deadlineDate.toISOString(), '2026-11-03T08:00:00.000Z');
});
