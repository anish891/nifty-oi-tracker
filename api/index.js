const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

// Initialize Postgres Connection Pool (compatible with Neon / Supabase)
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// Auto-initialize DB Tables if pool exists
async function initDb() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS option_chain_snapshots (
        id BIGSERIAL PRIMARY KEY,
        strike INT NOT NULL,
        option_type VARCHAR(4) NOT NULL,
        oi BIGINT NOT NULL,
        oi_change BIGINT NOT NULL,
        ltp NUMERIC NOT NULL,
        iv NUMERIC NOT NULL,
        volume BIGINT NOT NULL,
        expiry VARCHAR(20) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_ts_strike ON option_chain_snapshots (timestamp, strike);
      CREATE INDEX IF NOT EXISTS idx_snapshots_expiry ON option_chain_snapshots (expiry);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id SERIAL PRIMARY KEY,
        date DATE UNIQUE NOT NULL,
        closing_pcr NUMERIC NOT NULL,
        gex_regime VARCHAR(20) NOT NULL,
        top_buildup_strikes JSONB NOT NULL,
        cpr_width_type VARCHAR(20) NOT NULL,
        feature_vector JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } catch (err) {
    console.error('Database initialization failed:', err.message);
  }
}
initDb();

// Non-blocking Async Batch Insert for Strike Snapshots
function saveSnapshotsAsync(strikes, expiry, fetchedAt) {
  if (!pool || !strikes || !strikes.length) return;

  setImmediate(async () => {
    try {
      const values = [];
      const valueStrings = [];
      let paramIdx = 1;

      strikes.forEach(s => {
        const ts = fetchedAt || new Date().toISOString();
        if (s.CE) {
          valueStrings.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
          values.push(s.strike, 'call', s.CE.openInterest || 0, s.CE.changeinOpenInterest || 0, s.CE.lastPrice || 0, s.CE.impliedVolatility || 0, s.CE.totalTradedVolume || 0, expiry, ts);
        }
        if (s.PE) {
          valueStrings.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
          values.push(s.strike, 'put', s.PE.openInterest || 0, s.PE.changeinOpenInterest || 0, s.PE.lastPrice || 0, s.PE.impliedVolatility || 0, s.PE.totalTradedVolume || 0, expiry, ts);
        }
      });

      if (valueStrings.length === 0) return;

      const query = `
        INSERT INTO option_chain_snapshots 
        (strike, option_type, oi, oi_change, ltp, iv, volume, expiry, timestamp) 
        VALUES ${valueStrings.join(', ')}
      `;

      await pool.query(query, values);
    } catch (err) {
      console.error('Async snapshot save error:', err.message);
    }
  });
}

// NSE requires browser-like headers — this proxy adds them server-side
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/option-chain',
  'Origin': 'https://www.nseindia.com',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};


// Simple in-memory cache to avoid hammering NSE (1s TTL)
let cache = { data: null, ts: 0, expiry: null };

const CACHE_TTL = 100;
const COOKIE_TTL = 10 * 60 * 1000;

let cookieCache = {
  value: '',
  ts: 0
};

