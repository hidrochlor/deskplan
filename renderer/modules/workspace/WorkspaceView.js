import { Component } from '../../core/Component.js';
import { h, clear } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { formatCountdown, formatDate, formatDateTime, urgency } from '../../core/dates.js';
import { Item } from './Item.js';
import { repeatText, seriesOf } from './Repeats.js';
import { ItemTree } from './ItemTree.js';
import { NotePage } from './NotePage.js';
import { AddMenu } from './AddMenu.js';
import { formatSize } from './Attachments.js';

function byDeadline(a, b) {
  const da = a.deadlineDate ? a.deadlineDate.getTime() : null;
  const db = b.deadlineDate ? b.deadlineDate.getTime() : null;
  if (da !== null && db !== null && da !== db) return da - db;
  if (da !== null && db === null) return -1;
  if (da === null && db !== null) return 1;
  return b.createdAt.localeCompare(a.createdAt);
}

const byRecent = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
const byCompleted = (a, b) => (b.completedAt || '').localeCompare(a.completedAt || '');

/** Split into [not done, soonest deadline first] and [done, most recently finished first]. */
function splitDone(list) {
  return [list.filter((i) => !i.isDone).sort(byDeadline), list.filter((i) => i.isDone).sort(byCompleted)];
}

// The Home canvas. Top level: your folders. Open a folder to see and add what's inside:
// sub-folders, assignments / tasks / readings, notes, and files or photos.
// Opening a note shows it full size for writing.
export class WorkspaceView extends Component {
  /** @param {import('./Attachments.js').Attachments} attachments */
  constructor(ctx, attachments) {
    super(ctx);
    this.attachments = attachments;
    this.tree = new ItemTree(this.items);
    this.notePage = null;
    const saved = this.store.meta.ui?.open ?? null;
    this.openId = saved && this.items.get(saved) ? saved : null;
  }

  get items() { return this.store.collection('items'); }
  /** The folder or note being shown, or null at the top level. */
  get current() { return this.openId ? this.items.get(this.openId) : null; }
  /** The folder new things go into. */
  get folderId() {
    const cur = this.current;
    return cur && cur.isNote ? this.tree.parentOf(cur) : this.openId;
  }

  build() {
    this.crumbsEl = h('div', { class: 'crumbs' });
    this.boardEl = h('div', { class: 'board' });
    this.addHost = h('div');
    return h('section', { class: 'view workspace' },
      h('header', { class: 'view-head' }, this.crumbsEl),
      this.boardEl,
      this.addHost);
  }

  onMount() {
    this.addMenu = new AddMenu(this.ctx, {
      where: () => this.items.get(this.folderId)?.title || 'Home',
      onCreate: (o) => this.create(o),
      onFiles: this.attachments.available ? () => this.addFiles() : null,
      adapt: (option) => this.adaptAddOption(option),
    }).mount(this.addHost);
    this._cleanups.push(() => this.addMenu.unmount());

    this.on('data:changed', (e) => { if (e.collection === 'items') this.render(); });
    this.on('display:changed', () => { if (!this.current?.isNote) this.render(); }); // 12/24-hour clock
    // Only move the highlight (no redraw), so a double-click lands on the same element twice.
    this.on('selection:changed', () => this.markSelection());
    this.on('new', () => {
      if (this.current?.isNote) this.open(this.folderId);
      this.addMenu.open();
    });
    this.on('workspace:open', ({ id }) => this.open(id ?? null));

    // One click handler for every card, row and tile on the board.
    // The second click of a double-click opens whatever the FIRST click hit, even if the
    // side panel sliding in moved things in between.
    this.lastClick = null;
    this.listen(this.boardEl, 'click', (e) => {
      if (e.detail >= 2) {
        const last = this.lastClick;
        if (last && Date.now() - last.at < 600) this.activate(last.id);
        return;
      }
      const el = e.target.closest('[data-id]');
      this.lastClick = el ? { id: el.dataset.id, at: Date.now() } : null;
      if (el) this.ctx.selection.select('item', el.dataset.id);
    });
    this.every(60000, () => this.render());
    this.listenForMoves();

    // Drop files from Explorer onto the canvas to add them to the current folder.
    if (this.attachments.available) {
      this.listen(this.boardEl, 'dragover', (e) => {
        if (![...(e.dataTransfer?.types ?? [])].includes('Files') || this.current?.isNote) return;
        e.preventDefault();
        this.boardEl.classList.add('dropping');
      });
      this.listen(this.boardEl, 'dragleave', (e) => {
        if (!this.boardEl.contains(e.relatedTarget)) this.boardEl.classList.remove('dropping');
      });
      this.listen(this.boardEl, 'drop', (e) => {
        this.boardEl.classList.remove('dropping');
        if (this.current?.isNote || this.dragId) return; // dragId: an item being moved, not a file from Explorer
        e.preventDefault();
        this.attachments.addTo(this.items, this.folderId, this.attachments.pathsFromDrop(e.dataTransfer));
      });
    }
  }

