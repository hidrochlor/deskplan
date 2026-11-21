import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { SettingsSection } from './SettingsSection.js';
import { ACCENTS, FONTS, ZOOMS, isFontInstalled } from '../../services/Display.js';
import { formatTime } from '../../core/dates.js';

export class AppearanceSection extends SettingsSection {
  get title() { return 'Appearance'; }

  rows() {
    const s = this.settings;
    return [
      this.row('Theme', 'Match Windows follows your system light / dark setting.',
        this.choice([{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }, { id: 'system', label: 'Match Windows' }],
          s.get('theme'), (v) => s.set('theme', v))),

      this.row('Accent colour', 'Buttons, highlights, today on the calendar.',
        h('div', { class: 'swatches' }, ACCENTS.map((a) => h('button', {
          class: `swatch${s.get('accent') === a.id ? ' active' : ''}`, type: 'button', title: a.label, 'aria-label': a.label,
          style: { '--c': a.color }, onClick: () => s.set('accent', a.id),
        }, s.get('accent') === a.id ? icon('check', 14) : null)))),

      this.row('Font', 'Each option is shown in its own font. Fonts that are not installed fall back to Segoe UI.',
        h('div', { class: 'font-grid' }, FONTS.map((f) => {
          const installed = isFontInstalled(f.family);
          return h('button', {
            class: `font-card${s.get('font') === f.id ? ' active' : ''}`, type: 'button',
            style: { 'font-family': f.stack }, onClick: () => s.set('font', f.id),
          },
          h('span', { class: 'font-sample' }, 'Aa'),
          h('span', { class: 'font-name' }, f.label),
          h('span', { class: `font-note${installed ? '' : ' missing'}` }, installed ? f.note : 'Not installed'));
        })), { stacked: true }),

      this.row('Interface size', 'Scales text and controls together.',
        this.choice(ZOOMS, s.get('zoom'), (v) => s.set('zoom', v))),

      this.row('Animations', 'Panels slide and pop-ups fade. Turn off for an instant feel.',
        this.toggle(s.get('motion'), (v) => s.set('motion', v), 'Animations')),
    ];
  }
}

export class DateTimeSection extends SettingsSection {
  get title() { return 'Date & time'; }

  rows() {
    const s = this.settings;
    const sample = new Date(2026, 0, 1, 23, 59);
    return [
      this.row('Clock', `Deadlines show as ${formatTime(sample)}.`,
        this.choice([{ id: '24h', label: '24-hour' }, { id: '12h', label: '12-hour' }], s.get('clock'), (v) => s.set('clock', v))),
      this.row('Week starts on', 'First column of the calendar.',
        this.choice([{ id: 'mon', label: 'Monday' }, { id: 'sun', label: 'Sunday' }], s.get('weekStart'), (v) => s.set('weekStart', v))),
    ];
  }
}

export class NotificationsSection extends SettingsSection {
  get title() { return 'Notifications'; }

  rows() {
    const s = this.settings;
    const r = s.get('reminders');
    const step = (key, label, hint) => this.row(label, hint,
      this.toggle(r.enabled && r[key], (v) => s.patch('reminders', { [key]: v }), label));
    return [
      this.row('Deadline reminders', 'Windows notifications for anything with a deadline.',
        this.toggle(r.enabled, (v) => s.patch('reminders', { enabled: v }), 'Deadline reminders')),
      r.enabled ? [
        this.group('Remind me'),
        step('24h', '1 day before', null),
        step('1h', '1 hour before', null),
        step('due', 'When it is due', null),
      ] : null,
      this.row('Test', 'Check that Windows shows DeskPlan notifications.',
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.test() }, 'Send a test')),
    ];
  }

  test() {
    if (typeof Notification === 'undefined') return;
    const fire = () => new Notification('DeskPlan', { body: 'Reminders are working.' });
    if (Notification.permission === 'granted') fire();
    else Notification.requestPermission().then((p) => p === 'granted' && fire());
  }
}

export class DataSection extends SettingsSection {
  get title() { return 'Data'; }

  onMount() {
    super.onMount();
    this.info = null;
    window.api?.app?.info?.().then((info) => { this.info = info; if (this.el) this.render(); });
    // Other features add their own groups here (e.g. calendar feeds), without this page knowing about them.
    this.parts = this.ctx.registry.list('settingsData').map((spec) => spec.create(this.ctx));
    for (const part of this.parts) part.mount?.(this);
  }

  onUnmount() {
    for (const part of this.parts ?? []) part.unmount?.();
  }

  rows() {
    const api = window.api?.app;
    if (!api) return [h('div', { class: 'set-hint' }, 'Data options are available in the desktop app.')];
    const dir = this.info?.dataDir ?? '…';
    return [
      this.row('Where your data lives', 'Everything stays on this computer. To back up everything, including attached files and photos, copy this whole folder.',
        h('code', { class: 'set-path', title: dir }, dir), { stacked: true }),
      this.row('Open data folder', 'Your data file, its backup copy, and your attached files.',
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => api.openDataFolder() }, icon('folder', 14), 'Open')),
      this.row('Export a backup', 'Folders, notes, tasks and deadlines as one file. Attached files and photos are not included: copy the data folder for those.',
        h('button', {
          class: 'btn btn-small', type: 'button',
          onClick: () => api.exportBackup(this.store.toJSON()),
        }, icon('open', 14), 'Export…')),
      this.row('Reset settings', 'Back to the default look and options. Your data is not touched.',
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => this.settings.reset() }, 'Reset')),
      ...(this.parts ?? []).map((part) => part.rows(this)),
    ];
  }
}

export class AboutSection extends SettingsSection {
  get title() { return 'About'; }

  onMount() {
    super.onMount();
    window.api?.app?.info?.().then((info) => { this.version = info.version; if (this.el) this.render(); });
  }

  rows() {
    const keys = [
      ['Ctrl + N', 'Add something'],
      ['Ctrl + 1 / 2', 'Home / Calendar'],
      ['Ctrl + J', 'Show or hide the side panel'],
      ['Ctrl + ,', 'Settings'],
      ['Esc', 'Close the panel, pop-up or this window'],
      ['Double-click', 'Open a folder, note or file'],
    ];
    return [
      this.row('DeskPlan', 'A lightweight planner for folders, notes, tasks and deadlines.',
        h('span', { class: 'muted' }, this.version ? `Version ${this.version}` : '')),
      this.group('Keyboard shortcuts'),
      this.keyList(keys),
      // Features add their own groups (e.g. the note editor) through the registry.
      ...this.ctx.registry.list('shortcuts').flatMap((g) => [this.group(g.label), this.keyList(g.keys)]),
    ];
  }

  keyList(keys) {
    return h('div', { class: 'keys' }, keys.map(([k, what]) => h('div', { class: 'key-row' }, h('kbd', {}, k), h('span', {}, what))));
  }
}
