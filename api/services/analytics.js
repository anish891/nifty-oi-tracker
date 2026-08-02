const { saveSnapshotsAsync } = require('./db');

const welfordStats = {
  CE: {},
  PE: {}
};

function updateWelfordZScore(strike, oiChange, isCall, threshold = 2.5) {
  const targetMap = isCall ? welfordStats.CE : welfordStats.PE;
  if (!targetMap[strike]) {
    targetMap[strike] = { count: 0, mean: 0, M2: 0 };
  }

  const stat = targetMap[strike];
  stat.count += 1;

  const delta = oiChange - stat.mean;
  stat.mean += delta / stat.count;
  const delta2 = oiChange - stat.mean;
  stat.M2 += delta * delta2;

  if (stat.count < 3) {
    return { isAnomaly: false, zScore: 0 };
  }

  const variance = stat.M2 / (stat.count - 1);
  const stddev = Math.sqrt(variance);

  if (stddev === 0) {
    return { isAnomaly: false, zScore: 0 };
  }

  const zScore = (oiChange - stat.mean) / stddev;
  const isAnomaly = Math.abs(zScore) >= threshold;

  return {
    isAnomaly,
    zScore: Number(zScore.toFixed(2))
  };
}

const strikeTickBuffers = {
  CE: {},
  PE: {}
};

function updateAndDetectUnusualFlow(strike, volume, oiChg, isCall) {
  const targetMap = isCall ? strikeTickBuffers.CE : strikeTickBuffers.PE;
  if (!targetMap[strike]) targetMap[strike] = [];
  const buf = targetMap[strike];

  buf.push({ volume, oiChg: Math.abs(oiChg), ts: Date.now() });
  if (buf.length > 20) buf.shift();

  if (buf.length < 3) return null;

  let sumVol = 0;
  let sumOiChg = 0;
  for (let i = 0; i < buf.length; i++) {
    sumVol += buf[i].volume;
    sumOiChg += buf[i].oiChg;
  }
  const meanVol = sumVol / buf.length;
  const meanOiChg = sumOiChg / buf.length;

  const volRatio = meanVol > 0 ? volume / meanVol : 1;
  const oiRatio = meanOiChg > 0 ? Math.abs(oiChg) / meanOiChg : 1;

  const isUnusual = (volRatio >= 2.2 && volume >= 4000) || (volRatio >= 1.6 && oiRatio >= 1.8 && volume >= 2500);
  if (!isUnusual) return null;

  const intensity = (volRatio >= 3.5 || oiRatio >= 3.0) ? 'CRITICAL' : 'HIGH';
  const type = isCall ? 'CE' : 'PE';

  return {
    strike,
    optionType: type,
    volRatio: Number(volRatio.toFixed(1)),
    oiRatio: Number(oiRatio.toFixed(1)),
    intensity,
    volume,
    oiChg,
    summary: `${strike} ${type}: ${volRatio.toFixed(1)}x Vol Surge (${(volume / 1000).toFixed(1)}k Vol)`
  };
}