  onUnmount() {
    this.notePage?.unmount();
    this.notePage = null;
  }

  /** Show a folder or note (null = top level). */
  open(id, { select = false } = {}) {
    this.openId = id && this.items.get(id) ? id : null;
    this.store.meta.ui = { ...(this.store.meta.ui ?? {}), open: this.openId };
    this.store.touchMeta();
    if (select && this.openId) this.ctx.selection.select('item', this.openId);
    this.render();
  }

  /**
   * Drag any card, row or tile onto a folder card, or onto Home / a parent folder in the breadcrumbs,
   * to move it there. Valid targets light up while dragging; invalid ones (itself, its own contents,
   * where it already is) do nothing.
   */
  listenForMoves() {
    this.dragId = null;
    const targetOf = (e) => {
      const el = e.target.closest?.('[data-drop]');
      return el && this.dragId && this.tree.canMove(this.dragId, el.dataset.drop || null) ? el : null;
    };

    this.listen(this.el, 'dragstart', (e) => {
      const el = e.target.closest?.('[data-id]');
      if (!el || !this.boardEl.contains(el)) return;
      this.dragId = el.dataset.id;
      e.dataTransfer.setData('application/x-deskplan-item', this.dragId);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    this.listen(this.el, 'dragover', (e) => {
      if (!this.dragId) return;
      const target = targetOf(e);
      this.clearDropMarks(target);
      if (!target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      target.classList.add('drop-ok');
    });
    this.listen(this.el, 'dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget)) this.clearDropMarks();
    });
    this.listen(this.el, 'drop', (e) => {
      const target = targetOf(e);
      if (!target) return;
      e.preventDefault();
      const id = this.dragId;
      this.endDrag();
      this.tree.move(id, target.dataset.drop || null);
    });
    this.listen(this.el, 'dragend', () => this.endDrag());
  }

  clearDropMarks(except = null) {
    for (const el of this.el.querySelectorAll('.drop-ok')) if (el !== except) el.classList.remove('drop-ok');
  }

  endDrag() {
    this.dragId = null;
    this.clearDropMarks();
    for (const el of this.el.querySelectorAll('.dragging')) el.classList.remove('dragging');
  }

  /** Double-click: folders and notes open in the canvas, files open in their own app. */
  activate(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.isFile) this.attachments.open(item);
    else if (this.tree.isFolder(item) || item.isNote) this.open(item.id);
  }

  /** What the + menu offers here: no Assignment at the top level of Home, and a task inside an assignment is a Step. */
  adaptAddOption(option) {
    if (!option.kind) return option;
    const parent = this.items.get(this.folderId);
    if (!this.tree.rules.holds(parent?.kind ?? null, option.kind)) return null;
    return option.kind === 'task' && parent?.kind === 'assignment'
      ? { ...option, label: 'Step', hint: 'One part of this assignment' }
      : option;
  }

  /** Called by the + menu. New things go into the folder on screen. */
  create({ kind, title, deadline, start = null }) {
    if (this.tree.rules.problem({ kind, parentId: this.folderId ?? null, deadline, start, creating: true })) return; // the menu never offers this
    const item = this.items.add({ title, kind, parentId: this.folderId, deadline, start });
    if (item.isNote) {
      this.open(item.id, { select: true }); // straight into writing
      this.notePage?.focus();
    } else {
      this.ctx.selection.select('item', item.id);
    }
  }

  async addFiles() {
    const paths = await this.attachments.pick();
    await this.attachments.addTo(this.items, this.folderId, paths);
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  render() {
    if (this.openId && !this.current) this.openId = null; // it was deleted
    this.renderCrumbs();
    const cur = this.current;
    const writing = !!cur?.isNote;
    this.addHost.hidden = writing; // the + button stays out of the way while writing

    if (writing) {
      // Keep the open editor as is while typing; only swap it when another note opens.
      if (this.notePage?.id === cur.id) return;
      this.notePage?.unmount();
      clear(this.boardEl);
      this.notePage = new NotePage(this.ctx, cur.id).mount(this.boardEl);
      return;
    }
    this.notePage?.unmount();
    this.notePage = null;
    this.renderFolder();
  }

  renderCrumbs() {
    clear(this.crumbsEl);
    const cur = this.current;
    if (!cur) { this.crumbsEl.appendChild(h('h1', { class: 'crumb-current' }, icon('home', 15), 'Home')); return; }

    const sep = () => h('span', { class: 'crumb-sep' }, icon('chevRight', 13));
    this.crumbsEl.append(
      h('button', { class: 'icon-btn crumb-back', title: 'Back', 'data-drop': this.tree.parentOf(cur) ?? '', onClick: () => this.open(this.tree.parentOf(cur)) }, icon('chevLeft', 15)),
      h('button', { class: 'crumb', 'data-drop': '', onClick: () => this.open(null) }, 'Home'));
    for (const f of this.tree.path(cur.id)) {
      this.crumbsEl.append(sep(), h('button', { class: 'crumb', 'data-drop': f.id, onClick: () => this.open(f.id) }, f.title || 'Untitled'));
    }
    this.crumbsEl.append(sep(),
      h('h1', { class: 'crumb-current' }, icon(cur.isNote ? 'notes' : cur.kind === 'assignment' ? 'assignment' : 'folder', 15), h('span', { class: 'crumb-text' }, cur.title || 'Untitled')));
  }

  markSelection() {
    for (const el of this.boardEl.querySelectorAll('[data-id]')) {
      el.classList.toggle('selected', this.ctx.selection.is('item', el.dataset.id));
    }
  }

  /** Whether the finished part of To do lists is folded away. Remembered between sessions. */
  get doneFolded() { return !!this.store.meta.ui?.doneFolded; }
  set doneFolded(value) {
    this.store.meta.ui = { ...(this.store.meta.ui ?? {}), doneFolded: value };
    this.store.touchMeta();
  }

  renderFolder() {
    clear(this.boardEl);
    const children = this.tree.children(this.openId);
    // An assignment holds its steps but is still drawn as a row, not as a folder card.
    const isFolder = (i) => this.tree.isFolder(i) && i.kind !== 'assignment';
    // Everything stays on screen. Finished things sink to the end of their section, dimmed.
    const folders = splitDone(children.filter(isFolder)).flat();
    // A repeating task shows once, as its latest copy, under Repeating; its other copies stay out of To do and Done
    // (the side panel shows them all as its timeline).
    const series = seriesOf(children.filter((i) => i.kind === 'task' && !isFolder(i)));
    const inSeries = new Set(series.flatMap((s) => s.members.map((m) => m.id)));
    const [todo, done] = splitDone(children.filter((i) => !isFolder(i) && i.isActionable && !inSeries.has(i.id)));
    const notes = children.filter((i) => !isFolder(i) && i.isNote).sort(byRecent);
    const files = children.filter((i) => !isFolder(i) && i.isFile).sort(byRecent);
    const todoLabel = this.current?.kind === 'assignment' ? 'Steps' : 'To do';

    if (!children.length) {
      this.boardEl.appendChild(this.emptyState());
      return;
    }
    const section = (label, count, ...body) => h('section', { class: 'section' },
      h('div', { class: 'section-label' }, label, h('span', { class: 'section-count' }, String(count))), body);

    // Folders first (they are what Home is made of), then what needs doing, then reference material.
    if (folders.length) this.boardEl.appendChild(section('Folders', folders.length, h('div', { class: 'cards' }, folders.map((f) => this.folderCard(f)))));
    if (todo.length || done.length) {
      this.boardEl.appendChild(section(todoLabel, todo.length,
        todo.length ? h('div', { class: 'list' }, todo.map((i) => this.row(i))) : h('div', { class: 'all-done' }, icon('check', 14), 'All done here'),
        done.length ? this.doneGroup(done) : null));
    }
    if (series.length) {
      this.boardEl.appendChild(section('Repeating', series.length,
        h('div', { class: 'list' }, series.map((s) => this.seriesRow(s)))));
    }
    if (notes.length) this.boardEl.appendChild(section('Notes', notes.length, h('div', { class: 'cards' }, notes.map((n) => this.noteCard(n)))));
    if (files.length) this.boardEl.appendChild(section('Files', files.length, h('div', { class: 'tiles' }, files.map((f) => this.fileTile(f)))));
  }

  /** Finished items under the open ones, with a fold toggle. Unticking moves one straight back up. */
  doneGroup(done) {
    const folded = this.doneFolded;
    return h('div', { class: 'done-group' },
      h('button', {
        class: 'done-toggle', type: 'button', 'aria-expanded': String(!folded),
        onClick: () => { this.doneFolded = !folded; this.render(); },
      }, icon(folded ? 'chevRight' : 'chevDown', 14), `Done · ${done.length}`),
      folded ? null : h('div', { class: 'list' }, done.map((i) => this.row(i))));
  }

  emptyState() {
    if (!this.openId) {
      return h('div', { class: 'empty hero' },
        icon('folder', 40),
        h('div', { class: 'hero-title' }, 'Your canvas is empty'),
        h('div', {}, 'Press + at the bottom right to create a folder, for example "CSC101".'));
    }
    if (this.current?.kind === 'assignment') {
      return h('div', { class: 'empty hero' },
        icon('assignment', 40),
        h('div', { class: 'hero-title' }, 'No steps yet'),
        h('div', {}, 'Press + to break this assignment into steps, or add notes and files.'));
    }
    return h('div', { class: 'empty hero' },
      icon('folder', 40),
      h('div', { class: 'hero-title' }, 'This folder is empty'),
      h('div', {}, 'Press + to add notes, tasks and assignments, or drop files and photos here.'));
  }

  /** Deadline with a countdown. Once finished, only the date: a countdown ("overdue 14d") would be noise. */
  dueLabel(item, prefix = '') {
    const date = item.deadlineDate;
    if (!date) return null;
    const when = item.isDone ? formatDateTime(date) : `${formatDateTime(date)} · ${formatCountdown(date.getTime())}`;
    return h('span', { class: `due ${item.isDone ? 'muted' : urgency(date.getTime())}` },
      icon('clock', 12),
      h('span', { class: 'due-text' }, `${prefix}${when}`));
  }

  selectedClass(item) {
    return this.ctx.selection.is('item', item.id) ? ' selected' : '';
  }

  folderCard(folder) {
    const s = this.tree.summary(folder.id);
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
    const next = s.next;
    const nextLabel = next && next.id !== folder.id ? `${next.title || 'Untitled'} · ` : '';
    const meta = !s.items ? 'Empty' : s.total ? `${s.open} to do · ${s.done} done` : `${s.items} item${s.items === 1 ? '' : 's'}`;

    return h('div', {
      class: `card${this.selectedClass(folder)}${folder.isDone ? ' done' : ''}`,
      'data-id': folder.id, 'data-keep-panel': true, draggable: 'true', 'data-drop': folder.id,
      style: { '--c': folder.kindInfo.color },
      title: 'Double-click to open',
    },
    h('div', { class: 'card-top' }, icon('folder', 18),
      folder.kind !== 'folder' ? h('span', { class: 'chip' }, folder.kindInfo.label) : null), // "Folder" would only repeat the heading
    h('div', { class: 'card-title' }, folder.title || 'Untitled'),
    h('div', { class: 'card-meta' }, meta),
    s.total ? h('div', { class: 'bar' }, h('span', { style: { width: `${pct}%` } })) : null,
    next ? this.dueLabel(next, nextLabel) : null);
  }

  noteCard(note) {
    return h('div', {
      class: `card note-card${this.selectedClass(note)}`,
      'data-id': note.id, 'data-keep-panel': true, draggable: 'true',
      style: { '--c': note.kindInfo.color },
      title: 'Double-click to open',
    },
    h('div', { class: 'card-top' }, icon('notes', 16), h('span', { class: 'muted small' }, formatDate(new Date(note.updatedAt)))),
    h('div', { class: 'card-title' }, note.title || 'Untitled'),
    h('div', { class: 'note-preview' }, note.preview || 'Empty note'),
    this.checklistBar(note.checklist),
    this.dueLabel(note));
  }

  /** "3 / 7 done" with a bar, for notes that contain a checklist. */
  checklistBar({ done, total }) {
    if (!total) return null;
    return h('div', { class: 'note-checklist' },
      h('div', { class: 'card-meta' }, icon('checklist', 13), `${done} / ${total} done`),
      h('div', { class: 'bar' }, h('span', { style: { width: `${Math.round((done / total) * 100)}%` } })));
  }

  fileTile(file) {
    const url = file.isImage ? this.attachments.url(file) : null;
    return h('div', {
      class: `tile${this.selectedClass(file)}`,
      'data-id': file.id, 'data-keep-panel': true, draggable: 'true',
      title: `${file.file?.name ?? file.title}\nDouble-click to open`,
    },
    url
      ? h('div', { class: 'tile-thumb' }, h('img', { src: url, alt: '', loading: 'lazy', draggable: 'false' }))
      : h('div', { class: 'tile-thumb ext' }, (file.file?.ext || 'file').toUpperCase().slice(0, 4)),
    h('div', { class: 'tile-name' }, file.title || file.file?.name || 'File'),
    h('div', { class: 'tile-meta' }, formatSize(file.file?.size)));
  }

  row(item) {
    const assignment = item.kind === 'assignment';
    const step = this.tree.rules.isStep(item);
    return h('div', {
      class: `row${this.selectedClass(item)}${item.isDone ? ' done' : ''}${assignment ? ' assignment' : ''}`,
      'data-id': item.id, 'data-keep-panel': true, draggable: 'true',
      ...(assignment ? { 'data-drop': item.id } : {}), // drop a task on an assignment to make it a step
    },
    // A task has the round tick. An assignment is finished by submitting it, so it shows its steps' progress instead.
    assignment ? this.progressPill(item) : h('button', {
      class: 'check', title: item.isDone ? 'Mark as to do' : 'Mark as done',
      onClick: (e) => { e.stopPropagation(); this.items.update(item.id, Item.statusPatch(item.isDone ? 'todo' : 'done')); },
    }, item.isDone ? icon('check', 14) : null),
    h('div', { class: 'row-title' }, item.title || 'Untitled'),
    this.detailsHint(item),
    this.repeatHint(item),
    assignment && this.tree.needsCourse(item, this.store.meta.unsortedId)
      ? h('span', { class: 'chip', style: { '--c': 'var(--warn)' }, 'data-tip': 'Move it into a course folder', 'data-tip-title': 'Needs a course' }, 'Needs a course')
      : null,
    h('span', { class: 'chip', style: { '--c': item.kindInfo.color } }, step ? 'Step' : item.kindInfo.label),
    this.dueLabel(item) ?? h('span', { class: 'due' }), // an empty slot keeps the tags of every row in one column
    assignment ? this.submitButton(item) : null);
  }

  /** One repeating task: its latest copy's row (tick, title, next due time), or "Ended" once nothing more comes. */
  seriesRow(series) {
    const row = this.row(series.latest);
    if (series.ended()) {
      row.classList.add('done');
      row.querySelector('.check')?.remove();
      row.querySelector('.due')?.replaceWith(h('span', { class: 'due muted' }, 'Ended'));
    }
    return row;
  }

  /** "2 / 5" in the place of the tick: finished steps out of all steps of an assignment. */
  progressPill(item) {
    const { done, total } = this.tree.progress(item.id);
    return h('span', {
      class: `progress-pill${total && done === total ? ' complete' : ''}`,
      'data-tip': total ? `${done} of ${total} step${total === 1 ? '' : 's'} done` : 'Open it to add steps',
      'data-tip-title': 'Progress',
    }, total ? `${done} / ${total}` : '0 steps');
  }

  /** The assignment's own finish line: submitting it marks it done (the phone sees that as done). Click again to undo. */
  submitButton(item) {
    return h('button', {
      class: `btn btn-small submit-btn${item.isDone ? ' submitted' : ''}`, type: 'button',
      onClick: (e) => { e.stopPropagation(); this.items.update(item.id, Item.statusPatch(item.isDone ? 'todo' : 'done')); },
    }, item.isDone ? [icon('check', 13), 'Submitted'] : 'Mark submitted');
  }

  /** A small icon on rows that repeat; hovering says how often. */
  repeatHint(item) {
    if (!item.repeat) return null;
    return h('span', {
      class: 'row-details', 'data-tip': repeatText(item.repeat), 'data-tip-title': 'Repeats', 'aria-label': 'Repeats',
    }, icon('repeat', 13));
  }

  /** A small icon on rows that have something in Details; hovering shows a short preview. */
  detailsHint(item) {
    const text = item.description.trim();
    if (!text) return null;
    let preview = text.split('\n').filter((l) => l.trim()).slice(0, 3).join('\n');
    if (preview.length > 140) preview = preview.slice(0, 140).trimEnd();
    if (preview.length < text.length) preview += ' …';
    return h('span', {
      class: 'row-details', 'data-tip': preview, 'data-tip-title': 'Details', 'aria-label': 'Has details',
    }, icon('notes', 13));
  }
}
