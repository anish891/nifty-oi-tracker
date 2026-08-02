import { fetchOptionChainData, fetchSimilarSessionsData } from './api-client.js';
import { fmt, fmtK, fmtChg, pct, timeStr, getSmoothedBuildup } from './charts.js';

let currentData = null;
let prevData = null;
let intervalMs = 1500;
let timer = null;
let cdInterval = null;
let sortCol = null;
let sortDir = -1;
let selectedExpiry = null;
let cdRemaining = 5;
let fetchInProgress = false;

export async function fetchNow() {
  if (fetchInProgress) return;

  fetchInProgress = true;
  try {
    const data = await fetchOptionChainData(selectedExpiry);
    prevData = currentData;
    currentData = data;
    hideOverlay();
    renderAll();
    setLive(true);
  } catch (e) {
    setLive(false);
    console.error('Fetch failed:', e);
  } finally {
    fetchInProgress = false;
  }
}

export function setLive(ok) {
  const dot = document.getElementById('liveDot');
  const st = document.getElementById('statusText');
  if (dot) dot.classList.toggle('error', !ok);
  if (st) st.textContent = ok ? 'Live · auto-refresh every ' + (intervalMs / 1000) + 's' : 'Disconnected / Retrying…';
}

export function hideOverlay() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.classList.add('hidden');
}

