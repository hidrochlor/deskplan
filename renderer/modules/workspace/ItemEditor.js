import { Component } from '../../core/Component.js';
import { h, clear } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import {
  HOUR, addDays, dayKey, endOfDay, formatDateTime, fromInputValue, toInputValue, urgency,
} from '../../core/dates.js';
import { CalendarEvent } from '../../services/CalendarSource.js';
import { NextEventLabel } from '../../services/NextEventLabel.js';
import { Item, ITEM_STATUSES } from './Item.js';
import { canRepeat, readRepeat, repeatText, rootOf, seriesOf } from './Repeats.js';
import { ItemTree } from './ItemTree.js';
import { formatSize } from './Attachments.js';

// Right panel for one item. Shows only the fields that make sense for its kind:
//   everything      title, where it lives, delete
//   files           preview, open / show in folder
//   others          type, deadline
//   actionable      status
//   notes           word count (the text itself is written in the canvas)
//   the rest        a details box
export class ItemEditor extends Component {
  /** @param {import('./Attachments.js').Attachments} attachments */
  constructor(ctx, id, attachments) {
    super(ctx);
    this.id = id;
    this.attachments = attachments;
    this._busy = false;
    this._confirmDelete = false;
    this.tree = new ItemTree(this.items);
  }

  get items() { return this.store.collection('items'); }
  get item() { return this.items.get(this.id); }

  build() { return h('div', { class: 'editor' }); }

  onMount() {
    // Redraw when something else (the canvas, a checkbox) changes this item. An assignment also redraws when one of
    // its steps is ticked, added, moved or deleted, so Progress stays right (not while typing here: that would lose
    // the cursor).
    this.on('data:changed', (e) => {
      if (this._busy || e.collection !== 'items') return;
      if (e.id === this.id) {
        if (e.type !== 'remove') this.render();
        // A copy taken back by an untick: show the series through its copy that is now the latest.
        else if (this._series) {
          const latest = this.series?.latest;
          if (latest) this.ctx.selection.select('item', latest.id);
        }
        return;
      }
      if (this._series && rootOf(e.id) === rootOf(this.id) && !this.typing()) {
        this.render();
        return;
      }
      if (this.item?.kind !== 'assignment' || this.el.contains(document.activeElement)) return;
      const changed = this.items.get(e.id);
      if (e.type === 'remove' || changed?.parentId === this.id || this._steps?.has(e.id)) this.render();
    });
  }

  /** True while a box in this panel has the cursor: redrawing then would lose it. A focused button does not count. */
  typing() {
    const el = document.activeElement;
    return !!el && this.el.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  }

  /** Apply a change made from this editor without redrawing it under the user's cursor. */
  commit(patch) {
    this._busy = true;
    try { this.items.update(this.id, patch); } finally { this._busy = false; }
  }

  /** The quick buttons set the due time (the end of a time block, which keeps its length). Clear removes the start too. */
  setDeadline(date) {
    const item = this.item;
    if (!date && item.kind === 'assignment') { this.showError('An assignment always has a due time.'); return; }
    if (!date) { this.changeTimes({ start: null, deadline: null }); return; } // (refused with a message for a time block)
    const length = item.isBlock ? item.deadlineDate - item.startDate : 0;
    this.changeTimes({ start: item.isBlock ? new Date(date.getTime() - length) : null, deadline: date });
  }

  /**
   * Save a new start and / or end (Date or null), if ItemRules accepts the pair. Otherwise nothing is saved, the boxes go
   * back to what is stored and a short message says why.
   */
  changeTimes(change) {
    const item = this.item;
    const start = 'start' in change ? change.start : item.startDate;
    const deadline = 'deadline' in change ? change.deadline : item.deadlineDate;
    const iso = (d) => (d ? d.toISOString() : null);
    const rules = this.tree.rules;
    const locked = rules.deadlineLocked(item);
    if (locked) { this.showError(locked); this.syncInputs(); return; }
    const problem = rules.timeProblem({ kind: item.kind, start: iso(start), deadline: iso(deadline) }) ?? rules.keepsStart(item, iso(start));
    if (problem) { this.showError(problem); this.syncInputs(); return; }
    if (item.kind === 'assignment' && !deadline) { this.showError('An assignment always has a due time.'); this.syncInputs(); return; }
    this.hideError();
    const wasBlock = item.isBlock;
    this.commit({ start: iso(start), deadline: iso(deadline) });
    if (wasBlock !== this.item.isBlock) this.render(); // From and To appear or go away
    else { this.syncInputs(); this.refreshCountdown(); }
  }

