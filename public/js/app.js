import { fetchOptionChainData, fetchSimilarSessionsData, fetchIntradayData } from './api-client.js';
import { fmt, fmtK, fmtChg, pct, timeStr, getSmoothedBuildup, renderProbabilityChart, renderTimelineChart } from './charts.js';

let currentData = null;
let prevData = null;
let intervalMs = 3000;
let timer = null;
let cdInterval = null;
let sortCol = null;
let sortDir = -1;
let selectedExpiry = null;
let cdRemaining = 5;
let fetchInProgress = false;

// Server-side intraday history (survives page refresh / cold starts when storage is configured)
let intraday = null;
let intradayFetchedAt = 0;
let intradayExpiry = null;
let timelineMetric = 'pcr';
const INTRADAY_REFRESH_MS = 30000;
const METRIC_LABELS = {
  pcr: 'PCR', volPcr: 'Volume PCR', straddle: 'ATM Straddle', atmIv: 'ATM IV', ivSkew: 'IV Skew (25Δ RR)',
  vix: 'India VIX', gexCr: 'Net GEX (Cr)', callOI: 'Total Call OI', putOI: 'Total Put OI'
};

async function refreshIntraday(force = false) {
  const expiry = currentData && currentData.expiry;
  if (!expiry) return;
  const stale = Date.now() - intradayFetchedAt > INTRADAY_REFRESH_MS;
  if (!force && !stale && intradayExpiry === expiry) return;
  intradayFetchedAt = Date.now();
  intradayExpiry = expiry;
  try {
    intraday = await fetchIntradayData(expiry);
  } catch (e) {
    console.error('Intraday history fetch failed:', e);
    intraday = null;
  }
  if (currentData) {
    renderTimeline();
    renderFlowFeed(currentData);
  }
}

export function onTimelineMetricChange() {
  const sel = document.getElementById('timelineMetric');
  timelineMetric = sel ? sel.value : 'pcr';
  renderTimeline();
}

function renderTimeline() {
  const chip = document.getElementById('historyChip');
  const empty = document.getElementById('timelineEmpty');
  const points = intraday && intraday.expiry === (currentData && currentData.expiry) ? intraday.points || [] : [];

  if (chip) {
    if (!intraday) {
      chip.textContent = 'History: unavailable';
      chip.className = 'pill pill-warn';
    } else if (intraday.persistent) {
      chip.textContent = `History: saved · ${points.length} pts${intraday.date ? ' · ' + intraday.date : ''}`;
      chip.className = 'pill pill-bull';
    } else {
      chip.textContent = `History: in-memory · ${points.length} pts`;
      chip.className = 'pill pill-warn';
      chip.title = 'No storage configured — history is lost on restart/cold start. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.';
    }
  }

  if (points.length < 2) {
    if (empty) empty.textContent = intraday
      ? 'Collecting snapshots — one is stored each time NSE updates (about once a minute).'
      : 'Intraday history is unavailable right now.';
    if (points.length === 0) return;
  } else if (empty) {
    empty.textContent = '';
  }
  renderTimelineChart('timelineChart', points, timelineMetric, METRIC_LABELS[timelineMetric] || timelineMetric);
}

// Baseline snapshot (5m / 15m earlier) from server history, shaped like a local snapshot.
function serverSnapshot(name) {
  const b = intraday && intraday.baselines && intraday.baselines[name];
  if (!b || !currentData || intraday.expiry !== currentData.expiry) return null;
  const nowT = new Date(currentData.dataAsOf || currentData.fetchedAt).getTime();
  if (b.t >= nowT) return null;
  const strikes = {};
  Object.entries(b.strikes || {}).forEach(([k, [ce, pe]]) => { strikes[k] = { ceOI: ce, peOI: pe }; });
  return { pcr: b.pcr, totalCallOI: b.callOI, totalPutOI: b.putOI, strikes, timestamp: b.t };
}

export async function fetchNow() {
  if (fetchInProgress) return;

  fetchInProgress = true;
  try {
    const data = await fetchOptionChainData(selectedExpiry);
    const unchanged = currentData && data.fetchedAt === currentData.fetchedAt;
    if (!unchanged) {
      prevData = currentData;
      currentData = data;
      renderAll();
    }
    hideOverlay();
    setLive(true);
    refreshIntraday();
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
  if (st) st.textContent = ok ? (isMarketOpen() ? 'Live · auto-refresh every ' + (intervalMs / 1000) + 's' : 'Market closed · refreshing every 60s') : 'Disconnected / Retrying…';
}

export function hideOverlay() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.classList.add('hidden');
}

function updateKeyStrip(d) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('ksSpot', fmt(d.spot));
  set('ksAtm', fmt(d.atm));
  set('ksPcr', d.pcr.toFixed(2));
  set('ksVix', d.vix ? `${d.vix.last.toFixed(2)} ${d.vix.percentChange >= 0 ? '▲' : '▼'}${Math.abs(d.vix.percentChange).toFixed(1)}%` : '—');
  set('ksDay', d.day ? `${d.day.percentChange >= 0 ? '+' : ''}${d.day.percentChange.toFixed(2)}%` : '—');
  set('ksPain', fmt(d.maxPain));
  set('ksFut', d.impliedFuture ? `${fmt(d.impliedFuture)} (${d.basis >= 0 ? '+' : ''}${d.basis})` : '—');
  const dayEl = document.getElementById('ksDay');
  if (dayEl && d.day) dayEl.style.color = d.day.percentChange >= 0 ? 'var(--bull)' : 'var(--bear)';
  set('ksRegime', d.compositeRegime ? d.compositeRegime.regimeLabel : '—');
  document.body.classList.remove('is-loading');
  updateAge();
}

