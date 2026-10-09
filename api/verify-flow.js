// Regression: the unusual-flow detector must score *adjacent* NSE snapshots only.
// An idle serverless instance (or a restart) used to compare snapshots 30 minutes apart and flag
// hundreds of strikes as CRITICAL "volume surges" when volume per minute had not changed at all.
const assert = require('assert');

// Keep the test offline and fast: stub the network-backed market lookups BEFORE loading analytics.
const market = require('./services/market');
market.getIndexSnapshot = async () => null;
market.getPivotBasis = async () => null;
const analytics = require('./services/analytics');

const EXPIRY = '13-Oct-2026';
const mkRaw = (minuteOffset, perMinVol) => {
  const t = Date.UTC(2026, 9, 9, 4, 0) + minuteOffset * 60000; // IST = UTC+5:30
  const d = new Date(t + 5.5 * 3600e3);
  const p = n => String(n).padStart(2, '0');
  const stamp = `${p(d.getUTCDate())}-Oct-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
  const data = [];
  for (let k = 21700; k <= 22800; k += 50) {
    const leg = (ltp) => ({
      openInterest: 100000, changeinOpenInterest: 1000 + minuteOffset * 50, lastPrice: ltp, change: 0,
      impliedVolatility: 14, totalTradedVolume: 50000 + perMinVol * minuteOffset
    });
    data.push({ strikePrice: k, expiryDate: EXPIRY, CE: leg(120), PE: leg(110) });
  }
  return { records: { underlyingValue: 22250, timestamp: stamp, data, expiryDates: [EXPIRY] } };
};

(async () => {
  let nowMs = Date.now();
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    const run = async (minute, vol) => {
      nowMs += 61000; // defeats the 5 s response cache
      const d = await analytics.processOptionChainData(mkRaw(minute, vol), [EXPIRY], EXPIRY);
      return d.unusualActivity;
    };

    for (let m = 1; m <= 6; m++) await run(m, 2000);
    assert.strictEqual((await run(7, 2000)).length, 0, 'steady volume is not unusual');

    nowMs += 29 * 60000; // this instance sees nothing for 29 minutes
    const afterGap = await run(36, 2000); // same volume per minute as before
    assert.strictEqual(afterGap.length, 0, `a 29-minute gap must not create flow alerts (got ${afterGap.length})`);

    // a *real* surge between adjacent snapshots is still detected
    for (let m = 37; m <= 41; m++) await run(m, 2000);
    const surge = await run(42, 40000); // 20x the usual per-minute volume
    assert(surge.length > 0 && surge.every(a => a.volRatio >= 2.5), 'a genuine surge between adjacent snapshots is still flagged');

    // flow far from spot is never reported
    assert(surge.every(a => Math.abs(a.strike - 22250) / 22250 <= 0.03), 'flow >3% from spot is ignored');
  } finally {
    Date.now = realNow;
  }
  console.log('✓ flow detector OK (no false surges after gaps; real surges still caught; far strikes ignored)');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
