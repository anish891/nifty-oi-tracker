const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env.local') });
const { Pool } = require('pg');

let pool = null;
let dbUrl = (process.env.DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');

if (dbUrl && (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://'))) {
  try {
    const match = dbUrl.match(/^(postgresql?:\/\/)([^:]+):([^@]+)@(.+)$/);
    if (match) {
      const [, protocol, user, pass, rest] = match;
      dbUrl = `${protocol}${user}:${encodeURIComponent(pass)}@${rest}`;
    }
    new URL(dbUrl);
    pool = new Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false }
    });
  } catch (err) {
    console.error('Invalid DATABASE_URL format in .env.local:', err.message);
    pool = null;
  }
}

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

// Auto init on load if configured
initDb();

let lastDbWriteTs = 0;
const DB_WRITE_INTERVAL_MS = 60 * 1000; // 1 minute throttle

function saveSnapshotsAsync(strikes, expiry, fetchedAt) {
  if (!pool || !strikes || !strikes.length) return;

  const now = Date.now();
  if (now - lastDbWriteTs < DB_WRITE_INTERVAL_MS) {
    return;
  }
  lastDbWriteTs = now;

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
      await pool.query("DELETE FROM option_chain_snapshots WHERE timestamp < NOW() - INTERVAL '7 days'");
    } catch (err) {
      console.error('Async snapshot save error:', err.message);
    }
  });
}

function getPool() {
  return pool;
}

module.exports = {
  pool,
  getPool,
  initDb,
  saveSnapshotsAsync
};
