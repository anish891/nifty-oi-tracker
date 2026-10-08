const fetch = require('node-fetch');
const { getCookies, fetchWithTimeout } = require('./nse');

// Cached market-context lookups: India VIX / index day stats from NSE, and the
// previous completed session's OHLC (for real CPR/pivots) from Yahoo Finance.
// Every function resolves to null on failure so analytics can degrade gracefully.

const INDICES_TTL = 15 * 1000;
const OHLC_TTL = 30 * 60 * 1000;

let indicesCache = { ts: 0, value: null };
let ohlcCache = { ts: 0, value: null, key: null };
let indicesInflight = null;

function istNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(date).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    mins: (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10),
    isWeekday: !['Sat', 'Sun'].includes(parts.weekday)
  };
}

function pick(row) {
  return {
    last: row.last,
    previousClose: row.previousClose,
    open: row.open,
    high: row.high,
    low: row.low,
    percentChange: row.percentChange
  };
}

async function loadIndices() {
  const cookies = await getCookies();
  const json = await fetchWithTimeout('https://www.nseindia.com/api/allIndices', cookies);
  const rows = json?.data || [];
  const nifty = rows.find(r => r.index === 'NIFTY 50');
  const vix = rows.find(r => r.index === 'INDIA VIX');
  if (!nifty) throw new Error('NIFTY 50 missing from allIndices');
  return { nifty: pick(nifty), vix: vix ? pick(vix) : null };
}

async function getIndexSnapshot() {
  if (indicesCache.value && Date.now() - indicesCache.ts < INDICES_TTL) return indicesCache.value;
  if (!indicesInflight) {
    indicesInflight = loadIndices()
      .then(v => { indicesCache = { ts: Date.now(), value: v }; return v; })
      .catch(err => {
        console.error('allIndices failed:', err.message);
        return indicesCache.value; // stale (or null) is better than nothing
      })
      .finally(() => { indicesInflight = null; });
  }
  return indicesInflight;
}

async function loadDailyBars() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=10d&interval=1d';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    const json = await res.json();
    const r = json.chart.result[0];
    const q = r.indicators.quote[0];
    const offset = r.meta.gmtoffset || 0;
    const bars = [];
    r.timestamp.forEach((t, i) => {
      if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v == null)) return;
      bars.push({
        date: new Date((t + offset) * 1000).toISOString().slice(0, 10),
        open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i]
      });
    });
    return bars;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OHLC of the session pivots should be built from: the previous completed
 * session intraday, or today's once the cash market has closed (next day's CPR).
 */
async function getPivotBasis() {
  const now = istNow();
  const sessionClosed = now.isWeekday && now.mins >= 15 * 60 + 35;
  const key = `${now.ymd}|${sessionClosed}`;
  if (ohlcCache.value && ohlcCache.key === key && Date.now() - ohlcCache.ts < OHLC_TTL) return ohlcCache.value;

  try {
    const bars = await loadDailyBars();
    const todayBar = bars.find(b => b.date === now.ymd);
    const prior = bars.filter(b => b.date < now.ymd).pop();
    const basis = sessionClosed && todayBar ? todayBar : prior;
    if (!basis) return ohlcCache.value;
    const value = { ...basis, source: 'yahoo' };
    ohlcCache = { ts: Date.now(), value, key };
    return value;
  } catch (err) {
    console.error('Pivot basis (daily OHLC) failed:', err.message);
    return ohlcCache.value; // may be null → caller falls back to OI estimate
  }
}

module.exports = { getIndexSnapshot, getPivotBasis, istNow };
