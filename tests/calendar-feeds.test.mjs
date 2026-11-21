import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventBus } from '../renderer/core/EventBus.js';
import { Registry } from '../renderer/core/Registry.js';
import { Store } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { HOUR, DAY } from '../renderer/core/dates.js';
import { Item } from '../renderer/modules/workspace/Item.js';
import { ItemDeadlineSource } from '../renderer/modules/workspace/ItemDeadlineSource.js';
import { ItemTree } from '../renderer/modules/workspace/ItemTree.js';
import { SettingsService } from '../renderer/services/SettingsService.js';
import { DeadlineService } from '../renderer/services/DeadlineService.js';
import { CalendarEvent } from '../renderer/services/CalendarSource.js';
import { ReminderService, stepsFor, EXAM_STEPS } from '../renderer/services/ReminderService.js';
import { FeedCache, FeedEntry } from '../renderer/modules/feeds/FeedCache.js';
import { FeedCalendarSource } from '../renderer/modules/feeds/FeedCalendarSource.js';
import { CourseFolders } from '../renderer/modules/feeds/CourseFolders.js';
import { AssignmentImporter } from '../renderer/modules/feeds/AssignmentImporter.js';
import { FeedSync } from '../renderer/modules/feeds/FeedSync.js';
import { CourseFilter, courseKey } from '../renderer/modules/feeds/CourseFilter.js';
import { ItemSync } from '../renderer/modules/phonesync/ItemSync.js';
import { rulesFor } from './helpers/rulesFor.mjs';
import { TimetableMapper, MoodleMapper, CalendarMapper, mapperFor, roomOf, semesterOf, courseOf } from '../renderer/modules/feeds/feedMappers.js';

const require = createRequire(import.meta.url);
const { IcsParser } = require('../main/calendar/IcsParser.js');
const { FeedFetcher } = require('../main/calendar/FeedFetcher.js');
const { FeedStore } = require('../main/calendar/FeedStore.js');
const { FeedController } = require('../main/calendar/FeedController.js');
const { JsonFile } = require('../main/receiver/JsonFile.js');

