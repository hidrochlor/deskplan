import { Component } from '../../core/Component.js';
import { h } from '../../core/dom.js';
import { formatDate } from '../../core/dates.js';

// Inline form under the calendar: add something due on the chosen day.
// It knows nothing about tasks or folders; it uses a 'creator' that another module registered:
//   { id, kinds: [{id,label}], places(): [{id,label}], problem({ kind, placeId, due, start }), create({ kind, title, due, start, placeId }) }
// A task is a time block, so choosing Task shows a From time as well; the other kinds are just due at one time.
export class DayAddForm extends Component {
  /**
   * @param {object} creator   the registered creator
   * @param {Date} day
   * @param {() => void} onDone
   */
  constructor(ctx, creator, day, onDone) {
    super(ctx);
    this.creator = creator;
    this.day = day;
    this.onDone = onDone;
  }

  /** Last kind / place used, so adding several in a row is quick. */
  get memory() { return this.store.meta.ui?.calendarAdd ?? {}; }

  build() {
    const mem = this.memory;
    const places = this.creator.places();
    this.titleInput = h('input', { class: 'input grow', placeholder: `Due ${formatDate(this.day)}: name`, 'aria-label': 'Name' });
    this.kindSelect = h('select', { class: 'input', 'aria-label': 'Type', value: mem.kind ?? this.creator.kinds[0].id },
      this.creator.kinds.map((k) => h('option', { value: k.id }, k.label)));
    this.placeSelect = h('select', {
      class: 'input place', 'aria-label': 'Folder', title: 'Which folder it goes in',
      value: places.some((p) => p.id === mem.place) ? mem.place : '',
    }, places.map((p) => h('option', { value: p.id }, p.label)));
    this.timeInput = h('input', { class: 'input time', type: 'time', value: mem.time ?? '23:59', 'aria-label': 'Due time' });
    this.fromInput = h('input', { class: 'input time', type: 'time', value: mem.from ?? '09:00', 'aria-label': 'From time', hidden: true });
    const showFrom = () => {
      const task = this.kindSelect.value === 'task';
      this.fromInput.hidden = !task;
      this.timeInput.setAttribute('aria-label', task ? 'To time' : 'Due time');
      if (task && this.timeInput.value === '23:59') this.timeInput.value = '10:00'; // a task is a block, not "due at the end of the day"
    };
    this.kindSelect.addEventListener('change', showFrom);
    showFrom();

    this.errorEl = h('div', { class: 'day-add-error', role: 'alert', hidden: true });
    const clearError = () => { this.errorEl.hidden = true; };
    this.kindSelect.addEventListener('change', clearError);
    this.placeSelect.addEventListener('change', clearError);

    return h('form', { class: 'day-add', 'data-keep-panel': true, onSubmit: (e) => { e.preventDefault(); this.submit(); } },
      this.titleInput, this.kindSelect, this.placeSelect, this.fromInput, this.timeInput,
      h('button', { class: 'btn btn-primary btn-small', type: 'submit' }, 'Add'),
      h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.onDone() }, 'Cancel'),
      this.errorEl);
  }

  onMount() {
    this.listen(this.el, 'keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.onDone(); } });
    this.titleInput.focus();
  }

  submit() {
    const title = this.titleInput.value.trim();
    if (!title) { this.titleInput.focus(); return; }
    const at =(hhmm, fallback) => {
      const [h2, m2] = (hhmm || fallback).split(':').map(Number);
      return new Date(this.day.getFullYear(), this.day.getMonth(), this.day.getDate(), h2, m2);
    };
    const due = at(this.timeInput.value, '23:59');
    const start = this.kindSelect.value === 'task' ? at(this.fromInput.value, '09:00') : null;
    const choice = { kind: this.kindSelect.value, place: this.placeSelect.value, time: this.timeInput.value, from: this.fromInput.value };
    const problem = this.creator.problem?.({ kind: choice.kind, placeId: choice.place || null, due, start });
    if (problem) { this.errorEl.textContent = problem; this.errorEl.hidden = false; this.placeSelect.focus(); return; }
    this.store.meta.ui = { ...(this.store.meta.ui ?? {}), calendarAdd: choice };
    this.store.touchMeta();
    this.onDone(); // close first, then create (creating redraws the calendar)
    this.creator.create({ kind: choice.kind, title, due, start, placeId: choice.place || null });
  }
}
