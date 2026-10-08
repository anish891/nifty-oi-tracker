const { getIndexSnapshot, getPivotBasis } = require('./market');
const history = require('./history');

// ── Tunables (override via env) ──────────────────────────────────────────
const RISK_FREE_RATE = parseFloat(process.env.RISK_FREE_RATE) || 0.065;
// NIFTY lot size changes by NSE circular. GEX magnitude scales linearly with it
// (sign, regime and zero-gamma level do not). Verify against the current contract spec.
const LOT_SIZE = parseInt(process.env.NIFTY_LOT_SIZE, 10) || 65;
const PCR_BULL = 1.2;
const PCR_BEAR = 0.8;

// Anomaly / flow detectors are fed *increments between distinct NSE snapshots*.
// (NSE's changeinOpenInterest and totalTradedVolume are cumulative for the day, so
// comparing them to their own history only ever detects "the day has progressed".)
const welfordStats = { CE: {}, PE: {} };
const MIN_ANOMALY_INCREMENT = 2000; // contracts; ignore statistically-odd but tiny moves

function updateWelfordZScore(key, increment, isCall, threshold = 2.5) {
  const targetMap = isCall ? welfordStats.CE : welfordStats.PE;
  if (!targetMap[key]) targetMap[key] = { count: 0, mean: 0, M2: 0 };
  const stat = targetMap[key];

  // Score against history *before* this sample so a spike doesn't dilute its own z-score.
  let result = { isAnomaly: false, zScore: 0 };
  if (stat.count >= 5) {
    const stddev = Math.sqrt(stat.M2 / (stat.count - 1));
    if (stddev > 0) {
      const z = (increment - stat.mean) / stddev;
      result = {
        isAnomaly: Math.abs(z) >= threshold && Math.abs(increment) >= MIN_ANOMALY_INCREMENT,
        zScore: Number(z.toFixed(2))
      };
    }
  }

  stat.count += 1;
  const delta = increment - stat.mean;
  stat.mean += delta / stat.count;
  stat.M2 += delta * (increment - stat.mean);
  return result;
}

const strikeTickBuffers = { CE: {}, PE: {} };

/**
 * volInc / oiInc are increments since the previous NSE snapshot.
 * Compared against the mean of *prior* increments (current sample excluded).
 */
function updateAndDetectUnusualFlow(strike, volInc, oiInc, isCall, key = strike) {
  const targetMap = isCall ? strikeTickBuffers.CE : strikeTickBuffers.PE;
  if (!targetMap[key]) targetMap[key] = [];
  const buf = targetMap[key];
  const oiAbs = Math.abs(oiInc);

  let result = null;
  if (buf.length >= 3) {
    const meanVol = buf.reduce((a, x) => a + x.volume, 0) / buf.length;
    const meanOi = buf.reduce((a, x) => a + x.oiChg, 0) / buf.length;
    const volRatio = meanVol > 0 ? volInc / meanVol : 1;
    const oiRatio = meanOi > 0 ? oiAbs / meanOi : 1;

    const isUnusual = (volRatio >= 2.5 && volInc >= 3000) || (volRatio >= 1.8 && oiRatio >= 2 && volInc >= 1500);
    if (isUnusual) {
      const type = isCall ? 'CE' : 'PE';
      result = {
        strike,
        optionType: type,
        volRatio: Number(volRatio.toFixed(1)),
        oiRatio: Number(oiRatio.toFixed(1)),
        intensity: (volRatio >= 4 || oiRatio >= 3.5) ? 'CRITICAL' : 'HIGH',
        volume: volInc,
        oiChg: oiInc,
        summary: `${strike} ${type}: ${volRatio.toFixed(1)}x Vol Surge (+${(volInc / 1000).toFixed(1)}k contracts)`
      };
    }
  }

  buf.push({ volume: volInc, oiChg: oiAbs });
  if (buf.length > 20) buf.shift();
  return result;
}

// Per-expiry state so switching expiries doesn't mix baselines or double-count a snapshot.
const flowState = { lastTs: {}, prev: {}, results: {}, recent: {} };
const FLOW_VISIBLE_MS = 3 * 60 * 1000;

