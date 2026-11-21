import { Component } from '../../../core/Component.js';
import { h } from '../../../core/dom.js';
import { icon } from '../../../core/icons.js';
import { LineTools } from './LineTools.js';
import {
  MAX_INDENT, fromBlocks, toBlocks, fromPlainText, toPlainText, mergeRuns, inlineText,
} from './NoteFormat.js';

// The note editor. Loaded only when a note is opened (see NotePage).
//
// One contenteditable area; every line is a <div class="blk"> that carries its type
// (paragraph, heading1, heading2, bullet, task), its indent and its tick. Bullets and
// checkboxes are drawn by CSS, so the line holds nothing but text and the browser's own
// typing, selection, copy and undo do the heavy lifting. We only step in for:
//   Enter / Backspace at list edges, Tab indenting, ticking, markdown shortcuts, paste.
//
// Interface used by NotePage (a Tiptap-based editor could offer the same):
//   new RichEditor(ctx, { doc, onChange(doc, { silent }) }).mount(el); .focus(); .flush(); .load(doc); .isDirty; .unmount()

const TEXT_TYPES = ['paragraph', 'heading1', 'heading2', 'bullet', 'task'];
const isList = (type) => type === 'bullet' || type === 'task';
const isHeading = (type) => type === 'heading1' || type === 'heading2';
const SAVE_DELAY = 350;

export class RichEditor extends Component {
  constructor(ctx, { doc, onChange }) {
    super(ctx);
    this.doc = doc;
    this.onChange = onChange;
    this._timer = null;
    this._dirty = false;
    this._rendered = false;
  }

  build() {
    this.root = h('div', {
      class: 'rich', contenteditable: 'true', spellcheck: 'true',
      role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Note text',
    });
    this.bar = new SelectionBar(this);
    this.tools = new LineTools(this);
    return h('div', { class: 'rich-host' }, this.root, this.bar.el, ...this.tools.elements);
  }

  onMount() {
    document.execCommand('styleWithCSS', false, false); // bold = <b>, not <span style>
    this.listen(this.root, 'keydown', (e) => this.onKeydown(e));
    this.listen(this.root, 'input', (e) => this.onInput(e));
    this.listen(this.root, 'paste', (e) => this.onPaste(e));
    this.listen(this.root, 'mousedown', (e) => this.onMousedown(e));
    this.listen(this.root, 'blur', () => this.flush());
    this.on('app:before-quit', () => this.flush({ silent: true }));
    this.bar.attach();
    this.tools.attach();
    // Links: a normal click edits the text; Ctrl+click opens the link in the browser.
    this.listen(this.root, 'click', (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const url = safeLink(a.getAttribute('href'));
      if (url) window.api?.app?.openLink?.(url);
    });
    this.listen(this.root, 'mouseover', (e) => {
      const a = e.target.closest?.('a[href]');
      if (a && !a.title) a.title = `${a.getAttribute('href')}\nCtrl+click to open`;
    });
  }

  onUnmount() { this.flush({ silent: true }); }

  render() {
    if (this._rendered) return; // the DOM is the live document after the first draw
    this._rendered = true;
    this.root.replaceChildren(...toBlocks(this.doc).map((b) => this.blockEl(b)));
    this.refreshEmpty();
  }

