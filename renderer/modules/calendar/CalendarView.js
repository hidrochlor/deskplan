import { Component } from '../../core/Component.js';
import { h, clear } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import {
  MONTHS, MONTHS_LONG, WEEKDAYS_LONG, weekdayLabels, addDays, addMonths, dayKey, formatDate, formatTime,
  monthGrid, sameDay, startOfDay, startOfMonth,
} from '../../core/dates.js';
import { DayAddForm } from './DayAddForm.js';

// Sizes used to work out how many deadline chips fit in a day cell (keep in step with styles.css).
const CELL = { gap: 4, pad: 10, num: 22, chip: 20 }; // pad = 4+4 padding + 1+1 border; num/chip include the 2px gap
const LIST_DAYS = 30;                      // how far the Agenda view looks ahead, and how much "Show more" adds
const MODE_KEY = 'deskplan.calendarMode';  // Month or Agenda, remembered on this PC only

const FILTER_KEY = 'deskplan.agendaFilter'; // the Agenda's type filter, remembered on this PC only

// The Agenda's filter chips. A step (a task inside an assignment) counts as its assignment's. Lectures and other feed
// events have no chip: they show under All only.
const TYPES = [
  { id: 'task', label: 'Tasks' },
  { id: 'assignment', label: 'Assignments' },
  { id: 'exam', label: 'Exams' },
];

/** Which filter chip an event belongs to, or null (a lecture or other feed event: All only). */
export function typeOf(ev) {
  if (ev.kind === 'Exam') return 'exam';
  if (ev.kind === 'Assignment' || ev.group) return 'assignment';
  if (ev.kind === 'Lecture' || ev.kind === 'Event') return null;
  return 'task'; // tasks, and older actionable kinds such as Reading
}

function readMode() {
  try { return localStorage.getItem(MODE_KEY) === 'agenda' ? 'agenda' : 'month'; } catch { return 'month'; }
}

function readFilter() {
  try {
    const ids = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id) => TYPES.some((t) => t.id === id)) : []);
  } catch { return new Set(); }
}

// Month grid plus a strip of the whole year, so you can see at a glance which months have
// deadlines and jump to any of them. Shows whatever the registered calendar sources provide.
// If a module registered a 'creator', you can add things straight onto a day.
// The Agenda view swaps all that for a list: what is overdue, then every day with something on it, from today.
export class CalendarView extends Component {
  constructor(ctx) {
    super(ctx);
    const now = new Date();
    this.month = startOfMonth(now);
    this.day = startOfDay(now);
    this.addingOn = null;   // the day the add form is open for
    this.addForm = null;
    this.mode = readMode();
    this.listDays = LIST_DAYS;
    this.types = readFilter(); // the Agenda shows only these types; empty = everything
    this.openGroups = new Set(); // assignments whose steps are unfolded in the agenda (`${dayKey}|${groupId}`)
  }

  /** The first registered creator, or null (then there is no Add button). */
  get creator() { return this.ctx.registry.list('creator')[0] ?? null; }

