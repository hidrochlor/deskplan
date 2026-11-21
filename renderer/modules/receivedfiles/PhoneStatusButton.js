import { Component } from '../../core/Component.js';
import { h, clear } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { formatDateTime } from '../../core/dates.js';
import { phoneState, deviceLabel } from './phoneState.js';

// The phone icon in the top bar. A small dot shows the connection (grey off, blue paired but quiet, green a phone was
// seen in the last 10 minutes, amber a phone is waiting for approval). A separate amber "!" badge appears while
// receiving on a Public network. Click it for a pop-up with the switch and a link to Settings › Phones.
export class PhoneStatusButton extends Component {
  /** @param {import('./PhoneLink.js').PhoneLink} link */
  constructor(ctx, link) {
    super(ctx);
    this.link = link;
    this.open = false;
    this.pop = null;
  }

  build() {
    this.dotEl = h('span', { class: 'phone-dot' });
    this.warnEl = h('span', { class: 'phone-warn', 'aria-hidden': 'true' }, '!');
    this.btn = h('button', {
      class: 'icon-btn phone-btn', type: 'button', 'aria-haspopup': 'true',
      onClick: () => this.toggle(),
    }, icon('phone', 16), this.dotEl, this.warnEl);
    return this.btn;
  }

  onMount() {
    this.on('phones:changed', () => this.render());
    this.every(30000, () => this.render()); // green fades to blue as time passes, even when nothing new arrives
    this.on('settings:open', () => this.close()); // Ctrl+, and the gear open Settings without clicking here
    // The pop-up lives on <body> (the top bar is a window-drag area and clips), so it needs its own outside-click and Esc.
    this.listen(document, 'mousedown', (e) => {
      if (this.open && !e.target.closest?.('.phone-pop, .phone-btn')) this.close();
    });
    this.listen(document, 'keydown', (e) => { if (this.open && e.key === 'Escape') this.close(); });
    this.listen(window, 'resize', () => this.close());
  }

  onUnmount() { this.pop?.remove(); }

  toggle() { this.open ? this.close() : this.show(); }

  show() {
    this.open = true;
    this.bus.emit('phones:attend'); // an approval toast would only repeat what this pop-up shows
    this.pop = h('div', { class: 'phone-pop', role: 'dialog', 'aria-label': 'Phone connection' });
    document.body.appendChild(this.pop);
    const r = this.btn.getBoundingClientRect();
    this.pop.style.top = `${Math.round(r.bottom + 6)}px`;
    this.pop.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    this.render();
  }

  close() {
    this.open = false;
    this.pop?.remove();
    this.pop = null;
  }

  render() {
    const status = this.link.status;
    const state = phoneState(status);
    this.dotEl.dataset.level = state.level;
    this.warnEl.hidden = !state.warning;
    const text = `Phone: ${state.label}${state.warning ? `. ${state.warning}` : ''}`;
    this.btn.title = text;
    this.btn.setAttribute('aria-label', text);
    if (this.pop) this.fillPop(status, state);
  }

  fillPop(status, state) {
    clear(this.pop);
    if (!status) { this.pop.append(h('div', { class: 'phone-pop-text' }, state.label)); return; }

    const waiting = status.devices.filter((d) => !d.approved);

    // (Element.append would print a null as the text "null", so leave out what is not needed.)
    this.pop.append(...[
      h('div', { class: 'phone-pop-title' }, status.name),
      h('div', { class: 'phone-pop-state' }, h('span', { class: 'phone-dot inline', 'data-level': state.level }), state.label),
      state.warning ? h('div', { class: 'phone-pop-warn' }, state.warning) : null,
      h('div', { class: 'phone-pop-row' },
        h('span', {}, 'Receive files from phones'),
        h('button', {
          class: `toggle${status.enabled ? ' on' : ''}`, type: 'button', role: 'switch',
          'aria-checked': String(status.enabled), 'aria-label': 'Receive files from phones',
          onClick: () => this.link.setEnabled(!status.enabled),
        }, h('span', { class: 'toggle-knob' }))),
      ...waiting.map((d) => h('div', { class: 'phone-pop-row' },
        h('span', {}, deviceLabel(d, formatDateTime)),
        h('button', { class: 'btn btn-small btn-primary', type: 'button', onClick: () => this.link.approve(d.id) }, 'Approve'))),
      h('button', {
        class: 'phone-pop-link', type: 'button',
        onClick: () => { this.close(); this.bus.emit('settings:open', { section: 'phones' }); },
      }, 'Manage devices'),
    ].filter(Boolean));
  }
}