function computeCompositeRegime(gexRegime, pcr, cprType, ivSkew, spot, maxPain) {
  const negGex = gexRegime === 'NEGATIVE_GAMMA';
  const narrow = cprType === 'NARROW';
  const bullPcr = pcr > PCR_BULL;
  const bearPcr = pcr < PCR_BEAR;
  const nearPain = maxPain > 0 && spot > 0 && Math.abs(spot - maxPain) / spot < 0.005;

  let regimeLabel;
  let tacticalBias;
  let actionableStrategy;
  const drivers = [];

  if (negGex && narrow) {
    regimeLabel = '⚡ EXPLOSIVE BREAKOUT SETUP';
    tacticalBias = bullPcr ? 'BULLISH_BREAKOUT' : bearPcr ? 'BEARISH_BREAKOUT' : 'VOLATILE_EXPANSION';
    drivers.push('Negative Market GEX (dealer hedging amplifies moves)', 'Narrow CPR (trend-day setup)');
    if (bullPcr || bearPcr) drivers.push(`PCR ${pcr.toFixed(2)} confirms ${bullPcr ? 'upside' : 'downside'}`);
    actionableStrategy = bullPcr ? 'Long Call Spreads / Breakout Continuation'
      : bearPcr ? 'Long Put Spreads / Momentum Shorts' : 'Long Straddle / Wait for Direction';
  } else if (negGex && bullPcr && spot > maxPain) {
    regimeLabel = '🚀 SHORT SQUEEZE RISK';
    tacticalBias = 'STRONG_BULLISH';
    drivers.push(`High PCR (${pcr.toFixed(2)})`, 'Negative gamma squeeze potential', 'Spot above Max Pain');
    actionableStrategy = 'Ride Upward Momentum with Trailing Stop Loss';
  } else if (negGex && bearPcr) {
    regimeLabel = '📉 GAMMA SLIDE / CAPITULATION';
    tacticalBias = 'STRONG_BEARISH';
    drivers.push(`Low PCR (${pcr.toFixed(2)}, heavy call writing)`, 'Negative gamma cascading liquidation');
    if (spot < maxPain) drivers.push('Spot below Max Pain');
    actionableStrategy = 'Buy Put Spreads / Fade Rallies into Resistance';
  } else if (negGex) {
    regimeLabel = '🌪️ VOLATILE TWO-WAY MOVES';
    tacticalBias = 'VOLATILE_EXPANSION';
    drivers.push('Negative Market GEX (moves get amplified)', `PCR ${pcr.toFixed(2)} is neutral — no directional edge`);
    actionableStrategy = 'Reduce size / Defined-risk long volatility';
  } else if (narrow) {
    regimeLabel = '🌀 COILED UNDER POSITIVE GAMMA';
    tacticalBias = 'NEUTRAL';
    drivers.push('Positive GEX (dealers dampen moves)', 'Narrow CPR (breakout candidate)');
    actionableStrategy = 'Wait for CPR break with volume; avoid naked short premium';
  } else {
    regimeLabel = '🎯 RANGE-BOUND PINNING';
    tacticalBias = bullPcr ? 'MILD_BULLISH' : bearPcr ? 'MILD_BEARISH' : 'RANGE_BOUND';
    drivers.push('Positive Market GEX (dealer mean reversion)', `${cprType} CPR (range day likely)`);
    if (nearPain) drivers.push('Spot pinned near Max Pain');
    if (ivSkew > 1.2) drivers.push('Elevated put skew (hedging demand)');
    actionableStrategy = 'Sell Premium (Iron Flys / Condors around Max Pain)';
  }

  // Agreement between independent signals, not a calibrated probability.
  const confidenceScore = Math.min(90, 45 + 15 * drivers.length);

  return { regimeLabel, tacticalBias, confidenceScore, primaryDrivers: drivers, actionableStrategy };
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  let prob = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x > 0) prob = 1 - prob;
  return prob;
}

function getDTEInYears(expiryStr) {
  if (!expiryStr) return 1 / 365;
  const parts = expiryStr.split('-');
  let expDate = new Date();
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthIdx = monthNames.findIndex(m => m.toLowerCase() === parts[1].toLowerCase());
    const year = parseInt(parts[2], 10);
    if (monthIdx !== -1) {
      expDate = new Date(Date.UTC(year, monthIdx, day, 10, 0, 0));
    } else {
      expDate = new Date(expiryStr);
    }
  } else {
    expDate = new Date(expiryStr);
  }
  const now = new Date();
  const diffMs = expDate.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 3600 * 24);
  return Math.max(0.00005, diffDays / 365);
}

function calculateOptionGamma(S, K, T, v, r = RISK_FREE_RATE) {
  if (S <= 0 || K <= 0 || T <= 0 || v <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));
  const gamma = normalPdf(d1) / (S * v * Math.sqrt(T));
  return isNaN(gamma) ? 0 : gamma;
}

