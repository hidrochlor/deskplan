import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { formatDateTime } from '../../core/dates.js';
import { SettingsSection } from '../settings/SettingsSection.js';
import { phoneState, deviceLabel, RECENT_MS } from './phoneState.js';

const QR_LIFETIME_MS = 2 * 60 * 1000; // the pairing code stops being shown (and works only for 10 minutes anyway)

// Settings › Phones: the receive switch, pairing, and the list of paired phones.
export class PhonesSection extends SettingsSection {
  /** @param {import('./PhoneLink.js').PhoneLink} link @param {object|null} api */
  constructor(ctx, link, api) {
    super(ctx);
    this.link = link;
    this.api = api;
    this.qr = null;       // { dataUrl, knownIds } while a pairing code is on screen
    this.error = '';
    this.qrTimer = null;
    this.renaming = null; // id of the phone whose name is being edited
    this.renameValue = '';
  }

  get title() { return 'Phones'; }

  onMount() {
    super.onMount();
    this.on('phones:changed', (status) => { this.checkQr(status); this.render(); });
  }

  onUnmount() { clearTimeout(this.qrTimer); } // the code is never kept after leaving this page

  rows() {
    if (!this.link.available) {
      return [h('div', { class: 'set-hint' }, 'Receiving files from a phone is available in the desktop app.')];
    }
    const s = this.link.status;
    if (!s) return [h('div', { class: 'set-hint' }, 'Loading…')];

    const rows = [
      this.row('Receive files from phones',
        'Off until you turn it on. Files go to Received files, or straight into a folder chosen on the phone. Only turn it on at home or on your own hotspot: on shared Wi-Fi (school, café) other people on the network can see this PC.',
        this.toggle(s.enabled, (on) => this.setEnabled(on), 'Receive files from phones')),
    ];
    const legend = [this.group('What the top-bar phone icon means'), this.legend(s)];
    if (!s.enabled) return [...rows, ...legend];

    rows.push(
      s.network?.category === 'Public' ? h('div', { class: 'set-warning', role: 'alert' },
        h('strong', {}, `${s.network.interfaceName ?? 'This network'} is a Public network. `),
        'Windows treats it as an unfamiliar network such as a café or school Wi-Fi: other people on it can see this PC, and Windows will usually block your phone from connecting. ',
        'Use your home Wi-Fi or your phone hotspot instead. If you do trust this network, set it to Private in Windows Settings › Network & internet.') : null,
      this.group('Pair a phone'),
      this.row('Pair a new phone',
        'Open DeskPlan Companion on the phone and scan the code. Then approve the phone below.',
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.showQr() }, icon('phone', 14), this.qr ? 'New code' : 'Show code')),
      this.qr ? this.qrRow() : null,
      this.error ? h('div', { class: 'set-hint error' }, this.error) : null,

      this.group('Paired phones'),
      ...(s.devices.length ? s.devices.map((d) => this.deviceRow(d)) : [h('div', { class: 'set-hint' }, 'No phones yet.')]),