function updateAge() {
  const el = document.getElementById('ksAge');
  if (!el || !currentData) return;
  const sec = Math.max(0, Math.round((Date.now() - new Date(currentData.dataAsOf || currentData.fetchedAt).getTime()) / 1000));
  el.textContent = sec < 90 ? sec + 's ago' : sec < 5400 ? Math.round(sec / 60) + 'm ago' : (sec / 3600).toFixed(1) + 'h ago';
  el.classList.toggle('stale', sec > 120 && isMarketOpen());
}
setInterval(updateAge, 1000);

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

  updateKeyStrip(d);

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
  document.getElementById('mVolPcr').textContent = d.volPcr !== undefined ? d.volPcr.toFixed(2) : '—';

  if (d.lowerRange && d.upperRange) {
    document.getElementById('mExpectedRange').textContent = `${fmt(Math.round(d.lowerRange))} - ${fmt(Math.round(d.upperRange))}`;
  } else {
    document.getElementById('mExpectedRange').textContent = '—';
  }
  document.getElementById('mStraddlePrice').textContent = d.straddlePrice ? fmt(Math.round(d.straddlePrice)) : '—';

  // Populate ATM Straddle & Expected Move Calculator
  if (d.straddleDetails) {
    const sd = d.straddleDetails;
    const atmBadge = document.getElementById('straddleAtmBadge');
    if (atmBadge) atmBadge.textContent = `ATM: ${fmt(sd.atm)}`;
    const ceLtp = document.getElementById('straddleCeLtp');
    if (ceLtp) ceLtp.textContent = `CE: ₹${sd.ceLtp.toFixed(2)}`;
    const peLtp = document.getElementById('straddlePeLtp');
    if (peLtp) peLtp.textContent = `PE: ₹${sd.peLtp.toFixed(2)}`;
    const totalLtp = document.getElementById('straddleTotalLtp');
    if (totalLtp) totalLtp.textContent = `₹${sd.straddlePrice.toFixed(2)}`;
    const openPrice = document.getElementById('straddleOpenPrice');
    if (openPrice) openPrice.textContent = sd.prevCloseStraddle ? `₹${sd.prevCloseStraddle.toFixed(2)}` : '—';
    const dayChg = document.getElementById('straddleDayChg');
    if (dayChg) {
      dayChg.textContent = sd.prevCloseStraddle ? `${sd.decayPct >= 0 ? '+' : ''}${sd.decayPct.toFixed(1)}%` : '—';
      dayChg.style.color = sd.decayPct < 0 ? 'var(--bull)' : sd.decayPct > 0 ? 'var(--bear)' : 'var(--muted)';
    }
    const dailyMove = document.getElementById('straddleDailyMove');
    if (dailyMove) dailyMove.textContent = sd.dailyMove ? `±${sd.dailyMove.toFixed(0)}` : '—';

    const expMove = document.getElementById('straddleExpectedMove');
    if (expMove) expMove.textContent = `± ${sd.expectedMove.toFixed(1)} pts (${sd.expectedMovePct.toFixed(2)}%)`;
    const rangeBounds = document.getElementById('straddleRangeBounds');
    if (rangeBounds) rangeBounds.textContent = `${fmt(Math.round(sd.lowerRange))} - ${fmt(Math.round(sd.upperRange))}`;
    const lowerB = document.getElementById('straddleLowerBound');
    if (lowerB) lowerB.textContent = fmt(Math.round(sd.lowerRange));
    const upperB = document.getElementById('straddleUpperBound');
    if (upperB) upperB.textContent = fmt(Math.round(sd.upperRange));

    const decayBadge = document.getElementById('straddleDecayBadge');
    if (decayBadge) {
      if (sd.decayStatus === 'DECAYING') {
        decayBadge.textContent = `📉 ${Math.abs(sd.decayPct).toFixed(1)}% below prev session`;
        decayBadge.style.background = 'rgba(16,185,129,0.15)';
        decayBadge.style.color = 'var(--bull)';
      } else if (sd.decayStatus === 'EXPANDING') {
        decayBadge.textContent = `📈 ${Math.abs(sd.decayPct).toFixed(1)}% above prev session`;
        decayBadge.style.background = 'rgba(239,68,68,0.15)';
        decayBadge.style.color = 'var(--bear)';
      } else {
        decayBadge.textContent = `⚖️ Flat vs prev session (${sd.decayPct.toFixed(1)}%)`;
        decayBadge.style.background = 'var(--surface2)';
        decayBadge.style.color = 'var(--text)';
      }
    }

    const gaugeSpotLabel = document.getElementById('gaugeSpotLabel');
    const gaugeLowerLabel = document.getElementById('gaugeLowerLabel');
    const gaugeUpperLabel = document.getElementById('gaugeUpperLabel');
    const gaugeSpotMarker = document.getElementById('gaugeSpotMarker');

    if (gaugeSpotLabel) gaugeSpotLabel.textContent = fmt(d.spot);
    if (gaugeLowerLabel) gaugeLowerLabel.textContent = fmt(Math.round(sd.lowerRange));
    if (gaugeUpperLabel) gaugeUpperLabel.textContent = fmt(Math.round(sd.upperRange));

    if (gaugeSpotMarker && sd.upperRange > sd.lowerRange) {
      const rangeSpan = sd.upperRange - sd.lowerRange;
      let pct = ((d.spot - sd.lowerRange) / rangeSpan) * 100;
      pct = Math.max(0, Math.min(100, pct));
      gaugeSpotMarker.style.left = `${pct.toFixed(1)}%`;
    }
  }

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
      skewEl.className = 'val ' + (d.ivSkew > 1 ? 'bear' : d.ivSkew < -1 ? 'bull' : 'warn');
      const skewSub = document.getElementById('mIvSkewSub');
      if (skewSub) {
        if (d.ivSkew > 1) {
          skewSub.textContent = 'Puts richer (hedging demand)';
          skewSub.className = 'sub bear';
        } else if (d.ivSkew < -1) {
          skewSub.textContent = 'Calls richer (upside chasing)';
          skewSub.className = 'sub bull';
        } else {
          skewSub.textContent = 'Balanced IV';
          skewSub.className = 'sub warn';
        }
        if (d.ivSkewDetail) {
          skewSub.title = `${d.ivSkewMethod}: ${d.ivSkewDetail.putStrike}PE ${d.ivSkewDetail.putIv}% vs ${d.ivSkewDetail.callStrike}CE ${d.ivSkewDetail.callIv}%`;
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

    if (vr.source === 'VIX') {
      volBadge.title = `India VIX ${vr.vix} (${vr.vixChangePct >= 0 ? '+' : ''}${vr.vixChangePct}% today) | ATM IV ${vr.todayIv}% (${vr.atmIvVsVix >= 0 ? '+' : ''}${vr.atmIvVsVix} vs VIX). No stored IV history, so regime uses VIX level (≥20 high, ≤12 low).`;
    } else if (vr.regime === 'INSUFFICIENT_HISTORY') {
      volBadge.title = 'No IV history and VIX unavailable';
    } else {
      volBadge.title = `z = ${vr.zScore > 0 ? '+' : ''}${vr.zScore} | 20-day avg IV: ${vr.mean20}% | StdDev: ${vr.stddev20}% | Today: ${vr.todayIv}%`;
    }
  }

  document.getElementById('mMaxPain').textContent = fmt(d.maxPain);
  if (d.walls) {
    const fmtWalls = ws => ws.map(w => `${fmt(w.strike)} <span style="color:var(--muted)">(${fmtK(w.oi)})</span>`).join('<br>') || '—';
    document.getElementById('mWallsCall').innerHTML = fmtWalls(d.walls.calls);
    document.getElementById('mWallsPut').innerHTML = fmtWalls(d.walls.puts);
  }
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

    const srcEl = document.getElementById('cprSource');
    if (srcEl) {
      srcEl.textContent = d.cpr.source === 'PREV_SESSION' ? `· from ${d.cpr.basisDate} H/L/C` : '· ⚠ OI-estimate (prev-session data unavailable)';
      srcEl.style.color = d.cpr.source === 'PREV_SESSION' ? 'var(--muted)' : 'var(--warn)';
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

    document.getElementById('mZeroGamma').textContent = d.gex.zeroGammaLevel !== null ? fmt(d.gex.zeroGammaLevel) : 'None';
    document.getElementById('mGexDist').textContent = d.gex.distToZeroGamma !== null
      ? (d.gex.distToZeroGamma >= 0 ? '+' : '') + d.gex.distToZeroGamma + ' pts to flip'
      : 'No sign flip within ±1500 pts';

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
    document.getElementById('regimeConfidence').textContent = `Signal agreement: ${cr.confidenceScore}%`;

    const biasBadge = document.getElementById('tacticalBiasBadge');
    if (biasBadge) {
      biasBadge.textContent = 'Bias: ' + cr.tacticalBias.replace('_', ' ');
      biasBadge.className = 'bias-badge ' + (
        cr.tacticalBias.includes('BULLISH') ? 'bull' :
          cr.tacticalBias.includes('BEARISH') ? 'bear' : 'warn'
      );
    }
  }

  if (d.impliedProbability) {
    const ip = d.impliedProbability;
    const modeEl = document.getElementById('pdfModeStrike');
    if (modeEl) modeEl.textContent = fmt(ip.modeStrike);

    const range68El = document.getElementById('pdf68Range');
    if (range68El) range68El.textContent = `${fmt(ip.confidence68.lower)} - ${fmt(ip.confidence68.upper)}`;

    const range95El = document.getElementById('pdf95Range');
    if (range95El) range95El.textContent = `${fmt(ip.confidence95.lower)} - ${fmt(ip.confidence95.upper)}`;

    const stayEl = document.getElementById('pdfStayProbability');
    if (stayEl) stayEl.textContent = `${ip.stayProbabilityPct}%`;
  }

  if (d.mlPredictions) {
    const ml = d.mlPredictions;

    const signalBadge = document.getElementById('mlSignalBadge');
    if (signalBadge) {
      signalBadge.textContent = ml.directionalTrend.signal;
      signalBadge.style.background = ml.directionalTrend.signalClass === 'bull' ? 'rgba(16,185,129,0.15)' :
        ml.directionalTrend.signalClass === 'bear' ? 'rgba(239,68,68,0.15)' : 'var(--surface2)';
      signalBadge.style.color = ml.directionalTrend.signalClass === 'bull' ? 'var(--bull)' :
        ml.directionalTrend.signalClass === 'bear' ? 'var(--bear)' : 'var(--warn)';
    }

    const confEl = document.getElementById('mlDirectionConfidence');
    if (confEl) confEl.textContent = `Lean strength: ${ml.directionalTrend.confidence.toFixed(1)}%`;

    const barBull = document.getElementById('mlBarBull');
    const barNeut = document.getElementById('mlBarNeut');
    const barBear = document.getElementById('mlBarBear');

    if (barBull) barBull.style.width = `${ml.directionalTrend.bullishPct}%`;
    if (barNeut) barNeut.style.width = `${ml.directionalTrend.neutralPct}%`;
    if (barBear) barBear.style.width = `${ml.directionalTrend.bearishPct}%`;

    const pctBull = document.getElementById('mlPctBull');
    const pctNeut = document.getElementById('mlPctNeut');
    const pctBear = document.getElementById('mlPctBear');

    if (pctBull) pctBull.textContent = `${ml.directionalTrend.bullishPct}%`;
    if (pctNeut) pctNeut.textContent = `${ml.directionalTrend.neutralPct}%`;
    if (pctBear) pctBear.textContent = `${ml.directionalTrend.bearishPct}%`;

    const stateLabel = document.getElementById('mlStateLabel');
    if (stateLabel) {
      stateLabel.textContent = ml.marketState.stateLabel;
      stateLabel.style.color = ml.marketState.isHighVol ? '#a78bfa' : '#3b82f6';
    }

    const barBreakout = document.getElementById('mlBarBreakout');
    const barRangebound = document.getElementById('mlBarRangebound');

    if (barBreakout) barBreakout.style.width = `${ml.marketState.breakoutProbPct}%`;
    if (barRangebound) barRangebound.style.width = `${ml.marketState.rangeboundProbPct}%`;

    const pctBreakout = document.getElementById('mlPctBreakout');
    const pctRangebound = document.getElementById('mlPctRangebound');

    if (pctBreakout) pctBreakout.textContent = `${ml.marketState.breakoutProbPct}%`;
    if (pctRangebound) pctRangebound.textContent = `${ml.marketState.rangeboundProbPct}%`;
  }

  renderTradeSetup(d);


  recordSnapshot(d);
  renderFlowFeed(d);
  renderTimeline();
  fetchSimilarSessions();
  renderTable();
}