  focus() {
    this.root.focus();
    const last = this.root.lastElementChild;
    if (last) placeCaret(last, last.childNodes.length);
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  getDoc() { return fromBlocks(this.readBlocks()); }

  /** Typing that has not been saved yet. */
  get isDirty() { return this._dirty; }

  /** Show another version of the note (it changed elsewhere, on the phone). Unsaved typing is dropped: the caller decides when. */
  load(doc) {
    clearTimeout(this._timer);
    this._dirty = false;
    this.doc = doc;
    if (!this.root) return;
    this.root.replaceChildren(...toBlocks(doc).map((b) => this.blockEl(b)));
    this.refreshEmpty();
  }

  changed() {
    this.refreshEmpty();
    this._dirty = true;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), SAVE_DELAY);
  }

  /** Save now if anything changed. silent = while closing: don't trigger redraws. */
  flush({ silent = false } = {}) {
    clearTimeout(this._timer);
    if (!this._dirty || !this.root) return;
    this._dirty = false;
    this.onChange(this.getDoc(), { silent });
  }

  readBlocks() {
    return [...this.root.children].map((el) => (el._raw
      ? { type: 'raw', node: el._raw }
      : {
        type: TEXT_TYPES.includes(el.dataset.type) ? el.dataset.type : 'paragraph',
        indent: Number(el.dataset.indent) || 0,
        checked: el.dataset.checked === 'true',
        inline: readInline(el),
      }));
  }

  refreshEmpty() {
    const only = this.root.children.length === 1 ? this.root.firstElementChild : null;
    this.root.classList.toggle('is-empty', !!only && only.dataset.type === 'paragraph' && !only.textContent);
  }

  // ── Lines ─────────────────────────────────────────────────────────────────

  blockEl(b) {
    if (b.type === 'raw') {
      const el = h('div', { class: 'blk raw', contenteditable: 'false', title: 'Made by another editor, kept as it is' },
        toPlainText({ type: 'doc', content: [b.node] }));
      el._raw = b.node;
      return el;
    }
    const el = h('div', { class: 'blk' });
    this.setType(el, b.type);
    this.setIndent(el, b.indent ?? 0);
    if (b.type === 'task') this.setChecked(el, b.checked);
    el.append(...inlineNodes(b.inline));
    if (!el.firstChild) el.append(h('br'));
    return el;
  }

  setType(el, type) {
    el.className = 'blk';
    el.dataset.type = type;
    if (!isList(type)) this.setIndent(el, 0);
    if (type === 'task') { if (el.dataset.checked === undefined) el.dataset.checked = 'false'; }
    else delete el.dataset.checked;
  }

  setIndent(el, n) {
    const indent = Math.max(0, Math.min(MAX_INDENT, n));
    el.dataset.indent = String(indent);
    el.style.setProperty('--i', String(indent));
  }

  setChecked(el, on) { el.dataset.checked = String(!!on); }

  blockOf(node) {
    if (!node) return null;
    if (node === this.root) return null;
    let n = node.nodeType === 1 ? node : node.parentNode;
    while (n && n.parentNode !== this.root) n = n.parentNode;
    return n && n.parentNode === this.root ? n : null;
  }

  currentBlock() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    if (sel.anchorNode === this.root) return this.root.children[Math.min(sel.anchorOffset, this.root.children.length - 1)] ?? null;
    return this.blockOf(sel.anchorNode);
  }

  /** Every line touched by the selection (or the caret's line). */
  selectedBlocks() {
    const sel = getSelection();
    if (!sel.rangeCount) return [];
    const r = sel.getRangeAt(0);
    const pick = (node, offset) => (node === this.root ? this.root.children[Math.min(offset, this.root.children.length - 1)] : this.blockOf(node));
    const first = pick(r.startContainer, r.startOffset);
    const last = pick(r.endContainer, r.endOffset) ?? first;
    const out = [];
    for (let el = first; el; el = el.nextElementSibling) {
      out.push(el);
      if (el === last) break;
    }
    return out.filter((el) => !el._raw);
  }

  // ── Commands (keyboard and toolbar) ───────────────────────────────────────

  /** Turn the selected lines into a type; if they already all are, back to plain text. */
  toggleType(type) {
    const blocks = this.selectedBlocks();
    if (!blocks.length) return;
    const all = blocks.every((b) => b.dataset.type === type);
    for (const b of blocks) this.setType(b, all ? 'paragraph' : type);
    this.changed();
    this.bar.update();
    this.tools.flash();
  }

  /** Indent / outdent the selected list lines (at most one level deeper than the line above). */
  indent(delta) {
    const blocks = this.selectedBlocks().filter((b) => isList(b.dataset.type));
    for (const b of blocks) {
      const prev = b.previousElementSibling;
      const limit = prev && isList(prev.dataset.type) ? Number(prev.dataset.indent) + 1 : 0;
      this.setIndent(b, Math.min(limit, (Number(b.dataset.indent) || 0) + delta));
    }
    if (blocks.length) this.changed();
  }

  toggleChecked() {
    const tasks = this.selectedBlocks().filter((b) => b.dataset.type === 'task');
    const on = !tasks.every((b) => b.dataset.checked === 'true');
    for (const b of tasks) this.setChecked(b, on);
    if (tasks.length) this.changed();
  }

  format(command) {
    document.execCommand(command);
    this.changed();
    this.bar.update();
  }

  /** Make the selected words a link (or remove the link when url is null). */
  link(url) {
    if (url) document.execCommand('createLink', false, url);
    else document.execCommand('unlink');
    this.changed();
    this.bar.update();
  }

  /** The link the caret / selection is in, if any. */
  linkAtSelection() {
    const sel = getSelection();
    const n = sel.anchorNode;
    const a = (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('a[href]');
    return a && this.root.contains(a) ? a : null;
  }

  /** Make a line a given type (from the + menu): sets it, never toggles. */
  setLineType(blk, type) {
    if (!blk || blk._raw) return;
    this.setType(blk, type);
    if (type === 'task') this.setChecked(blk, false);
    this.changed();
    this.tools?.update();
  }

  // ── Events ────────────────────────────────────────────────────────────────

  onKeydown(e) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (this.tools.handleKey(e)) return; // the + / "/" menu is open: arrows, Enter, Esc go to it
    if (mod && key === 'k') { e.preventDefault(); if (!getSelection().isCollapsed) this.bar.openLink(); return; }
    if (e.key === 'Tab') { e.preventDefault(); this.indent(e.shiftKey ? -1 : 1); return; }
    if (mod && e.shiftKey && e.code === 'Digit8') { e.preventDefault(); this.toggleType('bullet'); return; }
    if (mod && e.shiftKey && e.code === 'Digit9') { e.preventDefault(); this.toggleType('task'); return; }
    if (mod && e.altKey && e.code === 'Digit1') { e.preventDefault(); this.toggleType('heading1'); return; }
    if (mod && e.altKey && e.code === 'Digit2') { e.preventDefault(); this.toggleType('heading2'); return; }
    if (mod && e.altKey && e.code === 'Digit0') { e.preventDefault(); this.toggleType('paragraph'); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); this.toggleChecked(); return; }
    if (mod && e.shiftKey && key === 'x') { e.preventDefault(); this.format('strikeThrough'); return; }
    if (mod && !e.shiftKey && key === 'u') { e.preventDefault(); return; } // notes have no underline

    const blk = this.currentBlock();
    if (!blk || blk._raw) return;
    const type = blk.dataset.type;
    const indent = Number(blk.dataset.indent) || 0;

    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      // Enter on an empty list line steps out of the list (first a level, then entirely).
      if (isList(type) && !blk.textContent.trim()) {
        e.preventDefault();
        if (indent > 0) this.setIndent(blk, indent - 1);
        else this.setType(blk, 'paragraph');
        this.changed();
        return;
      }
      // Enter at the end of a heading continues with normal text.
      if (isHeading(type) && caretOffset(blk) >= blk.textContent.length) {
        e.preventDefault();
        const next = this.blockEl({ type: 'paragraph', inline: [] });
        blk.after(next);
        placeCaret(next, 0);
        this.changed();
      }
      return; // otherwise the browser splits the line; onInput tidies the new one
    }

    if (e.key === 'Backspace' && !mod && getSelection().isCollapsed && type !== 'paragraph' && caretOffset(blk) === 0) {
      // At the start of a list line or heading: outdent, then turn into plain text, then merge as usual.
      e.preventDefault();
      if (isList(type) && indent > 0) this.setIndent(blk, indent - 1);
      else this.setType(blk, 'paragraph');
      this.changed();
    }
  }

  onInput(e) {
    this.normalize();
    const blk = this.currentBlock();
    if (blk && !blk._raw) {
      if (e.inputType === 'insertParagraph') this.tidyNewLine(blk);
      if (e.inputType === 'insertText' && e.data === ' ') this.markdownShortcut(blk);
      if (e.inputType?.startsWith('delete')) unwrapStyleSpans(blk);
      // "/" on an empty line opens the "what do you want to add?" menu.
      if (e.inputType === 'insertText' && e.data === '/' && blk.textContent === '/') this.tools.openMenu({ fromSlash: true });
      else this.tools.closeMenu();
    }
    this.changed();
    this.tools.update();
  }

  /** After the browser splits a line, the new line is a copy: make it a fresh, unticked one. */
  tidyNewLine(blk) {
    const prev = blk.previousElementSibling;
    if (blk.dataset.type === 'task' && !blk.textContent) this.setChecked(blk, false);
    if (prev?.dataset.type === 'task' && !prev.textContent) this.setChecked(prev, false);
    if (isHeading(blk.dataset.type) && !blk.textContent) this.setType(blk, 'paragraph');
  }

  /** "- " bullet, "[] " checklist, "[x] " ticked, "# " / "## " headings, typed at the start of a line. */
  markdownShortcut(blk) {
    if (blk.dataset.type !== 'paragraph') return;
    const text = blk.textContent.replace(/ /g, ' ');
    const at = caretOffset(blk);
    const rules = [
      [/^[-*•] /, 'bullet'], [/^\[ ?\] /, 'task'], [/^\[[xX]\] /, 'task', true], [/^## /, 'heading2'], [/^# /, 'heading1'],
    ];
    for (const [re, type, checked] of rules) {
      const m = text.match(re);
      if (!m || at !== m[0].length) continue;
      deleteLeadingChars(blk, m[0].length);
      this.setType(blk, type);
      if (type === 'task') this.setChecked(blk, !!checked);
      if (!blk.firstChild) blk.append(h('br'));
      placeCaret(blk, 0);
      return;
    }
  }

  /** Clicking a checkbox ticks it (and keeps the caret where it was). */
  onMousedown(e) {
    const blk = e.target.closest?.('.blk');
    if (!blk || blk.dataset.type !== 'task' || blk.parentNode !== this.root) return;
    const rect = blk.getBoundingClientRect();
    const boxRight = rect.left + parseFloat(getComputedStyle(blk).paddingLeft);
    if (e.clientX < boxRight - 26 || e.clientX > boxRight) return;
    e.preventDefault();
    this.setChecked(blk, blk.dataset.checked !== 'true');
    this.changed();
  }

  onPaste(e) {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    // Pasting a web address over selected words turns them into a link.
    const url = !getSelection().isCollapsed && /^\S+$/.test(text.trim()) ? safeLink(text) : null;
    if (url) { this.link(url); return; }
    const blocks = html ? blocksFromHTML(html) : toBlocks(fromPlainText(text));
    if (!blocks.length) return;
    if (blocks.length === 1 && blocks[0].type === 'paragraph') {
      // Plain words: insert in place through the browser, so Ctrl+Z can undo it.
      document.execCommand('insertHTML', false, inlineHTML(blocks[0].inline));
    } else {
      this.insertBlocks(blocks);
    }
    this.changed();
  }

  /** Insert several lines at the caret: the first joins the current line, the rest follow it. */
  insertBlocks(blocks) {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const cur = this.blockOf(range.startContainer) ?? this.root.lastElementChild;
    if (!cur || cur._raw) return;

    const tailRange = document.createRange();
    tailRange.setStart(range.startContainer, range.startOffset);
    tailRange.setEnd(cur, cur.childNodes.length);
    const tail = tailRange.extractContents();

    const [first, ...rest] = blocks.filter((b) => b.type !== 'raw');
    if (!first) return;
    dropPlaceholder(cur);
    if (!cur.textContent && first.type !== 'paragraph') {
      this.setType(cur, first.type);
      this.setIndent(cur, first.indent ?? 0);
      if (first.type === 'task') this.setChecked(cur, first.checked);
    }
    cur.append(...inlineNodes(first.inline));

    let last = cur;
    for (const b of rest) {
      const el = this.blockEl(b);
      last.after(el);
      last = el;
    }
    dropPlaceholder(last);
    const caret = document.createRange();
    caret.setStart(last, last.childNodes.length);
    caret.collapse(true);
    last.append(tail);
    if (!last.firstChild) last.append(h('br'));
    sel.removeAllRanges();
    sel.addRange(caret);
  }

  /** Keep the structure clean: every top-level child is a line; there is always at least one. */
  normalize() {
    const sel = getSelection();
    const keep = sel.rangeCount ? [sel.anchorNode, sel.anchorOffset] : null;
    let wrap = null;
    let moved = false;
    for (const node of [...this.root.childNodes]) {
      if (node.nodeType === 1 && node.tagName === 'DIV') {
        if (!node.classList.contains('blk')) this.setType(node, TEXT_TYPES.includes(node.dataset.type) ? node.dataset.type : 'paragraph');
        wrap = null;
        continue;
      }
      if (node.nodeType === 3 && !node.data) { node.remove(); continue; }
      if (!wrap) {
        wrap = h('div', { class: 'blk' });
        this.setType(wrap, 'paragraph');
        this.setIndent(wrap, 0);
        node.before(wrap);
      }
      wrap.append(node);
      moved = true;
    }
    if (!this.root.firstElementChild) {
      const blank = this.blockEl({ type: 'paragraph', inline: [] });
      this.root.append(blank);
      placeCaret(blank, 0);
      return;
    }
    // Moving a node drops the caret; put it back where it was.
    if (moved && keep?.[0] && this.root.contains(keep[0])) {
      try {
        const r = document.createRange();
        r.setStart(keep[0], keep[1]);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      } catch { /* caret lost: harmless */ }
    }
  }
}