function computeCompositeRegime(gexRegime, pcr, cprType, ivSkew, spot, maxPain) {
  let regimeLabel = 'BALANCE & CONSOLIDATION';
  let tacticalBias = 'NEUTRAL';
  let confidenceScore = 75;
  let primaryDrivers = [];
  let actionableStrategy = 'Sell Iron Condors / Strangle near ATM';

  const isNegGex = gexRegime === 'NEGATIVE_GAMMA';
  const isPosGex = gexRegime === 'POSITIVE_GAMMA';
  const isNarrowCpr = cprType === 'NARROW';
  const isWideCpr = cprType === 'WIDE';
  const isBullPcr = pcr > 1.15;
  const isBearPcr = pcr < 0.85;

  if (isNegGex && isNarrowCpr) {
    regimeLabel = '⚡ EXPLOSIVE BREAKOUT SETUP';
    tacticalBias = isBullPcr ? 'BULLISH_BREAKOUT' : isBearPcr ? 'BEARISH_BREAKOUT' : 'VOLATILE_EXPANSION';
    confidenceScore = 92;
    primaryDrivers = ['Negative Market GEX (Accelerated Moves)', 'Narrow CPR (Coiled Volatility)'];
    actionableStrategy = isBullPcr ? 'Long Call Spreads / Breakout Continuation' : 'Long Straddle / Directional Momentum';
  } else if (isPosGex && (isWideCpr || cprType === 'AVERAGE')) {
    regimeLabel = '🎯 RANGE-BOUND PINNING';
    tacticalBias = 'RANGE_BOUND';
    confidenceScore = 88;
    primaryDrivers = ['Positive Market GEX (Dealer Mean Reversion)', 'Wide/Average CPR (Support & Resistance Holds)'];
    actionableStrategy = 'Sell Premium (Short Straddles / Iron Flys around Max Pain)';
  } else if (isBullPcr && isNegGex && spot > maxPain) {
    regimeLabel = '🚀 SHORT SQUEEZE RISK';
    tacticalBias = 'STRONG_BULLISH';
    confidenceScore = 85;
    primaryDrivers = ['High Put-Call Ratio (Bullish Support)', 'Negative Gamma Squeeze Potential', 'Spot trading above Max Pain'];
    actionableStrategy = 'Ride Upward Momentum with Trailing Stop Loss';
  } else if (isBearPcr && isNegGex) {
    regimeLabel = '📉 GAMMA SLIDE / CAPITULATION';
    tacticalBias = 'STRONG_BEARISH';
    confidenceScore = 86;
    primaryDrivers = ['Low PCR (Heavy Call Selling)', 'Negative Gamma Cascading Liquidation'];
    actionableStrategy = 'Buy Put Spreads / Fade Rallies into Resistance';
  } else if (isPosGex && ivSkew > 1.2) {
    regimeLabel = '🛡️ HEDGED CONSOLIDATION';
    tacticalBias = 'NEUTRAL_ACCUMULATION';
    confidenceScore = 80;
    primaryDrivers = ['Dealer Long Gamma Buffer', 'Elevated Put IV Skew (Institutional Hedging)'];
    actionableStrategy = 'Accumulate Quality Dips / Sell Put Spreads';
  } else {
    regimeLabel = '⚖️ BALANCED ACCUMULATION';
    tacticalBias = isBullPcr ? 'MILD_BULLISH' : isBearPcr ? 'MILD_BEARISH' : 'NEUTRAL';
    confidenceScore = 78;
    primaryDrivers = [`PCR at ${pcr.toFixed(2)}`, `CPR Type: ${cprType}`, `Gamma: ${gexRegime}`];
    actionableStrategy = 'Trade Support & Resistance Boundaries';
  }

  return {
    regimeLabel,
    tacticalBias,
    confidenceScore,
    primaryDrivers,
    actionableStrategy
  };
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

function calculateOptionGamma(S, K, T, v, r = 0.065) {
  if (S <= 0 || K <= 0 || T <= 0 || v <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));
  const gamma = normalPdf(d1) / (S * v * Math.sqrt(T));
  return isNaN(gamma) ? 0 : gamma;
}