// --- Rate of Change (RoC) & Institutional Velocity Engine ---
const snapshotHistory = [];

function recordSnapshot(d) {
  if (!d) return;
  const now = Date.now();
  const strikesMap = {};
  if (d.strikes && Array.isArray(d.strikes)) {
    d.strikes.forEach(s => {
      strikesMap[s.strike] = {
        ceOI: s.CE?.openInterest || 0,
        peOI: s.PE?.openInterest || 0
      };
    });
  }

  snapshotHistory.push({
    timestamp: now,
    pcr: d.pcr || 0,
    totalCallOI: d.totalCallOI || 0,
    totalPutOI: d.totalPutOI || 0,
    strikes: strikesMap
  });

  // Maintain up to 16 minutes of rolling history (local fallback when server history is unavailable)
  const cutoff = now - 960000;
  while (snapshotHistory.length > 0 && snapshotHistory[0].timestamp < cutoff) {
    snapshotHistory.shift();
  }
}

function getSnapshotAgo(msAgo) {
  if (snapshotHistory.length < 2) return null;
  const now = Date.now();
  const targetTime = now - msAgo;
  let closest = snapshotHistory[0];
  let minDiff = Math.abs(closest.timestamp - targetTime);

  for (let i = 1; i < snapshotHistory.length; i++) {
    const diff = Math.abs(snapshotHistory[i].timestamp - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closest = snapshotHistory[i];
    }
  }

  const historySpan = now - snapshotHistory[0].timestamp;
  if (minDiff > 45000 && historySpan < msAgo - 30000) {
    if (historySpan >= 15000) return snapshotHistory[0];
    return null;
  }
  return closest;
}