const TIMETABLE = fs.readFileSync(new URL('./fixtures/stundenplan-sample.ics', import.meta.url), 'utf8');
const MOODLE = fs.readFileSync(new URL('./fixtures/moodle-sample.ics', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-30T12:00:00.000Z');

function setup() {
  const clock = { now: NOW };
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('items', Item);
  store.define('feedEntries', FeedEntry);
  const registry = new Registry();
  const ctx = { bus, store, registry };
  ctx.settings = new SettingsService(ctx);
  const cache = new FeedCache({ store, bus });
  const filter = new CourseFilter({ store, bus, now: () => clock.now });
  registry.register('calendarSource', new ItemDeadlineSource(store));
  registry.register('calendarSource', new FeedCalendarSource(cache, { now: () => clock.now, filter }));
  const folders = new CourseFolders({ store, settings: ctx.settings });
  const importer = new AssignmentImporter({ store, folders, now: () => NOW });
  ctx.deadlines = new DeadlineService(ctx);
  return { ...ctx, clock, cache, filter, folders, importer, items: store.collection('items') };
}

/** A fake window.api.feeds that serves the fixtures, like the main process would. */
function fakeApi(files = { timetable: TIMETABLE, moodle: MOODLE }) {
  const feeds = new Map();
  const answer = (feed) => ({ ok: true, feed: { ...feed }, events: IcsParser.parse(files[feed.kind], { now: NOW }).events });
  return {
    files,
    list: async () => [...feeds.values()].map((f) => ({ ...f })),
    add: async (url) => {
      const kind = url.includes('moodle') ? 'moodle' : 'timetable';
      const feed = { id: `f${feeds.size + 1}`, name: kind === 'moodle' ? 'Moodle' : 'Met26', kind, host: new URL(url).host, lastFetched: null, lastError: null };
      feeds.set(feed.id, feed);
      return answer(feed);
    },
    refresh: async (id) => (feeds.has(id) ? answer(feeds.get(id)) : { ok: false, error: 'gone' }),
    remove: async (id) => ({ ok: feeds.delete(id) }),
  };
}

const pathOf = (items, id) => [...new ItemTree(items).path(id), items.get(id)].map((f) => f.title).join(' › ');

// ── Parsing (main process) ──────────────────────────────────────────────────────

test('parser: timetable times come out in UTC from Europe/Vienna, in summer and in winter time', () => {
  const { name, producer, events } = IcsParser.parse(TIMETABLE, { now: NOW });
  assert.equal(name, 'Met26');
  assert.match(producer, /Stundenplan/);
  const byUid = Object.fromEntries(events.map((e) => [e.uid, e]));
  assert.equal(byUid.MET2026_1021327.start, '2026-09-30T06:45:00.000Z'); // 08:45 CEST
  assert.equal(byUid.MET2026_1021327.end, '2026-09-30T09:15:00.000Z');
  assert.equal(byUid.MET2026_1071313.start, '2026-12-02T09:00:00.000Z'); // 10:00 CET
});

test('parser: folded lines and escaped commas are joined, cancelled events are left out', () => {
  const { events } = IcsParser.parse(TIMETABLE, { now: NOW });
  assert.equal(events.length, 7);
  assert.ok(!events.some((e) => e.uid === 'MET2026_9999999'));
  const lecture = events.find((e) => e.uid === 'MET2026_1021327');
  assert.equal(lecture.summary, 'Strategic Management - Cases in International Business (Success and Pitfall Studies) (-84694) (Integrierte Lehrveranstaltung (IL)), Kuchler Karin, Standardgruppe, . ., WS46a WS46a.02.212 (MET 2026)');
  assert.equal(lecture.location, '. ., WS46a WS46a.02.212');
});

test('parser: Moodle deadlines are UTC moments with the course in CATEGORIES (tab-folded)', () => {
  const { events, producer } = IcsParser.parse(MOODLE, { now: NOW });
  assert.match(producer, /Moodle/);
  const quiz = events.find((e) => e.uid === '40252@moodle.fh-joanneum.at');
  assert.equal(quiz.start, '2026-11-03T11:00:00.000Z');
  assert.equal(quiz.end, quiz.start);
  assert.equal(quiz.categories, '(MET_WS2026_1) Strategic Management - Cases in International Business (Success and Pitfall Studies)');
  assert.match(events[0].description, /should contain all 5 exercises\.\nUpload the report as a \*\.pdf, please\./);
});

test('parser: refuses what is not a calendar, and repeats a recurring event within the next year', () => {
  assert.throws(() => IcsParser.parse('<html>login</html>'), /did not return a calendar/);
  const weekly = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x', 'BEGIN:VEVENT', 'UID:w1', 'SUMMARY:Gym',
    'DTSTART:20261102T170000Z', 'DTEND:20261102T180000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const { events } = IcsParser.parse(weekly, { now: NOW });
  assert.deepEqual(events.map((e) => e.start), ['2026-11-02T17:00:00.000Z', '2026-11-09T17:00:00.000Z', '2026-11-16T17:00:00.000Z']);
  assert.equal(new Set(events.map((e) => e.uid)).size, 3);
  assert.equal(events[0].end, '2026-11-02T18:00:00.000Z');
});

test('parser: a moved occurrence takes its new time and room; a cancelled one is gone; a lone change still shows', () => {
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x',
    'BEGIN:VEVENT', 'UID:w1', 'SUMMARY:Gym', 'LOCATION:Hall A',
    'DTSTART:20261102T170000Z', 'DTEND:20261102T180000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:w1', 'RECURRENCE-ID:20261109T170000Z', 'SUMMARY:Gym (moved)', 'LOCATION:Hall B',
    'DTSTART:20261110T080000Z', 'DTEND:20261110T090000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:w1', 'RECURRENCE-ID:20261116T170000Z', 'STATUS:CANCELLED',
    'DTSTART:20261116T170000Z', 'DTEND:20261116T180000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:lone', 'RECURRENCE-ID:20261120T100000Z', 'SUMMARY:Extra',
    'DTSTART:20261120T120000Z', 'DTEND:20261120T130000Z', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const { events } = IcsParser.parse(ics, { now: NOW });
  assert.deepEqual(events.map((e) => [e.uid, e.summary, e.location, e.start, e.end]), [
    ['w1|2026-11-02T17:00:00.000Z', 'Gym', 'Hall A', '2026-11-02T17:00:00.000Z', '2026-11-02T18:00:00.000Z'],
    ['w1|2026-11-09T17:00:00.000Z', 'Gym (moved)', 'Hall B', '2026-11-10T08:00:00.000Z', '2026-11-10T09:00:00.000Z'],
    ['lone|2026-11-20T10:00:00.000Z', 'Extra', '', '2026-11-20T12:00:00.000Z', '2026-11-20T13:00:00.000Z'],
  ]);
});

// ── Fetching and storing (main process) ─────────────────────────────────────────

test('fetcher: webcal becomes https, http and junk are refused', () => {
  assert.equal(FeedFetcher.normalizeUrl(' webcal://almaty.fh-joanneum.at/stundenplan/search.php?q=Met26 '), 'https://almaty.fh-joanneum.at/stundenplan/search.php?q=Met26');
  assert.throws(() => FeedFetcher.normalizeUrl('http://example.com/cal.ics'), /https:\/\/ or webcal/);
  assert.throws(() => FeedFetcher.normalizeUrl('not a url'), /not a web address/);
});

test('fetcher: error statuses, oversize answers and timeouts become sentences for the user', async () => {
  const answer = (status, body = '', headers = {}) => async () => new Response(body, { status, headers });
  await assert.rejects(new FeedFetcher({ fetch: answer(403) }).fetchText('https://x.test/c'), /may have expired/);
  await assert.rejects(new FeedFetcher({ fetch: answer(500) }).fetchText('https://x.test/c'), /error 500/);
  await assert.rejects(new FeedFetcher({ fetch: answer(200, 'x'.repeat(50)), maxBytes: 10 }).fetchText('https://x.test/c'), /too large/);
  const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(new FeedFetcher({ fetch: hang, timeoutMs: 20 }).fetchText('https://x.test/c'), /did not answer in time/);
  assert.equal(await new FeedFetcher({ fetch: answer(200, 'BEGIN:VCALENDAR') }).fetchText('webcal://x.test/c'), 'BEGIN:VCALENDAR');
});

test('feed store: the address is encrypted on disk and never listed; it survives a restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-feeds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = new JsonFile(`${dir}/feeds.json`);
  const cipher = { available: true, encrypt: (s) => Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s, 'base64').toString() };
  const url = 'https://moodle.fh-joanneum.at/calendar/export_execute.php?userid=1&authtoken=SECRET';
  const store = new FeedStore({ file, cipher });
  const feed = store.add({ url, name: 'Moodle', kind: 'moodle', host: 'moodle.fh-joanneum.at', count: 9, now: NOW });

  assert.ok(!JSON.stringify(store.list()).includes('SECRET'));
  assert.ok(!('url' in feed));
  assert.ok(!fs.readFileSync(`${dir}/feeds.json`, 'utf8').includes('SECRET'));
  const again = new FeedStore({ file, cipher });
  assert.equal(again.urlOf(feed.id), url);
  assert.equal(again.has(url), true);
  assert.equal(again.remove(feed.id), true);
  assert.deepEqual(new FeedStore({ file, cipher }).list(), []);
});

