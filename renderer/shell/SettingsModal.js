import { Component } from '../core/Component.js';
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';

// The Settings window: section list on the left, the chosen section on the right.
// Sections come from the registry ('settingsSection'), so any module can add its own:
//   { id, label, icon, create(ctx) -> Component }
// Open with bus.emit('settings:open', { section? }). Esc, ×, or a click outside closes it.
export class SettingsModal extends Component {
  constructor(ctx) {
    super(ctx);
    this.isOpen = false;
    this.sectionId = null;
    this.child = null;
  }

  get sections() { return this.ctx.registry.list('settingsSection'); }

  build() {
    this.navEl = h('nav', { class: 'settings-nav' });
    this.bodyEl = h('div', { class: 'settings-body' });
    this.dialogEl = h('div', { class: 'settings-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
      h('header', { class: 'settings-head' },
        h('h2', {}, 'Settings'),
        h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close settings', onClick: () => this.close() }, icon('close', 16))),
      h('div', { class: 'settings-main' }, this.navEl, this.bodyEl));
    return h('div', { class: 'settings-backdrop', hidden: true, onMousedown: (e) => { if (e.target === this.el) this.close(); } },
      this.dialogEl);
  }

  onMount() {
    this.on('settings:open', (opts) => this.open(opts?.section));
    this.listen(document, 'keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    }, true);
  }

  open(sectionId) {
    this.isOpen = true;
    this.el.hidden = false;
    this.show(sectionId ?? this.sectionId ?? this.sections[0]?.id);
    this.dialogEl.querySelector('.settings-nav-btn.active')?.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    this.child?.unmount();
    this.child = null;
  }

  show(id) {
    this.sectionId = id;
    this.render();
  }

  render() {
    if (!this.isOpen) return;
    clear(this.navEl);
    for (const s of this.sections) {
      this.navEl.appendChild(h('button', {
        class: `settings-nav-btn${s.id === this.sectionId ? ' active' : ''}`, type: 'button',
        onClick: () => this.show(s.id),
      }, icon(s.icon, 16), s.label));
    }

    this.child?.unmount();
    this.child = null;
    clear(this.bodyEl);
    const spec = this.ctx.registry.get('settingsSection', this.sectionId);
    if (!spec) return;
    try {
      this.child = spec.create(this.ctx);
      this.child.mount(this.bodyEl);
    } catch (err) {
      console.error(`[settings "${spec.id}"] failed to open`, err);
      this.bodyEl.replaceChildren(h('div', { class: 'empty error' }, `This section failed to open: ${err.message}`));
    }
  }
}