function calculateAndRenderRoC(d) {
  const snap3m = getSnapshotAgo(180000);
  const snap5m = serverSnapshot('m5') || getSnapshotAgo(300000);
  const snap15m = serverSnapshot('m15') || getSnapshotAgo(900000);
  const snapOpen = serverSnapshot('open');

  const fmtDelta = (val, isPcr = false) => {
    if (val === null || val === undefined) return '—';
    if (isPcr) {
      const sign = val > 0 ? '+' : '';
      const color = val > 0.02 ? 'var(--bull)' : val < -0.02 ? 'var(--bear)' : 'var(--muted)';
      return `<span style="color:${color}">${sign}${val.toFixed(2)}</span>`;
    } else {
      const sign = val > 0 ? '+' : '';
      const color = val > 0 ? 'var(--bull)' : val < 0 ? 'var(--bear)' : 'var(--muted)';
      return `<span style="color:${color}">${sign}${fmtK(val)}</span>`;
    }
  };

  // PCR RoC (5m / 15m; tooltip adds change since the open when history has it)
  const diff = (snap, key, now) => (snap ? now - snap[key] : null);
  const pcrRocEl = document.getElementById('mPcrRoc');
  if (pcrRocEl) {
    pcrRocEl.innerHTML = `5m: ${fmtDelta(diff(snap5m, 'pcr', d.pcr), true)} | 15m: ${fmtDelta(diff(snap15m, 'pcr', d.pcr), true)}`;
    pcrRocEl.title = snapOpen ? `Since open: ${(d.pcr - snapOpen.pcr >= 0 ? '+' : '')}${(d.pcr - snapOpen.pcr).toFixed(2)}` : '';
  }

  // Call & Put OI RoC
  const callRocEl = document.getElementById('mCallRoc');
  if (callRocEl) {
    callRocEl.innerHTML = `5m: ${fmtDelta(diff(snap5m, 'totalCallOI', d.totalCallOI))} | 15m: ${fmtDelta(diff(snap15m, 'totalCallOI', d.totalCallOI))}`;
    callRocEl.title = snapOpen ? `Since open: ${fmtK(d.totalCallOI - snapOpen.totalCallOI)}` : '';
  }

  const putRocEl = document.getElementById('mPutRoc');
  if (putRocEl) {
    putRocEl.innerHTML = `5m: ${fmtDelta(diff(snap5m, 'totalPutOI', d.totalPutOI))} | 15m: ${fmtDelta(diff(snap15m, 'totalPutOI', d.totalPutOI))}`;
    putRocEl.title = snapOpen ? `Since open: ${fmtK(d.totalPutOI - snapOpen.totalPutOI)}` : '';
  }

  // Institutional Spike Detection (3-min & 5-min strike velocity)
  const spikeAlerts = [];
  const compSnap = snap5m || snap3m;
  if (compSnap && d.strikes && Array.isArray(d.strikes)) {
    const timeLabel = snap5m ? '5m' : 'recent';
    d.strikes.forEach(s => {
      const prevStrike = compSnap.strikes[s.strike];
      if (!prevStrike) return;

      const ceDelta = (s.CE?.openInterest || 0) - prevStrike.ceOI;
      const peDelta = (s.PE?.openInterest || 0) - prevStrike.peOI;

      if (peDelta >= 25000) {
        spikeAlerts.push({
          type: 'PUT_WRITING',
          summary: `⚡ Rapid Put Writing at ${s.strike}: +${fmtK(peDelta)} in ${timeLabel} (Bullish Support)`
        });
      } else if (peDelta <= -20000) {
        spikeAlerts.push({
          type: 'PUT_UNWINDING',
          summary: `⚠️ Rapid Put Unwinding at ${s.strike}: ${fmtK(peDelta)} in ${timeLabel} (Support Break)`
        });
      }

      if (ceDelta >= 25000) {
        spikeAlerts.push({
          type: 'CALL_WRITING',
          summary: `⚡ Rapid Call Writing at ${s.strike}: +${fmtK(ceDelta)} in ${timeLabel} (Bearish Wall)`
        });
      } else if (ceDelta <= -20000) {
        spikeAlerts.push({
          type: 'CALL_COVERING',
          summary: `🚀 Rapid Call Short Covering at ${s.strike}: ${fmtK(ceDelta)} in ${timeLabel} (Short Squeeze)`
        });
      }
    });
  }

  return spikeAlerts;
}

function renderFlowFeed(d) {
  const spikeAlerts = calculateAndRenderRoC(d);

  const flowFeed = document.getElementById('flowAlertsFeed');
  if (flowFeed) {
    const combinedAlerts = [];

    // Add 5m institutional spike alerts first
    spikeAlerts.forEach(s => {
      const isBull = s.type === 'PUT_WRITING' || s.type === 'CALL_COVERING';
      const color = isBull ? 'var(--bull)' : 'var(--bear)';
      const bg = isBull ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)';
      const border = isBull ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)';
      combinedAlerts.push(`
        <span style="background: ${bg}; color: ${color}; border: 1px solid ${border}; border-radius: 4px; padding: 2px 8px; white-space: nowrap; font-weight: 600;">
          ${s.summary}
        </span>
      `);
    });

    if (d.unusualActivity && d.unusualActivity.length > 0) {
      d.unusualActivity.forEach(a => {
        combinedAlerts.push(`
          <span style="background: rgba(245,158,11,0.15); color: var(--warn); border: 1px solid rgba(245,158,11,0.3); border-radius: 4px; padding: 2px 8px; white-space: nowrap; font-weight: 600;">
            ${a.intensity === 'CRITICAL' ? '⚡' : '🔥'} ${a.summary}
          </span>
        `);
      });
    }

    if (combinedAlerts.length > 0) {
      flowFeed.innerHTML = combinedAlerts.join('');
    } else {
      flowFeed.innerHTML = '<span style="color: var(--muted);">Scanning for 5m OI velocity & volume anomalies...</span>';
    }
  }

}