test('controller: add names and types the feed, refuses duplicates and non-calendars, records refresh errors', async () => {
  let body = MOODLE;
  const fetcher = new FeedFetcher({ fetch: async () => new Response(body, { status: 200 }) });
  const c = new FeedController({ store: new FeedStore(), fetcher, now: () => NOW });
  const url = 'webcal://moodle.fh-joanneum.at/calendar/export_execute.php?authtoken=abc';

  const added = await c.add(url);
  assert.equal(added.ok, true);
  assert.deepEqual([added.feed.name, added.feed.kind, added.feed.host, added.feed.count], ['Moodle', 'moodle', 'moodle.fh-joanneum.at', 7]);
  assert.ok(!JSON.stringify(added).includes('authtoken'));
  assert.deepEqual(await c.add(url.replace('webcal', 'https')), { ok: false, error: 'This calendar is already added.' });

  body = TIMETABLE;
  const tt = await c.add('https://almaty.fh-joanneum.at/stundenplan/subscribe.php?q=Met26');
  assert.deepEqual([tt.feed.name, tt.feed.kind], ['Met26', 'timetable']);

  body = '<html>Please log in</html>';
  const failed = await c.refresh(added.feed.id);
  assert.equal(failed.ok, false);
  assert.match(failed.feed.lastError, /did not return a calendar/);
  assert.equal((await c.add('https://other.test/x.ics')).ok, false);
  assert.equal(c.list().length, 2);
});

// ── Reading the events ──────────────────────────────────────────────────────────

