const store = require('./storage');
const { istNow } = require('./market');

// Intraday buffer + session summaries.
//
//   oi:seen:{expiry}:{asOf}   claim key  → exactly one snapshot per NSE update, however many
//                                          clients / cron hits observe it
//   oi:s:{date}:{expiry}      list       → compact series point per snapshot (small, charted whole)
//   oi:k:{expiry}:{t}         string     → per-strike OI/price/IV for that snapshot (read selectively)
//   oi:latest:{expiry}        string     → most recent trading date recorded for the expiry
//   oi:sessions               hash       → date → end-of-day summary (similar sessions, IV history)

const DAY_TTL = 14 * 24 * 3600;
const STRIKES_TTL = 7 * 24 * 3600;
const SESSION_SAVE_FROM_MINS = 15 * 60 + 20; // IST; last write of the day (≈15:30) wins

const lastRecorded = new Map(); // expiry -> asOf this instance already handled (skips network)
const WINDOWS_MIN = { m5: 5, m15: 15, m30: 30 };

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function compactPoint(d, t) {
  return {
    t,
    spot: d.spot,
    pcr: d.pcr,
    ntmPcr: d.ntmPcr,
    volPcr: d.volPcr,
    straddle: d.straddlePrice,
    atmIv: d.atmIv,
    ivSkew: d.ivSkew,
    vix: d.vix ? d.vix.last : null,
    maxPain: d.maxPain,
    gexCr: d.gex ? d.gex.totalGexCr : null,
    callOI: d.totalCallOI,
    putOI: d.totalPutOI,
    callChg: d.totalCallChgOI,
    putChg: d.totalPutChgOI,
    fut: d.impliedFuture
  };
}

// [strike, ceOI, peOI, ceChgOI, peChgOI, ceLtp, peLtp, ceIv, peIv]
function compactStrikes(d) {
  return d.strikes.map(s => [
    s.strike,
    s.CE?.openInterest || 0, s.PE?.openInterest || 0,
    s.CE?.changeinOpenInterest || 0, s.PE?.changeinOpenInterest || 0,
    s.CE?.lastPrice || 0, s.PE?.lastPrice || 0,
    s.CE?.impliedVolatility || 0, s.PE?.impliedVolatility || 0
  ]);
}

function buildSessionRecord(d, vector, date) {
  return {
    date,
    closing_pcr: d.pcr,
    gex_regime: d.gex?.gexRegime || null,
    cpr_width_type: d.cpr?.cprType || null,
    feature_vector: vector,
    atm_iv: d.atmIv,
    close: d.spot,
    top_buildup_strikes: [
      { strike: d.maxCallOIStrike, side: 'CE' },
      { strike: d.maxPutOIStrike, side: 'PE' }
    ]
  };
}

async function saveSession(record) {
  await store.hset('oi:sessions', record.date, JSON.stringify(record));
  sessionsCache.ts = 0;
}

const sessionsCache = { ts: 0, rows: [] };

/** Newest first; cached for 5 minutes (it changes once a day). */
async function getSessions(limit = 100) {
  if (Date.now() - sessionsCache.ts > 5 * 60 * 1000) {
    const all = await store.hgetall('oi:sessions');
    sessionsCache.rows = Object.values(all).map(safeParse).filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1));
    sessionsCache.ts = Date.now();
  }
  return sessionsCache.rows.slice(0, limit);
}

/**
 * Persist one snapshot per NSE data timestamp. Safe to call on every request:
 * the common path (already recorded) never touches the network.
 */
async function recordSnapshot(d, vector) {
  const asOf = d.dataAsOf || d.fetchedAt;
  if (!asOf || !d.strikes?.length) return { recorded: false, reason: 'no-data' };
  if (lastRecorded.get(d.expiry) === asOf) return { recorded: false, reason: 'seen' };
  lastRecorded.set(d.expiry, asOf);

  const claimed = await store.setNx(`oi:seen:${d.expiry}:${asOf}`, '1', 24 * 3600);
  if (!claimed) return { recorded: false, reason: 'claimed-elsewhere' };

  const t = new Date(asOf).getTime();
  const { ymd, mins, isWeekday } = istNow(new Date(asOf));
  const seriesKey = `oi:s:${ymd}:${d.expiry}`;

  await store.pipeline([
    ['SET', `oi:k:${d.expiry}:${t}`, JSON.stringify(compactStrikes(d)), 'EX', STRIKES_TTL],
    ['RPUSH', seriesKey, JSON.stringify(compactPoint(d, t))],
    ['EXPIRE', seriesKey, DAY_TTL],
    ['SET', `oi:latest:${d.expiry}`, ymd, 'EX', DAY_TTL]
  ]);

  if (isWeekday && mins >= SESSION_SAVE_FROM_MINS && vector) {
    await saveSession(buildSessionRecord(d, vector, ymd));
  }
  return { recorded: true, date: ymd, t };
}