// ── Floating toolbar shown over selected text ───────────────────────────────

class SelectionBar {
  constructor(editor) {
    this.editor = editor;
    this.linkMode = false;
    this.saved = null; // the selection, kept while typing a link address
    const btn = (label, title, run, active) => ({ label, title, run, active });
    this.items = [
      btn(h('b', {}, 'B'), 'Bold (Ctrl+B)', () => editor.format('bold'), () => document.queryCommandState('bold')),
      btn(h('i', {}, 'I'), 'Italic (Ctrl+I)', () => editor.format('italic'), () => document.queryCommandState('italic')),
      btn(h('s', {}, 'S'), 'Strikethrough (Ctrl+Shift+X)', () => editor.format('strikeThrough'), () => document.queryCommandState('strikeThrough')),
      btn(icon('link', 16), 'Link (Ctrl+K)', () => this.openLink(), () => !!editor.linkAtSelection()),
      null,
      btn('H1', 'Heading (Ctrl+Alt+1)', () => editor.toggleType('heading1'), () => this.type() === 'heading1'),
      btn('H2', 'Subheading (Ctrl+Alt+2)', () => editor.toggleType('heading2'), () => this.type() === 'heading2'),
      btn('P', 'Normal text (Ctrl+Alt+0)', () => editor.toggleType('paragraph'), () => this.type() === 'paragraph'),
      btn(icon('list', 16), 'Bulleted list (Ctrl+Shift+8)', () => editor.toggleType('bullet'), () => this.type() === 'bullet'),
      btn(icon('checklist', 16), 'Checklist (Ctrl+Shift+9)', () => editor.toggleType('task'), () => this.type() === 'task'),
      null,
      btn(icon('outdent', 16), 'Outdent (Shift+Tab)', () => editor.indent(-1), null),
      btn(icon('indent', 16), 'Indent (Tab)', () => editor.indent(1), null),
    ];
    this.buttons = [];
    this.toolsEl = h('div', { class: 'rt-tools' }, this.items.map((it) => {
      if (!it) return h('span', { class: 'rt-sep' });
      const b = h('button', {
        class: 'rt-btn', type: 'button', title: it.title, 'aria-label': it.title,
        onMousedown: (e) => e.preventDefault(), // keep the text selected
        onClick: () => it.run(),
      }, it.label);
      this.buttons.push([b, it]);
      return b;
    }));

    // Link mode: the bar turns into an address box.
    this.linkInput = h('input', {
      class: 'rt-link-input', placeholder: 'Paste or type a link, then Enter', 'aria-label': 'Link address',
      onKeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.applyLink(this.linkInput.value); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeLink(); }
      },
      onBlur: () => { if (this.linkMode) this.closeLink(false); }, // clicked somewhere else
    });
    const keepFocus = (e) => e.preventDefault();
    this.unlinkBtn = h('button', {
      class: 'rt-btn', type: 'button', title: 'Remove link', 'aria-label': 'Remove link',
      onMousedown: keepFocus, onClick: () => this.applyLink(null),
    }, icon('trash', 15));
    this.linkEl = h('div', { class: 'rt-link', hidden: true },
      icon('link', 15), this.linkInput,
      h('button', {
        class: 'rt-btn', type: 'button', title: 'Apply', 'aria-label': 'Apply link',
        onMousedown: keepFocus, onClick: () => this.applyLink(this.linkInput.value),
      }, icon('check', 15)),
      this.unlinkBtn);

    this.el = h('div', { class: 'rt-bar', role: 'toolbar', 'aria-label': 'Formatting', hidden: true }, this.toolsEl, this.linkEl);
  }

  type() { return this.editor.currentBlock()?.dataset.type; }

  openLink() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    this.saved = sel.getRangeAt(0).cloneRange();
    const existing = this.editor.linkAtSelection();
    this.linkMode = true;
    this.toolsEl.hidden = true;
    this.linkEl.hidden = false;
    this.unlinkBtn.hidden = !existing;
    this.linkInput.value = existing?.getAttribute('href') ?? '';
    this.linkInput.focus();
    this.linkInput.select();
  }

  applyLink(raw) {
    const url = raw === null ? null : safeLink(raw);
    if (raw !== null && !url) { this.linkInput.focus(); this.linkInput.classList.add('bad'); return; }
    this.restore();
    this.editor.link(url);
    this.closeLink(false);
  }

  closeLink(restore = true) {
    if (restore) this.restore();
    this.linkMode = false;
    this.linkInput.classList.remove('bad');
    this.toolsEl.hidden = false;
    this.linkEl.hidden = true;
    this.update();
  }

  restore() {
    if (!this.saved) return;
    this.editor.root.focus();
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(this.saved);
    this.saved = null;
  }

  attach() {
    let frame = 0;
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => this.update()); };
    this.editor.listen(document, 'selectionchange', later);
    this.editor.listen(this.editor.root, 'scroll', later);
  }

  update() {
    if (this.linkMode) return; // typing an address: the selection now lives in the input box
    const root = this.editor.root;
    const sel = getSelection();
    if (!root || !sel.rangeCount || sel.isCollapsed || !root.contains(sel.anchorNode)) { this.el.hidden = true; return; }
    for (const [b, it] of this.buttons) b.classList.toggle('active', !!it.active?.());

    this.el.hidden = false;
    const host = this.editor.el.getBoundingClientRect();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const w = this.el.offsetWidth;
    const hgt = this.el.offsetHeight;
    let top = rect.top - host.top - hgt - 8;
    if (top < 0) top = rect.bottom - host.top + 8;
    const left = Math.max(0, Math.min(host.width - w, rect.left - host.left + rect.width / 2 - w / 2));
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

const MARK_TAGS = [['bold', 'b'], ['italic', 'i'], ['strike', 's']];

function inlineNodes(inline = []) {
  return mergeRuns(inline).map((r) => {
    let node = document.createDocumentFragment();
    r.text.split('\n').forEach((part, i) => {
      if (i) node.append(document.createElement('br'));
      if (part) node.append(document.createTextNode(part));
    });
    for (const [mark, tag] of MARK_TAGS) {
      if (!r.marks.includes(mark)) continue;
      const wrap = document.createElement(tag);
      wrap.append(node);
      node = wrap;
    }
    if (r.href) {
      const a = document.createElement('a');
      a.href = r.href;
      a.append(node);
      node = a;
    }
    return node;
  });
}

function inlineHTML(inline) {
  const div = document.createElement('div');
  div.append(...inlineNodes(inline));
  return div.innerHTML;
}

/** Text + bold / italic / strike from any element (ours, or pasted from the web or Word). */
function readInline(el) {
  const runs = [];
  const walk = (node, marks, href) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.data.replace(/ /g, ' ').replace(/​/g, '');
        runs.push(href ? { text, marks: [...marks], href } : { text, marks: [...marks] });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (tag === 'BR') { runs.push({ text: '\n', marks: [] }); continue; }
      if (tag === 'UL' || tag === 'OL' || tag === 'INPUT' || tag === 'STYLE' || tag === 'SCRIPT') continue;
      const style = child.style ?? {};
      const weight = style.fontWeight;
      const m = new Set(marks);
      if ((tag === 'B' || tag === 'STRONG') && weight !== 'normal' && weight !== '400') m.add('bold');
      else if (weight === 'bold' || Number(weight) >= 700) m.add('bold');
      if (tag === 'I' || tag === 'EM' || style.fontStyle === 'italic') m.add('italic');
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || /line-through/.test(style.textDecoration || '')) m.add('strike');
      const link = tag === 'A' ? safeLink(child.getAttribute('href')) : null;
      walk(child, m, link ?? href);
    }
  };
  walk(el, [], null);
  const last = runs[runs.length - 1];
  if (last?.text === '\n') runs.pop(); // the browser's placeholder <br> at the end of a line
  return mergeRuns(runs);
}

