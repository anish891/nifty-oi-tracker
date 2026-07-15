const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

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


// Simple in-memory cache to avoid hammering NSE (2.5s TTL)
let cache = { data: null, ts: 0, expiry: null };

const CACHE_TTL = 2500;
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

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        cookieCache = { value: '', ts: 0 };
      }
      throw new Error(`NSE API returned ${res.status}: ${res.statusText}`);
    }

    return await res.json();
  } catch (e) {
    cookieCache = { value: '', ts: 0 };
    throw e;
  } finally {
    clearTimeout(timeout);
  }
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

  const spot = raw.records.underlyingValue || 0;

  const atm = Math.round(spot / 50) * 50;
  const MIN_STRIKE = atm - 500;
  const MAX_STRIKE = atm + 500;

  const rows = (raw.records.data || []).filter(r => {
    const rowExpiry = r.expiryDate || r.expiryDates;

    return (
      rowExpiry === targetExpiry &&
      r.strikePrice >= MIN_STRIKE &&
      r.strikePrice <= MAX_STRIKE
    );
  });

  const strikeMap = {};

  rows.forEach(r => {
    const strike = r.strikePrice;

    if (!strikeMap[strike]) {
      strikeMap[strike] = {
        strike
      };
    }

    if (r.CE) strikeMap[strike].CE = r.CE;
    if (r.PE) strikeMap[strike].PE = r.PE;
  });

  const strikes = Object.values(strikeMap).sort(
    (a, b) => a.strike - b.strike
  );

  let totalCallOI = 0;
  let totalPutOI = 0;
  let totalCallChgOI = 0;
  let totalPutChgOI = 0;

  let maxCallOI = 0;
  let maxPutOI = 0;
  let maxCallOIStrike = atm;
  let maxPutOIStrike = atm;

  let maxCallChgOI = -Infinity;
  let maxPutChgOI = -Infinity;
  let maxCallChgStrike = atm;
  let maxPutChgStrike = atm;

  strikes.forEach(s => {
    const cOI = s.CE?.openInterest || 0;
    const pOI = s.PE?.openInterest || 0;

    const cChg = s.CE?.changeinOpenInterest || 0;
    const pChg = s.PE?.changeinOpenInterest || 0;

    totalCallOI += cOI;
    totalPutOI += pOI;

    totalCallChgOI += cChg;
    totalPutChgOI += pChg;

    if (cOI > maxCallOI) {
      maxCallOI = cOI;
      maxCallOIStrike = s.strike;
    }

    if (pOI > maxPutOI) {
      maxPutOI = pOI;
      maxPutOIStrike = s.strike;
    }

    if (cChg > maxCallChgOI) {
      maxCallChgOI = cChg;
      maxCallChgStrike = s.strike;
    }

    if (pChg > maxPutChgOI) {
      maxPutChgOI = pChg;
      maxPutChgStrike = s.strike;
    }
  });

  const pcr =
    totalCallOI > 0
      ? totalPutOI / totalCallOI
      : 0;

  // Calculate ATM Straddle expected range
  const atmStrikeObj = strikes.find(s => s.strike === atm) || strikes[Math.floor(strikes.length / 2)];
  const atmCE = atmStrikeObj?.CE || {};
  const atmPE = atmStrikeObj?.PE || {};
  const atmCELTP = atmCE.lastPrice || 0;
  const atmPELTP = atmPE.lastPrice || 0;
  const straddlePrice = atmCELTP + atmPELTP;
  const upperRange = spot + straddlePrice;
  const lowerRange = spot - straddlePrice;

  // Calculate Multi-Strike PCR (NTM PCR - ±3 strikes around ATM)
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

  // Calculate Value-Weighted PCR
  let weightedCallValue = 0;
  let weightedPutValue = 0;
  strikes.forEach(s => {
    weightedCallValue += (s.CE?.openInterest || 0) * (s.CE?.lastPrice || 0);
    weightedPutValue += (s.PE?.openInterest || 0) * (s.PE?.lastPrice || 0);
  });
  const weightedPcr = weightedCallValue > 0 ? weightedPutValue / weightedCallValue : 0;

  // Calculate Support & Resistance Strength (%)
  const resistanceStrength = totalCallOI > 0 ? (maxCallOI / totalCallOI) * 100 : 0;
  const supportStrength = totalPutOI > 0 ? (maxPutOI / totalPutOI) * 100 : 0;

  // Calculate ATM IV Skew
  const atmCeIv = atmCE.impliedVolatility || 0;
  const atmPeIv = atmPE.impliedVolatility || 0;
  const ivSkew = atmPeIv - atmCeIv;

  // Calculate Max Pain
  let maxPain = atm;
  let minTotalPain = Infinity;

  strikes.forEach(candidate => {
    let totalPain = 0;
    strikes.forEach(s => {
      const cOI = s.CE?.openInterest || 0;
      const pOI = s.PE?.openInterest || 0;

      if (candidate.strike > s.strike) {
        totalPain += cOI * (candidate.strike - s.strike);
      }
      if (candidate.strike < s.strike) {
        totalPain += pOI * (s.strike - candidate.strike);
      }
    });

    if (totalPain < minTotalPain) {
      minTotalPain = totalPain;
      maxPain = candidate.strike;
    }
  });

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
    totalCallOI,
    totalPutOI,
    totalCallChgOI,
    totalPutChgOI,
    maxCallOIStrike,
    maxPutOIStrike,
    maxCallChgStrike,
    maxPutChgStrike,
    strikes,
    fetchedAt: new Date().toISOString()
  };

  cache = {
    data: result,
    ts: now,
    expiry: targetExpiry
  };

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

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Nifty OI Tracker running on http://localhost:${PORT}`);
});

module.exports = app;