test('timetable mapper: course, type, room and lecturer from the FH summary; exam dates', () => {
  const { events } = IcsParser.parse(TIMETABLE, { now: NOW });
  const m = Object.fromEntries(events.map((e) => [e.uid, TimetableMapper.map(e)]));
  assert.deepEqual(m.MET2026_1021327, { type: 'lecture', title: 'Strategic Management - Cases in International Business (Success and Pitfall Studies)', course: 'Strategic Management - Cases in International Business (Success and Pitfall Studies)', context: 'IL · WS46a.02.212 · Kuchler Karin' });
  assert.equal(m.MET2026_1042925.context, 'VO · Online · Sumereder Christof');
  assert.equal(m.MET2026_1031549.context, 'SO · Trattnig Uwe'); // "Ohne Ort" = no place
  assert.equal(m.MET2026_1070879.context, 'IL · WS46a.02.210 · Sumereder Christof / Fluch Jürgen');
  assert.deepEqual(m.MET2026_1071313, { type: 'exam', title: 'Exam: Climate Change and Dynamics', course: 'Climate Change and Dynamics', context: 'WS46a.02.212 · Awan' });
  assert.equal(m.MET2026_1021365.title, 'Exam: Strategic Management - Cases in International Business (Success and Pitfall Studies)');
  assert.equal(TimetableMapper.map({ summary: 'Something odd, here', location: '' }).title, 'Something odd');
});

test('moodle mapper: due suffixes in both languages are dropped, "opens" is skipped, events with a length stay events', () => {
  const { events } = IcsParser.parse(MOODLE, { now: NOW });
  const m = Object.fromEntries(events.map((e) => [e.uid, MoodleMapper.map(e)]));
  assert.equal(m['32077@moodle.fh-joanneum.at'].title, 'Report submission for second attempt');
  assert.equal(m['48839@moodle.fh-joanneum.at'].title, 'Asynchronous assignment - Interim submissions');
  assert.equal(m['40252@moodle.fh-joanneum.at'].title, 'Mini-Lecture Quiz');
  assert.deepEqual(m['40100@moodle.fh-joanneum.at'], { type: 'skip' });
  assert.deepEqual(m['45200@moodle.fh-joanneum.at'], { type: 'event', title: 'Guest talk', context: 'Storage and Power-to-X Technologies' });
  assert.deepEqual([m['32077@moodle.fh-joanneum.at'].course, m['32077@moodle.fh-joanneum.at'].semester], ['Digital Signal Processing', 'SS 2026']);
});

test('mapper helpers: rooms, semesters, courses, and the fallback mapper', () => {
  assert.equal(roomOf('. ., WS46a WS46a.02.212'), 'WS46a.02.212');
  assert.equal(roomOf('Online'), 'Online');
  assert.equal(roomOf('Ohne Ort'), '');
  assert.equal(semesterOf('MET_WS2026_1'), 'WS 2026');
  assert.equal(semesterOf('STM_SS2026_2'), 'SS 2026');
  assert.equal(semesterOf('CS101'), '');
  assert.deepEqual(courseOf('Plain course'), { code: '', course: 'Plain course' });
  assert.equal(mapperFor('unknown'), CalendarMapper);
  assert.equal(CalendarMapper.map({ summary: '', location: 'Room 1' }).title, 'Untitled');
});

// ── On the calendar ────────────────────────────────────────────────────────────

test('calendar: lectures are quiet blocks, exams are reminded early, past ones count as done', () => {
  const { cache, deadlines } = setup();
  cache.replace({ id: 'tt', kind: 'timetable' }, IcsParser.parse(TIMETABLE, { now: NOW }).events);
  const events = deadlines.events();
  const lecture = events.find((e) => e.id === 'feed:tt|MET2026_1070879');
  const exam = events.find((e) => e.id === 'feed:tt|MET2026_1071313');
  assert.deepEqual([lecture.kind, lecture.quiet, lecture.isBlock, lecture.done], ['Lecture', true, true, false]);
  assert.deepEqual([exam.kind, exam.quiet, exam.remind], ['Exam', false, 'exam']);
  assert.equal(events.find((e) => e.id === 'feed:tt|MET2026_1021327').done, true); // 30 Sep: over
  assert.equal(stepsFor(lecture).length, 0);
  assert.equal(stepsFor(exam), EXAM_STEPS);
});

