// Small hand-drawn icon set (24x24, stroke-based, currentColor) shared by both
// interfaces. Icons are decorative (aria-hidden); buttons carry their own text.

const paths = {
  overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  restart: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>',
  camera: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1.5-2h5L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.5"/>',
  chart: '<path d="M4 19h16"/><path d="M6 15l4-5 3.5 3L19 6"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  logout: '<path d="M14 4.5h4.5v15H14"/><path d="M10 8l-4 4 4 4M6 12h9.5"/>',
  back: '<path d="M14.5 6l-6 6 6 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M3 19.5c.8-3.3 3.2-5 6-5s5.2 1.7 6 5"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.8c1.8.6 3 2.2 3.5 4.7"/>',
  layers: '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  list: '<path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01"/>',
  // OS glyphs: neutral shapes, not vendor logos
  linux: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l2.5 2L7 14M11.5 14.5H16"/>',
  windows: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18M6 6.8h.01M8.5 6.8h.01"/>',
  lxc: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
};

export function icon(name, { size = 18, cls = '' } = {}) {
  return `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.server}</svg>`;
}

// Own icon files from the branding folder, set by applyBrand(): { windows: url, … }
let customOsIcons = {};
export const customOsIcon = (os) => customOsIcons[os] ?? null;

/** OS glyph for a server: 'windows' | 'linux' | 'lxc' | anything else = generic server. */
export function osIcon(os, size = 20) {
  const own = customOsIcon(os);
  if (own) return `<img class="os-glyph os-img" src="${own}" width="${size}" height="${size}" alt="">`;
  if (os === 'lxc') return icon('lxc', { size, cls: 'os-glyph' });
  return icon(os === 'windows' ? 'windows' : os === 'linux' ? 'linux' : 'server', { size, cls: 'os-glyph' });
}

/** Brand mark: MDRCloud logo */
export function brandMark(size = 28) {
  return `<img class="brand-mark" src="/branding/mdrc-logo-1000x1000-dark.png" width="${size}" height="${size}" alt="MDRCloud" style="border-radius:6px;object-fit:contain;vertical-align:middle;display:inline-block">`;
}

/** Fetches the product name and applies it to the page (title + [data-brand]). */
export async function applyBrand(suffix = '') {
  let name = 'PVE Panel';
  try {
    const r = await fetch('/api/brand');
    if (r.ok) {
      const b = await r.json();
      name = b.name || name;
      customOsIcons = b.osIcons ?? {};
    }
  } catch { /* keep default */ }
  document.querySelectorAll('[data-brand]').forEach((el) => { el.textContent = name; });
  document.title = suffix ? `${suffix} – ${name}` : name;
  return name;
}
