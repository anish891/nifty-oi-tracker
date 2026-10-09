// Small shared UI helpers for side panels.

export const hmIst = t =>
  new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

/**
 * Drag a right-hand drawer to the right to close it. Ignores form controls, and ignores
 * mostly-vertical drags so scrolling inside the drawer keeps working.
 */
export function attachDrawerSwipe(drawer, onClose) {
  let startX = null;
  let startY = null;
  let dx = 0;
  drawer.addEventListener('pointerdown', e => {
    if (e.target.closest('input, select, textarea, button, label, canvas')) return;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
  });
  drawer.addEventListener('pointermove', e => {
    if (startX === null) return;
    dx = e.clientX - startX;
    if (Math.abs(e.clientY - startY) > Math.abs(dx)) return; // vertical scroll, not a swipe
    if (dx > 0) {
      drawer.classList.add('dragging');
      drawer.style.transform = `translateX(${dx}px)`;
    }
  });
  const end = () => {
    if (startX === null) return;
    const shouldClose = dx > 90;
    startX = null;
    drawer.classList.remove('dragging');
    drawer.style.transform = '';
    if (shouldClose) onClose();
  };
  drawer.addEventListener('pointerup', end);
  drawer.addEventListener('pointercancel', end);
}

// Only one side panel (alerts, strike detail) may be open at a time.
export function announcePanelOpen(name) {
  window.dispatchEvent(new CustomEvent('side-panel-open', { detail: name }));
}
export function onOtherPanelOpen(name, close) {
  window.addEventListener('side-panel-open', e => { if (e.detail !== name) close(); });
}
