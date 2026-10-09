const express = require('express');
const router = express.Router();
const history = require('../services/history');
const { istNow } = require('../services/market');
const { fetchRawNSEOptionChain } = require('../services/nse');
const {
  processOptionChainData,
  extractFeatureVector,
  computeCosineSimilarity,
  getCacheData
} = require('../services/analytics');

router.get('/option-chain', async (req, res) => {
  try {
    const { expiry } = req.query;
    const { raw, allExpiries, targetExpiry } = await fetchRawNSEOptionChain('NIFTY', expiry || null);
    const data = await processOptionChainData(raw, allExpiries, targetExpiry);
    res.json({ ok: true, data });
  } catch (err) {
    if (err.code !== 'BAD_EXPIRY') console.error('Error fetching option chain:', err.message);
    res.status(err.code === 'BAD_EXPIRY' ? 400 : 502).json({ ok: false, error: err.message });
  }
});

// Intraday series + baseline strike snapshots (5m / 15m / 30m earlier, and the open)
router.get('/intraday', async (req, res) => {
  try {
    const { expiry, date } = req.query;
    if (!expiry) return res.status(400).json({ ok: false, error: 'expiry is required' });
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD' });
    const data = await history.getIntraday(expiry, date || null);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, backend: history.backend, persistent: history.configured, ...data });
  } catch (err) {
    console.error('Error reading intraday history:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const EXPIRY_RE = /^\d{2}-[A-Za-z]{3}-\d{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// One strike across the day (sampled)
router.get('/strike-history', async (req, res) => {
  const { expiry, date } = req.query;
  const strike = Number(req.query.strike);
  if (!EXPIRY_RE.test(expiry || '') || !Number.isInteger(strike) || strike <= 0) {
    return res.status(400).json({ ok: false, error: 'expiry (DD-Mon-YYYY) and integer strike are required' });
  }
  if (date && !DATE_RE.test(date)) return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD' });
  try {
    const data = await history.getStrikeHistory(expiry, strike, date || null);
    res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('Error reading strike history:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/storage-status', (req, res) => {
  res.json({
    ok: true,
    backend: history.backend,
    persistent: history.configured,
    message: history.configured
      ? 'Upstash Redis connected via REST.'
      : 'No UPSTASH_REDIS_REST_URL / TOKEN set — history is in memory and is lost on restart or cold start.'
  });
});

// Records a snapshot even when nobody has the page open. Point an external pinger or
// Vercel Cron at it during market hours. Protected by CRON_SECRET when that is set.
router.all('/cron/snapshot', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.key;
    if (given !== secret) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    const { raw, allExpiries, targetExpiry } = await fetchRawNSEOptionChain('NIFTY', req.query.expiry || null);
    const data = await processOptionChainData(raw, allExpiries, targetExpiry);
    res.json({ ok: true, expiry: data.expiry, dataAsOf: data.dataAsOf, backend: history.backend, persistent: history.configured });
  } catch (err) {
    console.error('Cron snapshot failed:', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

router.post('/session-summary', async (req, res) => {
  try {
    const { raw, allExpiries, targetExpiry } = await fetchRawNSEOptionChain('NIFTY');
    const data = await processOptionChainData(raw, allExpiries, targetExpiry);
    const vector = extractFeatureVector(data);
    const date = istNow(new Date(data.dataAsOf || Date.now())).ymd;
    await history.saveSession(history.buildSessionRecord(data, vector, date));
    res.json({ ok: true, message: 'Session summary saved successfully', date, vector, persistent: history.configured });
  } catch (err) {
    console.error('Error saving session summary:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/similar-sessions', async (req, res) => {
  try {
    let liveData = getCacheData();
    if (!liveData) {
      const { raw, allExpiries, targetExpiry } = await fetchRawNSEOptionChain('NIFTY');
      liveData = await processOptionChainData(raw, allExpiries, targetExpiry);
    }
    const currentVector = extractFeatureVector(liveData);

    // Exclude today's own (possibly just-written) record so a session can't match itself at 100%
    const today = istNow().ymd;
    const pastSessions = (await history.getSessions(100)).filter(x => x.date !== today);

    if (pastSessions.length === 0) {
      // No stored sessions (DB disabled/empty): say so instead of inventing history.
      return res.json({
        ok: true,
        currentVector,
        topMatches: [],
        reason: history.configured
          ? 'No saved sessions yet — one is stored automatically after each close'
          : 'Session history needs storage (set UPSTASH_REDIS_REST_URL / TOKEN)'
      });
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

router.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

module.exports = router;