function calculateOptionGreeks(S, K, T, v, isCall, r = RISK_FREE_RATE) {
  if (S <= 0 || K <= 0 || T <= 0 || v <= 0) {
    return { delta: 0, gamma: 0, vega: 0, theta: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;

  const pdfD1 = normalPdf(d1);
  const gamma = pdfD1 / (S * v * sqrtT);

  let delta = 0;
  let theta = 0;

  if (isCall) {
    delta = normalCdf(d1);
    const term1 = -(S * pdfD1 * v) / (2 * sqrtT);
    const term2 = r * K * Math.exp(-r * T) * normalCdf(d2);
    theta = (term1 - term2) / 365;
  } else {
    delta = normalCdf(d1) - 1;
    const term1 = -(S * pdfD1 * v) / (2 * sqrtT);
    const term2 = r * K * Math.exp(-r * T) * normalCdf(-d2);
    theta = (term1 + term2) / 365;
  }

  const vega = (S * sqrtT * pdfD1) * 0.01;

  return {
    delta: Number(delta.toFixed(3)),
    gamma: Number(gamma.toFixed(6)),
    vega: Number(vega.toFixed(2)),
    theta: Number(theta.toFixed(2))
  };
}

function computeCosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function extractFeatureVector(data) {
  const pcr = data.pcr || 1.0;
  const gexRegimeCode = data.gex?.gexRegime === 'POSITIVE_GAMMA' ? 1.0 : -1.0;
  const cprWidthPct = data.cpr?.cprWidthPct || 0.5;
  const ivSkew = data.ivSkew || 0;
  const totalCallChgCr = (data.totalCallChgOI || 0) / 10000000;
  const totalPutChgCr = (data.totalPutChgOI || 0) / 10000000;

  return [pcr, gexRegimeCode, cprWidthPct, ivSkew, totalCallChgCr, totalPutChgCr];
}

const WINDOW_SIZE = 20;
const MIN_SAMPLES = 5;
const Z_THRESHOLD = 1.5;

/**
 * Prefers z-score of ATM IV against stored session history (pastIvs, newest first).
 * Without history it falls back to India VIX levels — never to made-up numbers.
 */
async function computeVolatilityRegime(currentAtmIv, pastIvs = [], vix = null) {
  const count = pastIvs.length;
  if (count < MIN_SAMPLES) {
    if (vix && vix.last > 0) {
      const regime = vix.last >= 20 ? 'HIGH_IV' : vix.last <= 12 ? 'LOW_IV' : 'NORMAL_IV';
      const chg = vix.previousClose > 0 ? ((vix.last - vix.previousClose) / vix.previousClose) * 100 : 0;
      return {
        regime,
        badgeText: `VIX ${vix.last.toFixed(1)} ${chg >= 0 ? '▲' : '▼'}${Math.abs(chg).toFixed(1)}%`,
        source: 'VIX',
        zScore: null,
        todayIv: Number(currentAtmIv.toFixed(1)),
        vix: vix.last,
        vixChangePct: Number(chg.toFixed(2)),
        atmIvVsVix: Number((currentAtmIv - vix.last).toFixed(2)),
        sampleCount: count
      };
    }
    return {
      regime: 'INSUFFICIENT_HISTORY',
      badgeText: 'No IV history',
      source: 'NONE',
      zScore: null,
      todayIv: Number(currentAtmIv.toFixed(1)),
      sampleCount: count
    };
  }

  let mean = 0;
  let M2 = 0;
  for (let i = 0; i < count; i++) {
    const delta = pastIvs[i] - mean;
    mean += delta / (i + 1);
    M2 += delta * (pastIvs[i] - mean);
  }
  const stddev = count > 1 ? Math.sqrt(M2 / (count - 1)) : 0;
  const zScore = stddev > 0 ? (currentAtmIv - mean) / stddev : 0;

  const regime = zScore > Z_THRESHOLD ? 'HIGH_IV' : zScore < -Z_THRESHOLD ? 'LOW_IV' : 'NORMAL_IV';
  return {
    regime,
    badgeText: regime === 'HIGH_IV' ? 'High IV' : regime === 'LOW_IV' ? 'Low IV' : 'Normal IV',
    source: 'HISTORY',
    zScore: Number(zScore.toFixed(2)),
    todayIv: Number(currentAtmIv.toFixed(1)),
    mean20: Number(mean.toFixed(1)),
    stddev20: Number(stddev.toFixed(2)),
    sampleCount: count
  };
}

// ── Pure helpers (exported for tests) ────────────────────────────────────

/** Pivot, BC/TC (ordered so TC >= BC) and R/S levels from a session's H/L/C. */
function computeCPR(high, low, close, refPrice = close) {
  const pivot = (high + low + close) / 3;
  const mid = (high + low) / 2;
  const mirror = 2 * pivot - mid;
  const tc = Math.max(mid, mirror);
  const bc = Math.min(mid, mirror);
  const width = tc - bc;
  const widthPct = refPrice > 0 ? (width / refPrice) * 100 : 0;
  const range = high - low;
  return {
    pivot, tc, bc, width, widthPct,
    r1: 2 * pivot - low, s1: 2 * pivot - high,
    r2: pivot + range, s2: pivot - range
  };
}

// Heuristic thresholds on width as % of price (typical Nifty CPR is ~0.1-0.4% wide).
function classifyCPR(widthPct) {
  return widthPct < 0.15 ? 'NARROW' : widthPct > 0.35 ? 'WIDE' : 'AVERAGE';
}

/** Spot at which net GEX changes sign, nearest to current spot; null if it never does. */
function findZeroGamma(gexAt, spot, lo, hi, step = 10) {
  let prevS = null;
  let prevG = null;
  let best = null;
  for (let sPrice = lo; sPrice <= hi; sPrice += step) {
    const g = gexAt(sPrice);
    if (prevG !== null && ((prevG < 0 && g >= 0) || (prevG > 0 && g <= 0))) {
      const x = prevS + (0 - prevG) * (sPrice - prevS) / (g - prevG);
      if (best === null || Math.abs(x - spot) < Math.abs(best - spot)) best = x;
    }
    prevS = sPrice;
    prevG = g;
  }
  return best === null ? null : Math.round(best);
}

/**
 * 25-delta risk reversal: IV(25Δ put) - IV(25Δ call), in vol points.
 * Positive = puts richer (hedging demand). Far better than comparing CE/PE IV at one strike,
 * which mostly measures put-call parity noise.
 */
function computeRiskReversal25(strikes, spot, T, r = RISK_FREE_RATE) {
  if (!(T > 0) || !(spot > 0)) return null;
  let bestC = null;
  let bestP = null;
  const sqrtT = Math.sqrt(T);
  for (const s of strikes) {
    const K = s.strike;
    const cIv = (s.CE?.impliedVolatility || 0) / 100;
    const pIv = (s.PE?.impliedVolatility || 0) / 100;
    if (K > spot && cIv > 0) {
      const d1 = (Math.log(spot / K) + (r + 0.5 * cIv * cIv) * T) / (cIv * sqrtT);
      const diff = Math.abs(normalCdf(d1) - 0.25);
      if (!bestC || diff < bestC.diff) bestC = { diff, iv: cIv, strike: K };
    }
    if (K < spot && pIv > 0) {
      const d1 = (Math.log(spot / K) + (r + 0.5 * pIv * pIv) * T) / (pIv * sqrtT);
      const diff = Math.abs(normalCdf(d1) - 1 + 0.25);
      if (!bestP || diff < bestP.diff) bestP = { diff, iv: pIv, strike: K };
    }
  }
  if (!bestC || !bestP || bestC.diff > 0.12 || bestP.diff > 0.12) return null;
  return {
    value: (bestP.iv - bestC.iv) * 100,
    putStrike: bestP.strike,
    callStrike: bestC.strike,
    putIv: bestP.iv * 100,
    callIv: bestC.iv * 100
  };
}

function parseNseTimestamp(str) {
  if (!str) return null;
  const d = new Date(`${str.replace(/-/g, ' ')} GMT+0530`);
  return isNaN(d) ? null : d.toISOString();
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);
}

let cache = { data: null, ts: 0, expiry: null };
const CACHE_TTL = 5000; // 5s TTL (NSE data refreshes every ~30-60s)

async function processOptionChainData(raw, allExpiries, targetExpiry) {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL && cache.expiry === targetExpiry) {
    return cache.data;
  }

  const [indices, pivotBasis, sessions] = await Promise.all([
    withTimeout(getIndexSnapshot(), 2500),
    withTimeout(getPivotBasis(), 2500),
    withTimeout(history.getSessions(20).catch(() => []), 2000)
  ]);

  const spot = raw.records.underlyingValue || raw.records.data?.[0]?.CE?.underlyingValue || raw.records.data?.[0]?.PE?.underlyingValue || 0;
  const atm = Math.round(spot / 50) * 50;
  const MIN_STRIKE = atm - 500;
  const MAX_STRIKE = atm + 500;
  const T = getDTEInYears(targetExpiry);
  const dteDays = T * 365;
  const allExpiryRows = (raw.records.data || []).filter(r => (r.expiryDate || r.expiryDates) === targetExpiry);

  const allExpiryStrikesMap = {};
  allExpiryRows.forEach(r => {
    const strike = r.strikePrice;
    if (!allExpiryStrikesMap[strike]) allExpiryStrikesMap[strike] = { strike };
    if (r.CE) allExpiryStrikesMap[strike].CE = r.CE;
    if (r.PE) allExpiryStrikesMap[strike].PE = r.PE;
  });

  const allExpiryStrikes = Object.values(allExpiryStrikesMap).sort((a, b) => a.strike - b.strike);
  const strikes = allExpiryStrikes.filter(s => s.strike >= MIN_STRIKE && s.strike <= MAX_STRIKE);

  let totalCallOI = 0, totalPutOI = 0, totalCallChgOI = 0, totalPutChgOI = 0;
  let totalCallVol = 0, totalPutVol = 0;
  let maxCallOI = 0, maxPutOI = 0;
  let maxCallOIStrike = atm, maxPutOIStrike = atm;
  const unusualFlowAlerts = [];

  // New NSE snapshot? Only then do increments mean anything.
  const nseTs = raw.records.timestamp || null;
  const isNewSnapshot = nseTs === null || flowState.lastTs[targetExpiry] !== nseTs;
  flowState.lastTs[targetExpiry] = nseTs;

  const trackSide = (s, side, leg) => {
    const isCall = side === 'CE';
    const key = `${targetExpiry}|${s.strike}|${side}`;
    const chg = leg.changeinOpenInterest || 0;
    const vol = leg.totalTradedVolume || 0;

    if (isNewSnapshot) {
      const prev = flowState.prev[key];
      let anomaly = { isAnomaly: false, zScore: 0 };
      if (prev) {
        const oiInc = chg - prev.chg;
        const volInc = Math.max(0, vol - prev.vol);
        anomaly = updateWelfordZScore(key, oiInc, isCall);
        const flow = updateAndDetectUnusualFlow(s.strike, volInc, oiInc, isCall, key);
        if (flow) flowState.recent[key] = { flow, ts: now };
      }
      flowState.prev[key] = { chg, vol };
      flowState.results[key] = anomaly;
    }

    leg.anomaly = flowState.results[key] || { isAnomaly: false, zScore: 0 };
    const rec = flowState.recent[key];
    if (rec && now - rec.ts < FLOW_VISIBLE_MS) {
      leg.unusualFlow = rec.flow;
      unusualFlowAlerts.push(rec.flow);
    }
  };

  allExpiryStrikes.forEach(s => {
    const cOI = s.CE?.openInterest || 0;
    const pOI = s.PE?.openInterest || 0;
    totalCallOI += cOI;
    totalPutOI += pOI;
    totalCallChgOI += s.CE?.changeinOpenInterest || 0;
    totalPutChgOI += s.PE?.changeinOpenInterest || 0;
    totalCallVol += s.CE?.totalTradedVolume || 0;
    totalPutVol += s.PE?.totalTradedVolume || 0;

    if (s.CE) trackSide(s, 'CE', s.CE);
    if (s.PE) trackSide(s, 'PE', s.PE);

    if (cOI > maxCallOI) { maxCallOI = cOI; maxCallOIStrike = s.strike; }
    if (pOI > maxPutOI) { maxPutOI = pOI; maxPutOIStrike = s.strike; }
  });

  const topWalls = (side) => [...allExpiryStrikes]
    .filter(s => (s[side]?.openInterest || 0) > 0)
    .sort((a, b) => b[side].openInterest - a[side].openInterest)
    .slice(0, 3)
    .map(s => ({ strike: s.strike, oi: s[side].openInterest, chgOi: s[side].changeinOpenInterest || 0 }));
  const walls = { calls: topWalls('CE'), puts: topWalls('PE') };

  const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;
  const volPcr = totalCallVol > 0 ? totalPutVol / totalCallVol : 0;

  // ── ATM straddle & expected move ──
  const atmStrikeObj = allExpiryStrikes.find(s => s.strike === atm) || allExpiryStrikes[Math.floor(allExpiryStrikes.length / 2)];
  const atmCE = atmStrikeObj?.CE || {};
  const atmPE = atmStrikeObj?.PE || {};
  const atmCELTP = atmCE.lastPrice || 0;
  const atmPELTP = atmPE.lastPrice || 0;
  const straddlePrice = atmCELTP + atmPELTP;

  // 0.85 x straddle ≈ 1-sigma move to expiry. Scale by sqrt(trading days) for a per-day figure.
  const expectedMove = straddlePrice * 0.85;
  const tradingDaysLeft = Math.max(1, Math.round(dteDays * 5 / 7));
  const dailyMove = expectedMove / Math.sqrt(tradingDaysLeft);
  const upperRange = spot + expectedMove;
  const lowerRange = spot - expectedMove;
  const expectedMovePct = spot > 0 ? (expectedMove / spot) * 100 : 0;

  // Stateless day change: NSE gives each leg's change vs previous close, so we can rebuild
  // yesterday's ATM straddle (at yesterday's ATM strike) and compare like with like.
  const day = indices?.nifty || null;
  const prevAtmStrike = day?.previousClose ? Math.round(day.previousClose / 50) * 50 : atm;
  const prevAtmObj = allExpiryStrikes.find(s => s.strike === prevAtmStrike) || atmStrikeObj;
  const pCE = prevAtmObj?.CE || {};
  const pPE = prevAtmObj?.PE || {};
  const haveChg = typeof pCE.change === 'number' && typeof pPE.change === 'number' && pCE.lastPrice > 0 && pPE.lastPrice > 0;
  const prevCloseStraddle = haveChg ? (pCE.lastPrice - pCE.change) + (pPE.lastPrice - pPE.change) : null;
  const straddleDayChgPct = prevCloseStraddle > 0 ? ((straddlePrice - prevCloseStraddle) / prevCloseStraddle) * 100 : 0;
  const straddleDecayStatus = straddleDayChgPct < -0.5 ? 'DECAYING' : straddleDayChgPct > 0.5 ? 'EXPANDING' : 'STABLE';

  // Implied future from put-call parity at the ATM strike
  const impliedFuture = atmCELTP > 0 && atmPELTP > 0 && atmStrikeObj
    ? atmStrikeObj.strike + (atmCELTP - atmPELTP) * Math.exp(RISK_FREE_RATE * T)
    : null;

  // ── Near-the-money PCR (±3 strikes) ──
  const atmIndex = strikes.findIndex(s => s.strike === atm);
  let ntmCallOI = 0, ntmPutOI = 0;
  if (atmIndex !== -1) {
    for (let i = Math.max(0, atmIndex - 3); i <= Math.min(strikes.length - 1, atmIndex + 3); i++) {
      ntmCallOI += strikes[i].CE?.openInterest || 0;
      ntmPutOI += strikes[i].PE?.openInterest || 0;
    }
  }
  const ntmPcr = ntmCallOI > 0 ? ntmPutOI / ntmCallOI : 0;

  const resistanceStrength = totalCallOI > 0 ? (maxCallOI / totalCallOI) * 100 : 0;
  const supportStrength = totalPutOI > 0 ? (maxPutOI / totalPutOI) * 100 : 0;

  // ── Volatility ──
  const atmCeIv = atmCE.impliedVolatility || 0;
  const atmPeIv = atmPE.impliedVolatility || 0;
  const atmIv = atmCeIv > 0 && atmPeIv > 0 ? (atmCeIv + atmPeIv) / 2 : (atmCeIv || atmPeIv);
  const rr = computeRiskReversal25(allExpiryStrikes, spot, T);
  const ivSkew = rr ? rr.value : atmPeIv - atmCeIv;
  const ivSkewMethod = rr ? '25Δ risk reversal' : 'ATM put-call IV gap';

  // ── Max pain ──
  let maxPain = atm;
  let minTotalPain = Infinity;
  const nStrikes = allExpiryStrikes.length;
  if (nStrikes > 0) {
    const sumCE_OI = new Float64Array(nStrikes);
    const sumCE_W = new Float64Array(nStrikes);
    const sumPE_OI = new Float64Array(nStrikes);
    const sumPE_W = new Float64Array(nStrikes);
    let runCE_OI = 0, runCE_W = 0, runPE_OI = 0, runPE_W = 0;

    for (let i = 0; i < nStrikes; i++) {
      const cOI = allExpiryStrikes[i].CE?.openInterest || 0;
      const pOI = allExpiryStrikes[i].PE?.openInterest || 0;
      const k = allExpiryStrikes[i].strike;
      runCE_OI += cOI; runCE_W += cOI * k;
      sumCE_OI[i] = runCE_OI; sumCE_W[i] = runCE_W;
      runPE_OI += pOI; runPE_W += pOI * k;
      sumPE_OI[i] = runPE_OI; sumPE_W[i] = runPE_W;
    }
    const totalPE_OI = sumPE_OI[nStrikes - 1];
    const totalPE_W = sumPE_W[nStrikes - 1];

    for (let i = 0; i < nStrikes; i++) {
      const K = allExpiryStrikes[i].strike;
      const callLoss = K * (i > 0 ? sumCE_OI[i - 1] : 0) - (i > 0 ? sumCE_W[i - 1] : 0);
      const putLoss = (totalPE_W - sumPE_W[i]) - K * (totalPE_OI - sumPE_OI[i]);
      const totalPain = callLoss + putLoss;
      if (totalPain < minTotalPain) { minTotalPain = totalPain; maxPain = K; }
    }
  }

  // ── Black-Scholes GEX (dealers assumed long calls / short puts — a convention, not observed) ──
  function computeGexForSpot(S) {
    let totalGex = 0, callGexTotal = 0, putGexTotal = 0;
    allExpiryStrikes.forEach(s => {
      const cOI = s.CE?.openInterest || 0;
      const pOI = s.PE?.openInterest || 0;
      const cGamma = calculateOptionGamma(S, s.strike, T, (s.CE?.impliedVolatility || 0) / 100);
      const pGamma = calculateOptionGamma(S, s.strike, T, (s.PE?.impliedVolatility || 0) / 100);
      const callGex = cOI * LOT_SIZE * cGamma * S * S * 0.01;
      const putGex = pOI * LOT_SIZE * pGamma * S * S * 0.01;
      callGexTotal += callGex;
      putGexTotal += putGex;
      totalGex += callGex - putGex;
    });
    return { totalGex, callGexTotal, putGexTotal };
  }

  const { totalGex: currentGex, callGexTotal, putGexTotal } = computeGexForSpot(spot);
  const totalGexCr = currentGex / 1e7;
  const callGexCr = callGexTotal / 1e7;
  const putGexCr = putGexTotal / 1e7;
  const zeroGammaLevel = findZeroGamma(S => computeGexForSpot(S).totalGex, spot, Math.max(1000, atm - 1500), atm + 1500, 10);

  strikes.forEach(s => {
    if (s.CE) s.CE.greeks = calculateOptionGreeks(spot, s.strike, T, (s.CE.impliedVolatility || 0) / 100, true);
    if (s.PE) s.PE.greeks = calculateOptionGreeks(spot, s.strike, T, (s.PE.impliedVolatility || 0) / 100, false);
  });

  // ── CPR / pivots: previous session's real H/L/C; OI-wall estimate only as a labelled fallback ──
  let cprInput;
  let cprSource;
  if (pivotBasis) {
    cprInput = { high: pivotBasis.high, low: pivotBasis.low, close: pivotBasis.close };
    cprSource = 'PREV_SESSION';
  } else {
    cprInput = {
      high: Math.max(maxCallOIStrike, Math.round(upperRange)),
      low: Math.min(maxPutOIStrike, Math.round(lowerRange)),
      close: spot
    };
    cprSource = 'OI_ESTIMATE';
  }
  const cprCalc = computeCPR(cprInput.high, cprInput.low, cprInput.close, spot);
  const cprTypeVal = classifyCPR(cprCalc.widthPct);
  const gexRegimeVal = totalGexCr >= 0 ? 'POSITIVE_GAMMA' : 'NEGATIVE_GAMMA';

  const volatilityRegime = await computeVolatilityRegime(
    atmIv,
    (sessions || []).map(x => parseFloat(x.atm_iv)).filter(v => v > 0),
    indices?.vix || null
  );
  const compositeRegime = computeCompositeRegime(gexRegimeVal, pcr, cprTypeVal, ivSkew, spot, maxPain);
  const impliedProbability = computeImpliedProbabilityDistribution(allExpiryStrikes, spot, T);
  const mlPredictions = computeIntradayMLPredictions(
    spot, maxPain, zeroGammaLevel, totalGexCr, pcr, ivSkew, cprTypeVal, unusualFlowAlerts.length, { dteDays }
  );

  const r1 = n => Number(n.toFixed(1));

  const result = {
    spot,
    atm,
    expiry: targetExpiry,
    allExpiries,
    dteDays: Number(dteDays.toFixed(2)),
    dataAsOf: parseNseTimestamp(raw.records.timestamp),
    pcr: Number(pcr.toFixed(2)),
    ntmPcr: Number(ntmPcr.toFixed(2)),
    volPcr: Number(volPcr.toFixed(2)),
    straddlePrice: Number(straddlePrice.toFixed(2)),
    upperRange: Number(upperRange.toFixed(2)),
    lowerRange: Number(lowerRange.toFixed(2)),
    straddleDetails: {
      atm,
      ceLtp: Number(atmCELTP.toFixed(2)),
      peLtp: Number(atmPELTP.toFixed(2)),
      straddlePrice: Number(straddlePrice.toFixed(2)),
      expectedMove: Number(expectedMove.toFixed(2)),
      expectedMovePct: Number(expectedMovePct.toFixed(2)),
      dailyMove: Number(dailyMove.toFixed(1)),
      tradingDaysLeft,
      upperRange: Number(upperRange.toFixed(2)),
      lowerRange: Number(lowerRange.toFixed(2)),
      prevCloseStraddle: prevCloseStraddle !== null ? Number(prevCloseStraddle.toFixed(2)) : null,
      decayPct: Number(straddleDayChgPct.toFixed(2)),
      decayStatus: straddleDecayStatus
    },
    impliedFuture: impliedFuture !== null ? Number(impliedFuture.toFixed(1)) : null,
    basis: impliedFuture !== null ? Number((impliedFuture - spot).toFixed(1)) : null,
    resistanceStrength: Number(resistanceStrength.toFixed(1)),
    supportStrength: Number(supportStrength.toFixed(1)),
    ivSkew: Number(ivSkew.toFixed(2)),
    ivSkewMethod,
    ivSkewDetail: rr ? { putStrike: rr.putStrike, callStrike: rr.callStrike, putIv: Number(rr.putIv.toFixed(1)), callIv: Number(rr.callIv.toFixed(1)) } : null,
    atmIv: Number(atmIv.toFixed(2)),
    vix: indices?.vix ? { last: indices.vix.last, previousClose: indices.vix.previousClose, percentChange: indices.vix.percentChange } : null,
    day: day ? { open: day.open, high: day.high, low: day.low, previousClose: day.previousClose, percentChange: day.percentChange } : null,
    volatilityRegime,
    compositeRegime,
    impliedProbability,
    mlPredictions,
    unusualActivity: unusualFlowAlerts,
    maxPain,
    walls,
    gex: {
      totalGexCr: Number(totalGexCr.toFixed(2)),
      callGexCr: Number(callGexCr.toFixed(2)),
      putGexCr: Number(putGexCr.toFixed(2)),
      zeroGammaLevel,
      gexRegime: gexRegimeVal,
      distToZeroGamma: zeroGammaLevel !== null ? Number((spot - zeroGammaLevel).toFixed(1)) : null,
      lotSize: LOT_SIZE
    },
    cpr: {
      pivot: r1(cprCalc.pivot),
      tc: r1(cprCalc.tc),
      bc: r1(cprCalc.bc),
      cprWidth: r1(cprCalc.width),
      cprWidthPct: Number(cprCalc.widthPct.toFixed(2)),
      cprType: cprTypeVal,
      r1: r1(cprCalc.r1),
      r2: r1(cprCalc.r2),
      s1: r1(cprCalc.s1),
      s2: r1(cprCalc.s2),
      source: cprSource,
      basisDate: pivotBasis?.date || null,
      basis: cprInput
    },
    totalCallOI,
    totalPutOI,
    totalCallChgOI,
    totalPutChgOI,
    maxCallOIStrike,
    maxPutOIStrike,
    strikes,
    fetchedAt: new Date().toISOString()
  };

  cache = { data: result, ts: now, expiry: targetExpiry };

  // Persist for the intraday buffer / session history. Never let storage trouble break the response.
  try {
    await withTimeout(history.recordSnapshot(result, extractFeatureVector(result)).catch(err => {
      console.error('History write failed:', err.message);
    }), 1500);
  } catch (err) {
    console.error('History write failed:', err.message);
  }
  return result;
}