test('top bar: the next lecture never wins over a real deadline; a past exam is not "overdue"', () => {
  const { cache, deadlines, items, clock } = setup();
  cache.replace({ id: 'tt', kind: 'timetable' }, IcsParser.parse(TIMETABLE, { now: NOW }).events);
  assert.equal(deadlines.next(NOW).id, 'feed:tt|MET2026_1071313'); // only the exam counts
  items.add({ kind: 'task', title: 'Essay', deadline: new Date(NOW + 40 * DAY).toISOString() });
  clock.now = Date.parse('2027-01-20T12:00:00.000Z'); // every exam is over
  assert.equal(deadlines.next(clock.now).title, 'Essay');
});

test('reminders: an exam a day and an hour before it starts, lectures never (and not kept in the log)', () => {
  const { cache, deadlines, store, settings, bus } = setup();
  cache.replace({ id: 'tt', kind: 'timetable' }, IcsParser.parse(TIMETABLE, { now: NOW }).events);
  const sent = [];
  const reminders = new ReminderService({ store, deadlines, settings, bus }, { notifier: (title) => sent.push(title) });
  const examStart = Date.parse('2026-12-02T09:00:00.000Z');
  reminders.tick(examStart - 2 * DAY);
  reminders.tick(examStart - 23 * HOUR);
  reminders.tick(examStart - 50 * 60 * 1000);
  assert.deepEqual(sent, ['Exam: Climate Change and Dynamics', 'Exam: Climate Change and Dynamics']);
  assert.ok(Object.keys(store.meta.reminders).every((k) => !k.includes('MET2026_1070879')));
});

// ── Moodle due dates become assignments ──────────────────────────────────────────

function moodleDeadlines(text = MOODLE) {
  return IcsParser.parse(text, { now: NOW }).events
    .map((e) => ({ uid: e.uid, start: e.start, mapped: MoodleMapper.map(e) }))
    .filter((d) => d.mapped.type === 'deadline');
}

test('import: one assignment per due date, in "<semester> › <course>", folders only for courses with due dates', () => {
  const { importer, items } = setup();
  assert.deepEqual(importer.import({ name: 'Moodle' }, moodleDeadlines()), { added: 5, updated: 0 });
  const assignments = items.all().filter((i) => i.kind === 'assignment');
  assert.equal(assignments.length, 5);
  const report = assignments.find((a) => a.title === 'Report submission for second attempt');
  assert.equal(pathOf(items, report.parentId), 'SS 2026 › Digital Signal Processing');
  assert.equal(report.deadline, '2026-11-01T22:59:00.000Z');
  assert.equal(report.source.label, 'Moodle');
  const folders = items.all().filter((i) => i.kind === 'folder').map((f) => pathOf(items, f.id)).sort();
  assert.deepEqual(folders, [
    'SS 2026', 'SS 2026 › Digital Signal Processing', 'WS 2026', 'WS 2026 › Environmental Process Engineering',
    'WS 2026 › Storage and Power-to-X Technologies', 'WS 2026 › Strategic Management - Cases in International Business (Success and Pitfall Studies)',
  ]);
  const rules = new ItemTree(items).rules;
  for (const a of assignments) assert.equal(rules.problem({ id: a.id, kind: a.kind, parentId: a.parentId, deadline: a.deadline }), null);
});

test('import: refreshing changes nothing; Moodle changes follow unless the user changed that field', () => {
  const { importer, items } = setup();
  importer.import({ name: 'Moodle' }, moodleDeadlines());
  assert.deepEqual(importer.import({ name: 'Moodle' }, moodleDeadlines()), { added: 0, updated: 0 });
  const quiz = items.all().find((i) => i.title === 'Mini-Lecture Quiz');
  const final = items.all().find((i) => i.title === 'Final presentations');
  items.update(quiz.id, { title: 'Quiz (my name)' });

  const moved = MOODLE
    .replace('SUMMARY:Mini-Lecture Quiz endet', 'SUMMARY:Mini-Lecture Quiz 2 endet')
    .replace('DTSTART:20261108T225900Z\nDTEND:20261108T225900Z', 'DTSTART:20261109T225900Z\nDTEND:20261109T225900Z');
  importer.import({ name: 'Moodle' }, moodleDeadlines(moved));
  assert.equal(items.get(quiz.id).title, 'Quiz (my name)'); // the user's title wins
  assert.equal(items.get(quiz.id).source.title, 'Mini-Lecture Quiz 2');
  assert.equal(items.get(final.id).deadline, '2026-11-09T22:59:00.000Z'); // Moodle moved it
});

