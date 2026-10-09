// Tests for public/js/alert-rules.js (a pure ES module with no imports).
// Loaded through a data: URL so this works on any Node >= 18 without a bundler or package "type".
const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/alert-rules.js'), 'utf8');
  const { evaluateRules, createAlertEngine, mergeSettings, pcrZone, DEFAULT_SETTINGS } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

  const T0 = Date.UTC(2026, 9, 9, 4, 0);
  const MIN = 60000;
  const base = (over = {}) => ({
    expiry: '13-Oct-2026',
    spot: 22200, pcr: 1.0, maxCallOIStrike: 23000, maxPutOIStrike: 21000,
    cpr: { source: 'PREV_SESSION', tc: 22300, bc: 22250 },
    gex: { gexRegime: 'POSITIVE_GAMMA', zeroGammaLevel: 22100 },
    compositeRegime: { regimeLabel: 'R' }, vix: { last: 14, percentChange: 1 }, unusualActivity: [],
    ...over
  });
  // feed snapshots one minute apart; returns every event emitted and the final state
  const feed = (snapshots, ctxs = [], settings = DEFAULT_SETTINGS) => {
    let state = null; const events = [];
    snapshots.forEach((s, i) => {
      const d = { ...s, dataAsOf: s.dataAsOf || new Date(T0 + i * MIN).toISOString() };
      const out = evaluateRules(state, d, ctxs[i] || {}, settings);
      state = out.next; events.push(...out.events);
    });
    return { events, state };
  };
  const keys = r => r.events.map(e => e.key);
  // a change must be seen on two consecutive snapshots: seed, then the changed snapshot twice
  const change = (over, ctx, settings) => feed([base(), base(over), base(over)], [{}, ctx || {}, ctx || {}], settings);

  // ── edge-triggered & confirmed ──────────────────────────────────────────
  assert.deepStrictEqual(feed([base(), base(), base()]).events, [], 'no change → no alerts');

  let r = feed([base(), base({ pcr: 1.25 })]);
  assert.deepStrictEqual(r.events, [], 'a single blip is not confirmed');
  r = change({ pcr: 1.25 });
  assert.deepStrictEqual(keys(r), ['pcr:bull']);
  assert(/bullish/.test(r.events[0].title));
  r = feed([base(), base({ pcr: 1.25 }), base({ pcr: 1.25 }), base({ pcr: 1.3 }), base({ pcr: 1.4 })]);
  assert.strictEqual(r.events.length, 1, 'staying in the zone must not re-fire');
  assert.strictEqual(pcrZone(0.7, 1.2, 0.8), 'bear');

  // ── hysteresis: hovering around a threshold stays quiet ────────────────
  const hover = feed([base({ pcr: 1.25 }), ...[1.19, 1.21, 1.19, 1.22, 1.18, 1.21].map(pcr => base({ pcr }))]);
  assert.deepStrictEqual(hover.events, [], 'PCR wobbling around 1.2 inside the margin never re-fires');
  const leave = feed([base({ pcr: 1.25 }), base({ pcr: 1.1 }), base({ pcr: 1.1 })]);
  assert.deepStrictEqual(keys(leave), ['pcr:neutral'], 'a real exit (well below the margin) does fire');

  // levels: crossing needs a clear break, then to hold
  r = feed([base({ spot: 22270 }), base({ spot: 22320 }), base({ spot: 22322 })]);
  assert.deepStrictEqual(keys(r), ['level:cprTop:above']);
  r = feed([base({ spot: 22270 }), base({ spot: 22303 }), base({ spot: 22304 })]);
  assert.deepStrictEqual(r.events, [], 'poking 3-4 pts past the level is inside the buffer');
  const chop = feed([base({ spot: 22270 }), ...[22318, 22290, 22320, 22288, 22322, 22285].map(spot => base({ spot }))]);
  assert.deepStrictEqual(chop.events, [], 'choppy back-and-forth never holds two snapshots on one side');
  r = feed([base({ spot: 22270 }), base({ spot: 22050 }), base({ spot: 22050 })]);
  assert.deepStrictEqual(keys(r).sort(), ['level:cprBottom:below', 'level:zeroGamma:below']);
  // CPR from the OI estimate is not a real level
  r = feed([base({ spot: 22270, cpr: { source: 'OI_ESTIMATE', tc: 22300, bc: 22250 } }), base({ spot: 22330, cpr: { source: 'OI_ESTIMATE', tc: 22300, bc: 22250 } }), base({ spot: 22331, cpr: { source: 'OI_ESTIMATE', tc: 22300, bc: 22250 } })]);
  assert(!keys(r).some(k => k.startsWith('level:cpr')));

  // ── walls: breach is high severity; near-tied walls don't flap ──────────
  r = feed([base({ spot: 22950 }), base({ spot: 23040 }), base({ spot: 23042 })]);
  assert(r.events.some(e => e.key === 'level:callWall:above' && e.severity === 'high'));
  const oi = (a, b) => [{ strike: 22800, CE: { openInterest: a } }, { strike: 23000, CE: { openInterest: b } }];
  const tied = feed([
    base({ maxCallOIStrike: 23000, strikes: oi(100000, 101000) }),
    ...Array.from({ length: 8 }, (_, i) => (i % 2 ? base({ maxCallOIStrike: 22800, strikes: oi(103000, 101000) }) : base({ maxCallOIStrike: 23000, strikes: oi(100000, 102000) })))
  ]);
  assert.deepStrictEqual(tied.events, [], 'a challenger within 10% of the incumbent never takes over');
  r = feed([base({ strikes: oi(100000, 101000) }), ...Array(2).fill(base({ maxCallOIStrike: 22800, strikes: oi(130000, 101000) }))]);
  assert.deepStrictEqual(keys(r), ['wallShift:call'], 'a clearly bigger wall does take over — once');

  // ── gamma flip needs a margin and to persist ────────────────────────────
  const gex = (total, regime) => base({ gex: { gexRegime: regime, totalGexCr: total, callGexCr: 60, putGexCr: 60, zeroGammaLevel: 22100 } });
  assert.deepStrictEqual(feed([gex(2, 'POSITIVE_GAMMA'), gex(-2, 'NEGATIVE_GAMMA'), gex(1, 'POSITIVE_GAMMA'), gex(-3, 'NEGATIVE_GAMMA')]).events, [], 'GEX hovering around zero is not a regime flip');
  r = feed([gex(20, 'POSITIVE_GAMMA'), gex(-20, 'NEGATIVE_GAMMA'), gex(-22, 'NEGATIVE_GAMMA')]);
  assert(r.events.some(e => e.key === 'gex:NEGATIVE_GAMMA' && e.severity === 'high'));

  // ── flow / OI spikes: once per strike, grouped bursts, far strikes ignored ─
  const spike = (type, strike) => ({ type, strike, summary: `${type} ${strike}` });
  const one = [spike('PUT_WRITING', 22000)];
  r = feed([base(), base(), base(), base(), base(), base()], [{}, { spikeAlerts: one }, { spikeAlerts: one }, { spikeAlerts: one }, { spikeAlerts: one }, { spikeAlerts: one }]);
  assert.deepStrictEqual(keys(r), ['flow:PUT_WRITING:22000'], 'a spike that persists is announced once, not every snapshot');
  r = feed([base(), base()], [{}, { spikeAlerts: [spike('CALL_WRITING', 22400), spike('CALL_WRITING', 22500), spike('CALL_WRITING', 22600), spike('PUT_WRITING', 22000)] }]);
  assert.deepStrictEqual(keys(r), ['flow:group'], 'four fresh spikes collapse into one grouped alert');
  assert(/4 strikes/.test(r.events[0].title));
  r = feed([base(), base()], [{}, { spikeAlerts: [spike('PUT_WRITING', 20050)] }]);
  assert.deepStrictEqual(r.events, [], 'strikes >3% from spot are ignored');
  r = feed([base(), base({ unusualActivity: [{ strike: 22500, optionType: 'CE', intensity: 'CRITICAL', summary: 'x' }, { strike: 22400, optionType: 'PE', intensity: 'HIGH', summary: 'y' }] })]);
  assert.deepStrictEqual(keys(r), ['flow:unusual:22500CE'], 'only CRITICAL unusual activity alerts');
  // already-happening spikes at page load are not news
  r = feed([base(), base()], [{ spikeAlerts: one }, { spikeAlerts: one }]);
  assert.deepStrictEqual(r.events, []);
  // …and it can announce again after it has been gone for longer than the retention window
  const gap = 12;
  const series = [base(), base(), ...Array.from({ length: gap }, () => base()), base()];
  const ctxs = [{}, { spikeAlerts: one }, ...Array.from({ length: gap }, () => ({})), { spikeAlerts: one }];
  r = feed(series, ctxs);
  assert.deepStrictEqual(keys(r), ['flow:PUT_WRITING:22000', 'flow:PUT_WRITING:22000'], 're-announces after 10+ quiet minutes');

  // ── momentum: once per move, re-arms after it fades ────────────────────
  const mom = (spot, spot5m) => [base({ spot }), { spot5m }];
  r = feed([base(), base({ spot: 22100 }), base({ spot: 22090 }), base({ spot: 22085 })], [{}, { spot5m: 22200 }, { spot5m: 22195 }, { spot5m: 22190 }]);
  assert.deepStrictEqual(keys(r), ['momentum:down'], 'a continuing move alerts once');
  r = feed([base(), base({ spot: 22100 }), base({ spot: 22198 }), base({ spot: 22100 })], [{}, { spot5m: 22200 }, { spot5m: 22200 }, { spot5m: 22200 }]);
  assert.deepStrictEqual(keys(r), ['momentum:down', 'momentum:down'], 'fires again after the move faded and returned');
  assert.deepStrictEqual(feed([base(), base({ spot: 22205 })], [{}, { spot5m: 22190 }]).events, [], '0.07% is below 0.3%');
  assert.deepStrictEqual(feed([base(), base({ spot: 22100 })], [{}, {}]).events, [], 'no baseline → no momentum alert');

  // ── VIX ─────────────────────────────────────────────────────────────────
  const vix = p => base({ vix: { last: 16, percentChange: p } });
  assert.deepStrictEqual(keys(feed([vix(1), vix(6.2), vix(6.4), vix(4.9), vix(5.2), vix(4.8), vix(5.1)])), ['vix'], 'VIX hovering at its trigger alerts once');

  // ── re-seed: expiry switch, wake-from-sleep, new day, time going backwards ─
  const noisy = o => base({ ...o, pcr: 1.3, maxCallOIStrike: 22800, gex: { gexRegime: 'NEGATIVE_GAMMA', zeroGammaLevel: 22100 }, spot: 22400 });
  r = feed([base(), base({ expiry: '20-Oct-2026', pcr: 1.3, spot: 22400, maxCallOIStrike: 22800, gex: { gexRegime: 'NEGATIVE_GAMMA', zeroGammaLevel: 22100 } }), base({ expiry: '20-Oct-2026', pcr: 1.3, spot: 22400, maxCallOIStrike: 22800, gex: { gexRegime: 'NEGATIVE_GAMMA', zeroGammaLevel: 22100 } })]);
  assert.deepStrictEqual(r.events, [], 'switching expiry must not fire alerts for the differences between expiries');
  r = feed([base({ dataAsOf: new Date(T0).toISOString() }), noisy({ dataAsOf: new Date(T0 + 40 * MIN).toISOString() }), noisy({ dataAsOf: new Date(T0 + 41 * MIN).toISOString() })]);
  assert.deepStrictEqual(r.events, [], 'a 40-minute gap (laptop asleep) re-seeds instead of replaying everything');
  r = feed([base(), noisy({ dataAsOf: new Date(T0 + 24 * 60 * MIN).toISOString() }), noisy({ dataAsOf: new Date(T0 + 24 * 60 * MIN + MIN).toISOString() })]);
  assert.deepStrictEqual(r.events, [], 'a new trading day re-seeds');
  r = feed([base({ dataAsOf: new Date(T0 + 10 * MIN).toISOString() }), noisy({ dataAsOf: new Date(T0).toISOString() })]);
  assert.deepStrictEqual(r.events, [], 'time going backwards re-seeds');

  // ── engine: cooldown, notify level, burst collapse, disabled ──────────
  const eng = createAlertEngine();
  const S = mergeSettings({ cooldownMin: 10 });
  const step = (d, ctx, t, settings = S) => eng.process({ ...d, dataAsOf: new Date(T0 + t * MIN).toISOString() }, ctx, settings, T0 + t * MIN);
  step(base(), {}, 0);
  step(base({ pcr: 1.3 }), {}, 1);
  let out = step(base({ pcr: 1.3 }), {}, 2);
  assert.deepStrictEqual(out.fired.map(e => e.key), ['pcr:bull']);
  assert.strictEqual(out.notify.length, 1, 'a warn-level event pops up by default');
  // flap out and back within the cooldown → suppressed
  step(base({ pcr: 1.0 }), {}, 3); step(base({ pcr: 1.0 }), {}, 4);
  step(base({ pcr: 1.3 }), {}, 5); out = step(base({ pcr: 1.3 }), {}, 6);
  assert.deepStrictEqual(out.fired, [], 'same alert inside the cooldown is suppressed');

  const eng2 = createAlertEngine();
  const run2 = (d, ctx, t) => eng2.process({ ...d, dataAsOf: new Date(T0 + t * MIN).toISOString() }, ctx, DEFAULT_SETTINGS, T0 + t * MIN);
  run2(base({ strikes: oi(100000, 101000) }), {}, 0);
  run2(base({ maxCallOIStrike: 22800, strikes: oi(130000, 101000) }), {}, 1);
  out = run2(base({ maxCallOIStrike: 22800, strikes: oi(130000, 101000) }), {}, 2);
  assert.strictEqual(out.fired.length, 1);
  assert.strictEqual(out.notify.length, 0, 'info-level events are logged but do not pop up under the default notify level');
  const loud = mergeSettings({ notifyLevel: 'info' });
  const eng3 = createAlertEngine();
  const run3 = (d, ctx, t) => eng3.process({ ...d, dataAsOf: new Date(T0 + t * MIN).toISOString() }, ctx, loud, T0 + t * MIN);
  run3(base({ strikes: oi(100000, 101000) }), {}, 0);
  run3(base({ maxCallOIStrike: 22800, pcr: 1.3, strikes: oi(130000, 101000), gex: { gexRegime: 'NEGATIVE_GAMMA', zeroGammaLevel: 22100 }, spot: 22400 }), {}, 1);
  out = run3(base({ maxCallOIStrike: 22800, pcr: 1.3, strikes: oi(130000, 101000), gex: { gexRegime: 'NEGATIVE_GAMMA', zeroGammaLevel: 22100 }, spot: 22400 }), {}, 2);
  assert(out.fired.length >= 3, 'several things changed together');
  assert.strictEqual(out.notify.length, 1, 'a burst collapses into one summary notification');
  assert(/new alerts/.test(out.notify[0].title));

  const off = createAlertEngine();
  const offSettings = mergeSettings({ enabled: false });
  off.process(base(), {}, offSettings, T0);
  assert.deepStrictEqual(off.process({ ...base({ pcr: 1.3 }), dataAsOf: new Date(T0 + MIN).toISOString() }, {}, offSettings, T0 + MIN), { fired: [], notify: [] });
  // enabling afterwards does not replay what happened while disabled
  const resumed = off.process({ ...base({ pcr: 1.3 }), dataAsOf: new Date(T0 + 2 * MIN).toISOString() }, {}, DEFAULT_SETTINGS, T0 + 2 * MIN);
  assert.deepStrictEqual(resumed.fired, []);

  // ── whole-day replay: a jittery but uneventful session stays quiet ────
  {
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.7;
    const e = createAlertEngine(); let spot = 22290; let logged = 0; let popups = 0;
    for (let m = 0; m < 375; m++) {
      spot += gauss() * 6;
      const a = 200000 + gauss() * 8000; const b = 200000 + gauss() * 8000;
      const g = gauss() * 3;
      const d = base({
        dataAsOf: new Date(T0 + m * MIN).toISOString(), spot, pcr: 1.2 + gauss() * 0.02,
        maxCallOIStrike: a > b ? 22800 : 23000, strikes: oi(a, b),
        gex: { gexRegime: g >= 0 ? 'POSITIVE_GAMMA' : 'NEGATIVE_GAMMA', totalGexCr: g, callGexCr: 60, putGexCr: 60, zeroGammaLevel: 22100 },
        vix: { last: 15, percentChange: 5 + gauss() * 0.3 }
      });
      const ctx = { spikeAlerts: m > 100 && m < 140 ? [22400, 22500, 22600].map(k => spike('CALL_WRITING', k)) : [], spot5m: spot - gauss() * 20 };
      const res = e.process(d, ctx, DEFAULT_SETTINGS, T0 + m * MIN);
      logged += res.fired.length; popups += res.notify.length;
    }
    assert(logged <= 25, `a noisy-but-uneventful day logged ${logged} alerts (was 375 before the fixes)`);
    assert(popups <= 20, `…and popped up ${popups} times`);
    console.log(`  noisy-day replay: ${logged} logged, ${popups} popups (previously 375)`);
  }

  // ── settings merge ──────────────────────────────────────────────────────
  const m = mergeSettings({ cooldownMin: 'x', notifyLevel: 'loud', rules: { pcr: { hi: 1.4, lo: 'bad' }, nope: {} }, sound: true });
  assert.strictEqual(m.cooldownMin, DEFAULT_SETTINGS.cooldownMin);
  assert.strictEqual(m.notifyLevel, 'warn', 'invalid notify level falls back to the default');
  assert.strictEqual(mergeSettings({ notifyLevel: 'high' }).notifyLevel, 'high');
  assert.strictEqual(m.rules.pcr.hi, 1.4);
  assert.strictEqual(m.rules.pcr.lo, DEFAULT_SETTINGS.rules.pcr.lo);
  assert.strictEqual(m.sound, true);
  assert(!('nope' in m.rules));
  assert.deepStrictEqual(mergeSettings(null), DEFAULT_SETTINGS);

  console.log('✓ alert rules OK (edge-triggered, hysteresis, confirmation, grouping, re-seeding, cooldown)');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