  build() {
    this.titleEl = h('h1', { class: 'cal-title' });
    this.stripEl = h('div', { class: 'cal-strip' });
    this.gridEl = h('div', { class: 'cal-grid' });
    this.agendaEl = h('div', { class: 'agenda-list' });
    this.agendaHeadEl = h('div', { class: 'agenda-head' });
    this.formHost = h('div', { class: 'agenda-form' }); // never cleared by redraws, so typing is safe
    this.listEl = h('div', { class: 'cal-list' });
    this.filterEl = h('div', { class: 'cal-filter', role: 'group', 'aria-label': 'Show only' });
    this.modeBtns = {
      month: h('button', { class: 'seg-btn', type: 'button', onClick: () => this.setMode('month') }, 'Month'),
      agenda: h('button', { class: 'seg-btn', type: 'button', onClick: () => this.setMode('agenda') }, 'Agenda'),
    };

    this.rootEl = h('section', { class: 'view calendar' },
      h('header', { class: 'view-head cal-head' },
        h('div', { class: 'cal-nav' },
          h('button', { class: 'icon-btn cal-month-only', title: 'Previous month', onClick: () => this.go(-1) }, icon('chevLeft', 16)),
          this.titleEl,
          h('button', { class: 'icon-btn cal-month-only', title: 'Next month', onClick: () => this.go(1) }, icon('chevRight', 16))),
        h('div', { class: 'cal-head-tools' },
          h('div', { class: 'seg', role: 'group', 'aria-label': 'Calendar view' }, this.modeBtns.month, this.modeBtns.agenda),
          h('button', { class: 'btn btn-small', onClick: () => this.today() }, 'Today'))),
      this.stripEl,
      this.weekdaysEl = h('div', { class: 'cal-weekdays' }),
      this.gridEl,
      h('div', { class: 'agenda' }, this.agendaHeadEl, this.formHost, this.agendaEl),
      this.filterEl,
      this.listEl);
    return this.rootEl;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* then it is remembered until the app closes */ }
    if (mode === 'agenda') this.closeAdd();
    this.render();
  }

  onMount() {
    this.on('data:changed', () => this.render());
    this.on('display:changed', () => this.render()); // clock format, week start
    this.every(60000, () => this.render());
    // Refit the chips whenever the grid's height changes (window resize, day list growing, panel toggled).
    let lastHeight = 0;
    const observer = new ResizeObserver(() => {
      const height = this.gridEl.clientHeight;
      if (this.mode !== 'month' || Math.abs(height - lastHeight) < 2) return;
      lastHeight = height;
      this.renderGrid();
    });
    observer.observe(this.gridEl);
    this._cleanups.push(() => observer.disconnect());
  }

  onUnmount() { this.closeAdd(); }

  // ── Navigation ─────────────────────────────────────────────────────────────

  go(delta) {
    this.month = addMonths(this.month, delta);
    this.render();
  }

  goTo(month) {
    this.month = startOfMonth(month);
    this.render();
  }

  today() {
    if (this.mode === 'agenda') { this.listEl.scrollTop = 0; return; }
    const now = new Date();
    this.month = startOfMonth(now);
    this.selectDay(startOfDay(now));
    this.render();
  }

  /** Change the chosen day without rebuilding the grid (so a double-click still lands). */
  selectDay(d) {
    this.day = startOfDay(d);
    if (this.addingOn && !sameDay(this.addingOn, this.day)) this.closeAdd();
    for (const cell of this.gridEl.querySelectorAll('[data-day]')) {
      cell.classList.toggle('selected', cell.dataset.day === dayKey(this.day));
    }
    this.renderAgenda();
  }

  openAdd(d) {
    if (!this.creator) return;
    this.selectDay(d);
    this.closeAdd();
    this.addingOn = this.day;
    this.addForm = new DayAddForm(this.ctx, this.creator, this.day, () => this.closeAdd()).mount(this.formHost);
    this.renderAgenda();
  }

  closeAdd() {
    this.addForm?.unmount();
    this.addForm = null;
    this.addingOn = null;
    if (this.agendaHeadEl) this.renderAgenda();
  }

  open(ev) {
    this.selectDay(ev.start);
    if (ev.ref) this.ctx.selection.select(ev.ref.type, ev.ref.id);
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  render() {
    const agenda = this.mode === 'agenda';
    this.rootEl.classList.toggle('is-agenda', agenda);
    for (const [mode, btn] of Object.entries(this.modeBtns)) {
      btn.classList.toggle('active', mode === this.mode);
      btn.setAttribute('aria-pressed', mode === this.mode ? 'true' : 'false');
    }
    if (agenda) {
      this.titleEl.textContent = 'Agenda';
      this.renderList();
      return;
    }
    this.titleEl.textContent = `${MONTHS_LONG[this.month.getMonth()]} ${this.month.getFullYear()}`;
    this.weekdaysEl.replaceChildren(...weekdayLabels().map((d) => h('div', {}, d)));
    this.renderStrip();
    this.renderGrid();
    this.renderAgenda();
  }

  /** Jan…Dec of the shown year, each with how many things are due that month. */
  renderStrip() {
    clear(this.stripEl);
    const year = this.month.getFullYear();
    const counts = new Array(12).fill(0);
    const late = new Array(12).fill(false);
    const now = new Date();
    for (const ev of this.ctx.deadlines.inRange(new Date(year, 0, 1), new Date(year + 1, 0, 1))) {
      if (ev.done || ev.start.getFullYear() !== year) continue; // a block counts in the month it starts
      counts[ev.start.getMonth()] += 1;
      if (ev.isOver(+now)) late[ev.start.getMonth()] = true;
    }

    this.stripEl.append(
      h('button', { class: 'icon-btn', title: 'Previous year', onClick: () => this.goTo(new Date(year - 1, this.month.getMonth(), 1)) }, icon('chevLeft', 14)),
      h('span', { class: 'cal-year' }, String(year)),
      h('button', { class: 'icon-btn', title: 'Next year', onClick: () => this.goTo(new Date(year + 1, this.month.getMonth(), 1)) }, icon('chevRight', 14)),
      h('div', { class: 'cal-months' }, MONTHS.map((name, m) => {
        const classes = ['cal-month'];
        if (m === this.month.getMonth()) classes.push('active');
        if (year === now.getFullYear() && m === now.getMonth()) classes.push('current');
        return h('button', {
          class: classes.join(' '), title: counts[m] ? `${counts[m]} due in ${MONTHS_LONG[m]}` : MONTHS_LONG[m],
          onClick: () => this.goTo(new Date(year, m, 1)),
        }, name, counts[m] ? h('span', { class: `cal-count${late[m] ? ' late' : ''}` }, String(counts[m])) : null);
      })));
  }

  /** How many chips fit in one day cell at the current window size. */
  chipCapacity() {
    const height = this.gridEl.clientHeight;
    if (!height) return 3;
    const cell = (height - 5 * CELL.gap) / 6;
    return Math.max(0, Math.floor((cell - CELL.pad - CELL.num) / CELL.chip));
  }

  renderGrid() {
    const days = monthGrid(this.month);
    const events = this.ctx.deadlines.inRange(days[0], addDays(days[41], 1));
    const byDay = new Map();
    for (const ev of events) {
      for (const day of ev.days()) { // a block that crosses midnight shows on every day it touches
        const key = dayKey(day);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(ev);
      }
    }

    clear(this.gridEl);
    const now = new Date();
    const fit = this.chipCapacity();
    for (const d of days) {
      const list = byDay.get(dayKey(d)) ?? [];
      const classes = ['cal-cell'];
      if (d.getMonth() !== this.month.getMonth()) classes.push('other');
      if (sameDay(d, now)) classes.push('today');
      if (sameDay(d, this.day)) classes.push('selected');

      // Chips fill the cell; whatever doesn't fit is counted next to the date ("+2 more"),
      // where it can never be cut off.
      const shown = list.slice(0, fit);
      const rest = list.length - shown.length;
      this.gridEl.appendChild(h('div', {
        class: classes.join(' '), 'data-day': dayKey(d),
        title: this.creator ? 'Double-click to add something due this day' : null,
        onClick: () => (d.getMonth() === this.month.getMonth() ? this.selectDay(d) : (this.goTo(d), this.selectDay(d))),
        onDblclick: () => this.openAdd(d),
      },
      h('div', { class: 'cal-cell-head' },
        h('span', { class: 'cal-num' }, String(d.getDate())),
        rest ? h('span', { class: 'cal-more', title: list.slice(fit).map((ev) => ev.title).join('\n') }, `+${rest} more`) : null),
      shown.map((ev) => this.chip(ev, now))));
    }
  }

  chip(ev, now) {
    const late = !ev.done && ev.isOver(+now);
    return h('div', {
      class: `cal-chip${ev.done ? ' done' : ''}${late ? ' late' : ''}`, 'data-keep-panel': true,
      style: { '--c': ev.color },
      title: `${ev.timeLabel()} ${ev.title} (${ev.kind}${ev.context ? ` · ${ev.context}` : ''})`,
      onClick: (e) => { e.stopPropagation(); this.open(ev); },
    }, h('span', { class: 'cal-chip-time' }, ev.timeLabel()), h('span', { class: 'cal-chip-title' }, ev.title));
  }

  renderAgenda() {
    const events = this.ctx.deadlines.onDay(this.day);
    const now = new Date();
    const weekday = WEEKDAYS_LONG[(this.day.getDay() + 6) % 7];

    clear(this.agendaHeadEl);
    this.agendaHeadEl.append(
      h('div', {}, h('span', { class: 'agenda-day' }, `${weekday}, ${formatDate(this.day)}`),
        h('span', { class: 'muted' }, events.length ? ` · ${events.length} due` : ' · nothing due')));
    // (Only append the button when it exists: Element.append would print a null as "null".)
    if (this.creator && !this.addingOn) {
      this.agendaHeadEl.append(h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.openAdd(this.day) }, icon('plus', 14), 'Add'));
    }

    clear(this.agendaEl);
    this.agendaEl.append(...this.rowsFor(events, this.day, now, () => this.renderAgenda()));
  }

  /**
   * One day's rows. When the assignment itself is on this day too, its steps fold under its own row (a chevron opens
   * them). Otherwise two or more steps of one assignment fold into one row of their own, and a lone step shows as it is.
   */
  rowsFor(events, day, now, redraw) {
    const groups = new Map();
    for (const ev of events) if (ev.group) groups.set(ev.group.id, [...(groups.get(ev.group.id) ?? []), ev]);
    const parents = new Set(events.filter((ev) => ev.kind === 'Assignment' && groups.has(ev.ref?.id)).map((ev) => ev.ref.id));
    const drawn = new Set();
    const rows = [];
    for (const ev of events) {
      if (parents.has(ev.ref?.id) && ev.kind === 'Assignment') {
        rows.push(...this.agendaParent(ev, groups.get(ev.ref.id), day, now, redraw));
        continue;
      }
      if (ev.group && parents.has(ev.group.id)) continue; // drawn under its assignment
      const steps = ev.group ? groups.get(ev.group.id) : null;
      if (!steps || steps.length < 2) { rows.push(this.agendaRow(ev, now)); continue; }
      if (drawn.has(ev.group.id)) continue;
      drawn.add(ev.group.id);
      rows.push(...this.agendaGroup(ev.group, steps, day, now, redraw));
    }
    return rows;
  }

  /**
   * The Agenda view: what is still open although its time has passed, then every day from today that has something
   * on it (a block that crosses midnight is listed on each day it touches). "Show more" looks further ahead.
   */
  renderList() {
    const now = new Date();
    const today = startOfDay(now);
    const until = addDays(today, this.listDays);
    const top = this.listEl.scrollTop;
    clear(this.listEl);

    const allOverdue = this.ctx.deadlines.events().filter((ev) => !ev.done && !ev.quiet && ev.dueAt < today);
    const ahead = this.ctx.deadlines.inRange(today, until);
    this.renderFilter([...allOverdue, ...ahead]);
    const shown = (ev) => !this.types.size || this.types.has(typeOf(ev));
    const overdue = allOverdue.filter(shown);
    const byDay = new Map();
    for (const ev of ahead.filter(shown)) {
      for (const day of ev.days()) {
        if (day < today || day >= until) continue;
        const key = dayKey(day);
        if (!byDay.has(key)) byDay.set(key, { day, events: [] });
        byDay.get(key).events.push(ev);
      }
    }
    const days = [...byDay.values()].sort((a, b) => a.day - b.day);

    const redraw = () => this.renderList();
    if (overdue.length) {
      this.listEl.appendChild(this.listDay('Overdue', `${overdue.length} still open`, 'late',
        this.rowsFor(overdue, new Date(0), now, redraw)));
    }
    for (const { day, events } of days) {
      const offset = Math.round((day - today) / 86400000);
      const name = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : WEEKDAYS_LONG[(day.getDay() + 6) % 7];
      this.listEl.appendChild(this.listDay(`${name}, ${formatDate(day)}`, `${events.length} ${events.length === 1 ? 'thing' : 'things'}`,
        offset === 0 ? 'today' : '', this.rowsFor(events, day, now, redraw)));
    }
    if (!overdue.length && !days.length) {
      const what = this.types.size ? TYPES.filter((t) => this.types.has(t.id)).map((t) => t.label.toLowerCase()).join(' or ') : null;
      this.listEl.appendChild(h('div', { class: 'empty cal-list-empty' },
        what ? `No ${what} in the next ${this.listDays} days.` : `Nothing in the next ${this.listDays} days.`));
    }
    this.listEl.appendChild(h('div', { class: 'cal-list-more' },
      h('span', { class: 'muted' }, `Up to ${formatDate(addDays(until, -1))}`),
      h('button', { class: 'btn btn-small', type: 'button', onClick: () => { this.listDays += LIST_DAYS; this.renderList(); } },
        `Show ${LIST_DAYS} more days`)));
    this.listEl.scrollTop = top; // a redraw (the minute tick, a change) keeps the reader's place
  }

  /** All, then one chip per type with how many of it the list holds. Several can be on at once. */
  renderFilter(events) {
    const counts = Object.fromEntries(TYPES.map((t) => [t.id, 0]));
    for (const ev of events) if (typeOf(ev)) counts[typeOf(ev)] += 1;
    const chip = (label, on, onClick, count = null) => h('button', {
      class: `cal-filter-chip${on ? ' active' : ''}`, type: 'button', 'aria-pressed': on ? 'true' : 'false', onClick,
    }, label, count === null ? null : h('span', { class: 'cal-filter-count' }, String(count)));

    clear(this.filterEl);
    this.filterEl.append(
      chip('All', !this.types.size, () => this.setTypes(new Set())),
      ...TYPES.map((t) => chip(t.label, this.types.has(t.id), () => {
        const next = new Set(this.types);
        if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
        this.setTypes(next.size === TYPES.length ? new Set() : next); // every type on is the same as All
      }, counts[t.id])));
  }

  setTypes(types) {
    this.types = types;
    try { localStorage.setItem(FILTER_KEY, JSON.stringify([...types])); } catch { /* remembered until the app closes */ }
    this.renderList();
  }

  listDay(title, count, tone, rows) {
    return h('div', { class: `cal-list-day${tone ? ` ${tone}` : ''}` },
      h('div', { class: 'cal-list-head' }, h('span', { class: 'agenda-day' }, title), h('span', { class: 'muted' }, ` · ${count}`)),
      rows);
  }

  agendaRow(ev, now, nested = false) {
    const late = !ev.done && ev.isOver(+now);
    return h('div', {
      class: `agenda-row${ev.done ? ' done' : ''}${late ? ' late' : ''}${nested ? ' agenda-step' : ''}`, 'data-keep-panel': true,
      onClick: () => this.open(ev),
    },
    h('span', { class: 'agenda-time' }, ev.timeLabel()),
    h('span', { class: 'dot', style: { '--c': ev.color } }),
    h('span', { class: 'agenda-title' }, ev.title),
    h('span', { class: 'muted agenda-where' }, nested ? ev.kind : ev.context ? `${ev.kind} · ${ev.context}` : ev.kind));
  }

  /**
   * An assignment's own row with its steps of this day folded under it. The chevron opens and closes them; the rest of
   * the row opens the assignment, as any row does.
   */
  agendaParent(ev, steps, day, now, redraw) {
    const key = `${dayKey(day)}|${ev.ref.id}`;
    const open = this.openGroups.has(key);
    const done = steps.filter((s) => s.done).length;
    const late = !ev.done && ev.isOver(+now);
    const toggle = (e) => { e.stopPropagation(); if (open) this.openGroups.delete(key); else this.openGroups.add(key); redraw(); };
    const head = h('div', {
      class: `agenda-row agenda-parent${ev.done ? ' done' : ''}${late ? ' late' : ''}`, 'data-keep-panel': true,
      onClick: () => this.open(ev),
    },
    h('span', { class: 'agenda-time' }, ev.timeLabel()),
    h('button', {
      class: 'agenda-chev agenda-chev-btn', type: 'button', 'aria-expanded': open ? 'true' : 'false',
      title: open ? 'Hide the steps' : 'Show the steps', onClick: toggle,
    }, icon(open ? 'chevDown' : 'chevRight', 14)),
    h('span', { class: 'dot', style: { '--c': ev.color } }),
    h('span', { class: 'agenda-title' }, ev.title),
    h('span', { class: 'muted agenda-where' },
      `${ev.kind} · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'} · ${done} done`));
    return open ? [head, ...steps.map((s) => this.agendaRow(s, now, true))] : [head];
  }

  /** One row for an assignment's steps on this day ("3 steps · 1 done"), and the steps under it when unfolded. */
  agendaGroup(group, steps, day, now, redraw) {
    const key = `${dayKey(day)}|${group.id}`;
    const open = this.openGroups.has(key);
    const done = steps.filter((s) => s.done).length;
    const late = steps.some((s) => !s.done && s.isOver(+now));
    const toggle = () => { if (open) this.openGroups.delete(key); else this.openGroups.add(key); redraw(); };
    const head = h('div', {
      class: `agenda-row agenda-group${done === steps.length ? ' done' : ''}${late ? ' late' : ''}`, 'data-keep-panel': true,
      role: 'button', tabindex: 0, 'aria-expanded': open ? 'true' : 'false',
      title: open ? 'Hide the steps' : 'Show the steps',
      onClick: toggle,
      onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
    },
    h('span', { class: 'agenda-time' }, steps[0].timeLabel()),
    h('span', { class: 'agenda-chev' }, icon(open ? 'chevDown' : 'chevRight', 14)),
    h('span', { class: 'agenda-title' }, group.title),
    h('span', { class: 'muted agenda-where' }, `${steps.length} steps · ${done} done`));
    return open ? [head, ...steps.map((s) => this.agendaRow(s, now, true))] : [head];
  }
}