test('import: never deletes, never re-adds what the user deleted, never moves, skips long-past due dates', () => {
  const { importer, items, store } = setup();
  importer.import({ name: 'Moodle' }, moodleDeadlines());
  const quiz = items.all().find((i) => i.title === 'Mini-Lecture Quiz');
  const report = items.all().find((i) => i.title === 'Report submission for second attempt');
  items.remove(quiz.id);
  const elsewhere = items.add({ kind: 'folder', title: 'My DSP' });
  items.update(report.id, { parentId: elsewhere.id });

  importer.import({ name: 'Moodle' }, moodleDeadlines().filter((d) => !d.mapped.title.startsWith('Final'))); // gone from the feed
  assert.equal(items.all().filter((i) => i.title === 'Mini-Lecture Quiz').length, 0);
  assert.ok(items.all().some((i) => i.title === 'Final presentations'));
  assert.equal(items.get(report.id).parentId, elsewhere.id);

  const old = { uid: 'old@moodle', start: new Date(NOW - 3 * DAY).toISOString(), mapped: { title: 'Old', course: 'X', semester: 'WS 2026', description: '' } };
  assert.equal(importer.import({ name: 'Moodle' }, [old]).added, 0);
  assert.ok(!('old@moodle' in store.meta.feedImports));
});

test('folders: an existing folder of the same name is reused, a renamed one is still found, filing off means Unsorted', () => {
  const { importer, items, folders, settings, store } = setup();
  const mine = items.add({ kind: 'folder', title: 'environmental process engineering' });
  importer.import({ name: 'Moodle' }, moodleDeadlines());
  assert.ok(items.all().some((i) => i.title === 'Final presentations' && i.parentId === mine.id));

  const storage = items.all().find((i) => i.title === 'Storage and Power-to-X Technologies');
  items.update(storage.id, { title: 'P2X' });
  assert.equal(folders.folderFor({ course: 'Storage and Power-to-X Technologies', semester: 'WS 2026' }), storage.id);
  assert.equal(items.all().filter((i) => i.title === 'WS 2026').length, 1);

  settings.set('feedFiling', false);
  const unsorted = folders.folderFor({ course: 'New course', semester: 'WS 2026' });
  assert.equal(items.get(unsorted).title, 'Unsorted');
  assert.equal(store.meta.unsortedId, unsorted);
  settings.set('feedFiling', true);
  assert.equal(folders.folderFor({ course: '', semester: '' }), unsorted);
});

// ── The sync service ─────────────────────────────────────────────────────────────

test('sync: adding both feeds fills the calendar and the folders; removing one keeps its assignments', async () => {
  const { cache, importer, bus, deadlines, items } = setup();
  const sync = new FeedSync({ api: fakeApi(), bus, cache, importer });
  let changes = 0;
  bus.on('feeds:changed', () => changes++);

  const tt = await sync.add('https://almaty.fh-joanneum.at/stundenplan/subscribe.php?q=Met26');
  const md = await sync.add('https://moodle.fh-joanneum.at/calendar/export_execute.php?authtoken=x');
  assert.equal(sync.feeds.length, 2);
  assert.ok(changes >= 2);
  assert.deepEqual(sync.summary(tt.feed), { lecture: 5, exam: 2 });
  assert.deepEqual(sync.summary(md.feed), { deadline: 5, skip: 1, event: 1 });
  const kinds = deadlines.events().map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'Assignment').length, 5);
  assert.equal(kinds.filter((k) => k === 'Lecture').length, 5);
  assert.equal(kinds.filter((k) => k === 'Event').length, 1); // the Moodle guest talk

  await sync.refresh(md.feed.id);
  assert.equal(items.all().filter((i) => i.kind === 'assignment').length, 5);

  await sync.remove(md.feed.id);
  assert.equal(cache.forFeed(md.feed.id).length, 0);
  assert.equal(items.all().filter((i) => i.kind === 'assignment').length, 5);
  assert.equal(sync.busy.size, 0);
});

test('sync: start lists the saved feeds and refreshes each; a failed refresh keeps the last download', async () => {
  const { cache, importer, bus } = setup();
  const api = fakeApi();
  const first = new FeedSync({ api, bus, cache, importer });
  const { feed } = await first.add('https://almaty.fh-joanneum.at/stundenplan/subscribe.php?q=Met26');
  const sync = new FeedSync({ api: { ...api, refresh: async () => ({ ok: false, error: 'offline', feed: { ...feed, lastError: 'offline' } }) }, bus, cache, importer, intervalMs: 1e9 });
  await sync.start();
  sync.stop();
  assert.equal(sync.feeds[0].lastError, 'offline');
  assert.equal(cache.forFeed(feed.id).length, 7);
});