export async function fetchSimilarSessions() {
  try {
    const { topMatches, reason } = await fetchSimilarSessionsData();
    const container = document.getElementById('similarSessionsList');
    if (!container) return;
    if (!topMatches || topMatches.length === 0) {
      container.innerHTML = `<div style="color:var(--muted); text-align:center; padding:10px;">${reason || 'No matching sessions'}</div>`;
      return;
    }

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

  const htmls = rows.map(r => {
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

    const cBD = getSmoothedBuildup(r.strike, cOI, cLTP, true, cChg, ce.change || 0);
    const pBD = getSmoothedBuildup(r.strike, pOI, pLTP, false, pChg, pe.change || 0);

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

    const cGreeksClass = window.showGreeks ? '' : 'hidden-greeks';
    const cDeltaVal = cGreeks.delta !== undefined ? cGreeks.delta : '—';
    const cThetaVal = cGreeks.theta !== undefined ? `₹${cGreeks.theta}` : '—';
    const pDeltaVal = pGreeks.delta !== undefined ? pGreeks.delta : '—';
    const pThetaVal = pGreeks.theta !== undefined ? `₹${pGreeks.theta}` : '—';

    return `
<tr class="${isATM ? 'atm-row' : ''} ${flashCls}" data-strike="${r.strike}">
  <td class="right greeks-col ${cGreeksClass} ${cDeltaVal > 0.5 ? 'pos' : ''}" style="font-family:var(--mono); font-size:11px;">${cDeltaVal}</td>
  <td class="right greeks-col ${cGreeksClass} neg" style="font-family:var(--mono); font-size:11px;">${cThetaVal}</td>
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
  <td class="right greeks-col ${cGreeksClass} ${Math.abs(pDeltaVal) > 0.5 ? 'pos' : ''}" style="font-family:var(--mono); font-size:11px;">${pDeltaVal}</td>
  <td class="right greeks-col ${cGreeksClass} neg" style="font-family:var(--mono); font-size:11px;">${pThetaVal}</td>
</tr>`;
  });

  reconcileRows(tbody, rows.map(r => r.strike), htmls);
}

// Only touch rows whose markup changed; keep unchanged <tr> nodes in place.
const rowHtmlCache = new Map();
function reconcileRows(tbody, keys, htmls) {
  const existing = new Map();
  for (const tr of tbody.children) existing.set(tr.dataset.strike, tr);

  const tpl = document.createElement('template');
  const seen = new Set();
  let cursor = tbody.firstElementChild;

  keys.forEach((strike, i) => {
    const key = String(strike);
    seen.add(key);
    let tr = existing.get(key);

    if (!tr || rowHtmlCache.get(key) !== htmls[i]) {
      tpl.innerHTML = htmls[i].trim();
      const fresh = tpl.content.firstElementChild;
      if (tr) {
        if (tr === cursor) cursor = cursor.nextElementSibling;
        tr.replaceWith(fresh);
      }
      tr = fresh;
      rowHtmlCache.set(key, htmls[i]);
    }

    if (tr !== cursor) tbody.insertBefore(tr, cursor);
    else cursor = cursor.nextElementSibling;
  });

  for (const [key, tr] of existing) {
    if (!seen.has(key)) { tr.remove(); rowHtmlCache.delete(key); }
  }
}

export function getSortVal(row, col) {
  const ce = row.CE || {};
  const pe = row.PE || {};
  const cG = ce.greeks || {};
  const pG = pe.greeks || {};
  const map = {
    callDelta: cG.delta !== undefined ? cG.delta : 0,
    callTheta: cG.theta !== undefined ? cG.theta : 0,
    callChgOI: ce.changeinOpenInterest || 0,
    callOI: ce.openInterest || 0,
    callIV: ce.impliedVolatility || 0,
    callLTP: ce.lastPrice || 0,
    callBid: ce.bidprice || 0,
    putBid: pe.bidprice || 0,
    putLTP: pe.lastPrice || 0,
    putIV: pe.impliedVolatility || 0,
    putOI: pe.openInterest || 0,
    putChgOI: pe.changeinOpenInterest || 0,
    putDelta: pG.delta !== undefined ? pG.delta : 0,
    putTheta: pG.theta !== undefined ? pG.theta : 0,
  };
  return map[col] !== undefined ? map[col] : row.strike;
}

export function toggleGreeksView() {
  const chk = document.getElementById('toggleGreeksBtn');
  window.showGreeks = chk ? chk.checked : false;

  const callColspan = document.getElementById('callHeaderColspan');
  const putColspan = document.getElementById('putHeaderColspan');
  if (callColspan) callColspan.colSpan = window.showGreeks ? 7 : 5;
  if (putColspan) putColspan.colSpan = window.showGreeks ? 7 : 5;

  const greeksCols = document.querySelectorAll('.greeks-col');
  greeksCols.forEach(col => {
    col.classList.toggle('hidden-greeks', !window.showGreeks);
  });
}

export function sortTable(col) {
  if (sortCol === col) sortDir *= -1;
  else { sortCol = col; sortDir = -1; }
  renderTable();
}

function isMarketOpen() {
  // NSE cash hours: Mon-Fri 09:15-15:30 IST (with a small buffer)
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 10 && mins <= 15 * 60 + 40;
}

function scheduleNext() {
  clearTimeout(timer);
  // Closed market: data is static, poll slowly. Hidden tab: don't poll at all.
  if (document.hidden) return;
  const delay = isMarketOpen() ? intervalMs : Math.max(intervalMs, 60000);
  cdRemaining = Math.round(delay / 1000);
  timer = setTimeout(async () => {
    await fetchNow();
    scheduleNext();
  }, delay);
}

export function startAutoRefresh() {
  clearTimeout(timer);
  clearInterval(cdInterval);

  cdInterval = setInterval(() => {
    cdRemaining = Math.max(0, cdRemaining - 1);
    const cdEl = document.getElementById('cdTimer');
    if (cdEl) cdEl.textContent = cdRemaining;
  }, 1000);

  scheduleNext();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(timer);
  } else {
    fetchNow().then(scheduleNext); // catch up immediately on return
  }
});

