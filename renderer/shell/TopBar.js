import { Component } from '../core/Component.js';
import { h, clear } from '../core/dom.js';
import { icon, logo } from '../core/icons.js';
import { urgency } from '../core/dates.js';
import { NextEventLabel } from '../services/NextEventLabel.js';

// Super-slim top strip. On the left the logo (above the icon bar, as in VS Code) and the name. On the right, two rows:
//   row 1: what is due next        row 2: when ("Oct 6, 23:59 · 4h 12m left")
export class TopBar extends Component {
  build() {
    this.titleEl = h('div', { class: 'next-title' });
    this.whenEl = h('div', { class: 'next-when' });
    this.nextBtn = h('button', { class: 'next', 'data-keep-panel': true, onClick: () => this.openNext() }, this.titleEl, this.whenEl);

    this.itemsEl = h('div', { class: 'tb-items' }); // controls that features add ('topBarItem')

    return h('div', { class: 'tb' },
      h('span', { class: 'brand-mark' }, logo(20)),
      h('span', { class: 'brand' }, 'DeskPlan'),
      h('button', {
        class: 'icon-btn', title: 'Show / hide side panel (Ctrl+J)', 'data-keep-panel': true,
        onClick: () => this.bus.emit('panel:toggle'),
      }, icon('panel', 16)),
      h('div', { class: 'tb-spacer' }),
      this.itemsEl,
      this.nextBtn);
  }

  onMount() {
    this.children = [];
    for (const spec of this.ctx.registry.list('topBarItem')) {
      try {
        this.children.push(spec.create(this.ctx).mount(this.itemsEl));
      } catch (err) {
        console.error(`[topBarItem "${spec.id}"] failed to open, skipping it`, err);
      }
    }
    this.on('data:changed', () => this.render());
    this.on('display:changed', () => this.render()); // 12/24-hour clock
    this.every(30000, () => this.render());
  }

  onUnmount() {
    for (const child of this.children ?? []) child.unmount();
  }

  openNext() {
    const ev = this.next;
    if (!ev || !ev.ref) return;
    this.ctx.selection.select(ev.ref.type, ev.ref.id);
    this.bus.emit('reveal', ev.ref); // the owning module (if any) takes the canvas there
  }

  render() {
    const ev = this.ctx.deadlines.next();
    this.next = ev;
    clear(this.titleEl);
    clear(this.whenEl);

    if (!ev) {
      this.nextBtn.className = 'next idle';
      this.titleEl.textContent = 'No upcoming deadlines';
      return;
    }
    const now = Date.now();
    this.nextBtn.className = `next ${urgency(NextEventLabel.urgencyAt(ev, now), now)}`;
    this.nextBtn.title = `${ev.kind}: ${ev.title}${ev.context ? ` (${ev.context})` : ''}`;
    // (Element.append would print a null as the text "null", so only add the context when there is one.)
    this.titleEl.append(h('span', { class: 'dot', style: { '--c': ev.color } }), ev.title);
    if (ev.context) this.titleEl.append(h('span', { class: 'next-context' }, ` · ${ev.context}`));
    this.whenEl.textContent = NextEventLabel.text(ev, now);
  }
}
