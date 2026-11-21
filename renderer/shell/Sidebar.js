import { Component } from '../core/Component.js';
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';

// Left icon strip. One button per registered view at the top, Settings at the bottom.
export class Sidebar extends Component {
  constructor(ctx) {
    super(ctx);
    this.active = null;
  }

  build() {
    this.navEl = h('div', { class: 'nav' });
    return h('div', { class: 'side' },
      this.navEl,
      h('div', { class: 'nav nav-bottom' },
        h('button', {
          class: 'nav-btn', title: 'Settings (Ctrl+,)', 'aria-label': 'Settings',
          onClick: () => this.bus.emit('settings:open'),
        }, icon('settings', 19))));
  }

  onMount() {
    this.on('view:changed', ({ id }) => { this.active = id; this.render(); });
  }

  render() {
    clear(this.navEl);
    for (const view of this.ctx.registry.list('view')) {
      this.navEl.appendChild(h('button', {
        class: `nav-btn${view.id === this.active ? ' active' : ''}`,
        title: view.label,
        'aria-label': view.label,
        onClick: () => this.bus.emit('view:open', { id: view.id }),
      }, icon(view.icon, 20)));
    }
  }
}
