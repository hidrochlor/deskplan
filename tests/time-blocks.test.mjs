import test from 'node:test';
import assert from 'node:assert/strict';
import { rulesFor } from './helpers/rulesFor.mjs';
import { EventBus } from '../renderer/core/EventBus.js';
import { Registry } from '../renderer/core/Registry.js';
import { Store } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { HOUR } from '../renderer/core/dates.js';
import { Item } from '../renderer/modules/workspace/Item.js';
import { ItemDeadlineSource } from '../renderer/modules/workspace/ItemDeadlineSource.js';
import { ItemSync } from '../renderer/modules/phonesync/ItemSync.js';
import { ItemPull } from '../renderer/modules/phonesync/ItemPull.js';
import { SyncLog } from '../renderer/modules/phonesync/SyncLog.js';
import { PhoneItemMapper } from '../renderer/modules/phonesync/PhoneItemMapper.js';
import { CalendarEvent } from '../renderer/services/CalendarSource.js';
import { DeadlineService } from '../renderer/services/DeadlineService.js';
import { NextEventLabel } from '../renderer/services/NextEventLabel.js';
import { ReminderService, reachedSteps, reminderKey } from '../renderer/services/ReminderService.js';

// Local times, because the app shows local time (the clock is 24-hour by default).
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m);
const iso = (d) => d.toISOString();
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const row = (id, kind, extra = {}) => ({
  id, kind, title: `${kind} ${id}`, status: 'todo', description: '', parentId: null, deadline: null, start: null,
  completedAt: null, createdAt: new Date(NOW - 99999).toISOString(), updatedAt: new Date(NOW - 5000).toISOString(), ...extra,
});

function setup(rows = []) {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('items', Item);
  store.collection('items').load(rows);
  const registry = new Registry();
  registry.register('calendarSource', new ItemDeadlineSource(store));
  const log = new SyncLog({ store, bus, now: () => NOW }); log.start();
  return {
    store, items: store.collection('items'), rules: rulesFor(store.collection('items')), deadlines: new DeadlineService({ registry }),
    sync: new ItemSync({ store, rulesFor, now: () => NOW }), pull: new ItemPull({ store, log, rulesFor, now: () => NOW }),
  };
}

// ── The item ────────────────────────────────────────────────────────────────

test('an old save file without start still loads: start is null and it is a plain deadline', async () => {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage({ version: 2, meta: {}, collections: { items: [{ id: 'old', title: 'Old', kind: 'task', deadline: '2026-11-01T09:00:00.000Z' }] } }) });
  store.define('items', Item);
  await store.load();
  const item = store.collection('items').get('old');
  assert.equal(item.start, null);
  assert.equal(item.isBlock, false);
  assert.equal(item.startDate, null);
  assert.equal(item.deadlineDate.toISOString(), '2026-11-01T09:00:00.000Z');
});

test('isBlock: true only with a start before the deadline; the shape is the fields, there is no kind for it', () => {
  const block = new Item(row('b', 'task', { start: iso(at(6, 15)), deadline: iso(at(6, 19)) }));
  assert.equal(block.isBlock, true);
  assert.equal(new Item(row('d', 'task', { deadline: iso(at(6, 19)) })).isBlock, false);
  assert.equal(new Item(row('x', 'task', { start: iso(at(6, 19)), deadline: iso(at(6, 15)) })).isBlock, false); // start after end
  assert.equal(new Item(row('y', 'task', { start: iso(at(6, 15)) })).isBlock, false);                          // no end
  assert.equal(new Item(row('n', 'note', { start: iso(at(6, 15)), deadline: iso(at(6, 19)) })).isBlock, true);   // kind does not matter
});

// ── Validation ──────────────────────────────────────────────────────────────

