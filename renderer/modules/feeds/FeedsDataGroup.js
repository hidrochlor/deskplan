import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { formatDateTime } from '../../core/dates.js';

// Settings › Data › Calendar feeds. Laid out like Settings › Phones › Paired phones: + adds an address, and each
// feed has a refresh and a delete button. The address itself is never shown (a Moodle link holds a token): only its host.
// A timetable also has a Courses button: a checklist, opened under its row, of the courses shown on the calendar.
export class FeedsDataGroup {
  /**
   * @param {object} ctx @param {import('./FeedSync.js').FeedSync} sync
   * @param {{coursesOpen: string|null}} [ui]  shared with FeedsModule, so its "Choose courses" toast can open a feed's list
   */
  constructor(ctx, sync, ui = { coursesOpen: null }) {
    this.ctx = ctx;
    this.sync = sync;
    this.ui = ui;
    this.adding = false;
    this.value = '';
    this.saving = false;
    this.error = '';
    this.confirmId = null; // the feed whose delete is waiting for "Remove"
  }

  mount(section) {
    this.section = section;
    this.off = this.ctx.bus.on('feeds:changed', () => this.redraw());
    // Opened from the toast: bring the list into view once the page has drawn.
    if (this.ui.coursesOpen) requestAnimationFrame(() => this.section?.el?.querySelector('.feed-courses')?.scrollIntoView({ block: 'nearest' }));
  }

  unmount() {
    this.off?.();
    this.section = null;
  }

  redraw() {
    if (!this.section?.el) return;
    this.section.render();
    if (this.adding) this.section.el.querySelector('.feed-url-input')?.focus();
  }

  rows(s) {
    const feeds = this.sync.feeds;
    return [
      h('div', { class: 'set-group set-group-row' },
        h('span', {}, 'Calendar feeds'),
        h('button', {
          class: 'icon-btn', type: 'button', title: 'Add a calendar address', 'aria-label': 'Add a calendar address',
          onClick: () => { this.adding = true; this.error = ''; this.redraw(); },
        }, icon('plus', 16))),
      h('div', { class: 'set-hint' },
        'Your FH timetable (Stundenplan) and your Moodle calendar. Lectures and exams appear on the calendar; Moodle due dates become assignments in your course folders.'),
      this.adding ? this.addRow() : null,
      this.error ? h('div', { class: 'set-hint error', role: 'alert' }, this.error) : null,
      ...(feeds.length ? feeds.flatMap((f) => this.feedRow(s, f)) : [h('div', { class: 'set-hint' }, 'No calendars yet.')]),
      s.row('File Moodle due dates into course folders',
        'On: each course with a due date gets a folder inside its semester, e.g. WS 2026 › Climate Change and Dynamics. Off: they all go into Unsorted. Already imported ones are not moved.',
        s.toggle(this.ctx.settings.get('feedFiling'), (v) => this.ctx.settings.set('feedFiling', v), 'File Moodle due dates into course folders')),
    ];
  }

  addRow() {
    const cancel = () => { this.adding = false; this.value = ''; this.error = ''; this.redraw(); };
    return h('div', { class: 'set-row stacked' },
      h('div', { class: 'quick-row feed-add' },
        h('input', {
          class: 'input grow feed-url-input', type: 'url', value: this.value, disabled: this.saving, spellcheck: 'false',
          placeholder: 'webcal://… or https://…', 'aria-label': 'Calendar address',
          onInput: (e) => { this.value = e.target.value; },
          onKeydown: (e) => {
            if (e.key === 'Enter') this.save();
            else if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
          },
        }),
        h('button', { class: 'btn btn-small btn-primary', type: 'button', disabled: this.saving, onClick: () => this.save() },
          this.saving ? 'Checking…' : 'Add'),
        h('button', { class: 'btn btn-small', type: 'button', disabled: this.saving, onClick: cancel }, 'Cancel')),
      h('div', { class: 'set-hint' },
        'Timetable: the subscribe link from the FH Stundenplan. Moodle: Calendar › Import or export calendars › Export calendar › Get calendar URL. Treat the Moodle link like a password.'));
  }

  async save() {
    if (this.saving || !this.value.trim()) return;
    this.saving = true;
    this.error = '';
    this.redraw();
    const res = await this.sync.add(this.value).catch((err) => ({ ok: false, error: err.message }));
    this.saving = false;
    if (res.ok) { this.adding = false; this.value = ''; } else this.error = res.error;
    this.redraw();
  }

