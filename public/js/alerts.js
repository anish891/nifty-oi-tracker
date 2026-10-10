import { DEFAULT_SETTINGS, mergeSettings, createAlertEngine } from './alert-rules.js';
import { attachDrawerSwipe, announcePanelOpen, onOtherPanelOpen } from './ui-utils.js';

// Alerts UI. The rule engine decides *what* happened and what deserves to interrupt (alert-rules.js);
// this file only delivers it: log, toast, optional sound / desktop notification, plus snooze.
// Settings, log and snooze live in localStorage only.

const SETTINGS_KEY = 'alertSettings';
const LOG_KEY = 'alertLog';
const SNOOZE_KEY = 'alertSnoozeUntil';
const LOG_MAX = 100;
const TOAST_TTL = { info: 6000, warn: 9000, high: 14000 };
const SWIPE_DISMISS_PX = 70;

let settings = loadSettings();
let log = loadLog();
let snoozeUntil = loadSnooze();
const engine = createAlertEngine();
let unread = 0;
let hiddenCount = 0;
let baseTitle = '';
let audioCtx = null;

function loadSettings() {
  try { return mergeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY))); } catch (e) { return mergeSettings(null); }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* storage unavailable */ }
}
function loadLog() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOG_KEY));
    return Array.isArray(parsed) ? parsed.slice(0, LOG_MAX) : [];
  } catch (e) { return []; }
}
function saveLog() {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, LOG_MAX))); } catch (e) { /* ignore */ }
}
function loadSnooze() {
  try { return Number(localStorage.getItem(SNOOZE_KEY)) || 0; } catch (e) { return 0; }
}
function saveSnooze() {
  try { localStorage.setItem(SNOOZE_KEY, String(snoozeUntil)); } catch (e) { /* ignore */ }
}

export function alertsEnabled() {
  return settings.enabled;
}

function isSnoozed() {
  return Date.now() < snoozeUntil;
}

// ── Delivery ─────────────────────────────────────────────────────────────

function beep(severity) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = severity === 'high' ? 880 : 620;
    gain.gain.value = 0.06;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + (severity === 'high' ? 0.4 : 0.18));
  } catch (e) { /* audio unavailable */ }
}

function desktopNotify(ev) {
  if (!settings.desktop || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  // The toast already covers a focused window; only interrupt when the user is elsewhere.
  if (document.hasFocus() && !document.hidden) return;
  try {
    const n = new Notification(ev.title, { body: ev.body, tag: ev.key });
    setTimeout(() => n.close(), 8000); // don't let them pile up in the notification centre
  } catch (e) { /* ignore */ }
}

// ── Toasts ───────────────────────────────────────────────────────────────

function toastHost() {
  return document.getElementById('alertToasts');
}

function removeToast(el) {
  if (!el || !el.isConnected) return;
  el.classList.add('leaving');
  setTimeout(() => { el.remove(); syncDismissAll(); }, 160);
}

function syncDismissAll() {
  const host = toastHost();
  const btn = document.getElementById('alertDismissAll');
  if (!host || !btn) return;
  btn.hidden = host.querySelectorAll('.alert-toast:not(.leaving)').length < 2;
}

function dismissAllToasts() {
  toastHost()?.querySelectorAll('.alert-toast').forEach(removeToast);
}

/** Drag a toast sideways to dismiss it (touch, pen and mouse); a tap or ✕ also closes it. */
function attachSwipe(el) {
  let startX = null;
  let dx = 0;
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('.at-close')) return;
    startX = e.clientX;
    dx = 0;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', e => {
    if (startX === null) return;
    dx = e.clientX - startX;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 220));
  });
  const end = () => {
    if (startX === null) return;
    const moved = Math.abs(dx);
    startX = null;
    el.classList.remove('dragging');
    if (moved >= SWIPE_DISMISS_PX) {
      el.style.transform = `translateX(${dx > 0 ? 400 : -400}px)`;
      el.style.opacity = '0';
      setTimeout(() => { el.remove(); syncDismissAll(); }, 160);
    } else {
      el.style.transform = '';
      el.style.opacity = '';
      if (moved < 6) removeToast(el); // a tap
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => {
    startX = null;
    el.classList.remove('dragging');
    el.style.transform = '';
    el.style.opacity = '';
  });
}

