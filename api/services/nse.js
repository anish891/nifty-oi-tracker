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

async function fetchRawNSEOptionChain(symbol = 'NIFTY', expiryDate = null) {
  let cookies = '';
  try {
    cookies = await getCookies();
  } catch (e) {
    console.error('Cookie fetch failed:', e.message);
  }

  const bootstrapExpiry = expiryDate || '30-Jun-2026';
  let url = `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=${symbol}&expiry=${encodeURIComponent(bootstrapExpiry)}`;

  let raw = await fetchWithTimeout(url, cookies);

  if (!raw?.records?.expiryDates?.length) {
    throw new Error('Unexpected NSE response structure');
  }

  const allExpiries = raw.records.expiryDates;
  const targetExpiry = expiryDate || allExpiries[0];

  if (targetExpiry !== bootstrapExpiry) {
    url = `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=${symbol}&expiry=${encodeURIComponent(targetExpiry)}`;
    raw = await fetchWithTimeout(url, cookies);

    if (!raw?.records?.data) {
      throw new Error('Unexpected NSE response structure');
    }
  }

  return { raw, allExpiries, targetExpiry };
}

module.exports = {
  NSE_HEADERS,
  getCookies,
  fetchWithTimeout,
  fetchRawNSEOptionChain
};