export function renderAll() {
  if (!currentData) return;
  const d = currentData;

  // Expiry dropdown
  const sel = document.getElementById('expirySelect');
  if (sel && (sel.options.length <= 1 || sel.options[0].value === '')) {
    sel.innerHTML = d.allExpiries.map(e =>
      `<option value="${e}" ${e === d.expiry ? 'selected' : ''}>${e}</option>`
    ).join('');
  }
  const expLabel = document.getElementById('expiryLabel');
  if (expLabel) expLabel.textContent = d.expiry;

  // Metrics
  document.getElementById('mSpot').textContent = fmt(d.spot);
  document.getElementById('mATM').textContent = fmt(d.atm);

  const pcrEl = document.getElementById('mPCR');
  if (pcrEl) {
    pcrEl.textContent = d.pcr.toFixed(2);
    pcrEl.className = 'val ' + (d.pcr > 1.2 ? 'bull' : d.pcr < 0.8 ? 'bear' : 'warn');
  }
  document.getElementById('mPCRsub').textContent = d.pcr > 1.2 ? 'Bullish' : d.pcr < 0.8 ? 'Bearish' : 'Neutral';

  document.getElementById('mNtmPcr').textContent = d.ntmPcr !== undefined ? d.ntmPcr.toFixed(2) : '—';
  document.getElementById('mWeightedPcr').textContent = d.weightedPcr !== undefined ? d.weightedPcr.toFixed(2) : '—';

  if (d.lowerRange && d.upperRange) {
    document.getElementById('mExpectedRange').textContent = `${fmt(Math.round(d.lowerRange))} - ${fmt(Math.round(d.upperRange))}`;
  } else {
    document.getElementById('mExpectedRange').textContent = '—';
  }
  document.getElementById('mStraddlePrice').textContent = d.straddlePrice ? fmt(Math.round(d.straddlePrice)) : '—';

  document.getElementById('mCallOI').textContent = fmtK(d.totalCallOI);
  document.getElementById('mPutOI').textContent = fmtK(d.totalPutOI);
  document.getElementById('mCallChg').textContent = 'Chg: ' + fmtChg(d.totalCallChgOI);
  document.getElementById('mPutChg').textContent = 'Chg: ' + fmtChg(d.totalPutChgOI);

  document.getElementById('mMaxCall').textContent = fmt(d.maxCallOIStrike);
  document.getElementById('mResStrength').textContent = d.resistanceStrength !== undefined ? d.resistanceStrength : '—';

  document.getElementById('mMaxPut').textContent = fmt(d.maxPutOIStrike);
  document.getElementById('mSupStrength').textContent = d.supportStrength !== undefined ? d.supportStrength : '—';

  const skewEl = document.getElementById('mIvSkew');
  if (skewEl) {
    if (d.ivSkew !== undefined) {
      skewEl.textContent = (d.ivSkew > 0 ? '+' : '') + d.ivSkew.toFixed(1) + '%';
      skewEl.className = 'val ' + (d.ivSkew > 1 ? 'bull' : d.ivSkew < -1 ? 'bear' : 'warn');
      const skewSub = document.getElementById('mIvSkewSub');
      if (skewSub) {
        if (d.ivSkew > 1) {
          skewSub.textContent = 'PE IV higher (Fearful)';
          skewSub.className = 'sub bull';
        } else if (d.ivSkew < -1) {
          skewSub.textContent = 'CE IV higher (Greedy)';
          skewSub.className = 'sub bear';
        } else {
          skewSub.textContent = 'Balanced IV';
          skewSub.className = 'sub warn';
        }
      }
    } else {
      skewEl.textContent = '—';
      document.getElementById('mIvSkewSub').textContent = '—';
    }
  }

  const volBadge = document.getElementById('volRegimeBadge');
  if (d.volatilityRegime && volBadge) {
    const vr = d.volatilityRegime;
    volBadge.textContent = vr.badgeText;
    volBadge.className = 'vol-badge ' + (
      vr.regime === 'HIGH_IV' ? 'vol-high' :
        vr.regime === 'LOW_IV' ? 'vol-low' :
          vr.regime === 'NORMAL_IV' ? 'vol-normal' : 'vol-history'
    );

    if (vr.regime === 'INSUFFICIENT_HISTORY') {
      volBadge.title = `Need at least 5 sessions (Current: ${vr.sampleCount})`;
    } else {
      volBadge.title = `z = ${vr.zScore > 0 ? '+' : ''}${vr.zScore} | 20-day avg IV: ${vr.mean20}% | StdDev: ${vr.stddev20}% | Today: ${vr.todayIv}%`;
    }
  }

  document.getElementById('mMaxPain').textContent = fmt(d.maxPain);
  document.getElementById('mTime').textContent = timeStr(d.fetchedAt);

  if (d.cpr) {
    document.getElementById('mCprPivot').textContent = fmt(d.cpr.pivot);
    document.getElementById('mCprTc').textContent = fmt(d.cpr.tc);
    document.getElementById('mCprBc').textContent = fmt(d.cpr.bc);
    document.getElementById('mCprWidth').textContent = d.cpr.cprWidth;
    const cprTypeEl = document.getElementById('mCprType');
    if (cprTypeEl) {
      cprTypeEl.textContent = d.cpr.cprType;
      cprTypeEl.className = 'val ' + (d.cpr.cprType === 'NARROW' ? 'bull' : d.cpr.cprType === 'WIDE' ? 'bear' : 'warn');
    }

    document.getElementById('mCprR1').textContent = fmt(d.cpr.r1);
    document.getElementById('mCprS1').textContent = fmt(d.cpr.s1);
    document.getElementById('mCprR2').textContent = fmt(d.cpr.r2);
    document.getElementById('mCprS2').textContent = fmt(d.cpr.s2);
  }

  if (d.gex) {
    const netGexEl = document.getElementById('mNetGex');
    if (netGexEl) {
      netGexEl.textContent = (d.gex.totalGexCr >= 0 ? '+' : '') + d.gex.totalGexCr + ' Cr';
      netGexEl.className = 'val ' + (d.gex.totalGexCr >= 0 ? 'bull' : 'bear');
    }

    const gexRegimeEl = document.getElementById('mGexRegime');
    if (gexRegimeEl) {
      gexRegimeEl.textContent = d.gex.gexRegime === 'POSITIVE_GAMMA' ? 'Low Vol (Mean Revert)' : 'High Vol (Trend)';
      gexRegimeEl.className = 'sub ' + (d.gex.gexRegime === 'POSITIVE_GAMMA' ? 'bull' : 'bear');
    }

    document.getElementById('mZeroGamma').textContent = fmt(d.gex.zeroGammaLevel);
    document.getElementById('mGexDist').textContent = (d.gex.distToZeroGamma >= 0 ? '+' : '') + d.gex.distToZeroGamma + ' pts to flip';

    document.getElementById('mCallGex').textContent = d.gex.callGexCr;
    document.getElementById('mPutGex').textContent = d.gex.putGexCr;
  }

  const pcr = d.pcr;
  const pFill = document.getElementById('pcrFill');
  if (pFill) {
    pFill.style.width = Math.min(100, Math.round(pcr / 2 * 100)) + '%';
    pFill.style.background = pcr > 1.2 ? '#10b981' : pcr < 0.8 ? '#ef4444' : '#f59e0b';
  }
  document.getElementById('pcrVal').textContent = pcr.toFixed(2);
  const sentEl = document.getElementById('pcrSent');
  if (sentEl) {
    if (pcr > 1.2) { sentEl.textContent = 'Bullish'; sentEl.className = 'pcr-sent bull'; }
    else if (pcr < 0.8) { sentEl.textContent = 'Bearish'; sentEl.className = 'pcr-sent bear'; }
    else { sentEl.textContent = 'Neutral'; sentEl.className = 'pcr-sent warn'; }
  }

  if (d.compositeRegime) {
    const cr = d.compositeRegime;
    document.getElementById('regimeTitle').textContent = cr.regimeLabel;
    document.getElementById('regimeStrategy').textContent = 'Strategy: ' + cr.actionableStrategy;
    document.getElementById('regimeConfidence').textContent = `Confidence: ${cr.confidenceScore}%`;

    const biasBadge = document.getElementById('tacticalBiasBadge');
    if (biasBadge) {
      biasBadge.textContent = 'Bias: ' + cr.tacticalBias.replace('_', ' ');
      biasBadge.className = 'val ' + (
        cr.tacticalBias.includes('BULLISH') ? 'bull' :
          cr.tacticalBias.includes('BEARISH') ? 'bear' : 'warn'
      );
    }
  }

  const flowFeed = document.getElementById('flowAlertsFeed');
  if (flowFeed) {
    if (d.unusualActivity && d.unusualActivity.length > 0) {
      flowFeed.innerHTML = d.unusualActivity.map(a => `
        <span style="background: rgba(245,158,11,0.15); color: var(--warn); border: 1px solid rgba(245,158,11,0.3); border-radius: 4px; padding: 2px 8px; white-space: nowrap; font-weight: 600;">
          ${a.intensity === 'CRITICAL' ? '⚡' : '🔥'} ${a.summary}
        </span>
      `).join('');
    } else {
      flowFeed.innerHTML = '<span style="color: var(--muted);">No statistical volume/OI anomalies detected in recent ticks.</span>';
    }
  }

  fetchSimilarSessions();
  renderTable();
}

