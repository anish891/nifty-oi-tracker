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


let timelineChart = null;

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const istHm = t => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

/** Spot on the left axis, one selectable metric on the right. Updates in place to avoid flicker. */
export function renderTimelineChart(canvasId, points, metricKey, metricLabel) {
  if (!window.Chart) return;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const labels = points.map(p => istHm(p.t));
  const spot = points.map(p => p.spot);
  const metric = points.map(p => (p[metricKey] === undefined ? null : p[metricKey]));
  const accent = cssVar('--accent') || '#3b82f6';
  const warn = cssVar('--warn') || '#f59e0b';
  const muted = cssVar('--muted') || '#6b7280';
  const grid = cssVar('--border') || 'rgba(255,255,255,0.07)';

  if (!timelineChart) {
    timelineChart = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets: [] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        elements: { point: { radius: 0, hoverRadius: 4 }, line: { borderWidth: 2, tension: 0.2 } },
        plugins: { legend: { labels: { color: muted, boxWidth: 10, font: { size: 11 } } } },
        scales: { x: { ticks: { color: muted, maxTicksLimit: 8, font: { size: 10 } }, grid: { color: grid } } }
      }
    });
  }

  const chart = timelineChart;
  chart.data.labels = labels;
  chart.data.datasets = [
    { label: 'Spot', data: spot, borderColor: accent, yAxisID: 'y' },
    { label: metricLabel, data: metric, borderColor: warn, yAxisID: 'y1', spanGaps: true }
  ];
  chart.options.plugins.legend.labels.color = muted;
  chart.options.scales.x.ticks.color = muted;
  chart.options.scales.x.grid.color = grid;
  chart.options.scales.y = { position: 'left', ticks: { color: accent, font: { size: 10 } }, grid: { color: grid } };
  chart.options.scales.y1 = { position: 'right', ticks: { color: warn, font: { size: 10 } }, grid: { drawOnChartArea: false } };
  chart.update('none');
}

let oiChart = null;

// Vertical reference lines (spot, max pain, ...) drawn at a fractional position between strike bars.
const oiMarkerPlugin = {
  id: 'oiMarkers',
  afterDatasetsDraw(chart) {
    const markers = chart.$oiMarkers || [];
    const strikes = chart.data.labels;
    const x = chart.scales.x;
    if (!markers.length || !strikes.length || !x) return;
    const { ctx, chartArea } = chart;

    const pixelAt = (value) => {
      if (value < strikes[0] || value > strikes[strikes.length - 1]) return null;
      let i = strikes.findIndex(k => k >= value);
      if (i <= 0) return x.getPixelForValue(0);
      const lo = strikes[i - 1];
      const frac = (value - lo) / (strikes[i] - lo || 1);
      return x.getPixelForValue(i - 1) + frac * (x.getPixelForValue(i) - x.getPixelForValue(i - 1));
    };

    ctx.save();
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    let row = 0;
    markers.forEach(m => {
      const px = pixelAt(m.value);
      if (px === null) return;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(m.dash || []);
      ctx.beginPath();
      ctx.moveTo(px, chartArea.top);
      ctx.lineTo(px, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = `${m.label} ${m.value.toLocaleString('en-IN')}`;
      const w = ctx.measureText(label).width + 8;
      const lx = Math.min(Math.max(px - w / 2, chartArea.left), chartArea.right - w);
      const ly = chartArea.top + 2 + (row++ % 3) * 14;
      ctx.fillStyle = m.color;
      ctx.fillRect(lx, ly, w, 13);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx + 4, ly + 2);
    });
    ctx.restore();
  }
};

/**
 * Grouped bars per strike: calls (bear colour) vs puts (bull colour).
 * series = { strikes: number[], calls: (number|null)[], puts: (number|null)[], diverging: boolean }
 */
export function renderOiChart(canvasId, series, markers = []) {
  if (!window.Chart) return;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const bear = cssVar('--bear') || '#ef4444';
  const bull = cssVar('--bull') || '#10b981';
  const muted = cssVar('--muted') || '#6b7280';
  const grid = cssVar('--border') || 'rgba(255,255,255,0.07)';

  if (!oiChart) {
    oiChart = new window.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels: [], datasets: [] },
      plugins: [oiMarkerPlugin],
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        onClick(evt, elements, chart) {
          if (!elements.length) return;
          const strike = Number(chart.data.labels[elements[0].index]);
          if (strike) window.dispatchEvent(new CustomEvent('strike-click', { detail: strike }));
        },
        onHover(evt, elements) {
          evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
        },
        plugins: {
          legend: { labels: { color: muted, boxWidth: 10, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              title: items => `Strike ${Number(items[0].label).toLocaleString('en-IN')}`,
              label: item => {
                const v = item.parsed.y;
                if (v === null || v === undefined) return `${item.dataset.label}: —`;
                return `${item.dataset.label}: ${v > 0 && item.chart.$diverging ? '+' : ''}${fmtK(v)}`;
              }
            }
          }
        },
        scales: {
          x: { ticks: { color: muted, font: { size: 10 }, callback(v) { return Number(this.getLabelForValue(v)).toLocaleString('en-IN'); } }, grid: { display: false } },
          y: { ticks: { color: muted, font: { size: 10 }, callback: v => fmtK(v) }, grid: { color: grid } }
        }
      }
    });
  }

  const chart = oiChart;
  chart.$oiMarkers = markers;
  chart.$diverging = !!series.diverging;
  chart.data.labels = series.strikes;
  chart.data.datasets = [
    { label: 'Calls', data: series.calls, backgroundColor: bear, borderRadius: 2, maxBarThickness: 22 },
    { label: 'Puts', data: series.puts, backgroundColor: bull, borderRadius: 2, maxBarThickness: 22 }
  ];
  chart.options.plugins.legend.labels.color = muted;
  chart.options.scales.x.ticks.color = muted;
  chart.options.scales.y.ticks.color = muted;
  chart.options.scales.y.grid.color = grid;
  chart.update('none');
}
