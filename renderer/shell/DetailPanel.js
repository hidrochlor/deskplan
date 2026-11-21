import { Component } from '../core/Component.js';
import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';

// Right panel: a floating rounded card with a header (title + close) and a scrolling body
// that shows the editor registered for whatever is selected.
// An editor can set the header with bus.emit('panel:title', { text, color }).
export class DetailPanel extends Component {
  /** @param {HTMLElement} host  the <aside>; gets class "closed" when hidden */
  constructor(ctx, host) {
    super(ctx);
    this.host = host;
    this.child = null;
  }

  build() {
    this.titleEl = h('div', { class: 'panel-heading' });
    this.bodyEl = h('div', { class: 'panel-body' });
    return h('div', { class: 'panel-card' },
      h('header', { class: 'panel-head' },
        this.titleEl,
        h('button', {
          class: 'icon-btn', title: 'Close (Ctrl+J)', 'aria-label': 'Close panel',
          onClick: () => this.host.classList.add('closed'),
        }, icon('close', 16))),
      this.bodyEl);
  }

  onMount() {
    this.on('selection:changed', () => this.render());
    this.on('selection:picked', () => this.host.classList.remove('closed')); // any click shows the panel
    this.on('panel:toggle', () => this.host.classList.toggle('closed'));
    this.on('panel:title', ({ text, color }) => this.setTitle(text, color));
    // Starts hidden, slides in when something is clicked, slides out on a click anywhere else.
    // Anything that opens the panel itself (cards, rows, chips…) carries data-keep-panel, so
    // clicking from one item to the next swaps the details instead of closing and reopening.
    this.host.classList.add('closed');
    this.listen(document, 'mousedown', (e) => {
      if (this.host.classList.contains('closed')) return;
      if (e.target.closest?.('.panel, [data-keep-panel]')) return;
      this.host.classList.add('closed');
    });
    this.listen(document, 'keydown', (e) => {
      if (e.key !== 'Escape' || this.host.classList.contains('closed')) return;
      if (e.target.closest?.('input, textarea, select, .add-menu, .day-add')) return; // Esc there belongs to that control
      this.host.classList.add('closed');
    });
  }

  setTitle(text, color = null) {
    clear(this.titleEl);
    if (color) this.titleEl.appendChild(h('span', { class: 'dot', style: { '--c': color } }));
    this.titleEl.append(text);
  }

  render() {
    this.child?.unmount();
    this.child = null;
    clear(this.bodyEl);
    this.setTitle('Details');

    const sel = this.ctx.selection.current;
    const spec = sel && this.ctx.registry.get('editor', sel.type);
    if (!spec) {
      this.bodyEl.appendChild(h('div', { class: 'empty small' }, 'Click something on the canvas to see its details here.'));
      return;
    }
    try {
      this.child = spec.create(this.ctx, sel.id);
      this.child.mount(this.bodyEl);
    } catch (err) {
      console.error(`[editor "${sel.type}"] failed to open`, err);
      this.child?.unmount();
      this.child = null;
      this.bodyEl.replaceChildren(h('div', { class: 'empty error' }, `Details failed to open: ${err.message}`));
    }
  }
}