// ── Market-implied distribution (Breeden-Litzenberger on a *fitted* IV smile) ──
// Differentiating raw per-strike prices twice amplifies IV noise (spiky densities, fat fake tails),
// so fit a smooth quadratic smile to OTM IVs first, then take the second derivative of model prices.

function bsCall(S, K, T, iv, r) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * sqrtT);
  return S * normalCdf(d1) - K * Math.exp(-r * T) * normalCdf(d1 - iv * sqrtT);
}

function solve3(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(m[j][i]) > Math.abs(m[piv][i])) piv = j;
    [m[i], m[piv]] = [m[piv], m[i]];
    if (Math.abs(m[i][i]) < 1e-12) return null;
    for (let j = i + 1; j < 3; j++) {
      const f = m[j][i] / m[i][i];
      for (let k = i; k < 4; k++) m[j][k] -= f * m[i][k];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let sum = m[i][3];
    for (let j = i + 1; j < 3; j++) sum -= m[i][j] * x[j];
    x[i] = sum / m[i][i];
  }
  return x;
}

function fitSmile(points) {
  // weighted LS: iv = a + b*k + c*k^2
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Y = [0, 0, 0];
  points.forEach(({ k, iv, w }) => {
    const row = [1, k, k * k];
    for (let i = 0; i < 3; i++) {
      Y[i] += w * row[i] * iv;
      for (let j = 0; j < 3; j++) S[i][j] += w * row[i] * row[j];
    }
  });
  return solve3(S, Y);
}

