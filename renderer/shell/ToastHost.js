import { Component } from '../core/Component.js';
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';

// Small pop-up messages in the top-right corner. Any part of the app can show one through the bus:
//   bus.emit('toast:show', { id, title, text?, actions?: [{ label, primary?, onClick }], timeout? })
//   bus.emit('toast:dismiss', { id })
// - Showing a toast with an id that is already on screen replaces it.
// - A click on an action runs its onClick and closes the toast. The × just closes it.
// - timeout (milliseconds) closes it by itself; without one it stays until the user decides.
export class ToastHost extends Component {
  constructor(ctx) {
    super(ctx);
    this.toasts = new Map(); // id -> { el, timer }
  }

  build() { return h('div', { class: 'toasts', role: 'region', 'aria-label': 'Notifications', 'aria-live': 'polite' }); }

  onMount() {
    this.on('toast:show', (spec) => this.show(spec));
    this.on('toast:dismiss', ({ id } = {}) => this.dismiss(id));
  }

  onUnmount() {
    for (const { timer } of this.toasts.values()) clearTimeout(timer);
    this.toasts.clear();
  }

  show({ id, title, text = '', actions = [], timeout = 0 }) {
    if (!id) return;
    this.dismiss(id);

    const el = h('div', { class: 'toast', role: 'status' },
      h('div', { class: 'toast-body' },
        h('div', { class: 'toast-title' }, title),
        text ? h('div', { class: 'toast-text' }, text) : null,
        actions.length ? h('div', { class: 'toast-actions' }, actions.map((a) => h('button', {
          class: `btn btn-small${a.primary ? ' btn-primary' : ''}`, type: 'button',
          onClick: () => { this.dismiss(id); try { a.onClick?.(); } catch (err) { console.error('[toast] action failed', err); } },
        }, a.label))) : null),
      h('button', { class: 'icon-btn toast-close', type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss', onClick: () => this.dismiss(id) }, icon('close', 14)));

    const timer = timeout > 0 ? setTimeout(() => this.dismiss(id), timeout) : null;
    this.toasts.set(id, { el, timer });
    this.el.appendChild(el);
  }

  dismiss(id) {
    const t = this.toasts.get(id);
    if (!t) return;
    clearTimeout(t.timer);
    t.el.remove();
    this.toasts.delete(id);
  }
}
