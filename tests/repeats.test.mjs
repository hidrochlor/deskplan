import test from 'node:test';
import assert from 'node:assert/strict';
import { rulesFor } from './helpers/rulesFor.mjs';
import { EventBus } from '../renderer/core/EventBus.js';
import { Store } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { Item } from '../renderer/modules/workspace/Item.js';
import {
  Repeats, dueCopies, nextId, nextDates, readRepeat, rootOf, seriesOf,
} from '../renderer/modules/workspace/Repeats.js';
import { ItemDeadlineSource } from '../renderer/modules/workspace/ItemDeadlineSource.js';
import { ItemSync } from '../renderer/modules/phonesync/ItemSync.js';

// Local times, so the tests mean the same in any time zone (repeats move in local time).
const local = (y, m, d, h = 9, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const NOW = new Date(2026, 10, 2, 12).getTime(); // Mon Nov 2, 2026, 12:00
const WEEKLY = { every: 'week', interval: 1, until: null };

function setup(rows = []) {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('items', Item);
  store.collection('items').load(rows);
  new Repeats({ store, bus, now: () => NOW }).start();
  return { store, items: store.collection('items'), sync: new ItemSync({ rulesFor, store, now: () => NOW }) };
}

const task = (extra = {}) => ({
  id: 'gym', kind: 'task', title: 'Gym', status: 'todo', parentId: null, description: 'legs',
  start: local(2026, 11, 3, 8), deadline: local(2026, 11, 3, 9), repeat: WEEKLY, ...extra,
});

test('nextId counts copies from the same root and always fits 64 characters', () => {
  assert.equal(nextId('abc'), 'abc.r1');
  assert.equal(nextId('abc.r1'), 'abc.r2');
  assert.equal(nextId('abc.r9'), 'abc.r10');
  const long = 'x'.repeat(64);
  assert.equal(nextId(long), `${'x'.repeat(52)}.r1`);
  assert.ok(nextId(nextId(long)).length <= 64);
});

test('readRepeat accepts a rule and refuses anything else', () => {
  assert.deepEqual(readRepeat({ every: 'week' }), { every: 'week', interval: 1, until: null });
  assert.equal(readRepeat(null), null);
  for (const bad of [{}, { every: 'year' }, { every: 'day', interval: 0 }, { every: 'day', interval: 13 }, { every: 'day', until: 'soon' }, []]) {
    assert.equal(readRepeat(bad), undefined, JSON.stringify(bad));
  }
});

test('nextDates moves start and due together, skipping the ones already missed', () => {
  const next = nextDates({ start: local(2026, 10, 13, 8), deadline: local(2026, 10, 13, 9), repeat: WEEKLY }, NOW);
  assert.deepEqual(next, { start: local(2026, 11, 3, 8), deadline: local(2026, 11, 3, 9) }); // Oct 20, 27 skipped
});

test('a monthly rule keeps its day, falling on the last day of shorter months', () => {
  const monthly = { every: 'month', interval: 1, until: null };
  const jan31 = new Date(2027, 0, 31, 9).getTime() - 1;
  assert.equal(nextDates({ deadline: local(2027, 1, 31), repeat: monthly }, jan31 + 2).deadline, local(2027, 2, 28));
});

test('until ends the series', () => {
  const rule = { every: 'week', interval: 1, until: local(2026, 11, 5) };
  assert.equal(nextDates({ deadline: local(2026, 11, 3), repeat: rule }, NOW), null); // Nov 10 is after Nov 5
  assert.ok(nextDates({ deadline: local(2026, 10, 29), repeat: rule }, NOW)); // Nov 5 itself is still in
});

test('ticking a repeating task makes its next copy, once', () => {
  const { items } = setup([task()]);
  items.update('gym', Item.statusPatch('done'));
  const copy = items.get('gym.r1');
  assert.ok(copy);
  assert.deepEqual(
    [copy.title, copy.kind, copy.description, copy.status, copy.start, copy.deadline, copy.repeat],
    ['Gym', 'task', 'legs', 'todo', local(2026, 11, 10, 8), local(2026, 11, 10, 9), WEEKLY],
  );
  // Unticking and ticking again does not make a second copy, and a later edit of the done item makes none.
  items.update('gym', Item.statusPatch('todo'));
  items.update('gym', Item.statusPatch('done'));
  items.update('gym', { title: 'Gym!' });
  assert.equal(items.all().length, 2);
});

test('an item already done when DeskPlan starts makes no copy; nor does one without a rule', () => {
  const { items } = setup([task({ status: 'done' }), task({ id: 'once', repeat: null })]);
  items.update('gym', { title: 'Gym (done)' });
  items.update('once', Item.statusPatch('done'));
  assert.equal(items.all().length, 2);
});

test('the phone ticking a repeating item makes the copy with the id the phone also makes', () => {
  const { items, sync } = setup([task({ updatedAt: new Date(NOW - 5000).toISOString() })]);
  const r = sync.handle({ op: 'put', payload: { body: {
    id: 'gym', title: 'Gym', start: task().start, end: task().deadline, done: true, updatedAt: new Date(NOW - 1000).toISOString(),
  } } });
  assert.equal(r.status, 200);
  assert.ok(items.get('gym.r1'));
  // The phone's own copy arrives after: same item, no duplicate.
  const copy = sync.handle({ op: 'put', payload: { body: {
    id: 'gym.r1', title: 'Gym', start: local(2026, 11, 10, 8), end: local(2026, 11, 10, 9), done: false,
    updatedAt: new Date(NOW - 500).toISOString(), repeat: WEEKLY,
  } } });
  assert.equal(copy.status, 200);
  assert.equal(items.all().length, 2);
});

test('the phone can set and clear a rule; an imported assignment ignores one; a bad rule is refused', () => {
  const { items, sync } = setup([
    task({ repeat: null, updatedAt: new Date(NOW - 5000).toISOString() }),
    { id: 'csc', kind: 'folder', title: 'CSC' },
    { id: 'hw', kind: 'assignment', title: 'HW', parentId: 'csc', deadline: local(2026, 11, 9), source: { label: 'Moodle' }, updatedAt: new Date(NOW - 5000).toISOString() },
  ]);
  const put = (body) => sync.handle({ op: 'put', payload: { body } });
  const base = { id: 'gym', title: 'Gym', start: task().start, end: task().deadline, done: false };
  put({ ...base, updatedAt: new Date(NOW - 3000).toISOString(), repeat: { every: 'day', interval: 2 } });
  assert.deepEqual(items.get('gym').repeat, { every: 'day', interval: 2, until: null });
  put({ ...base, updatedAt: new Date(NOW - 2000).toISOString() }); // left out: kept
  assert.deepEqual(items.get('gym').repeat, { every: 'day', interval: 2, until: null });
  put({ ...base, updatedAt: new Date(NOW - 1000).toISOString(), repeat: null });
  assert.equal(items.get('gym').repeat, null);

  put({ id: 'hw', title: 'HW', end: local(2026, 11, 9), done: false, updatedAt: new Date(NOW - 1000).toISOString(), repeat: WEEKLY });
  assert.equal(items.get('hw').repeat, null);

  const bad = put({ ...base, updatedAt: new Date(NOW - 500).toISOString(), repeat: { every: 'fortnight' } });
  assert.equal(bad.status, 422);
});

// German class, Mondays 16:00-17:30: the same case as the phone's tests, so both make the same copy.
const german = (id, day, extra = {}) => ({
  id, kind: 'task', title: 'German', status: 'todo', parentId: null,
  start: local(2026, 10, day, 16), deadline: local(2026, 10, day, 17, 30), repeat: WEEKLY, ...extra,
});

test('an occurrence that passed unticked moves its series on; it stays to do (missed)', () => {
  const { items } = setup([german('de', 26)]); // Oct 26, before NOW (Nov 2, 12:00)
  const copy = items.get('de.r1');
  assert.ok(copy, 'made when DeskPlan starts');
  assert.deepEqual([copy.start, copy.deadline, copy.status], [local(2026, 11, 2, 16), local(2026, 11, 2, 17, 30), 'todo']);
  assert.equal(items.get('de').status, 'todo');
  // Ticking the missed one later makes nothing more: its next copy is there.
  items.update('de', Item.statusPatch('done'));
  assert.equal(items.all().length, 2);
});

test('only the latest copy advances, never past until, and not while it is still to come', () => {
  const { items } = setup([german('de', 19, { status: 'done' }), german('de.r1', 26)]);
  assert.deepEqual(items.all().map((i) => i.id).sort(), ['de', 'de.r1', 'de.r2']);
  const ended = setup([german('x', 26, { repeat: { ...WEEKLY, until: local(2026, 11, 1) } })]);
  assert.equal(ended.items.all().length, 1);
  assert.deepEqual(dueCopies(ended.items, NOW), []);
});

test('seriesOf groups the copies, latest last; upcoming lists the dates to come up to until', () => {
  const rule = { ...WEEKLY, until: local(2026, 11, 30, 23) };
  const { items } = setup([german('de', 26, { status: 'done', repeat: rule }), { ...german('de.r1', 26, { repeat: rule }), start: local(2026, 11, 2, 16), deadline: local(2026, 11, 2, 17, 30) }, task({ repeat: null })]);
  const [series, ...rest] = seriesOf(items.all(), NOW);
  assert.equal(rest.length, 0);
  assert.equal(rootOf('de.r1'), 'de');
  assert.deepEqual(series.members.map((m) => m.id), ['de', 'de.r1']);
  assert.equal(series.latest.id, 'de.r1');
  assert.equal(series.ended(NOW), false);
  assert.deepEqual(series.upcoming().map((c) => new Date(c.start).getDate()), [9, 16, 23, 30]);
});

test('the calendar shows the copies still to come, quietly, pointing at the latest copy', () => {
  const { store } = setup([german('de', 26)]);
  const coming = new ItemDeadlineSource(store).events().filter((e) => e.id.includes(':next'));
  assert.ok(coming.length > 20); // half a year of Mondays
  assert.ok(coming.every((e) => e.quiet && e.ref.id === 'de.r1'));
});


test('tick the 9th and the 16th, untick both: the copies go again and the 9th is next', () => {
  const d = (id, day, status = 'todo') => german(id, day, { status, start: local(2026, 11, day, 16), deadline: local(2026, 11, day, 17, 30) });
  const { items } = setup([d('de', 9)]);
  items.update('de', Item.statusPatch('done'));
  items.update('de.r1', Item.statusPatch('done'));
  assert.deepEqual(items.all().map((i) => i.id).sort(), ['de', 'de.r1', 'de.r2']);
  items.update('de.r1', Item.statusPatch('todo'));
  assert.deepEqual(items.all().map((i) => i.id).sort(), ['de', 'de.r1']);
  items.update('de', Item.statusPatch('todo'));
  assert.deepEqual(items.all().map((i) => i.id), ['de']);
});

test('unticking keeps the copy when that copy is done, or when the time has passed', () => {
  const d = (id, day, status = 'todo') => german(id, day, { status, start: local(2026, 11, day, 16), deadline: local(2026, 11, day, 17, 30) });
  const { items } = setup([d('de', 9, 'done'), d('de.r1', 16, 'done'), d('de.r2', 23)]);
  items.update('de', Item.statusPatch('todo'));
  assert.equal(items.all().length, 3);
  const past = setup([german('old', 26, { status: 'done' }), d('old.r1', 9)]);
  past.items.update('old', Item.statusPatch('todo'));
  assert.equal(past.items.all().length, 2);
});

test('an edit of the series reaches the copies still ahead, not the past ones', () => {
  const at = (id, m, d, hr, status = 'todo') => german(id, d, { status, start: local(2026, m, d, hr), deadline: local(2026, m, d, hr, 30) });
  const { items } = setup([at('de', 10, 26, 14), at('de.r1', 11, 9, 14, 'done'), at('de.r2', 11, 16, 14)]);
  // 'de' is past and was missed: DeskPlan's start made nothing new, since de.r1 exists.
  items.update('de.r2', { title: 'Deutsch lernen', start: local(2026, 11, 16, 15), deadline: local(2026, 11, 16, 15, 30) });
  const r1 = items.get('de.r1');
  assert.deepEqual([r1.start, r1.title, r1.status], [local(2026, 11, 9, 15), 'Deutsch lernen', 'done']);
  assert.deepEqual([items.get('de').start, items.get('de').title], [local(2026, 10, 26, 14), 'German']);
});
