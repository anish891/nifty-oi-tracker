const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/option-chain',
  'Origin': 'https://www.nseindia.com',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

// In-memory cache: 5s TTL
let cache = { data: null, ts: 0, expiry: null };

async function fetchNSECookies() {
  const res = await fetch('https://www.nseindia.com/option-chain', { headers: NSE_HEADERS });
  const cookies = res.headers.raw()['set-cookie'] || [];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

async function fetchOptionChain(symbol = 'NIFTY', expiryDate = null) {
  const now = Date.now();
  if (cache.data && now - cache.ts < 5000 && (!expiryDate || cache.expiry === expiryDate)) {
    return cache.data;
  }

  let cookies = '';
  try {
    cookies = await fetchNSECookies();
  } catch (e) {
    console.error('Cookie fetch failed:', e.message);
  }

  // FIX 1: Use option-chain-indices (no expiry in URL) — it returns ALL expiries
  // so we can filter client-side and also populate the expiry dropdown correctly
  const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
  const res = await fetch(url, {
    headers: { ...NSE_HEADERS, 'Cookie': cookies }
  });

  if (!res.ok) {
    throw new Error(`NSE API returned ${res.status}: ${res.statusText}`);
  }

  const raw = await res.json();

  if (!raw?.records?.data) {
    throw new Error('Unexpected NSE response structure');
  }

  const spot = raw.records.underlyingValue;
  const allExpiries = raw.records.expiryDates || [];

  // FIX 2: Never hardcode a date — always pick the first available expiry dynamically
  const targetExpiry = expiryDate && allExpiries.includes(expiryDate)
    ? expiryDate
    : allExpiries[0];

  const atm = Math.round(spot / 50) * 50;
  const MIN_STRIKE = atm - 500;
  const MAX_STRIKE = atm + 500;

  // FIX 3: field is `r.expiryDate` (singular), NOT `r.expiryDates`
  const rows = raw.records.data.filter(r =>
    r.expiryDate === targetExpiry &&
    r.strikePrice >= MIN_STRIKE &&
    r.strikePrice <= MAX_STRIKE
  );

  const strikeMap = {};
  rows.forEach(r => {
    const s = r.strikePrice;
    if (!strikeMap[s]) strikeMap[s] = { strike: s };
    if (r.CE) strikeMap[s].CE = r.CE;
    if (r.PE) strikeMap[s].PE = r.PE;
  });

  const strikes = Object.values(strikeMap).sort((a, b) => a.strike - b.strike);

  let totalCallOI = 0, totalPutOI = 0, totalCallChgOI = 0, totalPutChgOI = 0;
  let maxCallOI = 0, maxPutOI = 0;
  let maxCallOIStrike = atm, maxPutOIStrike = atm;
  let maxCallChgOI = -Infinity, maxPutChgOI = -Infinity;
  let maxCallChgStrike = atm, maxPutChgStrike = atm;

  strikes.forEach(s => {
    const cOI = s.CE?.openInterest || 0;
    const pOI = s.PE?.openInterest || 0;
    const cChg = s.CE?.changeinOpenInterest || 0;
    const pChg = s.PE?.changeinOpenInterest || 0;

    totalCallOI += cOI;
    totalPutOI += pOI;
    totalCallChgOI += cChg;
    totalPutChgOI += pChg;

    if (cOI > maxCallOI) { maxCallOI = cOI; maxCallOIStrike = s.strike; }
    if (pOI > maxPutOI) { maxPutOI = pOI; maxPutOIStrike = s.strike; }
    if (cChg > maxCallChgOI) { maxCallChgOI = cChg; maxCallChgStrike = s.strike; }
    if (pChg > maxPutChgOI) { maxPutChgOI = pChg; maxPutChgStrike = s.strike; }
  });

  const pcr = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0;

  const result = {
    spot, atm,
    expiry: targetExpiry,
    allExpiries,
    pcr,
    totalCallOI, totalPutOI, totalCallChgOI, totalPutChgOI,
    maxCallOIStrike, maxPutOIStrike,
    maxCallChgStrike, maxPutChgStrike,
    strikes,
    fetchedAt: new Date().toISOString(),
  };

  cache = { data: result, ts: now, expiry: targetExpiry };
  return result;
}

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