import { Component } from '../../core/Component.js';
import { h, clear } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { formatDateTime } from '../../core/dates.js';
import { deleteReceived } from './deleteReceived.js';

// Right panel for one received file: what it is, where it came from, open it, delete it.
export class ReceivedFileEditor extends Component {
  /** @param {object|null} api  window.api.receiver, or null in a plain browser */
  constructor(ctx, id, api) {
    super(ctx);
    this.id = id;
    this.api = api;
    this._confirmDelete = false;
  }

  get items() { return this.store.collection('receivedFiles'); }
  get item() { return this.items.get(this.id); }

  build() { return h('div', { class: 'editor' }); }

  onMount() {
    this.on('data:changed', (e) => { if (e.collection === 'receivedFiles' && e.id === this.id && e.type !== 'remove') this.render(); });
  }

  render() {
    const item = this.item;
    clear(this.el);
    if (!item) { this.el.append(h('div', { class: 'empty' }, 'This file is no longer in Received files.')); return; }
    this.bus.emit('panel:title', { text: 'Received file', color: 'var(--accent)' });

    const when = item.receivedDate;
    this.el.append(...[
      h('div', { class: 'field' },
        h('label', { class: 'field-label' }, 'File name'),
        h('div', { class: 'received-name' }, item.fileName)),
      h('div', { class: 'facts' },
        this.stat('Size', item.sizeLabel),
        this.stat('From', item.deviceName || 'A phone'),
        this.stat('Received', when ? formatDateTime(when) : '—'),
        item.storedAs !== item.fileName ? this.stat('Saved as', item.storedAs) : null,
        this.stat('Checksum', item.sha256 ? `${item.sha256.slice(0, 12)}…` : '—', item.sha256)),
      this.api ? h('div', { class: 'quick-row' },
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.api.openFile(item.storedAs) }, icon('open', 14), 'Open'),
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.api.revealFile(item.storedAs) }, icon('folder', 14), 'Show in Explorer')) : null,
      h('footer', { class: 'editor-foot' }, h('span', { class: 'muted' }, 'Stored on this PC only'), this.deleteButton()),
    ].filter(Boolean)); // (Element.append would print a null as the text "null")
  }

  stat(label, value, title = null) {
    return h('div', { class: 'stat' }, h('span', { class: 'muted' }, label), h('span', { title }, value));
  }

  /** Two clicks to delete: removes the entry and the stored file. */
  deleteButton() {
    const btn = h('button', { class: 'btn btn-danger', type: 'button' }, icon('trash', 15), 'Delete');
    btn.addEventListener('click', async () => {
      if (!this._confirmDelete) {
        this._confirmDelete = true;
        btn.lastChild.textContent = 'Click again to delete';
        setTimeout(() => { this._confirmDelete = false; if (btn.isConnected) btn.lastChild.textContent = 'Delete'; }, 3000);
        return;
      }
      const { failed } = await deleteReceived({ items: this.items, api: this.api }, [this.id]);
      if (failed.length) btn.lastChild.textContent = 'Could not delete';
    });
    return btn;
  }
}
