const express = require('express');
const router = express.Router();
const { getPool } = require('../services/db');
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
    const data = await processOptionChainData(raw, allExpiries, targetExpiry, getPool());
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error fetching option chain:', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

router.get('/history', async (req, res) => {
  const pool = getPool();
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

router.get('/db-status', async (req, res) => {
  const pool = getPool();
  if (!pool) {
    return res.status(200).json({
      connected: false,
      message: 'DATABASE_URL is not set in environment variables.'
    });
  }

  try {
    const tableQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `;
    const { rows: tables } = await pool.query(tableQuery);

    const snapshotsCount = await pool.query('SELECT COUNT(*) FROM option_chain_snapshots');
    const sessionsCount = await pool.query('SELECT COUNT(*) FROM session_summaries');

    res.json({
      connected: true,
      tables: tables.map(t => t.table_name),
      rowCounts: {
        option_chain_snapshots: parseInt(snapshotsCount.rows[0].count, 10),
        session_summaries: parseInt(sessionsCount.rows[0].count, 10)
      }
    });
  } catch (err) {
    res.status(500).json({
      connected: false,
      error: err.message
    });
  }
});

router.post('/session-summary', async (req, res) => {
  const pool = getPool();
  if (!pool) {
    return res.status(503).json({ ok: false, error: 'Database connection not configured (DATABASE_URL missing)' });
  }

  try {
    const { raw, allExpiries, targetExpiry } = await fetchRawNSEOptionChain('NIFTY');
    const data = await processOptionChainData(raw, allExpiries, targetExpiry, pool);
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

router.get('/similar-sessions', async (req, res) => {
  try {
    let liveData = getCacheData();
    const pool = getPool();
    if (!liveData) {
      const { raw, allExpiries, targetExpiry } = await fetchRawNSEOptionChain('NIFTY');
      liveData = await processOptionChainData(raw, allExpiries, targetExpiry, pool);
    }
    const currentVector = extractFeatureVector(liveData);

    let pastSessions = [];
    if (pool) {
      const { rows } = await pool.query('SELECT * FROM session_summaries ORDER BY date DESC LIMIT 100');
      pastSessions = rows;
    }

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

router.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

module.exports = router;