async function fetchNSECookies() {
  const res = await fetch('https://www.nseindia.com/', { headers: NSE_HEADERS });
  const cookies = res.headers.raw()['set-cookie'] || [];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

async function getCookies() {
  const now = Date.now();

  if (
    cookieCache.value &&
    now - cookieCache.ts < COOKIE_TTL
  ) {
    return cookieCache.value;
  }

  const cookies = await fetchNSECookies();

  cookieCache = {
    value: cookies,
    ts: now
  };

  return cookies;
}


async function fetchWithTimeout(url, cookies) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 5000);

  try {
    const res = await fetch(url, {
      headers: {
        ...NSE_HEADERS,
        Cookie: cookies
      },
      signal: controller.signal
    });

    return await res.json();
  } catch (e) {
    cookieCache = { value: '', ts: 0 };
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
// Structure: welfordStats[optionType][strike] = { count, mean, M2 }
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

async function fetchOptionChain(symbol = 'NIFTY', expiryDate = null) {
  const now = Date.now();

  if (
    cache.data &&
    now - cache.ts < CACHE_TTL &&
    (!expiryDate || cache.expiry === expiryDate)
  ) {
    return cache.data;
  }

  let cookies = '';

  try {
    cookies = await getCookies();
  } catch (e) {
    console.error('Cookie fetch failed:', e.message);
  }

  // Bootstrap expiry required by NSE
  const bootstrapExpiry = expiryDate || '30-Jun-2026';

  let url =
    `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=${symbol}&expiry=${encodeURIComponent(bootstrapExpiry)}`;

  let raw = await fetchWithTimeout(url, cookies);

  if (!raw?.records?.expiryDates?.length) {
    throw new Error('Unexpected NSE response structure');
  }

  const allExpiries = raw.records.expiryDates;

  // Automatically use the nearest live expiry
  const targetExpiry = expiryDate || allExpiries[0];

  // If target differs from bootstrap, fetch again
  if (targetExpiry !== bootstrapExpiry) {
    url =
      `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=${symbol}&expiry=${encodeURIComponent(targetExpiry)}`;

    raw = await fetchWithTimeout(url, cookies);

    if (!raw?.records?.data) {
      throw new Error('Unexpected NSE response structure');
    }
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

  const allExpiryStrikes = Object.values(allExpiryStrikesMap).sort(
    (a, b) => a.strike - b.strike
  );

  // Filter strikes for display table
  const strikes = allExpiryStrikes.filter(s => s.strike >= MIN_STRIKE && s.strike <= MAX_STRIKE);

  let totalCallOI = 0;
  let totalPutOI = 0;
  let totalCallChgOI = 0;
  let totalPutChgOI = 0;

  let maxCallOI = 0;
  let maxPutOI = 0;
  let maxCallOIStrike = atm;
  let maxPutOIStrike = atm;

  // Calculate stats on the FULL option chain
  allExpiryStrikes.forEach(s => {
    const cOI = s.CE?.openInterest || 0;
    const pOI = s.PE?.openInterest || 0;

    const cChg = s.CE?.changeinOpenInterest || 0;
    const pChg = s.PE?.changeinOpenInterest || 0;

    totalCallOI += cOI;
    totalPutOI += pOI;

    totalCallChgOI += cChg;
    totalPutChgOI += pChg;

    if (s.CE) {
      s.CE.anomaly = updateWelfordZScore(s.strike, cChg, true);
    }
    if (s.PE) {
      s.PE.anomaly = updateWelfordZScore(s.strike, pChg, false);
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

  const pcr =
    totalCallOI > 0
      ? totalPutOI / totalCallOI
      : 0;

  // Calculate ATM Straddle expected range
  const atmStrikeObj = allExpiryStrikes.find(s => s.strike === atm) || allExpiryStrikes[Math.floor(allExpiryStrikes.length / 2)];
  const atmCE = atmStrikeObj?.CE || {};
  const atmPE = atmStrikeObj?.PE || {};
  const atmCELTP = atmCE.lastPrice || 0;
  const atmPELTP = atmPE.lastPrice || 0;
  const straddlePrice = atmCELTP + atmPELTP;
  const upperRange = spot + straddlePrice;
  const lowerRange = spot - straddlePrice;

  // Calculate Multi-Strike PCR (NTM PCR - ±3 strikes around ATM in the display subset)
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

  // Calculate Value-Weighted PCR (on the full chain)
  let weightedCallValue = 0;
  let weightedPutValue = 0;
  allExpiryStrikes.forEach(s => {
    weightedCallValue += (s.CE?.openInterest || 0) * (s.CE?.lastPrice || 0);
    weightedPutValue += (s.PE?.openInterest || 0) * (s.PE?.lastPrice || 0);
  });
  const weightedPcr = weightedCallValue > 0 ? weightedPutValue / weightedCallValue : 0;

  // Calculate Support & Resistance Strength (%) on full chain
  const resistanceStrength = totalCallOI > 0 ? (maxCallOI / totalCallOI) * 100 : 0;
  const supportStrength = totalPutOI > 0 ? (maxPutOI / totalPutOI) * 100 : 0;

  // Calculate ATM IV Skew
  const atmCeIv = atmCE.impliedVolatility || 0;
  const atmPeIv = atmPE.impliedVolatility || 0;
  const ivSkew = atmPeIv - atmCeIv;

  /**
   * MAX PAIN CALCULATION OPTIMIZATION
   * 
   * BEFORE (O(N^2) Brute Force):
   * For every candidate strike price K (N strikes), iterated through all N strikes to sum:
   *   CE Loss = CE_OI * (K - S) for S < K
   *   PE Loss = PE_OI * (S - K) for S > K
   * Total Complexity: O(N^2) operations per update tick.
   * 
   * AFTER (O(N log N) / O(N) Prefix-Sum Approach):
   * 1. Sort strikes in ascending order: S_0 < S_1 < ... < S_{N-1}. (O(N log N))
   * 2. Precompute prefix sum arrays:
   *    - sumCE_OI[i] = cumulative sum of Call OI up to index i
   *    - sumCE_Weighted[i] = cumulative sum of (Call OI * Strike) up to index i
   *    - sumPE_OI[i] = cumulative sum of Put OI up to index i
   *    - sumPE_Weighted[i] = cumulative sum of (Put OI * Strike) up to index i
   * 3. For any candidate strike K at index i, cash loss is computed in O(1):
   *    - Call Loss (S < K) = K * (sumCE_OI[i-1]) - (sumCE_Weighted[i-1])
   *    - Put Loss (S > K)  = (sumPE_Weighted[N-1] - sumPE_Weighted[i]) - K * (sumPE_OI[N-1] - sumPE_OI[i])
   * Overall Complexity: O(N log N) sort + O(N) linear sweep = O(N log N) time, O(N) space.
   */
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

      // Call Loss: Sum of CE_OI_j * (K - S_j) for j < i
      const callOI_left = i > 0 ? sumCE_OI[i - 1] : 0;
      const callW_left = i > 0 ? sumCE_W[i - 1] : 0;
      const callLoss = K * callOI_left - callW_left;

      // Put Loss: Sum of PE_OI_j * (S_j - K) for j > i
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

  // Calculate Black-Scholes Gamma and GEX (Gamma Exposure)
  function normalPdf(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }

  function getDTEInYears(expiryStr) {
    if (!expiryStr) return 1 / 365;
    const exp = new Date(expiryStr);
    const now = new Date();
    const diffTime = exp.getTime() - now.getTime();
    const diffDays = diffTime / (1000 * 3600 * 24);
    return Math.max(0.002, diffDays / 365); // min ~0.7 hours
  }

  function calculateOptionGamma(S, K, T, v, r = 0.07) {
    if (S <= 0 || K <= 0 || T <= 0 || v <= 0) return 0;
    const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));
    const gamma = normalPdf(d1) / (S * v * Math.sqrt(T));
    return isNaN(gamma) ? 0 : gamma;
  }

  const LOT_SIZE = 25; // Standard Nifty Lot Size
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
  const totalGexCr = currentGex / 1e7; // Convert to ₹ Crores
  const callGexCr = callGexTotal / 1e7;
  const putGexCr = putGexTotal / 1e7;

  // Search for Zero-Gamma Level (Price where GEX flips)
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

  // Calculate CPR & Floor Pivots
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
    maxPain,
    gex: {
      totalGexCr: Number(totalGexCr.toFixed(2)),
      callGexCr: Number(callGexCr.toFixed(2)),
      putGexCr: Number(putGexCr.toFixed(2)),
      zeroGammaLevel,
      gexRegime: totalGexCr >= 0 ? 'POSITIVE_GAMMA' : 'NEGATIVE_GAMMA',
      distToZeroGamma: Number((spot - zeroGammaLevel).toFixed(1))
    },
    cpr: {
      pivot: Number(pivot.toFixed(1)),
      tc: Number(tc.toFixed(1)),
      bc: Number(bc.toFixed(1)),
      cprWidth: Number(cprWidth.toFixed(1)),
      cprWidthPct: Number(cprWidthPct.toFixed(2)),
      cprType: cprWidthPct < 0.25 ? 'NARROW' : cprWidthPct > 0.6 ? 'WIDE' : 'AVERAGE',
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

  // Trigger non-blocking async DB snapshot write
  saveSnapshotsAsync(strikes, targetExpiry, result.fetchedAt);

  return result;
}

// CORS headers for frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/api/option-chain', async (req, res) => {
  try {
    const { expiry } = req.query;
    const data = await fetchOptionChain('NIFTY', expiry || null);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error fetching option chain:', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// GET /api/history - Query historical snapshots by date range & strike
app.get('/api/history', async (req, res) => {
  if (!pool) {
    return res.status(503).json({ ok: false, error: 'Database connection not configured (DATABASE_URL missing)' });
  }

  try {
    const { startDate, endDate, strike, expiry, limit = 500 } = req.query;
    let query = 'SELECT * FROM option_chain_snapshots WHERE 1=1';
    const params = [];
    let idx = 1;

    if (startDate) {
      query += ` AND timestamp >= $${idx++}`;
      params.push(startDate);
    }
    if (endDate) {
      query += ` AND timestamp <= $${idx++}`;
      params.push(endDate);
    }
    if (strike) {
      query += ` AND strike = $${idx++}`;
      params.push(parseInt(strike, 10));
    }
    if (expiry) {
      query += ` AND expiry = $${idx++}`;
      params.push(expiry);
    }

    query += ` ORDER BY timestamp DESC LIMIT $${idx++}`;
    params.push(parseInt(limit, 10));

    const { rows } = await pool.query(query, params);
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    console.error('Error fetching history:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cosine Similarity helper: similarity(A, B) = (A dot B) / (||A|| * ||B||)
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

// Construct session feature vector from chain data
function extractFeatureVector(data) {
  const pcr = data.pcr || 1.0;
  const gexRegimeCode = data.gex?.gexRegime === 'POSITIVE_GAMMA' ? 1.0 : -1.0;
  const cprWidthPct = data.cpr?.cprWidthPct || 0.5;
  const ivSkew = data.ivSkew || 0;
  const totalCallChgCr = (data.totalCallChgOI || 0) / 10000000;
  const totalPutChgCr = (data.totalPutChgOI || 0) / 10000000;

  return [pcr, gexRegimeCode, cprWidthPct, ivSkew, totalCallChgCr, totalPutChgCr];
}

// POST /api/session-summary - Save current session summary vector
app.post('/api/session-summary', async (req, res) => {
  if (!pool) {
    return res.status(503).json({ ok: false, error: 'Database connection not configured (DATABASE_URL missing)' });
  }

  try {
    const data = await fetchOptionChain('NIFTY');
    const today = new Date().toISOString().slice(0, 10);
    const vector = extractFeatureVector(data);

    const topStrikes = data.strikes.slice(0, 3).map(s => ({ strike: s.strike, cOI: s.CE?.openInterest || 0, pOI: s.PE?.openInterest || 0 }));

    const query = `
      INSERT INTO session_summaries 
      (date, closing_pcr, gex_regime, top_buildup_strikes, cpr_width_type, feature_vector)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (date) DO UPDATE SET
        closing_pcr = EXCLUDED.closing_pcr,
        gex_regime = EXCLUDED.gex_regime,
        top_buildup_strikes = EXCLUDED.top_buildup_strikes,
        cpr_width_type = EXCLUDED.cpr_width_type,
        feature_vector = EXCLUDED.feature_vector
    `;

    await pool.query(query, [
      today,
      data.pcr,
      data.gex?.gexRegime || 'POSITIVE_GAMMA',
      JSON.stringify(topStrikes),
      data.cpr?.cprType || 'AVERAGE',
      JSON.stringify(vector)
    ]);

    res.json({ ok: true, message: 'Session summary saved successfully', date: today, vector });
  } catch (err) {
    console.error('Error saving session summary:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/similar-sessions - Compute Cosine Similarity against all past stored sessions
app.get('/api/similar-sessions', async (req, res) => {
  try {
    // Read from cache if available to prevent re-entrant lock / infinite fetch recursion
    let liveData = cache.data;
    if (!liveData) {
      liveData = await fetchOptionChain('NIFTY');
    }
    const currentVector = extractFeatureVector(liveData);

    let pastSessions = [];
    if (pool) {
      const { rows } = await pool.query('SELECT * FROM session_summaries ORDER BY date DESC LIMIT 100');
      pastSessions = rows;
    }

    // Fallback mock past historical sessions for personal replay when DB is empty
    if (pastSessions.length === 0) {
      pastSessions = [
        { date: '2026-07-24', closing_pcr: 1.32, gex_regime: 'POSITIVE_GAMMA', cpr_width_type: 'NARROW', feature_vector: [1.32, 1.0, 0.18, 1.8, 0.4, 1.2] },
        { date: '2026-07-23', closing_pcr: 0.78, gex_regime: 'NEGATIVE_GAMMA', cpr_width_type: 'WIDE', feature_vector: [0.78, -1.0, 0.65, -2.1, -1.1, -0.5] },
        { date: '2026-07-22', closing_pcr: 1.05, gex_regime: 'POSITIVE_GAMMA', cpr_width_type: 'AVERAGE', feature_vector: [1.05, 1.0, 0.42, 0.2, 0.1, 0.3] },
        { date: '2026-07-21', closing_pcr: 0.85, gex_regime: 'NEGATIVE_GAMMA', cpr_width_type: 'AVERAGE', feature_vector: [0.85, -1.0, 0.48, -1.2, -0.8, -0.2] },
        { date: '2026-07-20', closing_pcr: 1.25, gex_regime: 'POSITIVE_GAMMA', cpr_width_type: 'NARROW', feature_vector: [1.25, 1.0, 0.22, 1.4, 0.6, 0.9] }
      ];
    }

    const scored = pastSessions.map(sess => {
      const vec = typeof sess.feature_vector === 'string' ? JSON.parse(sess.feature_vector) : sess.feature_vector;
      const sim = computeCosineSimilarity(currentVector, vec);
      return {
        date: sess.date,
        similarityPct: Number((sim * 100).toFixed(1)),
        closingPcr: sess.closing_pcr,
        gexRegime: sess.gex_regime,
        cprWidthType: sess.cpr_width_type
      };
    });

    scored.sort((a, b) => b.similarityPct - a.similarityPct);

    res.json({
      ok: true,
      currentVector,
      topMatches: scored.slice(0, 3)
    });
  } catch (err) {
    console.error('Error matching similar sessions:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Nifty OI Tracker running on http://localhost:${PORT}`);
  });
}

module.exports = app;