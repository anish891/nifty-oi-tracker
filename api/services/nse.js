const fetch = require('node-fetch');

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

const COOKIE_TTL = 10 * 60 * 1000;

let cookieCache = {
  value: '',
  ts: 0
};

async function fetchNSECookies() {
  const res = await fetch('https://www.nseindia.com/', { headers: NSE_HEADERS });
  let cookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    cookies = res.headers.getSetCookie();
  } else if (typeof res.headers.raw === 'function') {
    cookies = res.headers.raw()['set-cookie'] || [];
  }
  return (cookies || []).map(c => c.split(';')[0]).join('; ');
}

async function getCookies() {
  const now = Date.now();

  if (cookieCache.value && now - cookieCache.ts < COOKIE_TTL) {
    return cookieCache.value;
  }

  const cookies = await fetchNSECookies();
  cookieCache = {
    value: cookies,
    ts: now
  };

  return cookies;
}

async function fetchWithTimeout(url, cookies, attempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, {
      headers: { ...NSE_HEADERS, Cookie: cookies },
      signal: controller.signal
    });

    // Cookies are only bad on auth failures; don't drop them on a plain timeout.
    if (res.status === 401 || res.status === 403) {
      cookieCache = { value: '', ts: 0 };
      throw new Error(`NSE rejected request (${res.status})`);
    }
    return await res.json();
  } catch (e) {
    if (attempt < 1) {
      const fresh = cookieCache.value ? cookies : await getCookies().catch(() => cookies);
      return fetchWithTimeout(url, fresh, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Caching layers -------------------------------------------------------
const EXPIRY_TTL = 60 * 60 * 1000;   // expiry list changes ~daily
const RAW_TTL = 5000;                // NSE itself only updates every ~30-60s
const STALE_MAX = 5 * 60 * 1000;     // serve last good data up to 5 min on errors

let expiryCache = { list: null, ts: 0 };
const rawCache = new Map();          // `${symbol}|${expiry}` -> { value, ts }
const inflight = new Map();          // key -> Promise

function parseNseDate(str) {
  const d = new Date(`${str.replace(/-/g, ' ')} 23:59:59 GMT+0530`);
  return isNaN(d) ? null : d.getTime();
}

function getCachedExpiries() {
  if (!expiryCache.list || Date.now() - expiryCache.ts > EXPIRY_TTL) return null;
  // Drop the list once its nearest expiry has passed
  const first = parseNseDate(expiryCache.list[0]);
  if (first && first < Date.now()) return null;
  return expiryCache.list;
}

function expiryUrl(symbol, expiry) {
  return `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=${symbol}&expiry=${encodeURIComponent(expiry)}`;
}

async function loadFromNSE(symbol, expiryDate) {
  let cookies = '';
  try {
    cookies = await getCookies();
  } catch (e) {
    console.error('Cookie fetch failed:', e.message);
  }

  const known = getCachedExpiries();
  // With a cached expiry list the target is known up front -> single NSE call.
  const targetGuess = expiryDate || (known && known[0]) || null;
  const bootstrapExpiry = targetGuess || '30-Jun-2026';

  let raw = await fetchWithTimeout(expiryUrl(symbol, bootstrapExpiry), cookies);
  if (!raw?.records?.expiryDates?.length) {
    throw new Error('Unexpected NSE response structure');
  }

  const allExpiries = raw.records.expiryDates;
  expiryCache = { list: allExpiries, ts: Date.now() };
  const targetExpiry = expiryDate || allExpiries[0];

  if (targetExpiry !== bootstrapExpiry) {
    raw = await fetchWithTimeout(expiryUrl(symbol, targetExpiry), cookies);
    if (!raw?.records?.data) {
      throw new Error('Unexpected NSE response structure');
    }
  }

  return { raw, allExpiries, targetExpiry };
}

async function fetchRawNSEOptionChain(symbol = 'NIFTY', expiryDate = null) {
  const known = getCachedExpiries();
  const resolved = expiryDate || (known && known[0]) || null;
  const key = `${symbol}|${resolved || 'nearest'}`;

  const hit = rawCache.get(key);
  if (hit && Date.now() - hit.ts < RAW_TTL) return hit.value;

  // Coalesce concurrent requests into one NSE call
  if (inflight.has(key)) return inflight.get(key);

  const p = loadFromNSE(symbol, expiryDate)
    .then(value => {
      rawCache.set(key, { value, ts: Date.now() });
      return value;
    })
    .catch(err => {
      // Stale-on-error: better old data than a "Disconnected" dashboard
      if (hit && Date.now() - hit.ts < STALE_MAX) {
        console.error('NSE fetch failed, serving stale data:', err.message);
        return hit.value;
      }
      throw err;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

module.exports = {
  NSE_HEADERS,
  getCookies,
  fetchWithTimeout,
  fetchRawNSEOptionChain
};

