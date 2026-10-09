import { fetchStrikeHistory } from './api-client.js';
import { fmt, fmtK, fmtChg } from './charts.js';
import { hmIst, attachDrawerSwipe, announcePanelOpen, onOtherPanelOpen } from './ui-utils.js';

// Right-hand drawer: one strike's call/put OI, premium and IV across the day (sampled server-side).

let charts = [];
let openToken = 0; // guards against a slow response landing in a panel that has since moved on

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function destroyCharts() {
  charts.forEach(c => c.destroy());
  charts = [];
}

export function closeStrikePanel() {
  openToken += 1;
  document.getElementById('strikePanel')?.classList.remove('open');
  document.getElementById('strikePanel')?.setAttribute('aria-hidden', 'true');
  document.getElementById('strikeBackdrop')?.classList.remove('open');
  destroyCharts();
}

function statCell(label, ce, pe) {
  const cell = el('div', 'sp-stat');
  cell.append(el('div', 'sp-stat-label', label));
  const row = el('div', 'sp-stat-row');
  row.append(el('span', 'bear', ce), el('span', 'bull', pe));
  cell.append(row);
  return cell;
}

function renderHeader(body, strike, live, expiry, spot) {
  body.textContent = '';
  const title = el('div', 'sp-title');
  title.append(el('span', 'sp-strike', fmt(strike)));
  if (spot) {
    const dist = strike - spot;
    title.append(el('span', 'sp-dist', `${dist >= 0 ? '+' : ''}${fmt(Math.round(dist))} pts vs spot`));
  }
  title.append(el('span', 'sp-expiry', expiry));
  body.append(title);

  if (live) {
    const ce = live.CE || {};
    const pe = live.PE || {};
    const grid = el('div', 'sp-stats');
    grid.append(el('div', 'sp-legend'));
    grid.firstChild.append(el('span', 'bear', 'Call'), el('span', 'bull', 'Put'));
    grid.append(
      statCell('LTP', ce.lastPrice ? ce.lastPrice.toFixed(2) : '—', pe.lastPrice ? pe.lastPrice.toFixed(2) : '—'),
      statCell('Open interest', fmtK(ce.openInterest || 0), fmtK(pe.openInterest || 0)),
      statCell('Change in OI (day)', fmtChg(ce.changeinOpenInterest || 0), fmtChg(pe.changeinOpenInterest || 0)),
      statCell('IV', ce.impliedVolatility ? ce.impliedVolatility.toFixed(1) + '%' : '—', pe.impliedVolatility ? pe.impliedVolatility.toFixed(1) + '%' : '—'),
      statCell('Delta', ce.greeks ? String(ce.greeks.delta) : '—', pe.greeks ? String(pe.greeks.delta) : '—')
    );
    body.append(grid);
  }
}

function lineChart(host, title, labels, callData, putData, fmtTick) {
  const wrap = el('div', 'sp-chart');
  wrap.append(el('div', 'sp-chart-title', title));
  const holder = el('div', 'sp-canvas');
  const canvas = document.createElement('canvas');
  holder.append(canvas);
  wrap.append(holder);
  host.append(wrap);

  const muted = css('--muted') || '#6b7280';
  const grid = css('--border') || 'rgba(255,255,255,0.07)';
  const chart = new window.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Call', data: callData, borderColor: css('--bear') || '#ef4444', backgroundColor: 'transparent', spanGaps: true },
        { label: 'Put', data: putData, borderColor: css('--bull') || '#10b981', backgroundColor: 'transparent', spanGaps: true }
      ]
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      elements: { point: { radius: 0, hoverRadius: 3 }, line: { borderWidth: 2, tension: 0.2 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: i => `${i.dataset.label}: ${i.parsed.y === null ? '—' : fmtTick(i.parsed.y)}` } }
      },
      scales: {
        x: { ticks: { color: muted, maxTicksLimit: 6, font: { size: 10 } }, grid: { color: grid } },
        y: { ticks: { color: muted, font: { size: 10 }, callback: v => fmtTick(v) }, grid: { color: grid } }
      }
    }
  });
  charts.push(chart);
}

/**
 * @param {{expiry:string, strike:number, live?:object, spot?:number}} opts
 *   live = the current option-chain row for this strike (for the stat grid), spot = current spot.
 */
export async function openStrikePanel({ expiry, strike, live, spot }) {
  const panel = document.getElementById('strikePanel');
  const body = document.getElementById('strikeBody');
  if (!panel || !body) return;

  announcePanelOpen('strike');
  const token = ++openToken;
  destroyCharts();
  renderHeader(body, strike, live, expiry, spot);
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  document.getElementById('strikeBackdrop')?.classList.add('open');

  const status = el('div', 'sp-status', 'Loading the day…');
  body.append(status);

  let data;
  try {
    data = await fetchStrikeHistory(expiry, strike);
  } catch (err) {
    if (token !== openToken) return;
    status.textContent = 'Could not load history for this strike.';
    return;
  }
  if (token !== openToken) return;

  const samples = (data.samples || []).filter(s => s.t);
  if (samples.length < 2) {
    status.textContent = data.date
      ? 'Not enough stored snapshots for this strike yet — history builds up through the session.'
      : 'No stored history yet. Snapshots are recorded about once a minute while the market is open.';
    return;
  }
  status.remove();
  if (!window.Chart) return;

  const labels = samples.map(s => hmIst(s.t));
  const nz = v => (v > 0 ? v : null); // IV / price of 0 means "no quote", not a real zero
  lineChart(body, 'Open interest', labels, samples.map(s => s.ceOI), samples.map(s => s.peOI), v => fmtK(v));
  lineChart(body, 'Premium (LTP)', labels, samples.map(s => nz(s.ceLtp)), samples.map(s => nz(s.peLtp)), v => v.toFixed(1));
  lineChart(body, 'Implied volatility (%)', labels, samples.map(s => nz(s.ceIv)), samples.map(s => nz(s.peIv)), v => v.toFixed(1) + '%');
  const note = el('div', 'sp-note', `${data.date} · ${samples.length} snapshots (sampled across the session)`);
  body.append(note);
}

export function initStrikePanel() {
  const backdrop = el('div');
  backdrop.id = 'strikeBackdrop';
  backdrop.className = 'side-backdrop';
  backdrop.addEventListener('click', closeStrikePanel);

  const panel = document.createElement('aside');
  panel.id = 'strikePanel';
  panel.className = 'side-drawer';
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = `
    <div class="ad-head">
      <strong>Strike detail</strong>
      <button type="button" class="ad-close" aria-label="Close strike detail" style="margin-left:auto">✕</button>
    </div>
    <div id="strikeBody" class="sp-body"></div>`;
  document.body.append(backdrop, panel);

  panel.querySelector('.ad-close').addEventListener('click', closeStrikePanel);
  attachDrawerSwipe(panel, closeStrikePanel);
  onOtherPanelOpen('strike', closeStrikePanel);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeStrikePanel(); });
}
