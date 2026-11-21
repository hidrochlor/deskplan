import { h } from './dom.js';

// Base class for every piece of UI.
//
//   build()     create the root element (once)
//   onMount()   subscribe to events, start timers (use this.on / this.every)
//   render()    draw or redraw the contents
//   onUnmount() extra cleanup (rarely needed)
//
// Everything subscribed through on / every / listen is released automatically
// by unmount(), so removing a component never leaves anything running.
export class Component {
  constructor(ctx) {
    this.ctx = ctx;
    this.el = null;
    this._cleanups = [];
  }

  get bus() { return this.ctx.bus; }
  get store() { return this.ctx.store; }

  build() { return h('div'); }
  onMount() {}
  render() {}
  onUnmount() {}

  mount(parent) {
    this.el = this.build();
    parent.appendChild(this.el);
    this.onMount();
    this.render();
    return this;
  }

  unmount() {
    for (const fn of this._cleanups.splice(0)) {
      try { fn(); } catch (err) { console.error('[component] cleanup failed', err); }
    }
    this.onUnmount();
    this.el?.remove();
    this.el = null;
  }

  /** Listen to an app event until unmount. */
  on(event, fn) {
    this._cleanups.push(this.bus.on(event, fn));
  }

  /** Run fn every ms until unmount. */
  every(ms, fn) {
    const timer = setInterval(fn, ms);
    this._cleanups.push(() => clearInterval(timer));
  }

  /** Listen to a DOM event on any target until unmount. */
  listen(target, event, fn, opts) {
    target.addEventListener(event, fn, opts);
    this._cleanups.push(() => target.removeEventListener(event, fn, opts));
  }
}