/**
 * Series for the day plus baseline strike snapshots (5m / 15m / 30m earlier, and the open)
 * so the client can compute rate-of-change against *live* data.
 */
async function getIntraday(expiry, date = null) {
  const day = date || await store.get(`oi:latest:${expiry}`);
  if (!day) return { date: null, expiry, points: [], baselines: {} };

  const rows = await store.lrange(`oi:s:${day}:${expiry}`, 0, -1);
  // Insertion order is arrival order; two instances racing can append slightly out of order, so sort by time.
  const points = rows.map(safeParse).filter(Boolean).sort((a, b) => a.t - b.t);
  if (points.length === 0) return { date: day, expiry, points: [], baselines: {} };

  const latest = points[points.length - 1];
  const picks = { open: points[0] };
  for (const [name, mins] of Object.entries(WINDOWS_MIN)) {
    const target = latest.t - mins * 60 * 1000;
    let found = null;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].t <= target) { found = points[i]; break; }
    }
    picks[name] = found; // null until enough history has accumulated
  }

  const names = Object.keys(picks).filter(n => picks[n]);
  const strikeRows = names.length
    ? await store.pipeline(names.map(n => ['GET', `oi:k:${expiry}:${picks[n].t}`]))
    : [];

  const baselines = {};
  names.forEach((n, i) => {
    const strikes = safeParse(strikeRows[i]);
    baselines[n] = {
      ...picks[n],
      strikes: strikes ? Object.fromEntries(strikes.map(r => [r[0], [r[1], r[2]]])) : {}
    };
  });

  return { date: day, expiry, points, baselines };
}

const COLS = ['strike', 'ceOI', 'peOI', 'ceChg', 'peChg', 'ceLtp', 'peLtp', 'ceIv', 'peIv'];
const rowToObject = r => Object.fromEntries(COLS.map((c, i) => [c, r[i]]));

/** Per-strike table stored for one snapshot (null if that snapshot has expired / never existed). */
async function getSnapshotStrikes(expiry, t) {
  const raw = await store.get(`oi:k:${expiry}:${t}`);
  const rows = raw ? safeParse(raw) : null;
  return rows ? rows.map(rowToObject) : null;
}

/**
 * One strike's OI / price / IV across the day, sampled to at most `maxSamples` snapshots
 * (always including the first and last) so a drill-down costs ~60 reads, not ~400.
 */
async function getStrikeHistory(expiry, strike, date = null, maxSamples = 60) {
  const day = date || await store.get(`oi:latest:${expiry}`);
  if (!day) return { date: null, expiry, strike, samples: [] };

  const rows = await store.lrange(`oi:s:${day}:${expiry}`, 0, -1);
  const points = rows.map(safeParse).filter(Boolean).sort((a, b) => a.t - b.t);
  if (points.length === 0) return { date: day, expiry, strike, samples: [] };

  const stride = Math.max(1, Math.ceil(points.length / maxSamples));
  const picked = points.filter((_, i) => i % stride === 0);
  if (picked[picked.length - 1] !== points[points.length - 1]) picked.push(points[points.length - 1]);

  const blobs = await store.pipeline(picked.map(p => ['GET', `oi:k:${expiry}:${p.t}`]));
  const samples = [];
  picked.forEach((p, i) => {
    const table = blobs[i] ? safeParse(blobs[i]) : null;
    const row = table && table.find(r => r[0] === strike);
    if (row) samples.push({ t: p.t, spot: p.spot, ...rowToObject(row) });
  });
  return { date: day, expiry, strike, samples };
}

module.exports = {
  backend: store.backend,
  configured: store.configured,
  recordSnapshot,
  getIntraday,
  getSnapshotStrikes,
  getStrikeHistory,
  getSessions,
  saveSession,
  buildSessionRecord
};
