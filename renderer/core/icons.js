import { h } from './dom.js';

// Inline SVG icons (24x24 grid, drawn with the current text colour).
const PATHS = {
  tasks: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9"/>',
  notes: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9"/>',
  paperclip: '<path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  close:'<path d="M6 6l12 12M18 6L6 18"/>',
  assignment: '<path d="M9 4h6v3H9z"/><path d="M15 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="M9 13l2 2 4-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  checklist: '<rect x="3" y="4" width="6" height="6" rx="1.5"/><path d="M4.5 7l1 1 2-2M13 7h8"/><rect x="3" y="14" width="6" height="6" rx="1.5"/><path d="M13 17h8"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  indent:'<path d="M10 6h10M10 12h10M10 18h10M3 9l3 3-3 3"/>',
  outdent: '<path d="M10 6h10M10 12h10M10 18h10M6 9l-3 3 3 3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  chevLeft: '<path d="M15 6l-6 6 6 6"/>',
  chevDown: '<path d="M6 9l6 6 6-6"/>',
  chevRight:'<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  receivedFiles: '<path d="M4 13l2-8h12l2 8"/><path d="M4 13v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6h-5a3 3 0 0 1-6 0z"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
};

// The DeskPlan logo (a desk lamp, its light in indigo, a mint bulb), cropped to the drawing for the top bar.
// Colours come from --logo-* in styles.css so it follows the theme; build/icon.svg is the same drawing on its tile.
const LOGO = `
  <defs><linearGradient id="logo-cone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--logo-light)" stop-opacity=".45"/><stop offset="1" style="stop-color:var(--logo-light)" stop-opacity=".04"/></linearGradient></defs>
  <path d="M540 437 L700 403 L800 744 L440 744 Z" fill="url(#logo-cone)"/>
  <path d="M232 760 H452" style="stroke:var(--logo-line)" stroke-width="40" stroke-linecap="round"/>
  <path d="M452 760 H792" style="stroke:var(--logo-light)" stroke-width="40" stroke-linecap="round"/>
  <path d="M268 746 a76 34 0 0 1 152 0 z" style="fill:var(--logo-line)"/>
  <path d="M344 724 L420 470 L612 356" fill="none" style="stroke:var(--logo-line)" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="420" cy="470" r="22" style="fill:var(--frame);stroke:var(--logo-line)" stroke-width="16"/>
  <path d="M-82 0 A82 82 0 0 1 82 0 Z" style="fill:var(--logo-line);stroke:var(--logo-line)" stroke-width="12" stroke-linejoin="round" transform="translate(620 420) rotate(-12)"/>
  <circle cx="622" cy="432" r="18" style="fill:var(--logo-bulb)"/>`;

export function logo(height = 20) {
  const width = Math.round(height * 600 / 470);
  return h('span', {
    class: 'logo',
    html: `<svg width="${width}" height="${height}" viewBox="212 320 600 470" aria-hidden="true">${LOGO}</svg>`,
  });
}

export function icon(name, size = 18) {
  const body = PATHS[name] ?? '';
  return h('span', {
    class: 'icon',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  });
}