export function onIntervalChange() {
  const sel = document.getElementById('intervalSelect');
  intervalMs = sel ? parseInt(sel.value, 10) : 3000;
  setLive(true);
  startAutoRefresh();
}

export function onExpiryChange() {
  const sel = document.getElementById('expirySelect');
  selectedExpiry = sel ? sel.value : null;
  intraday = null;
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

export async function exportPDF() {
  if (!currentData || !currentData.strikes) {
    alert('No data available to export yet!');
    return;
  }

  const btn = document.getElementById('btnPDF');
  const originalText = btn ? btn.textContent : '📄 PDF';
  if (btn) btn.textContent = '⏳ Generating PDF...';

  const generatePDF = async () => {
    const reportContainer = buildPdfReportElement(currentData);
    document.body.appendChild(reportContainer);

    try {
      const opt = {
        margin: [0.25, 0.25, 0.25, 0.25],
        filename: `Nifty_OI_Report_${new Date().toISOString().slice(0, 10)}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: 'in', format: 'a4', orientation: 'landscape', compress: true },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
      };

      if (window.html2pdf) {
        await window.html2pdf().set(opt).from(reportContainer).save();
      } else {
        throw new Error('PDF library failed to load');
      }
    } finally {
      if (document.body.contains(reportContainer)) {
        document.body.removeChild(reportContainer);
      }
    }
  };

  try {
    if (typeof window.html2pdf === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
      script.onload = async () => {
        try {
          await generatePDF();
        } catch (e) {
          console.error('PDF generation error:', e);
          alert('Failed to generate PDF document.');
        } finally {
          if (btn) btn.textContent = originalText;
        }
      };
      script.onerror = () => {
        alert('Failed to load PDF export library.');
        if (btn) btn.textContent = originalText;
      };
      document.head.appendChild(script);
    } else {
      await generatePDF();
      if (btn) btn.textContent = originalText;
    }
  } catch (err) {
    console.error('PDF export failed:', err);
    alert('Failed to export PDF.');
    if (btn) btn.textContent = originalText;
  }
}

function buildPdfReportElement(d) {
  const container = document.createElement('div');
  container.className = 'pdf-export-report';
  container.style.cssText = `
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    color: #0f172a;
    background: #ffffff;
    padding: 24px 32px;
    width: 1020px;
    margin: 0 auto;
    box-sizing: border-box;
    position: absolute;
    left: -9999px;
    top: 0;
  `;

  const dateStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const cr = d.compositeRegime || {};
  const sd = d.straddleDetails || {};
  const gex = d.gex || {};

  container.innerHTML = `
    <!-- Header Banner -->
    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 16px;">
      <div>
        <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em;">
          Nifty <span style="color: #2563eb;">OI</span> Analytics Report
        </h1>
        <div style="font-size: 11px; color: #64748b; margin-top: 3px;">
          Generated: <strong>${dateStr} IST</strong> | Expiry: <strong>${d.expiry || '—'}</strong>
        </div>
      </div>
      <div style="text-align: right;">
        <div style="font-size: 18px; font-weight: 800; color: #2563eb;">Spot: ${fmt(d.spot)}</div>
        <div style="font-size: 11px; color: #64748b;">ATM Strike: ${fmt(d.atm)}</div>
      </div>
    </div>

    <!-- Executive Summary Grid -->
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px;">
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px;">
        <div style="font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase;">Market Regime</div>
        <div style="font-size: 13px; font-weight: 700; color: #0f172a; margin-top: 2px;">${cr.regimeLabel || '—'}</div>
        <div style="font-size: 10px; color: #64748b; margin-top: 2px;">Bias: <strong style="color: #2563eb;">${(cr.tacticalBias || '—').replace('_', ' ')}</strong></div>
      </div>

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px;">
        <div style="font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase;">PCR & Sentiment</div>
        <div style="font-size: 16px; font-weight: 800; color: ${d.pcr > 1.2 ? '#059669' : d.pcr < 0.8 ? '#dc2626' : '#d97706'}; margin-top: 2px;">
          ${d.pcr ? d.pcr.toFixed(2) : '—'} <span style="font-size: 11px; font-weight: 600;">(${d.pcr > 1.2 ? 'Bullish' : d.pcr < 0.8 ? 'Bearish' : 'Neutral'})</span>
        </div>
        <div style="font-size: 10px; color: #64748b; margin-top: 2px;">Near ATM: ${d.ntmPcr ? d.ntmPcr.toFixed(2) : '—'} | Vol: ${d.volPcr ? d.volPcr.toFixed(2) : '—'}</div>
      </div>

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px;">
        <div style="font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase;">Max Pain & Key Levels</div>
        <div style="font-size: 16px; font-weight: 800; color: #d97706; margin-top: 2px;">${fmt(d.maxPain)}</div>
        <div style="font-size: 10px; color: #64748b; margin-top: 2px;">Res: <strong style="color:#dc2626;">${fmt(d.maxCallOIStrike)}</strong> | Sup: <strong style="color:#059669;">${fmt(d.maxPutOIStrike)}</strong></div>
      </div>

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px;">
        <div style="font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase;">Expected Range (to Expiry)</div>
        <div style="font-size: 13px; font-weight: 700; color: #0f172a; margin-top: 2px;">
          ${d.lowerRange ? fmt(Math.round(d.lowerRange)) : '—'} - ${d.upperRange ? fmt(Math.round(d.upperRange)) : '—'}
        </div>
        <div style="font-size: 10px; color: #64748b; margin-top: 2px;">Straddle: ₹${sd.straddlePrice ? sd.straddlePrice.toFixed(1) : '—'} (±${sd.expectedMove ? sd.expectedMove.toFixed(1) : '—'} pts)</div>
      </div>
    </div>

    <!-- Technical Levels Summary Table -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 14px;">
        <div style="font-size: 11px; font-weight: 700; color: #2563eb; margin-bottom: 6px; text-transform: uppercase;">Central Pivot Range (CPR)</div>
        <div style="font-size: 11px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">
          <div>Pivot (P): <strong>${d.cpr ? fmt(d.cpr.pivot) : '—'}</strong></div>
          <div>CPR Type: <strong>${d.cpr ? d.cpr.type : '—'}</strong></div>
          <div>TC: <strong>${d.cpr ? fmt(d.cpr.tc) : '—'}</strong></div>
          <div>BC: <strong>${d.cpr ? fmt(d.cpr.bc) : '—'}</strong></div>
          <div>R1: <strong style="color:#dc2626;">${d.cpr ? fmt(d.cpr.r1) : '—'}</strong></div>
          <div>S1: <strong style="color:#059669;">${d.cpr ? fmt(d.cpr.s1) : '—'}</strong></div>
        </div>
      </div>

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 14px;">
        <div style="font-size: 11px; font-weight: 700; color: #2563eb; margin-bottom: 6px; text-transform: uppercase;">Gamma Exposure (GEX)</div>
        <div style="font-size: 11px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">
          <div>Net GEX: <strong>${gex.netGexCr !== undefined ? gex.netGexCr + ' Cr' : '—'}</strong></div>
          <div>Regime: <strong>${gex.gexRegime || '—'}</strong></div>
          <div>Zero-Gamma: <strong style="color:#d97706;">${gex.zeroGammaLevel ? fmt(gex.zeroGammaLevel) : '—'}</strong></div>
          <div>Flip Dist: <strong>${gex.distToZeroGamma !== undefined ? gex.distToZeroGamma + ' pts' : '—'}</strong></div>
          <div>Call GEX: <strong style="color:#dc2626;">${gex.callGexCr !== undefined ? gex.callGexCr + ' Cr' : '—'}</strong></div>
          <div>Put GEX: <strong style="color:#059669;">${gex.putGexCr !== undefined ? gex.putGexCr + ' Cr' : '—'}</strong></div>
        </div>
      </div>
    </div>

    <!-- Option Chain Data Table -->
    <div style="margin-top: 14px;">
      <div style="font-size: 12px; font-weight: 700; color: #0f172a; margin-bottom: 8px;">
        Option Chain Overview (ATM ± 10 Strikes)
      </div>
      <table style="width: 100%; border-collapse: collapse; font-size: 10px; text-align: right;">
        <thead>
          <tr style="background: #0f172a; color: #ffffff;">
            <th colspan="4" style="padding: 6px; text-align: center; border: 1px solid #334155;">CALLS</th>
            <th style="padding: 6px; text-align: center; background: #2563eb; border: 1px solid #334155;">STRIKE</th>
            <th colspan="4" style="padding: 6px; text-align: center; border: 1px solid #334155;">PUTS</th>
          </tr>
          <tr style="background: #1e293b; color: #f8fafc;">
            <th style="padding: 5px; border: 1px solid #334155;">Chg OI</th>
            <th style="padding: 5px; border: 1px solid #334155;">OI</th>
            <th style="padding: 5px; border: 1px solid #334155;">IV%</th>
            <th style="padding: 5px; border: 1px solid #334155;">LTP</th>
            <th style="padding: 5px; text-align: center; border: 1px solid #334155;">Strike</th>
            <th style="padding: 5px; border: 1px solid #334155;">LTP</th>
            <th style="padding: 5px; border: 1px solid #334155;">IV%</th>
            <th style="padding: 5px; border: 1px solid #334155;">OI</th>
            <th style="padding: 5px; border: 1px solid #334155;">Chg OI</th>
          </tr>
        </thead>
        <tbody>
          ${(d.strikes || []).map(s => {


    const isAtm = s.strike === d.atm;
    const bg = isAtm ? '#dbeafe' : '#ffffff';
    const fontWeight = isAtm ? '700' : '400';
    const ceChg = s.CE?.changeinOpenInterest || 0;
    const peChg = s.PE?.changeinOpenInterest || 0;

    return `
              <tr style="background: ${bg}; font-weight: ${fontWeight}; border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 4px 6px; color: ${ceChg >= 0 ? '#059669' : '#dc2626'};">${fmtChg(ceChg)}</td>
                <td style="padding: 4px 6px;">${fmtK(s.CE?.openInterest || 0)}</td>
                <td style="padding: 4px 6px;">${(s.CE?.impliedVolatility || 0).toFixed(1)}%</td>
                <td style="padding: 4px 6px;">₹${(s.CE?.lastPrice || 0).toFixed(2)}</td>
                <td style="padding: 4px 6px; text-align: center; background: ${isAtm ? '#bfdbfe' : '#f1f5f9'}; font-weight: 700;">${s.strike}</td>
                <td style="padding: 4px 6px;">₹${(s.PE?.lastPrice || 0).toFixed(2)}</td>
                <td style="padding: 4px 6px;">${(s.PE?.impliedVolatility || 0).toFixed(1)}%</td>
                <td style="padding: 4px 6px;">${fmtK(s.PE?.openInterest || 0)}</td>
                <td style="padding: 4px 6px; color: ${peChg >= 0 ? '#059669' : '#dc2626'};">${fmtChg(peChg)}</td>
              </tr>
            `;
  }).join('')}
        </tbody>
      </table>
    </div>

    <!-- Footer Disclaimer -->
    <div style="margin-top: 20px; border-top: 1px solid #e2e8f0; padding-top: 8px; font-size: 9px; color: #94a3b8; text-align: center;">
      Report generated automatically by Nifty OI Tracker. Data sourced from NSE India. For analytical purposes only.
    </div>
  `;

  return container;
}

// Dropdown Menu Handlers
export function toggleExportMenu(e) {
  if (e) e.stopPropagation();
  const dd = document.getElementById('exportDropdown');
  if (dd) dd.classList.toggle('active');
}

export function closeExportMenu() {
  const dd = document.getElementById('exportDropdown');
  if (dd) dd.classList.remove('active');
}

document.addEventListener('click', (e) => {
  const dd = document.getElementById('exportDropdown');
  if (dd && !dd.contains(e.target)) {
    dd.classList.remove('active');
  }
});

export function renderTradeSetup(d) {
  if (!d) return;

  const todayBiasEl = document.getElementById('setupTodayBias');
  const keyTargetEl = document.getElementById('setupKeyTarget');
  const invalidationEl = document.getElementById('setupInvalidation');
  const optimalStrategyEl = document.getElementById('setupOptimalStrategy');
  const biasBadgeEl = document.getElementById('setupBiasBadge');

  if (!todayBiasEl || !keyTargetEl || !invalidationEl || !optimalStrategyEl) return;

  const spot = d.spot || 0;
  const pivot = d.cpr ? d.cpr.pivot : d.atm;
  const tc = d.cpr ? d.cpr.tc : pivot + 10;
  const bc = d.cpr ? d.cpr.bc : pivot - 10;
  const r1 = d.cpr ? d.cpr.r1 : pivot + 50;
  const s1 = d.cpr ? d.cpr.s1 : pivot - 50;
  const zeroGamma = d.gex ? d.gex.zeroGammaLevel : (bc || pivot - 30);
  const maxCall = d.maxCallOIStrike || (d.atm + 100);
  const maxPut = d.maxPutOIStrike || (d.atm - 100);
  const pcr = d.pcr || 1.0;
  const isPosGamma = d.gex ? (d.gex.totalGexCr >= 0) : true;
  const sd = d.straddleDetails || {};

  // Directional bias = agreement of three independent reads (each -1/0/+1):
  // price vs CPR, PCR, and the composite regime. Needs 2+ net votes, so Neutral is reachable.
  const cprPos = spot > tc ? 1 : spot < bc ? -1 : 0;
  const pcrPos = pcr > 1.2 ? 1 : pcr < 0.8 ? -1 : 0;
  const tb = d.compositeRegime ? d.compositeRegime.tacticalBias : '';
  const regimePos = tb.includes('BULL') ? 1 : tb.includes('BEAR') ? -1 : 0;
  const biasScore = cprPos + pcrPos + regimePos;
  const isBullish = biasScore >= 2;
  const isBearish = biasScore <= -2;

  let biasText = '';
  let biasBadgeText = '';
  let biasColor = 'var(--warn)';
  let biasBg = 'rgba(245,158,11,0.15)';

  if (isBullish) {
    biasText = `Bullish while above ${fmt(Math.round(tc))} (CPR top) · ${biasScore}/3 signals`;
    biasBadgeText = 'Bias: Bullish 📈';
    biasColor = 'var(--bull)';
    biasBg = 'rgba(16,185,129,0.15)';
  } else if (isBearish) {
    biasText = `Bearish while below ${fmt(Math.round(bc))} (CPR bottom) · ${Math.abs(biasScore)}/3 signals`;
    biasBadgeText = 'Bias: Bearish 📉';
    biasColor = 'var(--bear)';
    biasBg = 'rgba(239,68,68,0.15)';
  } else {
    biasText = `Neutral / Rangebound around ${fmt(Math.round(pivot))} (mixed signals, ${biasScore >= 0 ? '+' : ''}${biasScore}/3)`;
    biasBadgeText = 'Bias: Neutral ⚖️';
    biasColor = 'var(--warn)';
    biasBg = 'rgba(245,158,11,0.15)';
  }

  // Key Target
  let targetText = '';
  if (isBullish) {
    targetText = `${fmt(maxCall)} (Max Call Wall / Resistance)`;
  } else if (isBearish) {
    targetText = `${fmt(maxPut)} (Max Put Wall / Support)`;
  } else {
    targetText = `${fmt(maxCall)} Res / ${fmt(maxPut)} Sup`;
  }

  // Invalidation Level
  let invalidationText = '';
  if (zeroGamma && Math.abs(spot - zeroGamma) > 5) {
    invalidationText = `${fmt(zeroGamma)} (Zero-Gamma Flip Level)`;
  } else {
    invalidationText = isBullish
      ? `${fmt(Math.round(s1))} (S1 Support Level)`
      : `${fmt(Math.round(r1))} (R1 Resistance Level)`;
  }

  // Optimal Strategy
  let strategyText = '';
  if (isBullish) {
    if (isPosGamma) {
      strategyText = `Bull Put Spread / Buying dips near S1 Pivot (${fmt(Math.round(s1))})`;
    } else {
      strategyText = `Long Call / Bull Call Spread above ${fmt(Math.round(pivot))}`;
    }
  } else if (isBearish) {
    if (isPosGamma) {
      strategyText = `Bear Call Spread / Shorting rallies near R1 (${fmt(Math.round(r1))})`;
    } else {
      strategyText = `Long Put / Bear Put Spread below ${fmt(Math.round(pivot))}`;
    }
  } else {
    if (sd.lowerRange && sd.upperRange) {
      strategyText = `Iron Condor / Selling ATM Straddle (Range: ${fmt(Math.round(sd.lowerRange))} - ${fmt(Math.round(sd.upperRange))})`;
    } else {
      strategyText = `Iron Condor / Range Trade between ${fmt(maxPut)} & ${fmt(maxCall)}`;
    }
  }

  // Update DOM
  todayBiasEl.textContent = biasText;
  keyTargetEl.textContent = targetText;
  invalidationEl.textContent = invalidationText;
  optimalStrategyEl.textContent = strategyText;

  if (biasBadgeEl) {
    biasBadgeEl.textContent = biasBadgeText;
    biasBadgeEl.style.background = biasBg;
    biasBadgeEl.style.color = biasColor;
  }
}

// Global window exposure for inline event handlers
window.fetchNow = fetchNow;
window.onIntervalChange = onIntervalChange;
window.onExpiryChange = onExpiryChange;
window.onTimelineMetricChange = onTimelineMetricChange;
window.onThemeSelectChange = onThemeSelectChange;
window.sortTable = sortTable;
window.toggleGreeksView = toggleGreeksView;
window.exportCSV = exportCSV;
window.exportPDF = exportPDF;
window.takeSnapshot = takeSnapshot;
window.toggleExportMenu = toggleExportMenu;
window.closeExportMenu = closeExportMenu;

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  document.body.classList.add('is-loading');
  const tb = document.querySelector('.topbar');
  const syncTopbar = () => tb && document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
  syncTopbar();
  window.addEventListener('resize', syncTopbar);
  const adv = document.getElementById('advancedAnalytics');
  if (adv) {
    try { adv.open = localStorage.getItem('advOpen') === '1'; } catch (e) { /* storage unavailable */ }
    adv.addEventListener('toggle', () => {
      try { localStorage.setItem('advOpen', adv.open ? '1' : '0'); } catch (e) { /* ignore */ }
    });
  }
  fetchNow();
  startAutoRefresh();
});