test('timeProblem: a start needs an end and must be earlier; an assignment never has a start', () => {
  const { rules } = setup();
  const s = iso(at(6, 15));
  const e = iso(at(6, 19));
  assert.equal(rules.timeProblem({ kind: 'task', start: null, deadline: e }), null);
  assert.equal(rules.timeProblem({ kind: 'task', start: null, deadline: null }), null);
  assert.equal(rules.timeProblem({ kind: 'task', start: s, deadline: e }), null);
  assert.match(rules.timeProblem({ kind: 'task', start: s, deadline: null }), /needs an end/);
  assert.match(rules.timeProblem({ kind: 'task', start: e, deadline: s }), /earlier/);
  assert.match(rules.timeProblem({ kind: 'task', start: s, deadline: s }), /earlier/);        // equal is not earlier
  assert.match(rules.timeProblem({ kind: 'assignment', start: s, deadline: e }), /no start/);
  assert.match(rules.timeProblem({ kind: 'task', start: 'nonsense', deadline: e }), /not valid/);
});

test('a task keeps its start: removing it is refused, and the type never changes', () => {
  const s = setup([row('f', 'folder'), row('t', 'task', { parentId: 'f', deadline: iso(at(6, 19)), start: iso(at(6, 15)) })]);
  assert.match(s.rules.keepsStart(s.items.get('t'), null), /keeps its start/);
  assert.equal(s.rules.keepsStart(s.items.get('t'), iso(at(6, 14))), null);       // moving it is fine
});

// ── Phone sync ──────────────────────────────────────────────────────────────

const body = (extra = {}) => ({ id: 'p1', title: 'Study', start: null, end: iso(at(6, 19)), done: false, updatedAt: new Date(NOW - 1000).toISOString(), ...extra });
const put = (s, b) => s.sync.handle({ op: 'put', payload: { body: b } });
const refused = (r, msg) => assert.deepEqual([r.status, r.body.error], [422, 'invalid-request'], msg);

test('phone: a task with start and end is a block, and it comes back the same through the pull', () => {
  const s = setup();
  const r = put(s, body({ start: iso(at(6, 15)) }));
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.start, r.body.end], [iso(at(6, 15)), iso(at(6, 19))]);
  assert.equal(s.items.get('p1').isBlock, true);
  assert.equal(s.items.get('p1').deadline, iso(at(6, 19)));                 // phone end = deadline
  const pulled = s.pull.handle({}).body.items.find((i) => i.id === 'p1');
  assert.deepEqual([pulled.start, pulled.end], [iso(at(6, 15)), iso(at(6, 19))]);
  // an edit that moves the block works; one that drops the start is refused (a task keeps its start)
  const moved = put(s, body({ start: iso(at(6, 16)), updatedAt: new Date(NOW - 20).toISOString() }));
  assert.deepEqual([moved.status, moved.body.start], [200, iso(at(6, 16))]);
  refused(put(s, body({ title: 'Study more', updatedAt: new Date(NOW - 10).toISOString() })), 'start dropped');
  assert.equal(s.items.get('p1').start, iso(at(6, 16)));
});

test('phone: a new task needs both a start and an end; an old task with only a due time can still be edited', () => {
  const s = setup([row('old', 'task', { deadline: iso(at(9, 12)) })]);
  refused(put(s, body({ id: 'n1', start: null, end: iso(at(6, 19)) })), 'new task, only an end');
  refused(put(s, body({ id: 'n2', start: iso(at(6, 15)), end: null })), 'new task, only a start');
  refused(put(s, body({ id: 'n3', start: null, end: null })), 'new task, neither');
  assert.equal(s.items.get('n1') ?? s.items.get('n2') ?? s.items.get('n3'), null);
  const edit = put(s, body({ id: 'old', start: null, end: iso(at(9, 13)), updatedAt: new Date(NOW - 10).toISOString() }));
  assert.equal(edit.status, 200);                                                // legacy: still valid as a due-time task
  assert.equal(put(s, body({ id: 'old', start: iso(at(9, 11)), end: iso(at(9, 13)), updatedAt: new Date(NOW - 5).toISOString() })).status, 200); // and it can become a block
});

