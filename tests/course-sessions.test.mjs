import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { EventBus } from '../renderer/core/EventBus.js';
import { Store } from '../renderer/data/Store.js';
import { MemoryStorage } from '../renderer/data/storage.js';
import { FeedCache, FeedEntry } from '../renderer/modules/feeds/FeedCache.js';
import { FeedCalendarSource } from '../renderer/modules/feeds/FeedCalendarSource.js';
import { CourseFilter } from '../renderer/modules/feeds/CourseFilter.js';
import { CourseSessions } from '../renderer/modules/feeds/CourseSessions.js';

// A course's whole timetable in the right panel (FeedEventEditor), the same rules as the phone's.
const require = createRequire(import.meta.url);
const { IcsParser } = require('../main/calendar/IcsParser.js');

// Local times, so the weekday and time slots mean the same in any time zone.
const at = (m, d, h, min = 0) => new Date(2026, m - 1, d, h, min);
const NOW = at(10, 30, 12).getTime(); // Fri Oct 30
const lecture = (id, start, end, course = 'Climate Change and Dynamics') => ({ id, type: 'lecture', title: course, context: 'VO', course, start, end });

const SESSIONS = [
  lecture('a', at(10, 20, 9), at(10, 20, 12, 15)),
  lecture('b', at(10, 27, 9), at(10, 27, 12, 15)),
  lecture('c', at(11, 3, 9), at(11, 3, 12, 15)),
  lecture('d', at(11, 5, 13), at(11, 5, 14, 30)),
  lecture('e', at(11, 10, 9), at(11, 10, 12, 15)),
  { id: 'x', type: 'exam', title: 'Exam: Climate Change and Dynamics', context: '', course: 'climate change  and dynamics', start: at(12, 2, 9), end: at(12, 2, 10, 30) },
  lecture('o', at(11, 4, 9), at(11, 4, 11), 'Renewable Energy Generation'),
];

test('a course: its lectures and exams, soonest first, and the next one', () => {
  const c = CourseSessions.of('Climate Change and Dynamics', SESSIONS);
  assert.deepEqual(c.sessions.map((s) => s.id), ['a', 'b', 'c', 'd', 'e', 'x']);
  assert.equal(c.lectures.length, 5);
  assert.equal(c.exams.length, 1);
  assert.equal(c.next(NOW).id, 'c');
});

test('the weekly slot is the one at least two lectures share; one-offs are irregular', () => {
  const c = CourseSessions.of('Climate Change and Dynamics', SESSIONS);
  assert.deepEqual(c.weekly, [{ weekday: 2, startMinute: 540, endMinute: 735, count: 4 }]);
  assert.equal(c.irregular, 1);
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.equal(CourseSessions.slotLabel(c.weekly[0], hm), 'Tue 09:00–12:15');
});

test('clicking a lecture of the sample timetable finds its whole course; hidden courses are left out', () => {
  const bus = new EventBus();
  const store = new Store({ bus, storage: new MemoryStorage() });
  store.define('feedEntries', FeedEntry);
  const cache = new FeedCache({ store, bus });
  const filter = new CourseFilter({ store, bus, now: () => NOW });
  const source = new FeedCalendarSource(cache, { now: () => NOW, filter });
  const text = fs.readFileSync(new URL('./fixtures/stundenplan-sample.ics', import.meta.url), 'utf8');
  cache.replace({ id: 'tt', kind: 'timetable', name: 'Met26' }, IcsParser.parse(text, { now: NOW }).events);

  // Storage and Power-to-X: lectures in the sample, opened from one of them.
  const event = source.events().find((e) => e.kind === 'Lecture' && e.title === 'Storage and Power-to-X Technologies');
  assert.equal(event.ref.type, 'feedEvent');
  const found = source.session(event.ref.id);
  assert.equal(found.kind, 'Lecture');
  assert.equal(found.course.course, 'Storage and Power-to-X Technologies');
  assert.ok(found.course.sessions.length >= 1);
  assert.ok(found.course.sessions.every((s) => s.course === 'Storage and Power-to-X Technologies'));
  // An exam opens its course too.
  const exam = source.events().find((e) => e.title === 'Exam: Climate Change and Dynamics');
  assert.equal(source.session(exam.ref.id).course.course, 'Climate Change and Dynamics');

  filter.setHidden('tt', ['storage and power-to-x technologies'], true);
  assert.equal(source.session(event.ref.id), null);
});