function lognormalFallback(spot, iv, T) {
  const sd = spot * iv * Math.sqrt(T);
  return {
    modeStrike: Math.round(spot),
    confidence68: { lower: Math.round(spot - sd), upper: Math.round(spot + sd) },
    confidence95: { lower: Math.round(spot - 2 * sd), upper: Math.round(spot + 2 * sd) },
    stayProbabilityPct: Number((Math.min(99.9, (normalCdf(0.015 * spot / sd) - normalCdf(-0.015 * spot / sd)) * 100)).toFixed(1)),
    distribution: [],
    method: 'LOGNORMAL_FALLBACK'
  };
}

function computeImpliedProbabilityDistribution(allStrikes, spot, T, r = RISK_FREE_RATE) {
  if (!allStrikes || allStrikes.length < 3 || !spot || spot <= 0 || !(T > 0)) {
    return lognormalFallback(spot || 0, 0.15, T > 0 ? T : 1 / 365);
  }

  const F = spot * Math.exp(r * T);
  const points = [];
  allStrikes.forEach(s => {
    if (s.strike < spot * 0.9 || s.strike > spot * 1.1) return;
    const cIv = (s.CE?.impliedVolatility || 0) / 100;
    const pIv = (s.PE?.impliedVolatility || 0) / 100;
    // OTM options carry the cleanest IV: puts below the forward, calls above
    const iv = s.strike < F ? (pIv || cIv) : (cIv || pIv);
    if (iv > 0.01 && iv < 3) {
      const oi = s.strike < F ? (s.PE?.openInterest || 0) : (s.CE?.openInterest || 0);
      points.push({ k: Math.log(s.strike / F), iv, w: 1 + Math.sqrt(oi) / 50 });
    }
  });

  const meanIv = points.length ? points.reduce((a, p) => a + p.iv, 0) / points.length : 0.15;
  if (points.length < 5) return lognormalFallback(spot, meanIv, T);

  const coef = fitSmile(points);
  if (!coef) return lognormalFallback(spot, meanIv, T);
  const minIv = Math.min(...points.map(p => p.iv));
  const maxIv = Math.max(...points.map(p => p.iv));
  const ivAt = K => {
    const k = Math.log(K / F);
    return Math.min(maxIv * 1.5, Math.max(minIv * 0.6, coef[0] + coef[1] * k + coef[2] * k * k));
  };

  const diffs = [];
  for (let i = 1; i < allStrikes.length; i++) diffs.push(allStrikes[i].strike - allStrikes[i - 1].strike);
  diffs.sort((a, b) => a - b);
  const h = diffs[Math.floor(diffs.length / 2)] || 50;

  const lo = Math.floor((spot * 0.88) / h) * h;
  const hi = Math.ceil((spot * 1.12) / h) * h;
  const grid = [];
  for (let K = lo; K <= hi; K += h) grid.push(K);

  const price = K => bsCall(spot, K, T, ivAt(K), r);
  const disc = Math.exp(r * T);
  const mass = grid.map(K => Math.max(0, disc * (price(K + h) - 2 * price(K) + price(K - h)) / (h * h)) * h);
  const total = mass.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return lognormalFallback(spot, meanIv, T);

  const cdf = [];
  let run = 0;
  const probs = mass.map(m => m / total);
  probs.forEach(p => { run += p; cdf.push(run); });

  const quantile = q => {
    for (let i = 0; i < grid.length; i++) {
      if (cdf[i] >= q) {
        if (i === 0) return grid[0];
        const frac = (q - cdf[i - 1]) / (cdf[i] - cdf[i - 1] || 1);
        return grid[i - 1] + frac * (grid[i] - grid[i - 1]);
      }
    }
    return grid[grid.length - 1];
  };
  const cdfAt = x => {
    if (x <= grid[0]) return 0;
    if (x >= grid[grid.length - 1]) return 1;
    for (let i = 1; i < grid.length; i++) {
      if (x <= grid[i]) return cdf[i - 1] + (x - grid[i - 1]) / (grid[i] - grid[i - 1]) * (cdf[i] - cdf[i - 1]);
    }
    return 1;
  };

  let modeIdx = 0;
  probs.forEach((p, i) => { if (p > probs[modeIdx]) modeIdx = i; });
  const round = x => Math.round(x / 10) * 10;

  const distribution = grid
    .map((K, i) => ({ strike: K, probabilityPct: Number((probs[i] * 100).toFixed(2)), cdfPct: Number((cdf[i] * 100).toFixed(1)) }))
    .filter(d => d.strike >= spot * 0.92 && d.strike <= spot * 1.08);

  return {
    modeStrike: grid[modeIdx],
    confidence68: { lower: round(quantile(0.16)), upper: round(quantile(0.84)) },
    confidence95: { lower: round(quantile(0.025)), upper: round(quantile(0.975)) },
    stayProbabilityPct: Number((Math.min(99.9, (cdfAt(spot * 1.015) - cdfAt(spot * 0.985)) * 100)).toFixed(1)),
    distribution,
    method: 'SMILE_FIT_BL'
  };
}