function calculateOptionGreeks(S, K, T, v, isCall, r = 0.065) {
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

async function computeVolatilityRegime(currentAtmIv, pool) {
  let pastIvs = [];

  if (pool) {
    try {
      const { rows } = await pool.query('SELECT atm_iv FROM session_summaries WHERE atm_iv > 0 ORDER BY date DESC LIMIT $1', [WINDOW_SIZE]);
      pastIvs = rows.map(r => parseFloat(r.atm_iv));
    } catch (err) {
      console.error('Error fetching past IVs from DB:', err.message);
    }
  }

  if (pastIvs.length < MIN_SAMPLES) {
    pastIvs = [14.2, 13.8, 14.5, 15.1, 14.0, 13.9, 14.8, 15.2, 14.1, 13.7];
  }

  const count = pastIvs.length;
  if (count < MIN_SAMPLES) {
    return {
      regime: 'INSUFFICIENT_HISTORY',
      badgeText: 'Need 5+ sessions',
      zScore: 0,
      todayIv: Number(currentAtmIv.toFixed(1)),
      mean20: 0,
      stddev20: 0,
      sampleCount: count
    };
  }

  let mean = 0;
  let M2 = 0;
  for (let i = 0; i < count; i++) {
    const x = pastIvs[i];
    const delta = x - mean;
    mean += delta / (i + 1);
    const delta2 = x - mean;
    M2 += delta * delta2;
  }

  const stddev = count > 1 ? Math.sqrt(M2 / (count - 1)) : 0;
  const zScore = stddev > 0 ? (currentAtmIv - mean) / stddev : 0;

  let regime = 'NORMAL_IV';
  let badgeText = 'Normal IV';

  if (zScore > Z_THRESHOLD) {
    regime = 'HIGH_IV';
    badgeText = 'High IV';
  } else if (zScore < -Z_THRESHOLD) {
    regime = 'LOW_IV';
    badgeText = 'Low IV';
  }

  return {
    regime,
    badgeText,
    zScore: Number(zScore.toFixed(2)),
    todayIv: Number(currentAtmIv.toFixed(1)),
    mean20: Number(mean.toFixed(1)),
    stddev20: Number(stddev.toFixed(2)),
    sampleCount: count
  };
}

let cache = { data: null, ts: 0, expiry: null };
const CACHE_TTL = 1000; // 1s TTL

async function processOptionChainData(raw, allExpiries, targetExpiry, pool) {
  const now = Date.now();
  if (
    cache.data &&
    now - cache.ts < CACHE_TTL &&
    cache.expiry === targetExpiry
  ) {
    return cache.data;
  }

  const spot = raw.records.underlyingValue || raw.records.data?.[0]?.CE?.underlyingValue || raw.records.data?.[0]?.PE?.underlyingValue || 0;
  const atm = Math.round(spot / 50) * 50;
  const MIN_STRIKE = atm - 500;
  const MAX_STRIKE = atm + 500;
  const allExpiryRows = (raw.records.data || []).filter(r => (r.expiryDate || r.expiryDates) === targetExpiry);

  const allExpiryStrikesMap = {};
  allExpiryRows.forEach(r => {
    const strike = r.strikePrice;
    if (!allExpiryStrikesMap[strike]) {
      allExpiryStrikesMap[strike] = { strike };
    }
    if (r.CE) allExpiryStrikesMap[strike].CE = r.CE;
    if (r.PE) allExpiryStrikesMap[strike].PE = r.PE;
  });

  const allExpiryStrikes = Object.values(allExpiryStrikesMap).sort((a, b) => a.strike - b.strike);
  const strikes = allExpiryStrikes.filter(s => s.strike >= MIN_STRIKE && s.strike <= MAX_STRIKE);

  let totalCallOI = 0;
  let totalPutOI = 0;
  let totalCallChgOI = 0;
  let totalPutChgOI = 0;

  let maxCallOI = 0;
  let maxPutOI = 0;
  let maxCallOIStrike = atm;
  let maxPutOIStrike = atm;

  let weightedCallValue = 0;
  let weightedPutValue = 0;

  const unusualFlowAlerts = [];

  allExpiryStrikes.forEach(s => {
    const cOI = s.CE?.openInterest || 0;
    const pOI = s.PE?.openInterest || 0;
    const cChg = s.CE?.changeinOpenInterest || 0;
    const pChg = s.PE?.changeinOpenInterest || 0;

    totalCallOI += cOI;
    totalPutOI += pOI;
    totalCallChgOI += cChg;
    totalPutChgOI += pChg;

    weightedCallValue += cOI * (s.CE?.lastPrice || 0);
    weightedPutValue += pOI * (s.PE?.lastPrice || 0);

    if (s.CE) {
      s.CE.anomaly = updateWelfordZScore(s.strike, cChg, true);
      const ceFlow = updateAndDetectUnusualFlow(s.strike, s.CE.totalTradedVolume || 0, cChg, true);
      if (ceFlow) {
        s.CE.unusualFlow = ceFlow;
        unusualFlowAlerts.push(ceFlow);
      }
    }
    if (s.PE) {
      s.PE.anomaly = updateWelfordZScore(s.strike, pChg, false);
      const peFlow = updateAndDetectUnusualFlow(s.strike, s.PE.totalTradedVolume || 0, pChg, false);
      if (peFlow) {
        s.PE.unusualFlow = peFlow;
        unusualFlowAlerts.push(peFlow);
      }
    }

    if (cOI > maxCallOI) {
      maxCallOI = cOI;
      maxCallOIStrike = s.strike;
    }

    if (pOI > maxPutOI) {
      maxPutOI = pOI;
      maxPutOIStrike = s.strike;
    }
  });

  const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

  const atmStrikeObj = allExpiryStrikes.find(s => s.strike === atm) || allExpiryStrikes[Math.floor(allExpiryStrikes.length / 2)];
  const atmCE = atmStrikeObj?.CE || {};
  const atmPE = atmStrikeObj?.PE || {};
  const atmCELTP = atmCE.lastPrice || 0;
  const atmPELTP = atmPE.lastPrice || 0;
  const straddlePrice = atmCELTP + atmPELTP;
  const upperRange = spot + straddlePrice;
  const lowerRange = spot - straddlePrice;

  const atmIndex = strikes.findIndex(s => s.strike === atm);
  let ntmCallOI = 0;
  let ntmPutOI = 0;
  if (atmIndex !== -1) {
    const startIndex = Math.max(0, atmIndex - 3);
    const endIndex = Math.min(strikes.length - 1, atmIndex + 3);
    for (let i = startIndex; i <= endIndex; i++) {
      ntmCallOI += strikes[i].CE?.openInterest || 0;
      ntmPutOI += strikes[i].PE?.openInterest || 0;
    }
  }
  const ntmPcr = ntmCallOI > 0 ? ntmPutOI / ntmCallOI : 0;
  const weightedPcr = weightedCallValue > 0 ? weightedPutValue / weightedCallValue : 0;

  const resistanceStrength = totalCallOI > 0 ? (maxCallOI / totalCallOI) * 100 : 0;
  const supportStrength = totalPutOI > 0 ? (maxPutOI / totalPutOI) * 100 : 0;

  const atmCeIv = atmCE.impliedVolatility || 0;
  const atmPeIv = atmPE.impliedVolatility || 0;
  const ivSkew = atmPeIv - atmCeIv;
  const atmIv = (atmCeIv + atmPeIv) / 2;

  // Optimized Max Pain Algorithm
  let maxPain = atm;
  let minTotalPain = Infinity;
  const nStrikes = allExpiryStrikes.length;

  if (nStrikes > 0) {
    const sorted = [...allExpiryStrikes].sort((a, b) => a.strike - b.strike);
    const sumCE_OI = new Float64Array(nStrikes);
    const sumCE_W = new Float64Array(nStrikes);
    const sumPE_OI = new Float64Array(nStrikes);
    const sumPE_W = new Float64Array(nStrikes);

    let runCE_OI = 0, runCE_W = 0;
    let runPE_OI = 0, runPE_W = 0;

    for (let i = 0; i < nStrikes; i++) {
      const cOI = sorted[i].CE?.openInterest || 0;
      const pOI = sorted[i].PE?.openInterest || 0;
      const k = sorted[i].strike;

      runCE_OI += cOI;
      runCE_W += cOI * k;
      sumCE_OI[i] = runCE_OI;
      sumCE_W[i] = runCE_W;

      runPE_OI += pOI;
      runPE_W += pOI * k;
      sumPE_OI[i] = runPE_OI;
      sumPE_W[i] = runPE_W;
    }

    const totalPE_OI = sumPE_OI[nStrikes - 1];
    const totalPE_W = sumPE_W[nStrikes - 1];

    for (let i = 0; i < nStrikes; i++) {
      const K = sorted[i].strike;
      const callOI_left = i > 0 ? sumCE_OI[i - 1] : 0;
      const callW_left = i > 0 ? sumCE_W[i - 1] : 0;
      const callLoss = K * callOI_left - callW_left;

      const putOI_right = totalPE_OI - sumPE_OI[i];
      const putW_right = totalPE_W - sumPE_W[i];
      const putLoss = putW_right - K * putOI_right;

      const totalPain = callLoss + putLoss;
      if (totalPain < minTotalPain) {
        minTotalPain = totalPain;
        maxPain = K;
      }
    }
  }

  // Black-Scholes GEX
  const LOT_SIZE = 25;
  const T = getDTEInYears(targetExpiry);

  function computeGexForSpot(S) {
    let totalGex = 0;
    let callGexTotal = 0;
    let putGexTotal = 0;
    allExpiryStrikes.forEach(s => {
      const cOI = s.CE?.openInterest || 0;
      const pOI = s.PE?.openInterest || 0;
      const cIv = (s.CE?.impliedVolatility || 0) / 100;
      const pIv = (s.PE?.impliedVolatility || 0) / 100;

      const cGamma = calculateOptionGamma(S, s.strike, T, cIv);
      const pGamma = calculateOptionGamma(S, s.strike, T, pIv);

      const callGex = cOI * LOT_SIZE * cGamma * S * S * 0.01;
      const putGex = pOI * LOT_SIZE * pGamma * S * S * 0.01;

      callGexTotal += callGex;
      putGexTotal += putGex;
      totalGex += (callGex - putGex);
    });
    return { totalGex, callGexTotal, putGexTotal };
  }

  const { totalGex: currentGex, callGexTotal, putGexTotal } = computeGexForSpot(spot);
  const totalGexCr = currentGex / 1e7;
  const callGexCr = callGexTotal / 1e7;
  const putGexCr = putGexTotal / 1e7;

  let zeroGammaLevel = atm;
  let minGexAbs = Infinity;
  const startSpot = Math.max(1000, atm - 1500);
  const endSpot = atm + 1500;

  for (let sPrice = startSpot; sPrice <= endSpot; sPrice += 10) {
    const gVal = Math.abs(computeGexForSpot(sPrice).totalGex);
    if (gVal < minGexAbs) {
      minGexAbs = gVal;
      zeroGammaLevel = sPrice;
    }
  }

  // Calculate Option Greeks for display strikes
  strikes.forEach(s => {
    if (s.CE) {
      const cIv = (s.CE.impliedVolatility || 0) / 100;
      s.CE.greeks = calculateOptionGreeks(spot, s.strike, T, cIv, true);
    }
    if (s.PE) {
      const pIv = (s.PE.impliedVolatility || 0) / 100;
      s.PE.greeks = calculateOptionGreeks(spot, s.strike, T, pIv, false);
    }
  });

  // CPR Calculation
  const estHigh = Math.max(maxCallOIStrike, Math.round(upperRange));
  const estLow = Math.min(maxPutOIStrike, Math.round(lowerRange));
  const estClose = spot;

  const pivot = (estHigh + estLow + estClose) / 3;
  const bc = (estHigh + estLow) / 2;
  const tc = (pivot - bc) + pivot;
  const cprWidth = Math.abs(tc - bc);
  const cprWidthPct = (cprWidth / spot) * 100;

  const r1 = (2 * pivot) - estLow;
  const s1 = (2 * pivot) - estHigh;
  const r2 = pivot + (estHigh - estLow);
  const s2 = pivot - (estHigh - estLow);

  const volatilityRegime = await computeVolatilityRegime(atmIv, pool);
  const cprTypeVal = cprWidthPct < 0.25 ? 'NARROW' : cprWidthPct > 0.6 ? 'WIDE' : 'AVERAGE';
  const gexRegimeVal = totalGexCr >= 0 ? 'POSITIVE_GAMMA' : 'NEGATIVE_GAMMA';
  const compositeRegime = computeCompositeRegime(gexRegimeVal, pcr, cprTypeVal, ivSkew, spot, maxPain);

  const result = {
    spot,
    atm,
    expiry: targetExpiry,
    allExpiries,
    pcr: Number(pcr.toFixed(2)),
    ntmPcr: Number(ntmPcr.toFixed(2)),
    weightedPcr: Number(weightedPcr.toFixed(2)),
    straddlePrice: Number(straddlePrice.toFixed(2)),
    upperRange: Number(upperRange.toFixed(2)),
    lowerRange: Number(lowerRange.toFixed(2)),
    resistanceStrength: Number(resistanceStrength.toFixed(1)),
    supportStrength: Number(supportStrength.toFixed(1)),
    ivSkew: Number(ivSkew.toFixed(2)),
    atmIv: Number(atmIv.toFixed(2)),
    volatilityRegime,
    compositeRegime,
    unusualActivity: unusualFlowAlerts,
    maxPain,
    gex: {
      totalGexCr: Number(totalGexCr.toFixed(2)),
      callGexCr: Number(callGexCr.toFixed(2)),
      putGexCr: Number(putGexCr.toFixed(2)),
      zeroGammaLevel,
      gexRegime: gexRegimeVal,
      distToZeroGamma: Number((spot - zeroGammaLevel).toFixed(1))
    },
    cpr: {
      pivot: Number(pivot.toFixed(1)),
      tc: Number(tc.toFixed(1)),
      bc: Number(bc.toFixed(1)),
      cprWidth: Number(cprWidth.toFixed(1)),
      cprWidthPct: Number(cprWidthPct.toFixed(2)),
      cprType: cprTypeVal,
      r1: Number(r1.toFixed(1)),
      r2: Number(r2.toFixed(1)),
      s1: Number(s1.toFixed(1)),
      s2: Number(s2.toFixed(1))
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

  cache = {
    data: result,
    ts: now,
    expiry: targetExpiry
  };

  saveSnapshotsAsync(strikes, targetExpiry, result.fetchedAt);
  return result;
}

function getCacheData() {
  return cache.data;
}

module.exports = {
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
  processOptionChainData,
  getCacheData
};
