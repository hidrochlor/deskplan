import { h, clear } from '../../../core/dom.js';
import { icon } from '../../../core/icons.js';

// Line types: what the hint above the caret calls them, and what the + / "/" menu offers.
export const LINE_TYPES = [
  { type: 'paragraph', label: 'Text', short: 'P', hint: 'Plain writing', keys: 'Ctrl+Alt+0' },
  { type: 'heading1', label: 'Heading 1', short: 'H1', hint: 'Big section title', keys: 'Ctrl+Alt+1' },
  { type: 'heading2', label: 'Heading 2', short: 'H2', hint: 'Smaller heading', keys: 'Ctrl+Alt+2' },
  { type: 'bullet', label: 'Bulleted list', icon: 'list', hint: 'Or type "- "', keys: 'Ctrl+Shift+8' },
  { type: 'task', label: 'Checklist', icon: 'checklist', hint: 'Tick items off. Or type "[] "', keys: 'Ctrl+Shift+9' },
];

// Helpers beside the line you are on:
//   • a + button next to an empty line, opening "Add a line as…" (also opened by typing "/")
//   • a small label above the caret saying what the line is ("Text", "Heading 1", …),
//     shown on empty lines and for a moment after the type changes.
export class LineTools {
  constructor(editor) {
    this.editor = editor;
    this.blk = null;
    this.menuOpen = false;
    this.fromSlash = false;
    this.active = 0;
    this.flashUntil = 0;

    const keepCaret = (e) => e.preventDefault();
    this.plus = h('button', {
      class: 'line-plus', type: 'button', hidden: true,
      title: 'Choose what to add: text, heading, list or checklist', 'aria-label': 'Choose what to add',
      onMousedown: keepCaret,
      onClick: () => (this.menuOpen ? this.closeMenu() : this.openMenu()),
    }, icon('plus', 15));
    this.pill = h('div', { class: 'line-pill', hidden: true, 'aria-hidden': 'true' });
    this.menu = h('div', { class: 'line-menu', role: 'menu', hidden: true, onMousedown: keepCaret });
  }

  get elements() { return [this.plus, this.pill, this.menu]; }

