import { Component } from '../../core/Component.js';
import { h } from '../../core/dom.js';
import { fromPlainText, toPlainText } from './editor/NoteFormat.js';
import { NoteVersions } from './NoteVersions.js';

// The writing area for a note item, shown in the canvas when the note is opened.
// The rich editor is loaded only now (not at app start), so it costs nothing until a note opens.
// Saves as you type: the formatted note into item.doc, and readable plain text into
// item.description (used for previews and word counts, and as a fallback).
export class NotePage extends Component {
  constructor(ctx, id) {
    super(ctx);
    this.id = id;
    this.editor = null;
    this._wantsFocus = false;
  }

  get items() { return this.store.collection('items'); }

  build() {
    const note = this.items.get(this.id);
    this.titleInput = h('input', {
      class: 'note-title', placeholder: 'Untitled', 'aria-label': 'Note title', value: note?.title ?? '',
      onInput: (e) => this.items.update(this.id, { title: e.target.value }),
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.editor?.focus(); } },
    });
    this.editorHost = h('div', { class: 'note-editor' });
    return h('div', { class: 'note-pane' }, this.titleInput, this.editorHost);
  }

  onMount() {
    this.versions = new NoteVersions(this.items, this.id);
    this.on('data:changed', (e) => {
      if (e.collection !== 'items' || e.id !== this.id) return;
      const note = this.items.get(this.id);
      if (!note) return;
      // Title renamed from the side panel or the phone: show it here too (but never while typing here).
      if (document.activeElement !== this.titleInput && this.titleInput.value !== note.title) this.titleInput.value = note.title;
      if (this.editor) this.takeOutsideChange(note);
    });

    import('./editor/RichEditor.js')
      .then(({ RichEditor }) => {
        const note = this.items.get(this.id);
        if (!this.el || !note) return; // closed before it finished loading
        this.editor = new RichEditor(this.ctx, {
          doc: note.doc ?? fromPlainText(note.description),
          onChange: (doc, { silent } = {}) => this.save(doc, silent),
        }).mount(this.editorHost);
        if (this._wantsFocus) this.editor.focus();
      })
      .catch((err) => {
        console.error('[note] rich editor failed to load, using plain text', err);
        this.plainFallback();
      });
  }

  onUnmount() {
    this.editor?.unmount();
    this.editor = null;
    this.bus.emit('toast:dismiss', { id: this.toastId }); // the copy, if any, is already saved
  }

  /** The text changed on the phone while this page is open (see NoteVersions). */
  takeOutsideChange(note) {
    const what = this.versions.changed(this.editor.isDirty);
    if (what === 'reload') this.editor.load(note.doc ?? fromPlainText(note.description));
    if (what !== 'conflict') return;
    this.bus.emit('toast:show', {
      id: this.toastId, title: 'This note changed on your phone',
      text: 'What you type here is saved as a separate "(PC copy)" note until you reload.',
      actions: [{ label: 'Reload', primary: true, onClick: () => this.reload() }],
    });
  }

  /** Show the phone's text; from now on typing saves into this note again. */
  reload() {
    this.bus.emit('toast:dismiss', { id: this.toastId });
    const doc = this.versions.reload();
    const note = this.items.get(this.id);
    if (note && this.editor) this.editor.load(doc ?? fromPlainText(note.description));
  }

  get toastId() { return `note-changed-${this.id}`; }

  save(doc, silent) {
    const patch = { doc, description: toPlainText(doc) };
    const id = this.versions.target(doc); // this note, or its PC copy while a phone change waits
    if (id !== this.id) { this.items.update(id, patch); return; }
    if (!silent) { this.items.update(this.id, patch); return; }
    // While the page is closing: write without announcing it, so nothing redraws mid-teardown.
    const note = this.items.get(this.id);
    if (!note) return;
    Object.assign(note, patch, { updatedAt: new Date().toISOString() });
    this.store.scheduleSave();
  }

  /** The old plain text box, if the editor can't load for any reason. */
  plainFallback() {
    if (!this.el) return;
    const note = this.items.get(this.id);
    this.editorHost.replaceChildren(h('textarea', {
      class: 'note-body', placeholder: 'Start writing…', 'aria-label': 'Note text', value: note?.description ?? '',
      onInput: (e) => this.items.update(this.id, { description: e.target.value, doc: null }),
    }));
  }

  focus() {
    if (!this.titleInput.value) { this.titleInput.focus(); return; }
    if (this.editor) this.editor.focus();
    else this._wantsFocus = true;
  }
}