export async function fetchSimilarSessions() {
  try {
    const topMatches = await fetchSimilarSessionsData();
    const container = document.getElementById('similarSessionsList');
    if (!container || !topMatches || topMatches.length === 0) return;

    container.innerHTML = topMatches.map(m => `
      <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:4px 8px; border-radius:4px;">
        <div>
          <span style="font-weight:600;">${m.date}</span>
          <span style="color:var(--muted); font-size:9px; margin-left:4px;">(PCR ${m.closingPcr.toFixed(2)})</span>
        </div>
        <div style="font-weight:600;" class="${m.similarityPct > 90 ? 'bull' : m.similarityPct > 75 ? 'acc' : 'warn'}">
          ${m.similarityPct}% match
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to fetch similar sessions:', err);
  }
}

export function renderTable() {
  if (!currentData) return;
  const d = currentData;
  let rows = [...d.strikes];

  const maxCallOI = Math.max(...rows.map(r => r.CE?.openInterest || 0));
  const maxPutOI = Math.max(...rows.map(r => r.PE?.openInterest || 0));
  const maxCallChg = Math.max(...rows.map(r => Math.abs(r.CE?.changeinOpenInterest || 0)));
  const maxPutChg = Math.max(...rows.map(r => Math.abs(r.PE?.changeinOpenInterest || 0)));

  if (sortCol) {
    rows.sort((a, b) => {
      const av = getSortVal(a, sortCol);
      const bv = getSortVal(b, sortCol);
      return (av - bv) * sortDir;
    });
  }

  const atm = d.atm;
  const prevRows = prevData ? prevData.strikes : [];
  const prevMap = {};
  prevRows.forEach(r => { prevMap[r.strike] = r; });

  const tbody = document.getElementById('chainBody');
  if (!tbody) return;

  tbody.innerHTML = rows.map(r => {
    const ce = r.CE || {};
    const pe = r.PE || {};
    const prev = prevMap[r.strike] || {};
    const prevCE = prev.CE || {};
    const isATM = r.strike === atm;

    const cOI = ce.openInterest || 0;
    const pOI = pe.openInterest || 0;
    const cChg = ce.changeinOpenInterest || 0;
    const pChg = pe.changeinOpenInterest || 0;
    const cIV = ce.impliedVolatility || 0;
    const pIV = pe.impliedVolatility || 0;
    const cLTP = ce.lastPrice || 0;
    const pLTP = pe.lastPrice || 0;
    const cBid = ce.bidprice || 0;
    const cAsk = ce.askPrice || 0;
    const pBid = pe.bidprice || 0;
    const pAsk = pe.askPrice || 0;

    const cBD = getSmoothedBuildup(r.strike, cOI, cLTP, true);
    const pBD = getSmoothedBuildup(r.strike, pOI, pLTP, false);

    const cBarW = pct(cOI, maxCallOI);
    const pBarW = pct(pOI, maxPutOI);
    const cChgW = pct(cChg, maxCallChg);
    const pChgW = pct(pChg, maxPutChg);

    const cChgCls = cChg > 0 ? 'pos' : cChg < 0 ? 'neg' : 'zero';
    const pChgCls = pChg > 0 ? 'pos' : pChg < 0 ? 'neg' : 'zero';

    const flashCls = prevData ? (cChg > (prevCE.changeinOpenInterest || 0) ? 'flash-bull' : '') : '';

    const cAnomalyHtml = ce.anomaly && ce.anomaly.isAnomaly ? `<span class="anomaly-badge" title="Z-Score: ${ce.anomaly.zScore}">🔥 z=${ce.anomaly.zScore}</span>` : '';
    const pAnomalyHtml = pe.anomaly && pe.anomaly.isAnomaly ? `<span class="anomaly-badge" title="Z-Score: ${pe.anomaly.zScore}">🔥 z=${pe.anomaly.zScore}</span>` : '';

    const cFlowHtml = ce.unusualFlow ? `<span class="anomaly-badge" style="background:rgba(239,68,68,0.2); color:#f87171; border-color:rgba(239,68,68,0.4);" title="${ce.unusualFlow.summary}">⚡ ${ce.unusualFlow.volRatio}x Vol</span>` : '';
    const pFlowHtml = pe.unusualFlow ? `<span class="anomaly-badge" style="background:rgba(16,185,129,0.2); color:#34d399; border-color:rgba(16,185,129,0.4);" title="${pe.unusualFlow.summary}">⚡ ${pe.unusualFlow.volRatio}x Vol</span>` : '';

    const cGreeks = ce.greeks || {};
    const pGreeks = pe.greeks || {};

    const cGreeksTitle = cGreeks.delta !== undefined
      ? `Call Greeks:\nDelta (Δ): ${cGreeks.delta}\nGamma (Γ): ${cGreeks.gamma}\nVega (V): ₹${cGreeks.vega} / 1% IV\nTheta (Θ): ₹${cGreeks.theta} / day`
      : '';

    const pGreeksTitle = pGreeks.delta !== undefined
      ? `Put Greeks:\nDelta (Δ): ${pGreeks.delta}\nGamma (Γ): ${pGreeks.gamma}\nVega (V): ₹${pGreeks.vega} / 1% IV\nTheta (Θ): ₹${pGreeks.theta} / day`
      : '';

    return `
<tr class="${isATM ? 'atm-row' : ''} ${flashCls}" data-strike="${r.strike}">
  <td class="right">
    <div class="oi-bar-row">
      <span class="chg-val ${cChgCls}">${fmtChg(cChg)}</span>
      ${cAnomalyHtml}
      ${cFlowHtml}
      <div class="bar-track"><div class="bar-fill call-fill" style="width:${cChgW}%"></div></div>
      <span class="bd ${cBD.cls}">${cBD.label}</span>
    </div>
  </td>
  <td class="right">
    <div class="oi-bar-row">
      <span>${fmtK(cOI)}</span>
      <div class="bar-track"><div class="bar-fill call-fill" style="width:${cBarW}%"></div></div>
    </div>
  </td>
  <td class="right muted" title="${cGreeksTitle}">${cIV ? cIV.toFixed(1) + '%' : '—'}</td>
  <td class="right" title="${cGreeksTitle}">${cLTP ? cLTP.toFixed(2) : '—'}</td>
  <td class="right muted" style="font-size:11px;">${cBid ? cBid.toFixed(1) + ' / ' + cAsk.toFixed(1) : '—'}</td>

  <td class="strike-cell ${isATM ? 'atm-row' : ''}">
    ${fmt(r.strike)}${isATM ? '<span class="atm-tag">ATM</span>' : ''}
  </td>

  <td class="right muted" style="font-size:11px;">${pBid ? pBid.toFixed(1) + ' / ' + pAsk.toFixed(1) : '—'}</td>
  <td class="right" title="${pGreeksTitle}">${pLTP ? pLTP.toFixed(2) : '—'}</td>
  <td class="right muted" title="${pGreeksTitle}">${pIV ? pIV.toFixed(1) + '%' : '—'}</td>
  <td class="right">
    <div class="oi-bar-row left">
      <div class="bar-track"><div class="bar-fill put-fill" style="width:${pBarW}%"></div></div>
      <span>${fmtK(pOI)}</span>
    </div>
  </td>
  <td class="right">
    <div class="oi-bar-row left">
      <span class="bd ${pBD.cls}">${pBD.label}</span>
      <div class="bar-track"><div class="bar-fill put-fill" style="width:${pChgW}%"></div></div>
      ${pAnomalyHtml}
      ${pFlowHtml}
      <span class="chg-val ${pChgCls}">${fmtChg(pChg)}</span>
    </div>
  </td>
</tr>`;
  }).join('');
}

export function getSortVal(row, col) {
  const ce = row.CE || {};
  const pe = row.PE || {};
  const map = {
    callChgOI: ce.changeinOpenInterest || 0,
    callOI: ce.openInterest || 0,
    callIV: ce.impliedVolatility || 0,
    callLTP: ce.lastPrice || 0,
    callBid: ce.bidprice || 0,
    putChgOI: pe.changeinOpenInterest || 0,
    putOI: pe.openInterest || 0,
    putIV: pe.impliedVolatility || 0,
    putLTP: pe.lastPrice || 0,
    putBid: pe.bidprice || 0,
  };
  return map[col] !== undefined ? map[col] : row.strike;
}

export function sortTable(col) {
  if (sortCol === col) sortDir *= -1;
  else { sortCol = col; sortDir = -1; }
  renderTable();
}

export function startAutoRefresh() {
  clearInterval(timer);
  clearInterval(cdInterval);
  cdRemaining = intervalMs / 1000;

  timer = setInterval(() => {
    fetchNow();
    cdRemaining = intervalMs / 1000;
  }, intervalMs);

  cdInterval = setInterval(() => {
    cdRemaining = Math.max(0, cdRemaining - 1);
    const cdEl = document.getElementById('cdTimer');
    if (cdEl) cdEl.textContent = cdRemaining;
  }, 1000);

  const cdEl = document.getElementById('cdTimer');
  if (cdEl) cdEl.textContent = intervalMs / 1000;
}

export function onIntervalChange() {
  const sel = document.getElementById('intervalSelect');
  intervalMs = sel ? parseInt(sel.value, 10) : 1500;
  setLive(true);
  startAutoRefresh();
}

export function onExpiryChange() {
  const sel = document.getElementById('expirySelect');
  selectedExpiry = sel ? sel.value : null;
  fetchNow();
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const sel = document.getElementById('themeSelect');
  if (sel) sel.value = theme;
}

export function initTheme() {
  const saved = localStorage.getItem('oi_tracker_theme') || 'system';
  applyTheme(saved);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const current = localStorage.getItem('oi_tracker_theme') || 'system';
    if (current === 'system') {
      applyTheme('system');
    }
  });
}

export function onThemeSelectChange() {
  const sel = document.getElementById('themeSelect');
  const val = sel ? sel.value : 'system';
  localStorage.setItem('oi_tracker_theme', val);
  applyTheme(val);
}

export function exportCSV() {
  if (!currentData || !currentData.strikes) {
    alert('No data available to export yet!');
    return;
  }

  const headers = [
    'Call_Chg_OI', 'Call_OI', 'Call_IV', 'Call_LTP', 'Call_Bid', 'Call_Ask',
    'Strike',
    'Put_Bid', 'Put_Ask', 'Put_LTP', 'Put_IV', 'Put_OI', 'Put_Chg_OI'
  ];

  const csvRows = [headers.join(',')];

  currentData.strikes.forEach(r => {
    const ce = r.CE || {};
    const pe = r.PE || {};
    const row = [
      ce.changeinOpenInterest || 0,
      ce.openInterest || 0,
      ce.impliedVolatility || 0,
      ce.lastPrice || 0,
      ce.bidprice || 0,
      ce.askPrice || 0,
      r.strike,
      pe.bidprice || 0,
      pe.askPrice || 0,
      pe.lastPrice || 0,
      pe.impliedVolatility || 0,
      pe.openInterest || 0,
      pe.changeinOpenInterest || 0
    ];
    csvRows.push(row.join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const filename = `Nifty_OI_${currentData.expiry || 'chain'}_${new Date().toISOString().slice(0, 10)}.csv`;
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function takeSnapshot() {
  const btn = document.getElementById('btnSnapshot');
  const originalText = btn ? btn.textContent : '📷 Snapshot';
  if (btn) btn.textContent = '⏳ Capturing...';

  const captureWindow = async () => {
    const canvas = await window.html2canvas(document.body, {
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--bg') || '#0d0f14',
      scrollX: 0,
      scrollY: 0,
      scale: 1.5,
      useCORS: true
    });
    const image = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    const filename = `Nifty_OI_Snapshot_${new Date().toISOString().slice(0, 10)}.png`;
    link.download = filename;
    link.href = image;
    link.click();
  };

  try {
    if (typeof window.html2canvas === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      script.onload = async () => {
        await captureWindow();
        if (btn) btn.textContent = originalText;
      };
      script.onerror = () => {
        alert('Failed to load screenshot library.');
        if (btn) btn.textContent = originalText;
      };
      document.head.appendChild(script);
    } else {
      await captureWindow();
      if (btn) btn.textContent = originalText;
    }
  } catch (err) {
    console.error('Snapshot failed:', err);
    alert('Failed to capture snapshot.');
    if (btn) btn.textContent = originalText;
  }
}

// Global window exposure for inline event handlers
window.fetchNow = fetchNow;
window.onIntervalChange = onIntervalChange;
window.onExpiryChange = onExpiryChange;
window.onThemeSelectChange = onThemeSelectChange;
window.sortTable = sortTable;
window.exportCSV = exportCSV;
window.takeSnapshot = takeSnapshot;

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  fetchNow();
  startAutoRefresh();
});