  attach() {
    const ed = this.editor;
    let frame = 0;
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => this.update()); };
    ed.listen(document, 'selectionchange', later);
    ed.listen(ed.root, 'scroll', later);
    ed.listen(ed.root, 'focus', later);
    ed.listen(ed.root, 'blur', () => setTimeout(() => {
      if (document.activeElement !== ed.root) { this.closeMenu(); this.hide(); }
    }, 0));
    ed.listen(document, 'mousedown', (e) => {
      if (this.menuOpen && !this.menu.contains(e.target) && !this.plus.contains(e.target)) this.closeMenu();
    });
  }

  hide() {
    this.plus.hidden = true;
    this.pill.hidden = true;
  }

  /** Show the line's label for a moment (after its type changed). */
  flash() {
    this.flashUntil = Date.now() + 1400;
    this.update();
    setTimeout(() => this.update(), 1450);
  }

  update() {
    const ed = this.editor;
    if (!ed.root) return;
    const sel = getSelection();
    const focused = document.activeElement === ed.root;
    const blk = focused && sel.rangeCount && sel.isCollapsed ? ed.currentBlock() : null;
    if (!blk || blk._raw) { if (!this.menuOpen) this.hide(); return; }
    if (this.menuOpen && blk !== this.blk) this.closeMenu();
    this.blk = blk;

    const text = blk.textContent;
    const empty = !text.trim() || (this.fromSlash && text === '/');
    const host = ed.el.getBoundingClientRect();
    const line = blk.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(blk).lineHeight) || 24;

    this.plus.hidden = !(empty || this.menuOpen);
    if (!this.plus.hidden) this.plus.style.top = `${line.top - host.top + (lh - 24) / 2}px`;

    // The label sits on the line itself, never over the line above: just after the caret on an
    // empty line, or after the last word when it flashes on a line that already has text.
    const showPill = (empty && !ed.root.classList.contains('is-empty')) || Date.now() < this.flashUntil;
    this.pill.hidden = !showPill;
    if (showPill) {
      const info = LINE_TYPES.find((t) => t.type === blk.dataset.type) ?? LINE_TYPES[0];
      this.pill.textContent = info.label;
      const anchor = empty ? caretRect(blk, line) : endOfText(blk, line);
      const left = (empty ? anchor.left : anchor.right) - host.left + 8;
      this.pill.style.left = `${Math.min(left, ed.el.clientWidth - this.pill.offsetWidth - 4)}px`;
      this.pill.style.top = `${line.top - host.top + (Math.min(lh, line.height) - 16) / 2}px`;
    }
    if (this.menuOpen) this.placeMenu();
  }

  // ── The menu ─────────────────────────────────────────────────────────────

  openMenu({ fromSlash = false } = {}) {
    if (!this.blk) this.update();
    if (!this.blk) return;
    this.menuOpen = true;
    this.fromSlash = fromSlash;
    this.active = Math.max(0, LINE_TYPES.findIndex((t) => t.type === this.blk.dataset.type));
    this.renderMenu();
    this.menu.hidden = false;
    this.plus.classList.add('open');
    this.update();
  }

  closeMenu() {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    this.fromSlash = false;
    this.menu.hidden = true;
    this.plus.classList.remove('open');
  }

  renderMenu() {
    clear(this.menu);
    this.menu.append(
      h('div', { class: 'line-menu-head' }, 'Add a line as…'),
      ...LINE_TYPES.map((t, i) => h('button', {
        class: `line-menu-item${i === this.active ? ' active' : ''}`, type: 'button', role: 'menuitem',
        onMouseenter: () => { this.active = i; this.highlight(); },
        onClick: () => this.choose(t.type),
      },
      h('span', { class: 'line-menu-icon' }, t.icon ? icon(t.icon, 16) : t.short),
      h('span', { class: 'line-menu-text' }, h('span', { class: 'line-menu-label' }, t.label), h('span', { class: 'line-menu-hint' }, t.hint)),
      h('kbd', {}, t.keys))),
      h('div', { class: 'line-menu-foot' }, '↑↓ to move · Enter to pick · Esc to close'));
  }

  highlight() {
    [...this.menu.querySelectorAll('.line-menu-item')].forEach((el, i) => el.classList.toggle('active', i === this.active));
  }

  placeMenu() {
    const below = this.plus.offsetTop + this.plus.offsetHeight + 6;
    const fits = below + this.menu.offsetHeight <= this.editor.el.clientHeight;
    this.menu.style.top = `${fits ? below : Math.max(0, this.plus.offsetTop - this.menu.offsetHeight - 6)}px`;
  }

  choose(type) {
    const blk = this.blk;
    if (!blk) return;
    if (this.fromSlash && blk.textContent === '/') blk.replaceChildren(h('br')); // remove the typed "/"
    this.closeMenu();
    this.editor.setLineType(blk, type);
    const r = document.createRange();
    r.setStart(blk, 0);
    r.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    this.flash();
  }

  /** Arrow keys, Enter and Esc drive the menu while it is open. Returns true if it used the key. */
  handleKey(e) {
    if (!this.menuOpen) return false;
    const n = LINE_TYPES.length;
    if (e.key === 'ArrowDown') { this.active = (this.active + 1) % n; this.highlight(); }
    else if (e.key === 'ArrowUp') { this.active = (this.active - 1 + n) % n; this.highlight(); }
    else if (e.key === 'Enter') this.choose(LINE_TYPES[this.active].type);
    else if (e.key === 'Escape') this.closeMenu();
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
}

/** The box of the last character on the line's first row of text. */
function endOfText(blk, line) {
  const r = document.createRange();
  r.selectNodeContents(blk);
  const rects = [...r.getClientRects()].filter((b) => b.width && Math.abs(b.top - line.top) < 4);
  return rects.length ? rects[rects.length - 1] : { right: line.left, top: line.top };
}

/** Where the caret is drawn. Empty lines report no box, so fall back to the start of the text area. */
function caretRect(blk, line) {
  const sel = getSelection();
  if (sel.rangeCount) {
    const r = sel.getRangeAt(0).cloneRange();
    const box = r.getClientRects()[0] ?? r.getBoundingClientRect();
    if (box && (box.width || box.height)) return box;
  }
  return { left: line.left + parseFloat(getComputedStyle(blk).paddingLeft || '0'), top: line.top };
}