// ── The due date belongs to Moodle; deleting can be undone ────────────────────────

test('lock: only an imported assignment has a locked due date', () => {
  const { importer, items } = setup();
  importer.import({ name: 'Moodle' }, moodleDeadlines());
  const rules = new ItemTree(items).rules;
  const imported = items.all().find((i) => i.kind === 'assignment');
  const own = items.add({ kind: 'assignment', title: 'Mine', parentId: imported.parentId, deadline: imported.deadline });
  assert.equal(rules.deadlineLocked(imported), 'Moodle sets this due date.');
  assert.equal(rules.deadlineLocked(own), null);
  assert.equal(rules.deadlineLocked(items.all().find((i) => i.kind === 'folder')), null);
});

test('lock: the phone can rename an imported assignment and tick it, but not move its due date', () => {
  const { importer, items, store } = setup();
  importer.import({ name: 'Moodle' }, moodleDeadlines());
  const quiz = items.all().find((i) => i.title === 'Mini-Lecture Quiz');
  const later = Date.parse(quiz.updatedAt) + 5000; // the phone edits after the import
  const sync = new ItemSync({ store, rulesFor, now: () => later });
  const res = sync.put({ id: quiz.id, title: 'Quiz!', start: null, end: '2026-12-24T10:00:00.000Z', done: true, updatedAt: new Date(later).toISOString() });
  assert.equal(res.status, 200);
  assert.deepEqual([items.get(quiz.id).title, items.get(quiz.id).status], ['Quiz!', 'done']);
  assert.equal(items.get(quiz.id).deadline, '2026-11-03T11:00:00.000Z');
});

test('lock: a refresh puts back a due date edited before the lock, and keeps a user title', () => {
  const { importer, items } = setup();
  importer.import({ name: 'Moodle' }, moodleDeadlines());
  const final = items.all().find((i) => i.title === 'Final presentations');
  items.update(final.id, { deadline: '2026-11-20T10:00:00.000Z', title: 'Final talk' });
  assert.equal(importer.import({ name: 'Moodle' }, moodleDeadlines()).updated, 1);
  assert.deepEqual([items.get(final.id).deadline, items.get(final.id).title], ['2026-11-08T22:59:00.000Z', 'Final talk']);
  assert.equal(importer.import({ name: 'Moodle' }, moodleDeadlines()).updated, 0); // and then it is quiet again
});

test('restore: a deleted assignment stays away on refresh, then comes back once, in its folder, even when past', async () => {
  const { cache, importer, bus, items, store } = setup();
  const sync = new FeedSync({ api: fakeApi(), bus, cache, importer });
  const { feed } = await sync.add('https://moodle.fh-joanneum.at/calendar/export_execute.php?authtoken=x');
  const report = items.all().find((i) => i.title === 'Report submission for second attempt');
  items.remove(report.id);
  await sync.refresh(feed.id);
  assert.equal(items.all().filter((i) => i.title === report.title).length, 0);
  assert.equal(sync.hiddenCount(feed), 1);

  importer.now = () => Date.parse('2026-11-20T12:00:00.000Z'); // long after it was due
  assert.equal(sync.restore(feed.id), 1);
  const back = items.all().find((i) => i.title === report.title);
  assert.equal(pathOf(items, back.parentId), 'SS 2026 › Digital Signal Processing');
  assert.equal(store.meta.feedImports['32077@moodle.fh-joanneum.at'], back.id);
  assert.equal(sync.hiddenCount(feed), 0);
  await sync.refresh(feed.id);
  assert.equal(items.all().filter((i) => i.title === report.title).length, 1);
  assert.equal(sync.restore(feed.id), 0);
});

test('restore: the course folder is made again when it was deleted too', () => {
  const { importer, items } = setup();
  importer.import({ name: 'Moodle' }, moodleDeadlines());
  const report = items.all().find((i) => i.title === 'Report submission for second attempt');
  const folderId = report.parentId;
  items.remove(report.id);
  items.remove(folderId);
  assert.equal(importer.restore({ name: 'Moodle' }, moodleDeadlines()), 1);
  const back = items.all().find((i) => i.title === report.title);
  assert.notEqual(back.parentId, folderId);
  assert.equal(pathOf(items, back.parentId), 'SS 2026 › Digital Signal Processing');
  assert.equal(items.all().filter((i) => i.title === 'SS 2026').length, 1);
});