test('phone: a start with no end, a start after the end, or a start on an assignment is 422', () => {
  const s = setup([row('f', 'folder'), row('hw', 'assignment', { parentId: 'f', deadline: iso(at(9, 12)) })]);
  refused(put(s, body({ id: 'n1', start: iso(at(6, 15)), end: null })), 'start without end');
  refused(put(s, body({ id: 'n2', start: iso(at(6, 19)), end: iso(at(6, 15)) })), 'start after end');
  refused(put(s, body({ id: 'n3', start: iso(at(6, 15)), end: iso(at(6, 15)) })), 'start equal to end');
  refused(put(s, body({ id: 'n4', kind: 'assignment', parentId: 'f', start: iso(at(6, 15)), end: iso(at(6, 19)) })), 'new assignment with a start');
  refused(put(s, body({ id: 'hw', start: iso(at(6, 15)), end: iso(at(9, 12)), updatedAt: new Date(NOW - 10).toISOString() })), 'assignment edit with a start');
  assert.equal(s.items.get('n1') ?? s.items.get('n2') ?? s.items.get('n3') ?? s.items.get('n4'), null);
  assert.equal(s.items.get('hw').start, null);
});

test('phone: an existing item can not change type, even by dropping its start', () => {
  const s = setup([row('f', 'folder'), row('b', 'task', { parentId: 'f', start: iso(at(6, 15)), deadline: iso(at(6, 19)) })]);
  refused(put(s, body({ id: 'b', kind: 'assignment', parentId: 'f', start: null, updatedAt: new Date(NOW - 10).toISOString() })), 'task to assignment');
  assert.equal(s.items.get('b').kind, 'task');
});

// ── PhoneItemMapper ─────────────────────────────────────────────────────────

test('PhoneItemMapper: phone start is start, phone end is the deadline; only an end is a deadline item', () => {
  const m = new PhoneItemMapper();
  const block = m.parse(body({ start: '2026-11-01T15:00:00+01:00', end: '2026-11-01T19:00:00Z' }));
  assert.deepEqual([block.start, block.end], ['2026-11-01T14:00:00.000Z', '2026-11-01T19:00:00.000Z']);
  assert.deepEqual(m.fields(block), { title: 'Study', start: '2026-11-01T14:00:00.000Z', deadline: '2026-11-01T19:00:00.000Z' });

  const deadlineOnly = m.parse({ id: 'a', title: 'x', end: '2026-11-01T19:00:00Z', done: false, updatedAt: '2026-10-29T10:00:00Z' }); // start left out
  assert.deepEqual(m.fields(deadlineOnly), { title: 'x', start: null, deadline: '2026-11-01T19:00:00.000Z' });
});

test('PhoneItemMapper: bad bodies and times are refused, unknown fields ignored, view is what the phone sees', () => {
  const m = new PhoneItemMapper();
  for (const bad of [null, 'x', {}, body({ start: '2026-11-01T15:00:00' }), body({ end: 'tomorrow' }), body({ kind: 'folder' }), body({ parentId: 5 })]) {
    assert.equal(m.parse(bad), null, JSON.stringify(bad));
  }
  assert.equal('foo' in m.parse(body({ foo: 1 })), false);
  const view = m.view(new Item(row('v', 'task', { start: iso(at(6, 15)), deadline: iso(at(6, 19)), description: 'd' })));
  assert.deepEqual(Object.keys(view).sort(), ['course', 'createdAt', 'description', 'done', 'end', 'id', 'kind', 'parentId', 'repeat', 'source', 'start', 'title', 'updatedAt']);
  assert.deepEqual([view.start, view.end], [iso(at(6, 15)), iso(at(6, 19))]);
});

// ── Calendar ────────────────────────────────────────────────────────────────

test('calendar source: a block is an event from start to end, a deadline has no end', () => {
  const s = setup([row('b', 'task', { start: iso(at(6, 15)), deadline: iso(at(6, 19)) }), row('d', 'task', { deadline: iso(at(6, 23, 59)) })]);
  const events = Object.fromEntries(s.deadlines.events().map((e) => [e.id, e]));
  assert.equal(events['item:b'].isBlock, true);
  assert.deepEqual([events['item:b'].start.getTime(), events['item:b'].end.getTime()], [at(6, 15).getTime(), at(6, 19).getTime()]);
  assert.equal(events['item:b'].timeLabel(), '15:00-19:00');
  assert.equal(events['item:d'].isBlock, false);
  assert.equal(events['item:d'].timeLabel(), '23:59');
  assert.equal(events['item:d'].start.getTime(), at(6, 23, 59).getTime());
});

