import { setClockFormat, setWeekStart } from '../core/dates.js';

export const ACCENTS = [
  { id: 'indigo', label: 'Indigo', color: '#7c8cff' },
  { id: 'blue', label: 'Blue', color: '#4c9aff' },
  { id: 'teal', label: 'Teal', color: '#33c3b0' },
  { id: 'green', label: 'Green', color: '#5cc96b' },
  { id: 'amber', label: 'Amber', color: '#f5b84b' },
  { id: 'clay', label: 'Clay', color: '#d97757' },
  { id: 'pink', label: 'Pink', color: '#f472b6' },
  { id: 'violet', label: 'Violet', color: '#b57cff' },
];

// Only fonts that ship with Windows or Office: nothing is downloaded or bundled.
export const FONTS = [
  { id: 'system', label: 'Segoe UI', family: 'Segoe UI', stack: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif', note: 'Windows default' },
  { id: 'bahnschrift', label: 'Bahnschrift', family: 'Bahnschrift', stack: 'Bahnschrift, "Segoe UI", sans-serif', note: 'Built into Windows' },
  { id: 'calibri', label: 'Calibri', family: 'Calibri', stack: 'Calibri, "Segoe UI", sans-serif', note: 'Office font' },
  { id: 'sitka', label: 'Sitka', family: 'Sitka Text', stack: '"Sitka Text", Georgia, serif', note: 'Serif, built into Windows' },
  { id: 'georgia', label: 'Georgia', family: 'Georgia', stack: 'Georgia, serif', note: 'Classic serif' },
];

export const ZOOMS = [
  { id: 0.9, label: 'Small' },
  { id: 1, label: 'Default' },
  { id: 1.1, label: 'Large' },
  { id: 1.25, label: 'Larger' },
];

// Window-control strip colours per theme (keep in step with --frame in styles.css).
const TITLEBAR = {
  dark: { color: '#0c0d12', symbolColor: '#c9cbd3' },
  light: { color: '#e8e6e0', symbolColor: '#3a362f' },
};

/** "#7c8cff" mixed toward black by `amount` (0–1). */
export function darken(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift) => Math.round(((n >> shift) & 255) * (1 - amount));
  return `#${[ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** True if the font is installed: text measures differently than in the fallback font. */
export function isFontInstalled(family) {
  const c = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlli1WQ@#';
  return ['monospace', 'serif'].some((fallback) => {
    c.font = `40px ${fallback}`;
    const base = c.measureText(sample).width;
    c.font = `40px "${family}", ${fallback}`;
    return c.measureText(sample).width !== base;
  });
}

// Applies settings to the page: theme, accent, font, size, motion, clock, week start.
// Runs once at start-up and again whenever a setting changes.
export class Display {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = document.documentElement;
    this.systemDark = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
  }

  start() {
    this.apply();
    this.ctx.bus.on('settings:changed', () => this.apply());
    this.systemDark?.addEventListener?.('change', () => { if (this.ctx.settings.get('theme') === 'system') this.apply(); });
  }

  get theme() {
    const t = this.ctx.settings.get('theme');
    if (t !== 'system') return t;
    return this.systemDark?.matches === false ? 'light' : 'dark';
  }

  apply() {
    const s = this.ctx.settings.all();
    const theme = this.theme;
    this.root.dataset.theme = theme;
    this.root.style.colorScheme = theme;

    const accent = ACCENTS.find((a) => a.id === s.accent) ?? ACCENTS[0];
    // Accents are bright for dark backgrounds; on the light theme use a deeper shade so text stays readable.
    this.root.style.setProperty('--accent', theme === 'light' ? darken(accent.color, 0.22) : accent.color);

    const font = FONTS.find((f) => f.id === s.font) ?? FONTS[0];
    this.root.style.setProperty('--font', font.stack);

    window.api?.app?.setZoom?.(s.zoom || 1); // real page zoom, so full-height layouts stay correct
    this.root.classList.toggle('no-motion', s.motion === false);

    setClockFormat(s.clock);
    setWeekStart(s.weekStart);

    window.api?.app?.setTitleBar?.(TITLEBAR[theme]);
    this.ctx.bus.emit('display:changed', { theme });
  }
}