  showError(text) {
    if (!this.errorEl) return;
    this.errorEl.textContent = text;
    this.errorEl.hidden = false;
  }

  hideError() { if (this.errorEl) this.errorEl.hidden = true; }

  /** Put the stored times back into the boxes. */
  syncInputs() {
    const item = this.item;
    if (this.deadlineInput) this.deadlineInput.value = item.deadlineDate ? toInputValue(item.deadlineDate) : '';
    if (this.startInput) this.startInput.value = item.isBlock ? toInputValue(item.startDate) : '';
  }

  /** "starts in 2h", "ends 19:00 · 1h 20m left" or "Oct 6, 23:59 · 4h left", the same words as the top bar. */
  refreshCountdown() {
    const item = this.item;
    const date = item?.deadlineDate;
    if (!date) { this.countdownEl.className = 'countdown'; this.countdownEl.textContent = 'No deadline'; return; }
    const event = new CalendarEvent({ id: item.id, title: '', start: item.isBlock ? item.startDate : date, end: item.isBlock ? date : null });
    const now = Date.now();
    this.countdownEl.className = `countdown ${urgency(NextEventLabel.urgencyAt(event, now), now)}`;
    this.countdownEl.textContent = NextEventLabel.text(event, now);
  }

  render() {
    const item = this.item;
    clear(this.el);
    if (!item) { this.el.appendChild(h('div', { class: 'empty' }, 'This item no longer exists.')); return; }
    this.bus.emit('panel:title', { text: item.kindInfo.label, color: item.kindInfo.color });

    this.el.append(
      h('input', {
        class: 'input title-input', value: item.title, placeholder: 'Title', 'aria-label': 'Title',
        onInput: (e) => this.commit({ title: e.target.value }),
      }),
      this.locationField(item));

    if (item.isFile) {
      this.el.append(this.fileField(item));
    } else {
      // (No Type box: the type is fixed when an item is made. The panel title shows it.)
      if (item.isActionable) this.el.append(this.statusField(item));
      this.el.append(this.deadlineField(item));
      if (item.isActionable && !item.source) this.el.append(this.repeatField(item));
      const series = this.series;
      if (series) this.el.append(this.timelineField(series));
      if (item.isNote) {
        this.el.append(h('div', { class: 'facts' },
          this.stat('Words', String(item.wordCount)),
          item.checklist.total ? this.stat('Checklist', `${item.checklist.done} / ${item.checklist.total} done`) : null,
          this.stat('Edited', formatDateTime(new Date(item.updatedAt)))));
      } else {
        this.el.append(this.field('Details', h('textarea', {
          class: 'input area', rows: 8, placeholder: 'Details, links, requirements…', value: item.description,
          onInput: (e) => this.commit({ description: e.target.value }),
        })));
      }
    }

    this.el.append(h('footer', { class: 'editor-foot' },
      h('span', { class: 'muted' }, `${item.source ? `From ${item.source.label} · ` : ''}Created ${formatDateTime(new Date(item.createdAt))}`),
      this.deleteButton()));
  }

  field(label, ...children) {
    return h('div', { class: 'field' }, h('label', { class: 'field-label' }, label), children);
  }

  stat(label, value) {
    return h('div', { class: 'stat' }, h('span', { class: 'muted' }, label), h('span', {}, value));
  }

  /** Where the item lives, plus a button that takes the canvas there. */
  locationField(item) {
    const where = ['Home', ...this.tree.path(item.id).map((f) => f.title || 'Untitled')].join(' › ');
    const opens = (this.tree.isFolder(item) && item.kind !== 'assignment') || item.isNote; // an assignment is "shown" as a row, its steps open from Progress
    return this.field('In',
      h('div', { class: 'location' },
        h('span', { class: 'location-path' }, where),
        h('button', {
          class: 'btn btn-small', type: 'button',
          onClick: () => this.bus.emit('reveal', { type: 'item', id: item.id }),
        }, icon(opens ? 'open' : 'folder', 14), opens ? 'Open' : 'Show')),
      this.moveSelect(item));
  }

