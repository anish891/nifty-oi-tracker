export function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return n.toLocaleString('en-IN');
}

export function fmtK(n) {
  if (!n && n !== 0) return '—';
  if (Math.abs(n) >= 100000) return (n / 100000).toFixed(2) + 'L';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}

export function fmtChg(v) {
  if (v === undefined || v === null || isNaN(v)) return '—';
  return (v > 0 ? '+' : '') + fmtK(v);
}

export function pct(v, max) {
  return max > 0 ? Math.min(100, Math.round(Math.abs(v) / max * 100)) : 0;
}

export function timeStr(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Ring buffer for strike tick history (last 8 ticks)
const tickHistory = {
  CE: {},
  PE: {}
};

export function updateTickHistory(strike, oi, price, isCall) {
  const targetMap = isCall ? tickHistory.CE : tickHistory.PE;
  if (!targetMap[strike]) targetMap[strike] = [];
  const history = targetMap[strike];

  history.push({ oi, price, ts: Date.now() });
  if (history.length > 8) history.shift();
}

export function buildupSingle(chgOI, chgPrice, isCall) {
  const oiUp = chgOI >= 0;
  const priceUp = isCall ? chgPrice >= 0 : chgPrice < 0;
  if (oiUp) return priceUp ? { label: 'LONG BUILD', cls: 'bd-lb' } : { label: 'SHORT BUILD', cls: 'bd-sb' };
  return priceUp ? { label: 'SHORT COV', cls: 'bd-sc' } : { label: 'LONG UNWD', cls: 'bd-lu' };
}

export function getSmoothedBuildup(strike, currentOI, currentPrice, isCall, dayOiChg = 0, dayPriceChg = 0) {
  updateTickHistory(strike, currentOI, currentPrice, isCall);

  const history = isCall ? tickHistory.CE[strike] : tickHistory.PE[strike];

  // Intraday trend over the last few distinct snapshots, when there is one
  if (history && history.length >= 2) {
    const oldest = history[0];
    const newest = history[history.length - 1];
    const oiTrend = newest.oi - oldest.oi;
    const priceTrend = newest.price - oldest.price;
    if (oiTrend !== 0 || priceTrend !== 0) return buildupSingle(oiTrend, priceTrend, isCall);
  }

  // Otherwise classify on the day's change (NSE: OI change vs prev close, price change vs prev close).
  // Never default to "LONG BUILD" just because nothing has moved yet.
  if (dayOiChg === 0 && dayPriceChg === 0) return { label: '—', cls: '' };
  return buildupSingle(dayOiChg, dayPriceChg, isCall);
}

let pdfChartInstance = null;

export function renderProbabilityChart(canvasId, pdfData, spotPrice) {
  if (!window.Chart) return;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!pdfData || !pdfData.distribution || pdfData.distribution.length === 0) return;

  const labels = pdfData.distribution.map(d => d.strike);
  const data = pdfData.distribution.map(d => d.probabilityPct);

  const conf68Lower = pdfData.confidence68?.lower || spotPrice * 0.99;
  const conf68Upper = pdfData.confidence68?.upper || spotPrice * 1.01;

  const pointBackgroundColors = labels.map(strike => {
    if (strike === pdfData.modeStrike) return '#3b82f6';
    if (strike >= conf68Lower && strike <= conf68Upper) return 'rgba(16, 185, 129, 0.9)';
    return 'rgba(167, 139, 250, 0.5)';
  });

  const gradient = ctx.createLinearGradient(0, 0, 0, 200);
  gradient.addColorStop(0, 'rgba(139, 92, 246, 0.35)');
  gradient.addColorStop(1, 'rgba(139, 92, 246, 0.0)');

  if (pdfChartInstance) {
    pdfChartInstance.data.labels = labels;
    pdfChartInstance.data.datasets[0].data = data;
    pdfChartInstance.data.datasets[0].pointBackgroundColor = pointBackgroundColors;
    pdfChartInstance.data.datasets[0].pointRadius = labels.map(s => s === pdfData.modeStrike ? 6 : 3);
    pdfChartInstance.update('none');
    return;
  }

  pdfChartInstance = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Implied Density (%)',
          data: data,
          borderColor: '#8b5cf6',
          borderWidth: 2.5,
          backgroundColor: gradient,
          fill: true,
          tension: 0.35,
          pointRadius: labels.map(s => s === pdfData.modeStrike ? 6 : 3),
          pointBackgroundColor: pointBackgroundColors,
          pointHoverRadius: 7
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: (ctx) => `Probability: ${ctx.parsed.y}%`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8', font: { size: 10 } },
          title: { display: true, text: 'Nifty Strike Price', color: '#64748b', font: { size: 10 } }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#94a3b8',
            font: { size: 10 },
            callback: (val) => `${val}%`
          },
          title: { display: true, text: 'Implied Probability (%)', color: '#64748b', font: { size: 10 } },
          beginAtZero: true
        }
      }
    }
  });
}