/** Pasted HTML -> lines. Understands paragraphs, headings, nested lists, checkboxes and our own lines. */
function blocksFromHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  const BLOCK_TAGS = /^(P|DIV|H[1-6]|LI|UL|OL|BLOCKQUOTE|SECTION|ARTICLE|TABLE|TBODY|THEAD|TR|TD|TH|PRE)$/;
  const para = (inline, keepEmpty = false) => {
    if (keepEmpty || inlineText(inline).trim()) out.push({ type: 'paragraph', indent: 0, checked: false, inline });
  };

  const listItem = (li, depth, task) => {
    const box = li.querySelector('input[type=checkbox]');
    const isTask = task || !!box || li.dataset.checked !== undefined;
    const own = li.cloneNode(true);
    own.querySelectorAll('ul, ol').forEach((n) => n.remove());
    out.push({
      type: isTask ? 'task' : 'bullet', indent: Math.min(depth, MAX_INDENT),
      checked: box ? box.checked || box.hasAttribute('checked') : li.dataset.checked === 'true',
      inline: readInline(own),
    });
    for (const sub of li.querySelectorAll(':scope > ul, :scope > ol')) list(sub, depth + 1);
  };
  const list = (ul, depth) => {
    const task = ul.dataset.type === 'taskList' || ul.classList.contains('contains-task-list');
    for (const child of ul.children) {
      if (child.tagName === 'LI') listItem(child, depth, task);
      else if (child.tagName === 'UL' || child.tagName === 'OL') list(child, depth + 1);
    }
  };
  const element = (el) => {
    const own = el.dataset?.type;
    if (TEXT_TYPES.includes(own)) {
      out.push({ type: own, indent: Number(el.dataset.indent) || 0, checked: el.dataset.checked === 'true', inline: readInline(el) });
      return;
    }
    const tag = el.tagName;
    if (tag === 'UL' || tag === 'OL') { list(el, 0); return; }
    if (tag === 'LI') { listItem(el, 0, false); return; }
    if (/^H[1-6]$/.test(tag)) { out.push({ type: tag === 'H1' ? 'heading1' : 'heading2', indent: 0, checked: false, inline: readInline(el) }); return; }
    if ([...el.children].some((c) => BLOCK_TAGS.test(c.tagName))) walk(el);
    else para(readInline(el));
  };
  const walk = (node) => {
    let loose = [];
    const flush = () => {
      if (!loose.length) return;
      const tmp = document.createElement('div');
      loose.forEach((n) => tmp.append(n.cloneNode(true)));
      para(readInline(tmp));
      loose = [];
    };
    for (const child of node.childNodes) {
      if (child.nodeType === 1 && BLOCK_TAGS.test(child.tagName)) { flush(); element(child); }
      else if (child.nodeType === 1 || child.nodeType === 3) loose.push(child);
    }
    flush();
  };
  walk(doc.body);
  return out;
}

