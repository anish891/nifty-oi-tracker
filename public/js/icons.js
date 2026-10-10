// Inline SVG icon set (24x24 grid, 2px round strokes, currentColor), so icons follow the text
// colour and the light/dark theme. Everything here is a static string we author: nothing user- or
// network-supplied is ever interpolated into the markup.

const PATHS = {
  'trending-up': '<path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  'trending-down': '<path d="M22 17l-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  'alert-triangle': '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  'bar-chart': '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  scale: '<path d="M16 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="M2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  compress: '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>',
  wind: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M6.34 17.66l-1.41 1.41"/><path d="M19.07 4.93l-1.41 1.41"/>',
  loader: '<path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/>',
  minus: '<path d="M5 12h14"/>'
};

/** SVG markup for an icon (empty string for an unknown name, so a typo never breaks the page). */
export function icon(name, extraClass = '') {
  const body = PATHS[name];
  if (!body) return '';
  return `<svg class="ico${extraClass ? ' ' + extraClass : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

function iconNode(name, extraClass = '') {
  const tpl = document.createElement('template');
  tpl.innerHTML = icon(name, extraClass);
  return tpl.content.firstElementChild;
}

/** Replace the content of `el` with [icon] + text. Text goes in as a text node, never as HTML. */
export function setIconText(el, name, text, extraClass = '') {
  if (!el) return;
  el.textContent = '';
  const node = name ? iconNode(name, extraClass) : null;
  if (node) el.append(node);
  el.append(document.createTextNode(text));
}

/** Fill every <span data-icon="name"> placeholder in the page. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(slot => {
    if (slot.firstElementChild) return;
    const node = iconNode(slot.dataset.icon);
    if (node) slot.append(node);
  });
}

/** Icon for a composite-regime label (the label text itself carries no emoji). */
export function regimeIcon(label) {
  const l = String(label || '').toUpperCase();
  if (l.includes('EXPLOSIVE')) return 'zap';
  if (l.includes('SQUEEZE')) return 'rocket';
  if (l.includes('SLIDE') || l.includes('CAPITULATION')) return 'trending-down';
  if (l.includes('TWO-WAY') || l.includes('VOLATILE')) return 'wind';
  if (l.includes('COILED')) return 'compress';
  if (l.includes('RANGE')) return 'target';
  return 'scale';
}

export const themeIcon = theme => ({ dark: 'moon', light: 'sun' }[theme] || 'monitor');