  /** "Move to…": pick another folder (or Home). Folders can't go into themselves or what they contain. */
  moveSelect(item) {
    const here = this.tree.parentOf(item) ?? '';
    const options = [{ id: '', label: 'Home' }, ...this.tree.folderOptions({ excludeId: item.id })]
      .filter((o) => o.id !== here && this.tree.canMove(item.id, o.id || null)); // an assignment can not go to Home, a folder not into an assignment
    return h('select', {
      class: 'input move-select', 'aria-label': 'Move to', title: 'Move to another folder',
      value: '__move',
      onChange: (e) => { if (e.target.value !== '__move') this.tree.move(item.id, e.target.value || null); },
    }, [h('option', { value: '__move', disabled: true }, 'Move to…'), ...options.map((o) => h('option', { value: o.id }, o.label))]);
  }

  statusField(item) {
    if (item.kind === 'assignment') return this.assignmentField(item);
    return this.field('Status', h('div', { class: 'seg' }, ITEM_STATUSES.map((s) =>
      h('button', {
        class: `seg-btn${item.status === s.id ? ' active' : ''}`,
        onClick: () => { this.commit(Item.statusPatch(s.id)); this.render(); },
      }, s.label))));
  }

  /** An assignment is finished by submitting it; its steps (tasks inside it) show as progress. */
  assignmentField(item) {
    const { done, total } = this.tree.progress(item.id);
    this._steps = new Set(this.tree.steps(item.id).map((s) => s.id)); // a step moved out redraws Progress too
    const submitted = item.isDone;
    return this.field('Progress',
      h('div', { class: 'facts' },
        this.stat('Steps', total ? `${done} / ${total} done` : 'No steps yet'),
        this.tree.needsCourse(item, this.store.meta.unsortedId) ? this.stat('Course', 'Needs a course: move it into one') : null),
      h('div', { class: 'quick-row' },
        h('button', {
          class: `btn btn-small${submitted ? '' : ' btn-primary'}`, type: 'button',
          onClick: () => { this.commit(Item.statusPatch(submitted ? 'todo' : 'done')); this.render(); },
        }, submitted ? 'Mark as not submitted' : icon('check', 14), submitted ? null : 'Mark submitted'),
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.bus.emit('reveal', { type: 'item', id: item.id, inside: true }) }, icon('open', 14), 'Open steps')));
  }

  /**
   * "Due" for something due at one time. A task can also run from a start to an end (a time block): then "From" and "To".
   * An assignment is only ever due at one time, so it never gets a start.
   */
  deadlineField(item) {
    const block = item.isBlock;
    this.errorEl = h('div', { class: 'field-error', role: 'alert', hidden: true });
    if (this.tree.rules.deadlineLocked(item)) return this.lockedDeadlineField(item);
    this.deadlineInput = h('input', {
      class: 'input', type: 'datetime-local', 'aria-label': block ? 'To' : 'Deadline',
      value: item.deadlineDate ? toInputValue(item.deadlineDate) : '',
      onChange: (e) => this.changeTimes({ deadline: fromInputValue(e.target.value) }),
    });
    this.startInput = block ? h('input', {
      class: 'input', type: 'datetime-local', 'aria-label': 'From', value: toInputValue(item.startDate),
      onChange: (e) => this.changeTimes({ start: fromInputValue(e.target.value) }),
    }) : null;
    this.countdownEl = h('div', { class: 'countdown' });
    this.refreshCountdown();

    const quick = (label, fn) => h('button', { class: 'btn btn-small', type: 'button', onClick: fn }, label);
    const today = new Date();
    // A task is a time block for good: no Clear, no Remove start. Assignments are due times only; only the due time can be cleared
    // on something that is neither (a note, a folder, or a task made before blocks existed).
    const canClear = !block && item.kind !== 'assignment';
    const quickRow = h('div', { class: 'quick-row' },
      quick('Today', () => this.setDeadline(endOfDay(today))),
      quick('Tomorrow', () => this.setDeadline(endOfDay(addDays(today, 1)))),
      quick('+1 week', () => this.setDeadline(endOfDay(addDays(today, 7)))),
      canClear ? quick('Clear', () => this.setDeadline(null)) : null);

    if (block) {
      return h('div', { class: 'editor' },
        this.field('From', this.startInput),
        this.field('To', this.deadlineInput, quickRow, this.countdownEl, this.errorEl));
    }
    // An old task with only a due time can be given a start. The button sits above the due time, where the start belongs.
    const addStart = item.kind === 'task' ? quick('Add start time', () => this.addStart()) : null;
    return this.field('Due', addStart, this.deadlineInput, quickRow, this.countdownEl, this.errorEl);
  }

  /**
   * "Repeat": how often a new copy comes when this one is ticked off (Repeats.js), and until when. Needs a due time.
   * A rule set elsewhere (the phone: every 3 days, say) shows as its own choice so it is not lost by opening the panel.
   */
  repeatField(item) {
    const PRESETS = [
      { id: '', label: 'Never', rule: null },
      { id: 'day', label: 'Daily', rule: { every: 'day', interval: 1 } },
      { id: 'week', label: 'Weekly', rule: { every: 'week', interval: 1 } },
      { id: 'week2', label: 'Every 2 weeks', rule: { every: 'week', interval: 2 } },
      { id: 'month', label: 'Monthly', rule: { every: 'month', interval: 1 } },
    ];
    const current = item.repeat ? readRepeat(item.repeat) : null;
    const matches = (rule) => (rule === null ? current === null
      : !!current && current.every === rule.every && current.interval === rule.interval);
    const options = item.kind === 'task' ? [...PRESETS] : [PRESETS[0]];
    if (current && !PRESETS.some((p) => matches(p.rule))) {
      options.push({ id: 'custom', label: repeatText({ ...current, until: null }), rule: current });
    }
    const chosen = options.find((o) => matches(o.rule)) ?? options[0];
    const save = (rule, until) => {
      const repeat = rule ? { every: rule.every, interval: rule.interval, until } : null;
      const problem = this.tree.rules.repeatProblem(item, repeat);
      if (problem) { this.showError(problem); return; }
      this.hideError();
      this.commit({ repeat });
      this.render();
    };
    const select = h('select', {
      // Only tasks repeat; an assignment that already does (an older DeskPlan) can still be set to Never.
      class: 'input', 'aria-label': 'Repeat', value: chosen.id, disabled: (!canRepeat(item) || item.kind !== 'task') && !current,
      onChange: (e) => save(options.find((o) => o.id === e.target.value)?.rule ?? null, current?.until ?? null),
    }, options.map((o) => h('option', { value: o.id, selected: o === chosen }, o.label)));
    const until = current ? h('label', { class: 'repeat-until' }, h('span', { class: 'muted' }, 'Until'),
      h('input', {
        class: 'input', type: 'date', 'aria-label': 'Repeat until', value: current.until ? dayKey(new Date(current.until)) : '',
        onChange: (e) => {
          const [y, m, d] = e.target.value.split('-').map(Number);
          save(current, e.target.value ? endOfDay(new Date(y, m - 1, d)).toISOString() : null);
        },
      })) : null;
    const hint = !item.deadline
      ? 'Set a due time first.'
      : current ? 'The next one is added when you tick this one off, or when its time has passed.' : null;
    return this.field('Repeat', h('div', { class: 'repeat-row' }, select, until),
      hint ? h('div', { class: 'set-hint' }, hint) : null);
  }

  /** The repeating series this item is a copy of, or null. */
  get series() {
    const root = rootOf(this.id);
    return seriesOf(this.items.all().filter((i) => rootOf(i.id) === root))[0] ?? null;
  }

  /**
   * A repeating item's timeline: the copies to come (not made yet), then the earlier ones, newest first, each done or
   * missed, with a tick to change that. Edits above apply to the latest copy, which the next ones are made from.
   */
  timelineField(series) {
    const latest = series.latest;
    const ended = series.ended();
    const LABELS = { next: 'Next', todo: 'To do', done: 'Done', missed: 'Missed' };
    const line = (when, { item = null, state = 'planned' } = {}) => h('div', { class: `timeline-row tl-${state}` },
      item ? h('button', {
        class: 'check', type: 'button', title: item.isDone ? 'Mark as to do' : 'Mark as done',
        onClick: () => this.items.update(item.id, Item.statusPatch(item.isDone ? 'todo' : 'done')),
      }, item.isDone ? icon('check', 14) : null) : h('span', { class: 'timeline-dot' }),
      h('span', { class: 'timeline-when' }, when),
      LABELS[state] ? h('span', { class: 'timeline-state' }, LABELS[state]) : null);
    const when = (start, deadline) => (start
      ? `${formatDateTime(new Date(start))} – ${formatDateTime(new Date(deadline)).split(', ')[1]}`
      : formatDateTime(new Date(deadline)));
    const next = !ended && !latest.isDone ? latest : null;
    // Done; missed once its time passed; to do while it is still ahead (unticked after a later one was done).
    const stateOf = (m) => (m.isDone ? 'done' : Date.parse(m.deadline) > Date.now() ? 'todo' : 'missed');
    const earlier = [...series.members].reverse().filter((m) => m !== next && m.deadline);
    const coming = ended ? [] : series.upcoming({ max: 6 });
    // Redraw when a copy of this series changes (a tick here, or the next copy being made).
    this._series = new Set(series.members.map((m) => m.id));
    return this.field(ended ? 'Timeline · ended' : 'Timeline',
      h('div', { class: 'timeline' },
        next ? line(when(next.start, next.deadline), { item: next, state: 'next' }) : null,
        coming.map((c) => line(when(c.start, c.deadline))),
        earlier.map((m) => line(when(m.start, m.deadline), { item: m, state: stateOf(m) }))),
      this.id !== latest.id
        ? h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.ctx.selection.select('item', latest.id) },
          'Edit the series (its latest copy)')
        : null);
  }

  /** An imported assignment: its due time is shown, not edited (ItemRules.deadlineLocked). Own plans go into steps. */
  lockedDeadlineField(item) {
    this.deadlineInput = null;
    this.startInput = null;
    this.countdownEl = h('div', { class: 'countdown' });
    this.refreshCountdown();
    return this.field('Due',
      h('div', { class: 'due-locked' }, item.deadlineDate ? formatDateTime(item.deadlineDate) : 'No due date'),
      this.countdownEl,
      h('div', { class: 'set-hint' }, `Set by ${item.source.label || 'the calendar'}, so it changes when it does. To plan your own time, add a step.`),
      this.errorEl);
  }

  /** Turn an old due-time task into a time block: it starts an hour before its due time (change it in From). */
  addStart() {
    const end = this.item.deadlineDate;
    if (!end) { this.showError('A start needs an end time. Set the due time first.'); return; }
    this.changeTimes({ start: new Date(end.getTime() - HOUR) });
  }

  fileField(item) {
    const url = item.isImage ? this.attachments.url(item) : null;
    return h('div', { class: 'field' },
      url ? h('img', { class: 'file-preview', src: url, alt: '' }) : null,
      h('div', { class: 'facts' },
        this.stat('File', item.file?.name ?? '—'),
        this.stat('Size', formatSize(item.file?.size))),
      h('div', { class: 'quick-row' },
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.attachments.open(item) }, icon('open', 14), 'Open'),
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.attachments.reveal(item) }, icon('folder', 14), 'Show in Explorer')));
  }

  deleteButton() {
    const inside = this.tree.descendants(this.id).length;
    // A repeating item goes with all its copies: deleting only the latest would have the one before make it again.
    const members = this.series?.members ?? [];
    const label = members.length > 1 ? `Delete series (${members.length})` : inside ? `Delete with ${inside} inside` : 'Delete';
    // An imported assignment is not added again after a delete; Settings › Data can bring it back while the feed still has it.
    const from = this.item.source?.label;
    const btn = h('button', {
      class: 'btn btn-danger', type: 'button',
      title: from ? `${from} won't add it back by itself. You can restore it in Settings › Data.` : null,
    }, icon('trash', 15), label);
    btn.addEventListener('click', () => {
      if (!this._confirmDelete) {
        this._confirmDelete = true;
        btn.lastChild.textContent = from ? `Click again: ${from} won't add it back` : 'Click again to delete';
        setTimeout(() => { this._confirmDelete = false; if (btn.isConnected) btn.lastChild.textContent = label; }, 3000);
        return;
      }
      if (members.length > 1) {
        for (const m of members) if (this.items.get(m.id)) this.attachments.forget(this.tree.removeTree(m.id));
        return;
      }
      this.attachments.forget(this.tree.removeTree(this.id));
    });
    return btn;
  }
}