/** A link the app is willing to keep and open: web, mail. "uni.at/page" becomes https://uni.at/page. */
export function safeLink(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^(https?:|mailto:)/i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return `https://${s}`;
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s)) return `mailto:${s}`;
  return null;
}

/** Characters before the caret within a line. */
function caretOffset(blk) {
  const sel = getSelection();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.setStart(blk, 0);
  try { pre.setEnd(r.startContainer, r.startOffset); } catch { return 0; }
  return pre.toString().length;
}

function placeCaret(el, offset) {
  const r = document.createRange();
  r.setStart(el, Math.min(offset, el.childNodes.length));
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function deleteLeadingChars(blk, count) {
  const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
  let left = count;
  const empty = [];
  for (let t = walker.nextNode(); t && left > 0; t = walker.nextNode()) {
    const n = Math.min(left, t.data.length);
    t.deleteData(0, n);
    left -= n;
    if (!t.data) empty.push(t);
  }
  empty.forEach((t) => t.remove());
}

function dropPlaceholder(el) {
  if (el.childNodes.length === 1 && el.firstChild.nodeName === 'BR') el.firstChild.remove();
}

/** The browser adds <span style=…> when merging lines of different looks; unwrap them. */
function unwrapStyleSpans(blk) {
  const spans = blk.querySelectorAll('span[style], font');
  if (!spans.length) return;
  const sel = getSelection();
  const keep = sel.rangeCount ? [sel.anchorNode, sel.anchorOffset] : null;
  spans.forEach((s) => s.replaceWith(...s.childNodes));
  if (keep && blk.contains(keep[0])) {
    try { const r = document.createRange(); r.setStart(keep[0], keep[1]); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); } catch { /* fine */ }
  }
}