/**
 * Hand-weighted scoring model (NOT trained on data). Outputs are relative scores,
 * not calibrated probabilities.
 */
function computeIntradayMLPredictions(spot, maxPain, zeroGammaLevel, gexTotalCr, pcr, ivSkew, cprType, unusualCount, opts = {}) {
  const dteDays = opts.dteDays !== undefined ? opts.dteDays : 1;
  const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

  const distZeroGammaPct = zeroGammaLevel ? ((spot - zeroGammaLevel) / spot) * 100 : null;
  const distMaxPainPct = maxPain > 0 ? ((spot - maxPain) / spot) * 100 : 0;
  const pcrNorm = clamp((pcr - 1.0) / 0.5);              // high PCR = put writing = supportive
  const skewNorm = clamp(ivSkew / 3.0);                  // put-rich skew = hedging = cautious
  // Max-pain gravity: spot ABOVE max pain pulls down, below pulls up; matters most near expiry
  const painPull = clamp(-distMaxPainPct / 1.0) * (dteDays <= 2 ? 0.4 : 0.15);

  const zBull = 0.4 + 0.85 * pcrNorm - 0.35 * skewNorm + painPull;
  const zBear = 0.4 - 0.85 * pcrNorm + 0.35 * skewNorm - painPull;
  // Positive gamma and wide CPR both argue for "no trend"
  const zNeut = 0.3 + 1.2 * (1 - Math.abs(pcrNorm)) + 0.8 * (cprType === 'WIDE' ? 1 : 0) + 0.6 * (gexTotalCr >= 0 ? 1 : 0);

  const eB = Math.exp(zBull), eR = Math.exp(zBear), eN = Math.exp(zNeut);
  const sumExp = eB + eR + eN;
  const bullishPct = Number(((eB / sumExp) * 100).toFixed(1));
  const bearishPct = Number(((eR / sumExp) * 100).toFixed(1));
  const neutralPct = Number(((eN / sumExp) * 100).toFixed(1));

  let directionalSignal = 'NEUTRAL / RANGEBOUND';
  let signalClass = 'warn';
  if (bullishPct >= 45 && bullishPct > bearishPct) {
    directionalSignal = 'BULLISH LEAN';
    signalClass = 'bull';
  } else if (bearishPct >= 45 && bearishPct > bullishPct) {
    directionalSignal = 'BEARISH LEAN';
    signalClass = 'bear';
  }

  let breakout = 0;
  if (gexTotalCr < 0) breakout += 1.8;
  if (cprType === 'NARROW') breakout += 1.5;
  if (distZeroGammaPct !== null && Math.abs(distZeroGammaPct) < 0.25) breakout += 1.2;
  if (unusualCount > 0) breakout += 0.8;

  let range = 1.0;
  if (gexTotalCr >= 0) range += 1.6;
  if (cprType === 'WIDE') range += 1.4;

  // 0.6 temperature keeps hand-set logits from saturating at 1% / 99%
  const eBo = Math.exp(breakout * 0.6);
  const eRa = Math.exp(range * 0.6);
  const breakoutProbPct = Number(((eBo / (eBo + eRa)) * 100).toFixed(1));
  const rangeboundProbPct = Number(((eRa / (eBo + eRa)) * 100).toFixed(1));

  let stateLabel = 'RANGEBOUND REVERSION';
  if (breakoutProbPct >= 60) stateLabel = 'HIGH VOLATILITY BREAKOUT';
  else if (breakoutProbPct >= 45) stateLabel = 'BALANCED / CONDITIONAL BREAKOUT';

  return {
    directionalTrend: {
      bullishPct, neutralPct, bearishPct,
      signal: directionalSignal,
      signalClass,
      confidence: Math.max(bullishPct, bearishPct, neutralPct)
    },
    marketState: {
      breakoutProbPct,
      rangeboundProbPct,
      stateLabel,
      isHighVol: breakoutProbPct >= 60
    },
    featuresUsed: [
      `PCR: ${pcr.toFixed(2)}`,
      `Net GEX: ${gexTotalCr.toFixed(1)} Cr`,
      `Zero Gamma: ${zeroGammaLevel ?? 'n/a'}`,
      `CPR: ${cprType}`
    ]
  };
}

function getCacheData() {
  return cache.data;
}

module.exports = {
  computeCPR,
  classifyCPR,
  findZeroGamma,
  computeRiskReversal25,
  calculateOptionGamma,
  calculateOptionGreeks,
  normalPdf,
  getDTEInYears,
  updateWelfordZScore,
  updateAndDetectUnusualFlow,
  computeCompositeRegime,
  computeCosineSimilarity,
  extractFeatureVector,
  computeVolatilityRegime,
  computeImpliedProbabilityDistribution,
  computeIntradayMLPredictions,
  processOptionChainData,
  getCacheData
};