// ── Choosing courses (a year-group timetable has both majors) ─────────────────────

const TT_FEED = { id: 'tt', kind: 'timetable', name: 'Met26' };

test('courses: one line per course, exams counted with their course, only what is still to come', () => {
  const { cache, filter } = setup();
  cache.replace(TT_FEED, IcsParser.parse(TIMETABLE, { now: NOW }).events);
  const courses = filter.courses(TT_FEED, cache.forFeed('tt'));
  assert.deepEqual(courses.map((c) => [c.name, c.lectures, c.exams]), [
    ['Climate Change and Dynamics', 0, 1], // only its exam is in the sample
    ['Energy Networks and Hybrid Technologies', 1, 0],
    ['Environmental Process Engineering', 0, 0], // its one lecture is over
    ['Other Event 1. Semester MET', 1, 0],
    ['Storage and Power-to-X Technologies', 0, 0],
    ['Strategic Management - Cases in International Business (Success and Pitfall Studies)', 0, 1],
  ]);
  assert.ok(courses.every((c) => !c.hidden && !c.isNew));
  assert.deepEqual(filter.courses({ id: 'm', kind: 'moodle' }, IcsParser.parse(MOODLE, { now: NOW }).events), []);
});

test('courses: unticking hides its lectures and its exams from the calendar; ticking brings them back', () => {
  const { cache, filter, deadlines, bus } = setup();
  cache.replace(TT_FEED, IcsParser.parse(TIMETABLE, { now: NOW }).events);
  let redraws = 0;
  bus.on('data:changed', (e) => { if (e.type === 'filter') redraws++; });
  const strategic = courseKey('Strategic Management - Cases in International Business (Success and Pitfall Studies)');
  filter.setHidden('tt', [strategic], true);
  const titles = deadlines.events().map((e) => e.title);
  assert.ok(!titles.some((t) => t.includes('Strategic Management')));
  assert.ok(titles.includes('Exam: Climate Change and Dynamics'));
  assert.equal(redraws, 1);
  filter.setHidden('tt', [strategic], false);
  assert.equal(deadlines.events().filter((e) => e.title.includes('Strategic Management')).length, 2);
});

test('courses: the first download announces every course; later only the ones that are new, once', async () => {
  const { cache, importer, bus, filter } = setup();
  const api = fakeApi();
  const sync = new FeedSync({ api, bus, cache, importer, filter });
  const seen = [];
  bus.on('feeds:new-courses', (e) => seen.push([e.first, e.names.length, e.names[0]]));

  const { feed } = await sync.add('https://almaty.fh-joanneum.at/stundenplan/subscribe.php?q=Met26');
  await sync.refresh(feed.id);
  assert.deepEqual(seen, [[true, 6, 'Climate Change and Dynamics']]);

  filter.setHidden(feed.id, [courseKey('Energy Networks and Hybrid Technologies')], true); // the user picks theirs
  sync.lookedAtCourses(feed);
  api.files.timetable = TIMETABLE.replace('UID:MET2026_1071313\nSUMMARY:Prüfungstermin: M19.0592101 26W 2SSt VO Climate Change and\n  Dynamics',
    'UID:MET2026_2000001\nSUMMARY:Prüfungstermin: M19.0592101 26W 2SSt VO Urban Air Mobility');
  await sync.refresh(feed.id);
  assert.deepEqual(seen[1], [false, 1, 'Urban Air Mobility']);
  const list = sync.courses(feed);
  assert.equal(list.find((c) => c.name === 'Urban Air Mobility').isNew, true);  // badge until the list is closed
  assert.equal(list.find((c) => c.name === 'Urban Air Mobility').hidden, false); // new courses start visible
  assert.equal(list.find((c) => c.name === 'Energy Networks and Hybrid Technologies').hidden, true); // the choice survives refreshes
  sync.lookedAtCourses(feed);
  assert.ok(sync.courses(feed).every((c) => !c.isNew));

  await sync.remove(feed.id);
  assert.equal(store(sync).feedCourses?.[feed.id], undefined);
});

const store = (sync) => sync.cache.store.meta;