function toast(ev) {
  const host = toastHost();
  if (!host) return;
  // The open drawer already shows the new entry; a toast on top of it is just noise.
  const drawer = document.getElementById('alertsDrawer');
  if (drawer && drawer.classList.contains('open')) return;

  const el = document.createElement('div');
  el.className = `alert-toast sev-${ev.severity}`;
  el.dataset.born = String(Date.now());
  el.dataset.ttl = String(TOAST_TTL[ev.severity] || TOAST_TTL.warn);
  el.setAttribute('role', 'status');

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'at-close';
  close.setAttribute('aria-label', 'Dismiss alert');
  close.textContent = '✕';
  close.addEventListener('click', e => { e.stopPropagation(); removeToast(el); });

  const t = document.createElement('div');
  t.className = 'at-title';
  t.textContent = ev.title;
  const b = document.createElement('div');
  b.className = 'at-body';
  b.textContent = ev.body;
  el.append(close, t, b);

  // Hovering / touching pauses the countdown so a toast can be read without racing it.
  el.addEventListener('pointerenter', () => { el.dataset.paused = '1'; });
  el.addEventListener('pointerleave', () => { delete el.dataset.paused; el.dataset.born = String(Date.now()); });

  attachSwipe(el);
  host.prepend(el);
  const maxVisible = window.matchMedia('(max-width: 720px)').matches ? 2 : 3;
  [...host.querySelectorAll('.alert-toast')].slice(maxVisible).forEach(x => x.remove());
  syncDismissAll();
}

/** Remove expired toasts. Runs on an interval *and* when the tab returns, since background timers are throttled. */
function sweepToasts() {
  const host = toastHost();
  if (!host) return;
  const now = Date.now();
  host.querySelectorAll('.alert-toast').forEach(el => {
    if (el.dataset.paused) return;
    if (now - Number(el.dataset.born) > Number(el.dataset.ttl)) removeToast(el);
  });
}

// ── Badges, snooze, delivery entry point ─────────────────────────────────

function updateBadges() {
  const badge = document.getElementById('alertBadge');
  if (badge) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = unread === 0;
  }
  const bell = document.getElementById('alertBell');
  if (bell) {
    const snoozed = isSnoozed();
    bell.classList.toggle('snoozed', snoozed);
    bell.title = snoozed ? `Alerts snoozed until ${new Date(snoozeUntil).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}` : 'Alerts';
  }
  document.title = hiddenCount > 0 ? `(${hiddenCount}) ${baseTitle}` : baseTitle;
}

function logEvent(ev) {
  log.unshift({ ...ev, t: Date.now() });
  log = log.slice(0, LOG_MAX);
  unread += 1;
  if (document.hidden) hiddenCount += 1;
}

function interrupt(ev) {
  toast(ev);
  if (settings.sound) beep(ev.severity);
  desktopNotify(ev);
}

/** Called once per *new* snapshot. */
export function processAlerts(d, ctx = {}) {
  const { fired, notify } = engine.process(d, ctx, settings);
  if (fired.length === 0) return;
  fired.forEach(logEvent);
  saveLog();
  if (!isSnoozed()) notify.forEach(interrupt);
  updateBadges();
  renderLog();
}

export function snoozeAlerts(minutes) {
  snoozeUntil = minutes > 0 ? Date.now() + minutes * 60000 : 0;
  saveSnooze();
  if (minutes > 0) dismissAllToasts();
  updateBadges();
  renderSnooze();
}

// ── Drawer UI ────────────────────────────────────────────────────────────

const RULE_META = [
  { id: 'pcr', label: 'PCR changes zone', fields: [['hi', 'Bullish above', 0.05], ['lo', 'Bearish below', 0.05]] },
  { id: 'levels', label: 'Spot crosses CPR top/bottom or zero-gamma', fields: [] },
  { id: 'walls', label: 'Spot breaks / OI wall shifts (max call / put)', fields: [] },
  { id: 'gex', label: 'Gamma regime flips (positive / negative)', fields: [] },
  { id: 'flow', label: 'Smart-money flow & fast OI builds', fields: [] },
  { id: 'momentum', label: 'Fast spot move in 5 min', fields: [['pct', 'Move ≥ (%)', 0.05]] },
  { id: 'vix', label: 'India VIX spike', fields: [['pct', 'Day change ≥ (%)', 0.5]] },
  { id: 'regime', label: 'Composite regime label changes (noisy)', fields: [] }
];

