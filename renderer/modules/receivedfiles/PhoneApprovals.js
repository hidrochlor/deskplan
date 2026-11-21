// Asks the user to approve a phone, the moment it connects for the first time.
//
// A phone that has scanned the pairing code can do nothing until it is approved on the PC. Without a prompt
// the user has to know to look in Settings, so this shows a toast with Approve / Refuse (through the bus,
// see ToastHost). If DeskPlan is not the window in front, it also sends a desktop notification.
// Each waiting phone is announced once; closing the toast with × means "later" (the top-bar dot stays amber).
const toastId = (deviceId) => `phone-approval-${deviceId}`;

function desktopNotify(title, body, onClick) {
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
  const fire = () => { const n = new Notification(title, { body }); n.onclick = onClick; };
  if (Notification.permission === 'granted') fire();
  else Notification.requestPermission().then((p) => p === 'granted' && fire());
}

export class PhoneApprovals {
  /**
   * @param {{bus: object, link: import('./PhoneLink.js').PhoneLink,
   *          notify?: Function, hasFocus?: () => boolean, focusWindow?: () => void}} o
   *   notify / hasFocus / focusWindow are replaced in tests
   */
  constructor({
    bus, link, notify = desktopNotify, hasFocus = () => document.hasFocus(),
    focusWindow = () => globalThis.window?.api?.focusWindow?.(),
  }) {
    Object.assign(this, { bus, link, notify, hasFocus, focusWindow });
    this.shown = new Set(); // device ids already asked about
    bus.on('phones:changed', (status) => this.check(status));
    // The pop-up and the Settings page show the same Approve button, so the toast steps aside
    // once the user is looking there (the phone stays waiting, and is not asked about again).
    bus.on('phones:attend', () => this.hideToasts());
    bus.on('settings:open', () => this.hideToasts());
  }

  hideToasts() {
    for (const id of this.shown) this.bus.emit('toast:dismiss', { id: toastId(id) });
  }

  check(status) {
    const waiting = (status?.devices ?? []).filter((d) => !d.approved && d.claimedAt);
    const waitingIds = new Set(waiting.map((d) => d.id));

    for (const device of waiting) {
      if (this.shown.has(device.id)) continue;
      this.shown.add(device.id);
      this.ask(device);
    }
    // Approved or refused somewhere else (pop-up, Settings): take its toast away.
    for (const id of [...this.shown]) {
      if (waitingIds.has(id)) continue;
      this.shown.delete(id);
      this.bus.emit('toast:dismiss', { id: toastId(id) });
    }
  }

  ask(device) {
    const name = device.name || 'A new phone';
    this.bus.emit('toast:show', {
      id: toastId(device.id),
      title: `${name} wants to connect`,
      text: 'It scanned your pairing code. Approve it only if it is your phone: once approved it can send files and tasks to this PC.',
      actions: [
        { label: 'Approve', primary: true, onClick: () => this.approve(device, name) },
        { label: 'Refuse', onClick: () => this.link.revoke(device.id) },
      ],
    });
    if (!this.hasFocus()) {
      this.notify('DeskPlan: a phone wants to connect', `${name} is waiting for your approval.`, () => this.focusWindow());
    }
  }

  async approve(device, name) {
    try {
      await this.link.approve(device.id);
      this.bus.emit('toast:show', { id: toastId(device.id), title: `${name} is connected`, text: 'It can now send files and tasks to DeskPlan.', timeout: 4000 });
    } catch (err) {
      console.error('[received-files] could not approve the phone', err);
      this.bus.emit('toast:show', { id: toastId(device.id), title: 'Could not approve the phone', text: 'Try again in Settings › Phones.', timeout: 6000 });
    }
  }
}
