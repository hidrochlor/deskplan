import { h } from './dom.js';

// App-styled tooltips (the browser's own `title` box can't be styled).
// Any element with data-tip="text" gets one on hover; data-tip-title adds a small heading.
// A plain `title="text"` works too: on hover it is moved into data-tip, so the browser's white box never appears.
// One shared tooltip element for the whole app; started once in app.js.
export class Tooltip {
  constructor({ delay = 350 } = {}) {
    this.delay = delay;
    this.timer = null;
    this.target = null;
    this.titleEl = h('div', { class: 'tip-title' });
    this.textEl = h('div', { class: 'tip-text' });
    this.el = h('div', { class: 'tip', role: 'tooltip', hidden: true }, this.titleEl, this.textEl);
  }

  start(parent = document.body) {
    parent.appendChild(this.el);
    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest?.('[data-tip], [title]');
      if (target) this.adoptTitle(target);
      if (target === this.target) return;
      this.hide();
      if (!target) return;
      this.target = target;
      this.timer = setTimeout(() => this.show(target), this.delay);
    });
    // Code that sets a title while the pointer is already resting on the element (the phone icon refreshes its own)
    // would otherwise bring the browser's box back, because no new mouseover happens. Swap those at once.
    new MutationObserver((changes) => {
      for (const { target } of changes) {
        this.adoptTitle(target);
        if (target === this.target && !this.el.hidden) this.show(target); // show the fresh text
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['title'], subtree: true });
    // Hide as soon as anything else happens: a click, scrolling, typing, leaving the window.
    for (const ev of ['mousedown', 'keydown', 'wheel', 'blur']) window.addEventListener(ev, () => this.hide(), true);
    document.addEventListener('mouseleave', () => this.hide());
  }

  /** Moves a native title into data-tip (data-tip wins if both exist), keeping an accessible name for icon-only controls. */
  adoptTitle(target) {
    const title = target.getAttribute('title');
    if (title === null) return;
    // A tip we made from a title earlier ("data-tip-auto") is replaced by a newer title (some titles change over time).
    if (title && (!target.dataset.tip || 'tipAuto' in target.dataset)) {
      const old = target.dataset.tip;
      target.dataset.tip = title;
      target.dataset.tipAuto = '';
      const label = target.getAttribute('aria-label');
      if ((label === null && !target.textContent.trim()) || (label !== null && label === old)) target.setAttribute('aria-label', title);
    }
    target.removeAttribute('title');
  }

  show(target) {
    if (!target.dataset.tip) return;
    if (!target.isConnected) return;
    const title = target.dataset.tipTitle ?? '';
    this.titleEl.textContent = title;
    this.titleEl.hidden = !title;
    this.textEl.textContent = target.dataset.tip;
    this.el.hidden = false;

    // Below the element if it fits, otherwise above; always inside the window.
    const r = target.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const ht = this.el.offsetHeight;
    const gap = 8;
    let top = r.bottom + gap;
    if (top + ht > window.innerHeight - 4) top = r.top - ht - gap;
    const left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
    this.el.style.top = `${Math.max(6, top)}px`;
    this.el.style.left = `${left}px`;
  }

  hide() {
    clearTimeout(this.timer);
    this.target = null;
    this.el.hidden = true;
  }
}