function hm(t) {
  return new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

function renderLog() {
  const host = document.getElementById('alertLogList');
  if (!host) return;
  host.textContent = '';
  if (log.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'al-empty';
    empty.textContent = 'No alerts yet. They appear here when something changes between snapshots.';
    host.append(empty);
    return;
  }
  log.forEach(ev => {
    const row = document.createElement('div');
    row.className = `al-row sev-${ev.severity}`;
    const top = document.createElement('div');
    top.className = 'al-top';
    const title = document.createElement('span');
    title.className = 'al-title';
    title.textContent = ev.title;
    const time = document.createElement('span');
    time.className = 'al-time';
    time.textContent = hm(ev.t);
    top.append(title, time);
    const body = document.createElement('div');
    body.className = 'al-body';
    body.textContent = ev.body;
    row.append(top, body);
    host.append(row);
  });
}

function renderSnooze() {
  const host = document.getElementById('alertSnooze');
  if (!host) return;
  host.textContent = '';
  const mk = (text, onClick, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.className = cls;
    b.addEventListener('click', onClick);
    return b;
  };
  const label = document.createElement('span');
  label.className = 'snooze-label';
  if (isSnoozed()) {
    label.textContent = `Snoozed until ${new Date(snoozeUntil).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} (still logged)`;
    host.append(label, mk('Resume', () => snoozeAlerts(0)));
  } else {
    label.textContent = 'Mute pop-ups:';
    host.append(label, mk('15 min', () => snoozeAlerts(15)), mk('1 hour', () => snoozeAlerts(60)), mk('Rest of day', () => snoozeAlerts(8 * 60)));
  }
}

function permissionText() {
  if (typeof Notification === 'undefined') return 'Not supported in this browser';
  return { granted: 'Allowed', denied: 'Blocked. Change it in your browser site settings', default: 'Not asked yet' }[Notification.permission];
}

function renderSettings() {
  const host = document.getElementById('alertSettingsPane');
  if (!host) return;
  host.textContent = '';

  const mkCheck = (label, checked, onChange, note) => {
    const wrap = document.createElement('label');
    wrap.className = 'as-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    if (note) {
      const n = document.createElement('small');
      n.textContent = note;
      wrap.append(n);
    }
    return wrap;
  };
  const mkNumber = (label, value, step, onChange) => {
    const wrap = document.createElement('label');
    wrap.className = 'as-num';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(step);
    input.min = '0';
    input.value = String(value);
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v) && v >= 0) onChange(v);
      else input.value = String(value);
    });
    wrap.append(span, input);
    return wrap;
  };
  const heading = text => {
    const h = document.createElement('div');
    h.className = 'as-h';
    h.textContent = text;
    return h;
  };
  const button = (text, onClick, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };

  host.append(heading('Delivery'));
  host.append(mkCheck('Enable alerts', settings.enabled, v => { settings.enabled = v; saveSettings(); }));

  const level = document.createElement('label');
  level.className = 'as-num';
  const levelText = document.createElement('span');
  levelText.textContent = 'Pop up / beep / notify for';
  const sel = document.createElement('select');
  [['info', 'Everything'], ['warn', 'Warnings and above'], ['high', 'High severity only']].forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    o.selected = settings.notifyLevel === v;
    sel.append(o);
  });
  sel.addEventListener('change', () => { settings.notifyLevel = sel.value; saveSettings(); });
  level.append(levelText, sel);
  host.append(level);

  host.append(mkCheck('Play a sound', settings.sound, v => {
    settings.sound = v;
    saveSettings();
    if (v) beep('info'); // user gesture also unlocks audio
  }));
  host.append(mkCheck('Desktop notifications when this tab is in the background', settings.desktop, async v => {
    settings.desktop = v;
    if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
    saveSettings();
    renderSettings();
  }, `Permission: ${permissionText()}`));
  host.append(mkNumber('Repeat the same alert at most every (min)', settings.cooldownMin, 1, v => { settings.cooldownMin = v; saveSettings(); }));

  host.append(heading('What to alert on'));
  RULE_META.forEach(meta => {
    const rule = settings.rules[meta.id];
    const block = document.createElement('div');
    block.className = 'as-rule';
    block.append(mkCheck(meta.label, rule.on, v => { rule.on = v; saveSettings(); }));
    if (meta.fields.length) {
      const fields = document.createElement('div');
      fields.className = 'as-fields';
      meta.fields.forEach(([f, label, step]) => fields.append(mkNumber(label, rule[f], step, v => { rule[f] = v; saveSettings(); })));
      block.append(fields);
    }
    host.append(block);
  });

  const actions = document.createElement('div');
  actions.className = 'as-actions';
  actions.append(
    button('Send test alert', () => {
      const ev = { key: 'test', severity: 'warn', title: 'Test alert', body: 'If you can see this (and hear it, if sound is on), alerts are working.' };
      logEvent(ev);
      saveLog();
      updateBadges();
      renderLog();
      interrupt(ev);
    }),
    button('Reset to defaults', () => {
      settings = mergeSettings(DEFAULT_SETTINGS);
      saveSettings();
      renderSettings();
    }, 'as-danger')
  );
  host.append(actions);

  const note = document.createElement('p');
  note.className = 'as-note';
  note.textContent = 'Alerts are evaluated in this browser on each new NSE snapshot (about once a minute), so they only fire while a dashboard tab is open. A change must hold for two snapshots before it alerts, and values hovering near a threshold stay quiet. Settings and the log are stored in this browser only.';
  host.append(note);
}

