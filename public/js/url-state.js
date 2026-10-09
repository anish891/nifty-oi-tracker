// Shareable view state in the query string: ?expiry=13-Oct-2026&view=m15&overlay=vix
// Values are validated on read, so a stale or hand-edited link can never break the page.

const EXPIRY_RE = /^\d{2}-[A-Za-z]{3}-\d{4}$/;

export function readUrlState(allowed) {
  const p = new URLSearchParams(location.search);
  const expiry = p.get('expiry');
  const view = p.get('view');
  const overlay = p.get('overlay');
  return {
    expiry: expiry && EXPIRY_RE.test(expiry) ? expiry : null,
    view: view && allowed.views.includes(view) ? view : null,
    overlay: overlay && allowed.overlays.includes(overlay) ? overlay : null
  };
}

export function writeUrlState(patch) {
  try {
    const p = new URLSearchParams(location.search);
    Object.entries(patch).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    const qs = p.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? '?' + qs : ''}${location.hash}`);
  } catch (e) { /* history API unavailable (sandboxed iframe, etc.) */ }
}