      this.group('Received files'),
      this.row('Storage folder', 'Files from your phone are stored here and listed on the Received files page.',
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.api.openFolder() }, icon('folder', 14), 'Open')),
      this.row('This PC', [phoneState(s).label, s.network && s.network.category !== 'Unknown' ? `${s.network.interfaceName}: ${s.network.category} network` : null, `port ${s.port}`].filter(Boolean).join(' · '),
        h('code', { class: 'set-code', title: `Certificate fingerprint (SHA-256)\n${s.fingerprint}` }, `${s.fingerprint.slice(0, 16)}…`)),
      h('div', { class: 'set-hint note' },
        'Windows Firewall: if Windows asks, allow DeskPlan on Private networks only. Some shared Wi-Fi blocks phones from reaching this PC; your phone hotspot works anywhere (set that network to Private in Windows).'),
      ...legend);
    return rows;
  }

  /** The dot colours and the warning badge, in words. The one that matches right now is highlighted. */
  legend(status) {
    const current = phoneState(status).level;
    const minutes = RECENT_MS / 60000;
    const levels = [
      ['off', 'Receiving is off.'],
      ['ready', `Receiving is on, but no phone has been seen in the last ${minutes} minutes (or none is paired yet).`],
      ['ok', `Connected: a phone was seen in the last ${minutes} minutes. A phone syncs now and then instead of staying connected.`],
      ['attention', 'A phone is waiting for you to approve it.'],
    ];
    return h('div', { class: 'legend' },
      ...levels.map(([level, text]) => h('div', { class: `legend-row${level === current ? ' current' : ''}` },
        h('span', { class: 'phone-dot inline', 'data-level': level }), h('span', {}, text))),
      h('div', { class: 'legend-row' },
        h('span', { class: 'phone-warn inline' }, '!'),
        h('span', {}, 'Warning, shown next to the icon without changing its colour: Windows calls this network Public, so other people on it can see this PC.')));
  }

  qrRow() {
    return h('div', { class: 'set-row stacked' },
      h('div', { class: 'qr-box' }, h('img', { src: this.qr.dataUrl, alt: 'Pairing code: scan it with DeskPlan Companion', width: 220, height: 220 })),
      h('div', { class: 'set-hint' }, 'This code is a password for your files. Do not share a picture of it. It disappears after two minutes or when a phone connects.'));
  }

  deviceRow(d) {
    const seen = d.lastSeen ? `last seen ${formatDateTime(new Date(d.lastSeen))}` : 'never connected';
    const hint = d.approved ? `Approved · ${seen}` : 'Waiting for your approval';
    const renaming = this.renaming === d.id;
    return this.row(renaming ? this.renameInput(d) : deviceLabel(d, formatDateTime), hint,
      h('div', { class: 'quick-row' },
        renaming ? null : h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.startRename(d) }, 'Rename'),
        d.approved ? null : h('button', { class: 'btn btn-small btn-primary', type: 'button', onClick: () => this.link.approve(d.id) }, 'Approve'),
        h('button', { class: 'btn btn-small btn-danger', type: 'button', onClick: () => this.link.revoke(d.id) }, d.approved ? 'Revoke' : 'Refuse')));
  }

  /** Phones that do not send their name can be named here. Enter saves, Esc cancels, leaving the box saves. */
  renameInput(d) {
    const finish = (save) => {
      if (this.renaming !== d.id) return; // already finished (Enter, then the box losing focus)
      this.renaming = null;
      if (save) this.link.rename(d.id, this.renameValue).catch((err) => { this.error = `Could not rename: ${err.message}`; this.render(); });
      else this.render();
    };
    return h('input', {
      class: 'input rename-input', value: this.renameValue, maxlength: 80, placeholder: 'Name this phone', 'aria-label': 'Phone name',
      onInput: (e) => { this.renameValue = e.target.value; },
      onKeydown: (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') { e.stopPropagation(); finish(false); } },
      onBlur: () => finish(true),
    });
  }

  startRename(d) {
    this.renaming = d.id;
    this.renameValue = d.name;
    this.render();
  }

  render() {
    super.render();
    this.el?.querySelector('.rename-input')?.focus();
  }

  async setEnabled(on) {
    this.hideQr();
    this.error = '';
    try { await this.link.setEnabled(on); } catch (err) { this.error = `Could not change this: ${err.message}`; this.render(); }
  }

  async showQr() {
    this.error = '';
    try {
      const { qrDataUrl } = await this.link.startPairing();
      this.qr = { dataUrl: qrDataUrl, knownIds: new Set(this.link.status.devices.map((d) => d.id)) };
      clearTimeout(this.qrTimer);
      this.qrTimer = setTimeout(() => { this.hideQr(); if (this.el) this.render(); }, QR_LIFETIME_MS);
    } catch (err) {
      this.error = `Could not make a pairing code: ${err.message}`;
    }
    this.render();
  }

  hideQr() {
    clearTimeout(this.qrTimer);
    this.qr = null;
  }

  /** Hide the code as soon as a new phone has connected with it, or receiving was switched off. */
  checkQr(status) {
    if (!this.qr) return;
    if (!status?.enabled || status.devices.some((d) => !this.qr.knownIds.has(d.id) && d.claimedAt)) this.hideQr();
  }
}