function setTab(name) {
  document.getElementById('alertLogPane').hidden = name !== 'log';
  document.getElementById('alertSettingsPane').hidden = name !== 'settings';
  document.querySelectorAll('#alertsDrawer .ad-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
}

export function toggleAlertsDrawer(force) {
  const drawer = document.getElementById('alertsDrawer');
  if (!drawer) return;
  const open = typeof force === 'boolean' ? force : !drawer.classList.contains('open');
  drawer.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  document.getElementById('alertsBackdrop')?.classList.toggle('open', open);
  if (open) {
    announcePanelOpen('alerts');
    unread = 0;
    hiddenCount = 0;
    dismissAllToasts();
    updateBadges();
    renderLog();
    renderSettings();
    renderSnooze();
  }
}

export function initAlerts() {
  baseTitle = document.title;

  const toasts = document.createElement('div');
  toasts.id = 'alertToasts';
  toasts.setAttribute('aria-live', 'polite');
  const dismissAll = document.createElement('button');
  dismissAll.type = 'button';
  dismissAll.id = 'alertDismissAll';
  dismissAll.textContent = 'Dismiss all';
  dismissAll.hidden = true;
  dismissAll.addEventListener('click', dismissAllToasts);
  toasts.append(dismissAll);

  const backdrop = document.createElement('div');
  backdrop.id = 'alertsBackdrop';
  backdrop.addEventListener('click', () => toggleAlertsDrawer(false));

  const drawer = document.createElement('aside');
  drawer.id = 'alertsDrawer';
  drawer.setAttribute('aria-hidden', 'true');
  drawer.innerHTML = `
    <div class="ad-head">
      <strong>Alerts</strong>
      <div class="ad-tabs">
        <button type="button" class="ad-tab active" data-tab="log">Log</button>
        <button type="button" class="ad-tab" data-tab="settings">Settings</button>
      </div>
      <button type="button" class="ad-close" aria-label="Close alerts">✕</button>
    </div>
    <div id="alertSnooze" class="ad-snooze"></div>
    <div id="alertLogPane">
      <div class="ad-toolbar"><button type="button" id="alertClear">Clear log</button></div>
      <div id="alertLogList"></div>
    </div>
    <div id="alertSettingsPane" hidden></div>`;
  document.body.append(backdrop, toasts, drawer);

  drawer.querySelector('.ad-close').addEventListener('click', () => toggleAlertsDrawer(false));
  drawer.querySelectorAll('.ad-tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
  drawer.querySelector('#alertClear').addEventListener('click', () => { log = []; saveLog(); renderLog(); });
  attachDrawerSwipe(drawer, () => toggleAlertsDrawer(false));
  onOtherPanelOpen('alerts', () => toggleAlertsDrawer(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { toggleAlertsDrawer(false); dismissAllToasts(); } });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (hiddenCount) { hiddenCount = 0; updateBadges(); }
      sweepToasts();
    }
  });
  setInterval(sweepToasts, 1000);

  renderLog();
  renderSnooze();
  updateBadges();
}
