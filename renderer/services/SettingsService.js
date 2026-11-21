// User preferences, saved in the data file under meta.settings.
// Missing keys fall back to DEFAULT_SETTINGS, so new settings work with old files.
// Emits 'settings:changed' { key, value } on every change.
export const DEFAULT_SETTINGS = {
  theme: 'dark',          // 'dark' | 'light' | 'system'
  accent: 'indigo',       // an id from ACCENTS (Display.js)
  font: 'system',         // an id from FONTS (Display.js); unknown ids fall back to the first font
  zoom: 1,                // interface size: 0.9 | 1 | 1.1 | 1.25
  motion: true,           // false = no slide / fade animations
  clock: '24h',           // '24h' | '12h'
  weekStart: 'mon',       // 'mon' | 'sun'
  reminders: { enabled: true, '24h': true, '1h': true, due: true },
  feedFiling: true,       // Moodle deadlines go into "<semester> › <course>" folders; false = all into Unsorted
};

export class SettingsService {
  constructor(ctx) {
    this.bus = ctx.bus;
    this.store = ctx.store;
  }

  get(key) {
    const saved = this.store.meta.settings?.[key];
    const fallback = DEFAULT_SETTINGS[key];
    if (saved === undefined) return structuredClone(fallback);
    // Objects merge with defaults so a newly added sub-option still has a value.
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) return { ...fallback, ...saved };
    return saved;
  }

  all() {
    return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, this.get(k)]));
  }

  set(key, value) {
    this.store.meta.settings = { ...(this.store.meta.settings ?? {}), [key]: value };
    this.store.touchMeta();
    this.bus.emit('settings:changed', { key, value });
  }

  /** Change one field of an object setting, e.g. patch('reminders', { '1h': false }). */
  patch(key, fields) {
    this.set(key, { ...this.get(key), ...fields });
  }

  reset() {
    this.store.meta.settings = {};
    this.store.touchMeta();
    this.bus.emit('settings:changed', { key: '*', value: null });
  }
}