test('calendar: a block that crosses midnight appears on both days; a deadline and a block ending at midnight sharp on one', () => {
  const s = setup([
    row('night', 'task', { start: iso(at(6, 22)), deadline: iso(at(7, 2)) }),
    row('due', 'task', { deadline: iso(at(6, 23, 59)) }),
    row('exact', 'task', { start: iso(at(6, 20)), deadline: iso(at(7, 0)) }),
  ]);
  const ids = (list) => list.map((e) => e.id).sort();
  assert.deepEqual(ids(s.deadlines.onDay(at(6, 12))), ['item:due', 'item:exact', 'item:night']);
  assert.deepEqual(ids(s.deadlines.onDay(at(7, 12))), ['item:night']);                 // not "exact": it ends at 00:00
  assert.deepEqual(ids(s.deadlines.onDay(at(5, 12))), []);
  assert.equal(s.deadlines.events().find((e) => e.id === 'item:night').days().length, 2);
  assert.equal(s.deadlines.events().find((e) => e.id === 'item:due').days().length, 1);
});

// ── Top bar ─────────────────────────────────────────────────────────────────

const ev = (start, end = null) => new CalendarEvent({ id: 'e', title: 't', start, end });

test('top bar text: deadline, block not started, block running, overdue', () => {
  const now = at(6, 13).getTime();
  assert.equal(NextEventLabel.text(ev(at(6, 17, 12)), now), 'Oct 6, 17:12 · 4h 12m left');                // deadline: as before
  assert.equal(NextEventLabel.text(ev(at(6, 15), at(6, 19)), now), 'starts in 2h');                       // not started
  assert.equal(NextEventLabel.text(ev(at(6, 12), at(6, 14, 20)), now), 'ends 14:20 · 1h 20m left');       // running
  assert.equal(NextEventLabel.text(ev(at(6, 8), at(6, 11)), now), 'ended Oct 6, 11:00 · overdue 2h');     // block over
  assert.equal(NextEventLabel.text(ev(at(6, 10)), now), 'Oct 6, 10:00 · overdue 3h');                      // deadline over
});

test('top bar colour follows the end of a running block and the start of one not begun', () => {
  const now = at(6, 13).getTime();
  assert.equal(NextEventLabel.urgencyAt(ev(at(6, 12), at(6, 14)), now), at(6, 14).getTime());
  assert.equal(NextEventLabel.urgencyAt(ev(at(6, 15), at(6, 19)), now), at(6, 15).getTime());
  assert.equal(NextEventLabel.urgencyAt(ev(at(6, 17)), now), at(6, 17).getTime());
});

test('next event: a running block counts as next although its start is past; overdue is after the end', () => {
  const s = setup([
    row('running', 'task', { start: iso(at(6, 12)), deadline: iso(at(6, 14)) }),
    row('later', 'task', { deadline: iso(at(6, 20)) }),
    row('over', 'task', { start: iso(at(5, 9)), deadline: iso(at(5, 10)) }),
  ]);
  assert.equal(s.deadlines.next(at(6, 13).getTime()).id, 'item:running');   // start is past, still running
  assert.equal(s.deadlines.next(at(6, 15).getTime()).id, 'item:later');     // block ended: it is overdue, a later item comes first
  assert.equal(s.deadlines.next(at(6, 21).getTime()).id, 'item:later');     // everything is over: the latest due one
  s.items.update('later', { status: 'done' });
  assert.equal(s.deadlines.next(at(6, 21).getTime()).id, 'item:running');   // latest end among the open ones
  assert.equal(setup().deadlines.next(), null);
});

