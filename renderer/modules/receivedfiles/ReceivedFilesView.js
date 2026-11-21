import { Component } from '../../core/Component.js';
import { h, clear } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { formatDateTime } from '../../core/dates.js';
import { deleteReceived } from './deleteReceived.js';

// The Received files page: every file received from a phone, newest first. Click one for its details on the right.
// Tick the boxes to delete several at once (two clicks, like every delete).
export class ReceivedFilesView extends Component {
  /** @param {import('./PhoneLink.js').PhoneLink} link @param {object|null} api */
  constructor(ctx, link, api) {
    super(ctx);
    this.link = link;
    this.api = api;
    this.checked = new Set(); // ids ticked for deleting
    this._confirmDelete = false;
    this._failed = 0;          // how many could not be deleted last time
  }

  get items() { return this.store.collection('receivedFiles'); }

  build() {
    this.countEl = h('span', { class: 'section-count' });
    this.actionsEl = h('div', { class: 'received-actions' });
    this.listEl = h('div', { class: 'received-list' });
    return h('section', { class: 'view received-files' },
      h('header', { class: 'view-head' }, h('h1', {}, 'Received files ', this.countEl), this.actionsEl),
      this.listEl);
  }

  onMount() {
    this.on('data:changed', (e) => { if (e.collection === 'receivedFiles') this.render(); });
    this.on('selection:changed', () => this.render());
    this.on('phones:changed', () => this.render());
  }

  render() {
    const items = this.items.all().sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    for (const id of this.checked) if (!this.items.get(id)) this.checked.delete(id); // deleted elsewhere
    this.countEl.textContent = items.length ? String(items.length) : '';
    this.renderActions(items);
    clear(this.listEl);
    if (!items.length) { this.listEl.append(this.empty()); return; }
    this.listEl.append(...items.map((item) => this.row(item)));
  }

  /** Open folder, or, with files ticked: how many, Select all, Clear and Delete. */
  renderActions(items) {
    clear(this.actionsEl);
    const n = this.checked.size;
    if (!n) {
      if (this.api) this.actionsEl.append(h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.api.openFolder() }, icon('folder', 14), 'Open folder'));
      return;
    }
    const all = n === items.length;
    this.actionsEl.append(...[
      h('span', { class: 'muted received-picked' }, this._failed ? `${this._failed} could not be deleted` : `${n} selected`),
      all ? null : h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.pick(items.map((i) => i.id)) }, 'Select all'),
      h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.pick([]) }, 'Clear'),
      this.deleteButton(n),
    ].filter(Boolean));
  }

  pick(ids) {
    this.checked = new Set(ids);
    this._confirmDelete = false;
    this._failed = 0;
    this.render();
  }

  toggle(id) {
    if (this.checked.has(id)) this.checked.delete(id); else this.checked.add(id);
    this._confirmDelete = false;
    this._failed = 0;
    this.render();
  }

  /** Two clicks to delete the ticked files: removes the entries and the stored files. */
  deleteButton(n) {
    const label = () => (this._confirmDelete ? `Click again to delete ${n}` : `Delete ${n}`);
    const btn = h('button', { class: 'btn btn-small btn-danger', type: 'button' }, icon('trash', 14), label());
    btn.addEventListener('click', async () => {
      if (!this._confirmDelete) {
        this._confirmDelete = true;
        btn.lastChild.textContent = label();
        setTimeout(() => { this._confirmDelete = false; if (btn.isConnected) btn.lastChild.textContent = label(); }, 3000);
        return;
      }
      this._confirmDelete = false;
      btn.disabled = true;
      const ids = [...this.checked];
      const { failed } = await deleteReceived({ items: this.items, api: this.api }, ids);
      this.checked = new Set(failed); // what could not be deleted stays ticked, so it can be tried again
      this._failed = failed.length;
      this.render();
    });
    return btn;
  }

  row(item) {
    const when = item.receivedDate;
    const ticked = this.checked.has(item.id);
    return h('div', {
      class: `row received-row${this.ctx.selection.is('receivedFile', item.id) ? ' selected' : ''}${ticked ? ' ticked' : ''}`, 'data-keep-panel': true,
      onClick: () => this.ctx.selection.select('receivedFile', item.id),
      onDblclick: () => this.api?.openFile(item.storedAs),
    },
    h('input', {
      type: 'checkbox', class: 'received-tick', checked: ticked, 'aria-label': `Select ${item.fileName}`,
      onClick: (e) => { e.stopPropagation(); this.toggle(item.id); },
      onDblclick: (e) => e.stopPropagation(),
    }),
    icon('paperclip', 16),
    h('div', { class: 'row-title', title: item.fileName }, item.fileName || 'Untitled'),
    h('span', { class: 'received-meta' }, [item.sizeLabel, item.deviceName].filter(Boolean).join(' · ')),
    h('span', { class: 'due' }, when ? formatDateTime(when) : ''),
    this.api ? h('button', {
      class: 'icon-btn', type: 'button', title: 'Open', 'aria-label': `Open ${item.fileName}`,
      onClick: (e) => { e.stopPropagation(); this.api.openFile(item.storedAs); },
    }, icon('open', 15)) : null);
  }

  empty() {
    const on = this.link.status?.enabled;
    return h('div', { class: 'empty' },
      h('div', {}, 'Nothing here yet.'),
      h('div', { class: 'muted received-empty-hint' },
        on ? 'Share a file from the DeskPlan Companion app on your phone and it will appear here.'
          : 'Receiving from phones is off. Turn it on to pair a phone and receive files.'),
      this.link.available && !on
        ? h('button', {
          class: 'btn btn-small', type: 'button',
          onClick: () => this.bus.emit('settings:open', { section: 'phones' }),
        }, icon('phone', 14), 'Set up a phone')
        : null);
  }
}
