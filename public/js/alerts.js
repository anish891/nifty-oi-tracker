import { DEFAULT_SETTINGS, mergeSettings, evaluateRules } from './alert-rules.js';

// Alerts UI: evaluates rules on every new snapshot, then delivers via toast, bell log, optional
// sound and optional desktop notification. Settings and the log live in localStorage only.

const SETTINGS_KEY = 'alertSettings';
const LOG_KEY = 'alertLog';
const LOG_MAX = 100;

let settings = loadSettings();
let log = loadLog();
let ruleState = null;
let unread = 0;
let hiddenCount = 0;
let baseTitle = '';
let audioCtx = null;
const lastFired = new Map(); // event key -> timestamp (cooldown)

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

export function alertsEnabled() {
  return settings.enabled;
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
  try { new Notification(ev.title, { body: ev.body, tag: ev.key }); } catch (e) { /* ignore */ }
}

function toast(ev) {
  const host = document.getElementById('alertToasts');
  if (!host) return;
  // The open drawer already shows the new entry; a toast on top of it is just noise.
  const drawer = document.getElementById('alertsDrawer');
  if (drawer && drawer.classList.contains('open')) return;
  const el = document.createElement('div');
  el.className = `alert-toast sev-${ev.severity}`;
  const t = document.createElement('div');
  t.className = 'at-title';
  t.textContent = ev.title;
  const b = document.createElement('div');
  b.className = 'at-body';
  b.textContent = ev.body;
  el.append(t, b);
  el.addEventListener('click', () => el.remove());
  host.prepend(el);
  while (host.children.length > 4) host.lastChild.remove();
  setTimeout(() => el.remove(), ev.severity === 'high' ? 15000 : 8000);
}

function updateBadges() {
  const badge = document.getElementById('alertBadge');
  if (badge) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = unread === 0;
  }
  document.title = hiddenCount > 0 ? `(${hiddenCount}) ${baseTitle}` : baseTitle;
}

function fire(ev) {
  const entry = { ...ev, t: Date.now() };
  log.unshift(entry);
  log = log.slice(0, LOG_MAX);
  saveLog();
  unread += 1;
  if (document.hidden) hiddenCount += 1;
  toast(ev);
  if (settings.sound) beep(ev.severity);
  desktopNotify(ev);
  updateBadges();
  renderLog();
}

/** Called once per *new* snapshot. Always advances state so enabling alerts never replays old news. */
export function processAlerts(d, ctx = {}) {
  const { events, next } = evaluateRules(ruleState, d, ctx, settings);
  ruleState = next;
  if (!settings.enabled) return;

  const now = Date.now();
  const cooldown = settings.cooldownMin * 60 * 1000;
  events.forEach(ev => {
    const last = lastFired.get(ev.key);
    if (last && now - last < cooldown) return;
    lastFired.set(ev.key, now);
    fire(ev);
  });
}

// ── Drawer UI ────────────────────────────────────────────────────────────

const RULE_META = [
  { id: 'pcr', label: 'PCR changes zone', fields: [['hi', 'Bullish above', 0.05], ['lo', 'Bearish below', 0.05]] },
  { id: 'levels', label: 'Spot crosses CPR top/bottom or zero-gamma', fields: [] },
  { id: 'walls', label: 'Spot breaks / OI wall shifts (max call / put)', fields: [] },
  { id: 'gex', label: 'Gamma regime flips (positive ↔ negative)', fields: [] },
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

function permissionText() {
  if (typeof Notification === 'undefined') return 'Not supported in this browser';
  return { granted: 'Allowed', denied: 'Blocked — change it in your browser site settings', default: 'Not asked yet' }[Notification.permission];
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
    button('Send test alert', () => fire({
      key: 'test', severity: 'warn', title: 'Test alert', body: 'If you can see this (and hear it, if sound is on), alerts are working.'
    })),
    button('Reset to defaults', () => {
      settings = mergeSettings(DEFAULT_SETTINGS);
      saveSettings();
      renderSettings();
    }, 'as-danger')
  );
  host.append(actions);

  const note = document.createElement('p');
  note.className = 'as-note';
  note.textContent = 'Alerts are evaluated in this browser on each new NSE snapshot (about once a minute), so they only fire while a dashboard tab is open. Settings and the log are stored in this browser only.';
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
  if (open) {
    unread = 0;
    hiddenCount = 0;
    document.getElementById('alertToasts')?.replaceChildren();
    updateBadges();
    renderLog();
    renderSettings();
  }
}

export function initAlerts() {
  baseTitle = document.title;

  const toasts = document.createElement('div');
  toasts.id = 'alertToasts';
  toasts.setAttribute('aria-live', 'polite');

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
    <div id="alertLogPane">
      <div class="ad-toolbar"><button type="button" id="alertClear">Clear log</button></div>
      <div id="alertLogList"></div>
    </div>
    <div id="alertSettingsPane" hidden></div>`;
  document.body.append(toasts, drawer);

  drawer.querySelector('.ad-close').addEventListener('click', () => toggleAlertsDrawer(false));
  drawer.querySelectorAll('.ad-tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
  drawer.querySelector('#alertClear').addEventListener('click', () => { log = []; saveLog(); renderLog(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleAlertsDrawer(false); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && hiddenCount) { hiddenCount = 0; updateBadges(); }
  });

  renderLog();
  updateBadges();
}