  feedRow(s, feed) {
    const busy = this.sync.busy.has(feed.id);
    if (this.confirmId === feed.id) {
      return s.row(feed.name, 'Remove this calendar? Its lectures and exams disappear. Imported assignments stay in your folders.',
        h('div', { class: 'quick-row' },
          h('button', { class: 'btn btn-small', type: 'button', onClick: () => { this.confirmId = null; this.redraw(); } }, 'Keep'),
          h('button', { class: 'btn btn-small btn-danger', type: 'button', onClick: () => this.remove(feed.id) }, 'Remove')));
    }
    const hidden = this.sync.hiddenCount(feed);
    const courses = this.sync.courses(feed);
    const open = this.ui.coursesOpen === feed.id && courses.length > 0;
    const shown = courses.filter((c) => !c.hidden).length;
    const row = s.row(feed.name, this.hint(feed, busy, hidden),
      h('div', { class: 'quick-row' },
        courses.length ? h('button', {
          class: `btn btn-small${open ? ' active' : ''}`, type: 'button', 'aria-expanded': String(open),
          title: 'Choose which courses show on the calendar',
          onClick: () => (open ? this.closeCourses(feed) : this.openCourses(feed)),
        }, `Courses ${shown}/${courses.length}`) : null,
        hidden ? h('button', {
          class: 'btn btn-small', type: 'button', title: 'Bring back the assignments you deleted (while Moodle still lists them)',
          onClick: () => this.restore(feed),
        }, 'Restore') : null,
        h('button', {
          class: `icon-btn${busy ? ' spinning' : ''}`, type: 'button', disabled: busy,
          title: busy ? 'Updating…' : 'Update now', 'aria-label': `Update ${feed.name} now`,
          onClick: () => this.sync.refresh(feed.id),
        }, icon('refresh', 16)),
        h('button', {
          class: 'icon-btn', type: 'button', title: 'Remove', 'aria-label': `Remove ${feed.name}`,
          onClick: () => { this.confirmId = feed.id; this.redraw(); },
        }, icon('trash', 16))));
    return open ? [row, this.coursesList(feed, courses)] : [row];
  }

  /** One line per course: ticked = on the calendar. Counts are what is still to come. */
  coursesList(feed, courses) {
    const filter = this.sync.filter;
    const n = (count, one, many) => (count ? `${count} ${count === 1 ? one : many}` : null);
    return h('div', { class: 'feed-courses', role: 'group', 'aria-label': `Courses from ${feed.name}` },
      h('div', { class: 'set-hint' }, 'Untick the courses that are not yours. Their lectures and exams leave the calendar; nothing is deleted. New courses start ticked.'),
      courses.map((c) => h('label', { class: `feed-course${c.hidden ? ' off' : ''}` },
        h('input', { type: 'checkbox', checked: !c.hidden, onChange: () => filter.setHidden(feed.id, [c.key], !c.hidden) }),
        h('span', { class: 'feed-course-name' }, c.name, c.isNew ? h('span', { class: 'badge-new' }, 'New') : null),
        h('span', { class: 'muted feed-course-count' }, [n(c.lectures, 'lecture', 'lectures'), n(c.exams, 'exam', 'exams')].filter(Boolean).join(' · ') || 'nothing left'))),
      h('div', { class: 'quick-row feed-courses-foot' },
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => filter.setHidden(feed.id, courses.map((c) => c.key), false) }, 'Show all'),
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => filter.setHidden(feed.id, courses.map((c) => c.key), true) }, 'Hide all'),
        h('span', { class: 'tb-spacer' }),
        h('button', { class: 'btn btn-small btn-primary', type: 'button', onClick: () => this.closeCourses(feed) }, 'Done')));
  }

  openCourses(feed) {
    this.ui.coursesOpen = feed.id;
    this.redraw();
  }

  /** Closing the list is "looked at": its "New" badges go. */
  closeCourses(feed) {
    this.ui.coursesOpen = null;
    this.sync.lookedAtCourses(feed);
    this.redraw();
  }

  /** "moodle.fh-joanneum.at · 9 due dates · 1 hidden · updated Oct 30, 14:32", with the last error in red when there is one. */
  hint(feed, busy, hidden = 0) {
    const c = this.sync.summary(feed);
    const n = (count, one, many) => (count ? `${count} ${count === 1 ? one : many}` : null);
    const what = [n(c.deadline, 'due date', 'due dates'), n(c.lecture, 'lecture', 'lectures'), n(c.exam, 'exam', 'exams'), n(c.event, 'event', 'events')]
      .filter(Boolean).join(', ') || 'nothing in it yet';
    const when = busy ? 'updating…' : feed.lastFetched ? `updated ${formatDateTime(new Date(feed.lastFetched))}` : null;
    return h('span', {},
      [feed.host, what, hidden ? `${hidden} deleted (can be restored)` : null, when].filter(Boolean).join(' · '),
      feed.lastError && !busy ? h('span', { class: 'feed-error' }, ` · Last update failed: ${feed.lastError}`) : null);
  }

  restore(feed) {
    const count = this.sync.restore(feed.id);
    this.ctx.bus.emit('toast:show', {
      id: `feed-restore-${feed.id}`, title: count ? `Restored ${count} assignment${count === 1 ? '' : 's'}` : 'Nothing to restore',
      text: count ? 'They are back in their course folders.' : `${feed.name} no longer lists them.`, timeout: 5000,
    });
  }

  async remove(id) {
    this.confirmId = null;
    await this.sync.remove(id).catch((err) => { this.error = `Could not remove it: ${err.message}`; });
    this.redraw();
  }
}
