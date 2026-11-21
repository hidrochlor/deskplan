import { Component } from '../../core/Component.js';
import { h, clear } from '../../core/dom.js';

// Base for one page of the Settings window. Subclasses set `title` and implement rows().
// Redraws itself when settings change, so controls always show the saved value.
export class SettingsSection extends Component {
  get title() { return ''; }
  get settings() { return this.ctx.settings; }

  build() { return h('div', { class: 'settings-section' }); }

  onMount() {
    this.on('settings:changed', () => this.render());
  }

  render() {
    clear(this.el);
    this.el.append(h('h3', { class: 'settings-title' }, this.title), ...this.rows().flat().filter(Boolean));
  }

  /** @returns {HTMLElement[]} */
  rows() { return []; }

  // ── Building blocks ──────────────────────────────────────────────────────

  /** A labelled row: text on the left, control on the right (or below with { stacked: true }). */
  row(label, hint, control, { stacked = false } = {}) {
    return h('div', { class: `set-row${stacked ? ' stacked' : ''}` },
      h('div', { class: 'set-text' }, h('div', { class: 'set-label' }, label), hint ? h('div', { class: 'set-hint' }, hint) : null),
      h('div', { class: 'set-control' }, control));
  }

  group(label) {
    return h('div', { class: 'set-group' }, label);
  }

  /** Segmented choice. options: [{ id, label }] */
  choice(options, value, onPick) {
    return h('div', { class: 'seg' }, options.map((o) =>
      h('button', {
        class: `seg-btn${o.id === value ? ' active' : ''}`, type: 'button',
        onClick: () => onPick(o.id),
      }, o.label)));
  }

  toggle(on, onChange, label) {
    return h('button', {
      class: `toggle${on ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label,
      onClick: () => onChange(!on),
    }, h('span', { class: 'toggle-knob' }));
  }
}
