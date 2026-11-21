import { Component } from '../core/Component.js';
import { h } from '../core/dom.js';

// The centre area. Shows one registered view at a time and remembers the last one.
export class CanvasHost extends Component {
  constructor(ctx) {
    super(ctx);
    this.current = null;
    this.currentId = null;
  }

  build() { return h('div', { class: 'canvas-inner' }); }

  onMount() {
    this.on('view:open', ({ id }) => this.open(id));

    const views = this.ctx.registry.list('view');
    const saved = this.store.meta.ui?.view;
    const start = views.find((v) => v.id === saved) ?? views[0];
    if (start) this.open(start.id);
  }

  open(id) {
    const spec = this.ctx.registry.get('view', id);
    if (!spec || this.currentId === id) return;

    this.current?.unmount();
    this.current = null;
    this.el.replaceChildren();
    this.currentId = id;

    try {
      this.current = spec.create(this.ctx);
      this.current.mount(this.el);
    } catch (err) {
      console.error(`[view "${id}"] failed to open`, err);
      this.current?.unmount();
      this.current = null;
      this.el.replaceChildren(h('div', { class: 'empty error' }, `The "${spec.label}" page failed to open: ${err.message}`));
    }

    this.store.meta.ui = { ...(this.store.meta.ui ?? {}), view: id };
    this.store.touchMeta();
    this.bus.emit('view:changed', { id });
  }
}
