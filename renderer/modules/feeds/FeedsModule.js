import { FeatureModule } from '../../core/FeatureModule.js';
import { FeedCache, FeedEntry } from './FeedCache.js';
import { FeedCalendarSource } from './FeedCalendarSource.js';
import { CourseFolders } from './CourseFolders.js';
import { AssignmentImporter } from './AssignmentImporter.js';
import { FeedSync } from './FeedSync.js';
import { FeedsDataGroup } from './FeedsDataGroup.js';
import { CourseFilter } from './CourseFilter.js';
import { FeedEventEditor } from './FeedEventEditor.js';

// Calendar feeds: the FH timetable and the Moodle calendar, in the one calendar.
//   lectures and exams   read-only calendar events (FeedCalendarSource)
//   Moodle due dates     assignment items in "<semester> › <course>" folders (AssignmentImporter, CourseFolders)
// Downloading runs in the main process (main/calendar/); the addresses never reach this page.
// Delete its line in app.js and the calendar goes back to items only. Imported assignments stay.
export class FeedsModule extends FeatureModule {
  /** @param {{api?: object|null}} [o]  api = window.api.feeds; null/absent in a plain browser */
  constructor({ api = globalThis.window?.api?.feeds ?? null } = {}) {
    super('feeds');
    this.api = api;
  }

  install(ctx) {
    const { store, registry, bus } = ctx;
    store.define('feedEntries', FeedEntry);
    const cache = new FeedCache({ store, bus });
    const filter = new CourseFilter({ store, bus });
    const source = new FeedCalendarSource(cache, { filter });
    registry.register('calendarSource', source);
    // Clicking a lecture or exam: its details and its course's whole timetable, in the right panel.
    registry.register('editor', { id: 'feedEvent', create: (c, id) => new FeedEventEditor(c, id, source) });
    // The phone's calendar gets the same lectures and exams (GET /v1/calendar), with the same courses hidden.
    registry.register('phoneCalendar', { id: 'feeds', events: (from, to) => source.phoneEvents(from, to) });
    // Which courses are hidden is shared with the phone (GET / PUT /v1/feed-settings): its newer choices are applied
    // first, then it is told every choice the PC holds.
    registry.register('phoneFeedCourses', {
      id: 'feeds',
      handle: ({ courses } = {}) => {
        if (courses !== undefined && !filter.applyShared(courses)) return { status: 422, body: { error: 'invalid-request' } };
        return { status: 200, body: { courses: filter.shared() } };
      },
    });
    if (!this.api) return; // adding and updating feeds needs the desktop app

    const importer = new AssignmentImporter({ store, folders: new CourseFolders({ store, settings: ctx.settings }) });
    const sync = new FeedSync({ api: this.api, bus, cache, importer, filter });
    this.sync = sync;
    const ui = { coursesOpen: null }; // which feed's course list Settings › Data opens with (set by the toast below)
    registry.register('settingsData', { id: 'feeds', create: (c) => new FeedsDataGroup(c, sync, ui) });
    bus.on('app:ready', () => sync.start().catch((err) => console.error('[feeds] could not start', err)));
    // The phone added, renamed or removed a feed: list them again (new ones are downloaded).
    this.api.onRemoteChange?.(() => sync.reload().catch((err) => console.error('[feeds] could not reload', err)));

    // A timetable for the whole year group brings every major's courses: point new ones out once, so the user can untick
    // the ones that are not theirs (on the first download, and again when next semester's courses appear).
    bus.on('feeds:new-courses', ({ feed, names, first }) => {
      const what = names.length === 1 ? '1 new course' : `${names.length} new courses`;
      bus.emit('toast:show', {
        id: `feed-courses-${feed.id}`,
        title: first ? `${feed.name}: choose your courses` : `${feed.name} has ${what}`,
        text: first
          ? `It lists ${names.length} courses. Untick the ones that are not yours, for example the other major's.`
          : `${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}. They show on the calendar until you untick them.`,
        actions: [{ label: 'Choose courses', primary: true, onClick: () => { ui.coursesOpen = feed.id; bus.emit('settings:open', { section: 'data' }); } }],
      });
    });
  }
}
