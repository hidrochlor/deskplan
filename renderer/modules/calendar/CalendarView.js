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

// Month grid plus a strip of the whole year, so you can see at a glance which months have
// deadlines and jump to any of them. Shows whatever the registered calendar sources provide.
// If a module registered a 'creator', you can add things straight onto a day.
export class CalendarView extends Component {
  constructor(ctx) {
    super(ctx);
    const now = new Date();
    this.month = startOfMonth(now);
    this.day = startOfDay(now);
    this.addingOn = null;   // the day the add form is open for
    this.addForm = null;
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

    return h('section', { class: 'view calendar' },
      h('header', { class: 'view-head cal-head' },
        h('div', { class: 'cal-nav' },
          h('button', { class: 'icon-btn', title: 'Previous month', onClick: () => this.go(-1) }, icon('chevLeft', 16)),
          this.titleEl,
          h('button', { class: 'icon-btn', title: 'Next month', onClick: () => this.go(1) }, icon('chevRight', 16))),
        h('button', { class: 'btn btn-small', onClick: () => this.today() }, 'Today')),
      this.stripEl,
      this.weekdaysEl = h('div', { class: 'cal-weekdays' }),
      this.gridEl,
      h('div', { class: 'agenda' }, this.agendaHeadEl, this.formHost, this.agendaEl));
  }

  onMount() {
    this.on('data:changed', () => this.render());
    this.on('display:changed', () => this.render()); // clock format, week start
    this.every(60000, () => this.render());
    // Refit the chips whenever the grid's height changes (window resize, day list growing, panel toggled).
    let lastHeight = 0;
    const observer = new ResizeObserver(() => {
      const height = this.gridEl.clientHeight;
      if (Math.abs(height - lastHeight) < 2) return;
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
    for (const ev of events) {
      const late = !ev.done && ev.isOver(+now);
      this.agendaEl.appendChild(h('div', {
        class: `agenda-row${ev.done ? ' done' : ''}${late ? ' late' : ''}`, 'data-keep-panel': true,
        onClick: () => this.open(ev),
      },
      h('span', { class: 'agenda-time' }, ev.timeLabel()),
      h('span', { class: 'dot', style: { '--c': ev.color } }),
      h('span', { class: 'agenda-title' }, ev.title),
      h('span', { class: 'muted agenda-where' }, ev.context ? `${ev.kind} · ${ev.context}` : ev.kind)));
    }
  }
}