test('next event: a block not yet started is next before a later deadline, and a deadline due sooner still wins', () => {
  const s = setup([
    row('block', 'task', { start: iso(at(6, 15)), deadline: iso(at(6, 19)) }),
    row('sooner', 'task', { deadline: iso(at(6, 14)) }),
    row('later', 'task', { deadline: iso(at(6, 22)) }),
  ]);
  assert.equal(s.deadlines.next(at(6, 13).getTime()).id, 'item:sooner');
  assert.equal(s.deadlines.next(at(6, 14, 30).getTime()).id, 'item:block');
});

// ── Reminders ───────────────────────────────────────────────────────────────

test('reminders for a block: 10 minutes before the start and at the end', () => {
  const block = ev(at(6, 15), at(6, 19));
  const keys = (now) => reachedSteps(block, now).map((s) => s.key);
  assert.deepEqual(keys(at(6, 14, 49).getTime()), []);
  assert.deepEqual(keys(at(6, 14, 50).getTime()), ['start10']);
  assert.deepEqual(keys(at(6, 17).getTime()), ['start10']);
  assert.deepEqual(keys(at(6, 19).getTime()), ['start10', 'end']);
  // a deadline keeps 24 h, 1 h and at the due time
  assert.deepEqual(reachedSteps(ev(at(6, 19)), at(6, 18).getTime()).map((s) => s.key), ['24h', '1h']);
});

test('reminders: moving a block start or end restarts them, as moving a deadline does', () => {
  assert.notEqual(reminderKey(ev(at(6, 15), at(6, 19))), reminderKey(ev(at(6, 16), at(6, 19))));
  assert.notEqual(reminderKey(ev(at(6, 15), at(6, 19))), reminderKey(ev(at(6, 15), at(6, 20))));
  assert.equal(reminderKey(ev(at(6, 15), at(6, 19))), reminderKey(ev(at(6, 15), at(6, 19))));
  assert.notEqual(reminderKey(ev(at(6, 19))), reminderKey(ev(at(6, 20))));
});

test('ReminderService notifies a block twice (before the start, at the end) and again after it is moved', () => {
  const block = new CalendarEvent({ id: 'item:b', title: 'Study', start: at(6, 15), end: at(6, 19) });
  const events = [block];
  const notes = [];
  const store = { meta: {}, touchMeta() {} };
  const service = new ReminderService({ store, deadlines: { events: () => events }, settings: null }, { notifier: (title, text) => notes.push([title, text]) });

  service.tick(at(6, 14, 0).getTime());                       // first sight: nothing announced
  assert.equal(notes.length, 0);
  service.tick(at(6, 14, 51).getTime());                      // 9 minutes before the start
  assert.deepEqual(notes.map((n) => n[1]), ['starts in 9m']);
  service.tick(at(6, 17, 0).getTime());                       // nothing new
  assert.equal(notes.length, 1);
  service.tick(at(6, 19, 0).getTime());                       // the end
  assert.equal(notes.length, 2);
  assert.equal(notes[1][1], 'ended Oct 6, 19:00');

  events[0] = new CalendarEvent({ id: 'item:b', title: 'Study', start: at(7, 15), end: at(7, 19) }); // moved to the next day
  service.tick(at(6, 19, 1).getTime());                       // the new times are first sight: silent
  service.tick(at(7, 14, 55).getTime());                      // and its own reminders come
  assert.equal(notes.length, 3);
});

test('a reminder for a block is dropped when it is more than 6 hours past the end (the PC was asleep)', () => {
  const block = new CalendarEvent({ id: 'b', title: 'x', start: at(6, 15), end: at(6, 19) });
  const notes = [];
  const service = new ReminderService({ store: { meta: {}, touchMeta() {} }, deadlines: { events: () => [block] }, settings: null }, { notifier: (t) => notes.push(t) });
  service.tick(at(6, 10).getTime());
  service.tick(at(6, 19, 0).getTime() + 7 * HOUR);            // the phone slept: both steps are due, but long past the end
  assert.equal(notes.length, 0);
});
