const assert = require('assert');
const root = require('path').join(__dirname, 'services') + '/';
const history = require(root + 'history');

const mk = (minOffset, callOI) => {
  const asOf = new Date(Date.UTC(2026, 9, 8, 4, 0 + minOffset)).toISOString(); // 09:30 IST + offset
  return {
    expiry: '13-Oct-2026', dataAsOf: asOf, fetchedAt: asOf, spot: 22200 + minOffset, pcr: 0.6 + minOffset / 1000,
    ntmPcr: 0.8, volPcr: 1, straddlePrice: 280, atmIv: 14, ivSkew: 2, vix: { last: 15 }, maxPain: 22400,
    gex: { totalGexCr: 100, gexRegime: 'POSITIVE_GAMMA' }, totalCallOI: callOI, totalPutOI: 2e6, totalCallChgOI: 1, totalPutChgOI: 2,
    impliedFuture: 22210, maxCallOIStrike: 23000, maxPutOIStrike: 21000, cpr: { cprType: 'WIDE' }, atm: 22250,
    strikes: [{ strike: 22250, CE: { openInterest: callOI / 100, changeinOpenInterest: 5, lastPrice: 100, impliedVolatility: 13 }, PE: { openInterest: 5000, changeinOpenInterest: 5, lastPrice: 110, impliedVolatility: 14 } }]
  };
};

(async () => {
  console.log('backend:', history.backend, 'persistent:', history.configured);
  for (let m = 0; m <= 40; m += 1) {
    const r = await history.recordSnapshot(mk(m, 3e6 + m * 1e4), [1, 2, 3]);
    assert(r.recorded, `minute ${m} should record: ${JSON.stringify(r)}`);
  }
  // duplicate NSE timestamp must not double-record
  assert.strictEqual((await history.recordSnapshot(mk(40, 3.4e6), [1])).recorded, false);

  const out = await history.getIntraday('13-Oct-2026');
  assert.strictEqual(out.date, '2026-10-08');
  assert.strictEqual(out.points.length, 41);
  const lastT = out.points.at(-1).t;
  assert.strictEqual((lastT - out.baselines.m5.t) / 60000, 5);
  assert.strictEqual((lastT - out.baselines.m15.t) / 60000, 15);
  assert.strictEqual((lastT - out.baselines.m30.t) / 60000, 30);
  assert.strictEqual(out.baselines.open.t, out.points[0].t);
  assert.deepStrictEqual(Object.keys(out.baselines.m5.strikes), ['22250']);
  assert.strictEqual(out.baselines.m5.strikes[22250][0], (3e6 + 35 * 1e4) / 100);

  // too little history → baseline is null, not a wrong value
  await history.recordSnapshot({ ...mk(0, 1e6), expiry: '20-Oct-2026' }, null);
  const young = await history.getIntraday('20-Oct-2026');
  assert.strictEqual(young.baselines.m5, undefined);
  assert(young.baselines.open);

  // session summary only after 15:20 IST (09:50 UTC)
  const late = mk(0, 3e6); late.dataAsOf = late.fetchedAt = new Date(Date.UTC(2026, 9, 8, 10, 0)).toISOString(); late.expiry = '27-Oct-2026';
  await history.recordSnapshot(late, [9, 9, 9]);
  const sessions = await history.getSessions(10);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].date, '2026-10-08');
  // out-of-order arrival (two instances racing) must not scramble the series or the baselines
  {
    const ex = '24-Nov-2026';
    for (const m of [5, 0, 3, 1, 4, 2, 6]) await history.recordSnapshot({ ...mk(m, 3e6 + m * 1e4), expiry: ex }, null);
    const o = await history.getIntraday(ex);
    assert.deepStrictEqual(o.points.map(p => p.t), [...o.points.map(p => p.t)].sort((a, b) => a - b), 'points are returned in time order');
    assert.strictEqual(o.baselines.open.t, o.points[0].t, 'open baseline is the earliest snapshot, not the first inserted');
  }

  // snapshot + strike-history reads
  const lastPoint = out.points.at(-1);
  const snap = await history.getSnapshotStrikes('13-Oct-2026', lastPoint.t);
  assert(Array.isArray(snap) && snap[0].strike === 22250 && snap[0].ceOI === (3e6 + 40 * 1e4) / 100, 'snapshot rows are decoded into named fields');
  assert.strictEqual(await history.getSnapshotStrikes('13-Oct-2026', 12345), null, 'unknown snapshot → null');
  const sh = await history.getStrikeHistory('13-Oct-2026', 22250, null, 10);
  assert(sh.samples.length <= 11 && sh.samples.length >= 8, `sampled to ~10, got ${sh.samples.length}`);
  assert.strictEqual(sh.samples[0].t, out.points[0].t, 'includes the first snapshot');
  assert.strictEqual(sh.samples.at(-1).t, lastPoint.t, 'includes the latest snapshot');
  assert(sh.samples.every(x => x.strike === 22250 && typeof x.ceOI === 'number' && typeof x.spot === 'number'));
  assert.deepStrictEqual((await history.getStrikeHistory('13-Oct-2026', 99999, null, 10)).samples, [], 'strike never stored → no samples');
  assert.deepStrictEqual((await history.getStrikeHistory('01-Jan-2030', 22250)).samples, [], 'unknown expiry → empty');

  console.log('✓ history OK:', out.points.length, 'points; baselines', Object.keys(out.baselines).join(','), '; sessions', sessions.length);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
