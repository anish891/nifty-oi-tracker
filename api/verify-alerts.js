// Tests for public/js/alert-rules.js (a pure ES module with no imports).
// Loaded through a data: URL so this works on any Node >= 18 without a bundler or package "type".
const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/alert-rules.js'), 'utf8');
  const { evaluateRules, mergeSettings, pcrZone, DEFAULT_SETTINGS } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

  const base = () => ({
    spot: 22200, pcr: 1.0, maxCallOIStrike: 23000, maxPutOIStrike: 21000,
    cpr: { source: 'PREV_SESSION', tc: 22300, bc: 22250 },
    gex: { gexRegime: 'POSITIVE_GAMMA', zeroGammaLevel: 22100 },
    compositeRegime: { regimeLabel: 'RANGE' },
    vix: { last: 14, percentChange: 1 },
    unusualActivity: []
  });
  const run = (prevData, curData, ctx, settings = DEFAULT_SETTINGS) => {
    const seeded = evaluateRules(null, prevData, {}, settings);
    assert.strictEqual(seeded.events.length, 0, 'first snapshot only seeds state');
    return evaluateRules(seeded.next, curData, ctx, settings);
  };
  const keys = ev => ev.events.map(e => e.key);

  // no change → no alerts (edge-triggered, not level-triggered)
  assert.deepStrictEqual(run(base(), base()).events, []);

  // PCR zone entered, and only once
  let r = run(base(), { ...base(), pcr: 1.25 });
  assert.deepStrictEqual(keys(r), ['pcr:bull'], 'cooldown key includes the destination zone');
  assert(/bullish/.test(r.events[0].title));
  const again = evaluateRules(r.next, { ...base(), pcr: 1.3 }, {}, DEFAULT_SETTINGS);
  assert.deepStrictEqual(again.events, [], 'staying in the zone must not re-fire');
  assert.strictEqual(pcrZone(0.7, 1.2, 0.8), 'bear');

  // level crossings, with direction; levels that moved are tested against current values
  r = run(base(), { ...base(), spot: 22320 });
  assert.deepStrictEqual(keys(r).sort(), ['level:cprBottom', 'level:cprTop'], 'a jump across the whole CPR crosses both edges');
  r = run({ ...base(), spot: 22270 }, { ...base(), spot: 22320 });
  assert.deepStrictEqual(keys(r), ['level:cprTop']);
  assert(/above CPR top/.test(r.events[0].title));
  r = run({ ...base(), spot: 22270 }, { ...base(), spot: 22050 });
  assert.deepStrictEqual(keys(r).sort(), ['level:cprBottom', 'level:zeroGamma']);
  assert.deepStrictEqual(keys(run(base(), { ...base(), spot: 22050 })), ['level:zeroGamma'], 'spot already below CPR bottom: only zero-gamma is crossed');
  r = run({ ...base(), spot: 22350 }, { ...base(), spot: 22350, cpr: { source: 'PREV_SESSION', tc: 22400, bc: 22300 } });
  assert(!keys(r).some(k => k.startsWith('level:cpr')), 'spot standing still while a level moves is not a crossing');

  // CPR from the OI estimate is not a real level → no crossing alerts
  r = run(base(), { ...base(), spot: 22320, cpr: { source: 'OI_ESTIMATE', tc: 22300, bc: 22250 } });
  assert(!keys(r).includes('level:cprTop'));

  // wall breach is high severity; wall shift is info
  r = run({ ...base(), spot: 22950 }, { ...base(), spot: 23010 });
  assert(r.events.some(e => e.key === 'level:callWall' && e.severity === 'high'));
  r = run(base(), { ...base(), maxCallOIStrike: 22800 });
  assert.deepStrictEqual(keys(r), ['wallShift:call']);

  // gamma flip
  r = run(base(), { ...base(), gex: { gexRegime: 'NEGATIVE_GAMMA', zeroGammaLevel: 22100 } });
  assert(r.events.some(e => e.key === 'gex:NEGATIVE_GAMMA' && /NEGATIVE/.test(e.title) && e.severity === 'high'));

  // flow: spike alerts and only CRITICAL unusual activity
  r = run(base(), { ...base(), unusualActivity: [
    { strike: 22500, optionType: 'CE', intensity: 'CRITICAL', summary: 'x' },
    { strike: 22400, optionType: 'PE', intensity: 'HIGH', summary: 'y' }
  ] }, { spikeAlerts: [{ type: 'PUT_WRITING', strike: 22000, summary: 'Rapid Put Writing' }] });
  assert.deepStrictEqual(keys(r).sort(), ['flow:PUT_WRITING:22000', 'flow:unusual:22500CE']);

  // momentum needs history, respects threshold and direction
  assert.deepStrictEqual(keys(run(base(), { ...base(), spot: 22205 }, { spot5m: 22190 })), [], '0.07% is below 0.3%');
  r = run(base(), { ...base(), spot: 22100 }, { spot5m: 22200 });
  assert(keys(r).includes('momentum:down'));
  assert(!keys(run(base(), base(), {})).includes('momentum:up'), 'no baseline → no momentum alert');

  // VIX fires on entering the spike zone only
  r = run(base(), { ...base(), vix: { last: 16, percentChange: 6.2 } });
  assert.deepStrictEqual(keys(r), ['vix']);
  assert.deepStrictEqual(evaluateRules(r.next, { ...base(), vix: { last: 16.5, percentChange: 8 } }, {}, DEFAULT_SETTINGS).events, []);

  // disabled rules stay quiet
  const off = mergeSettings({ rules: { pcr: { on: false } } });
  assert.deepStrictEqual(run(base(), { ...base(), pcr: 1.25 }, {}, off).events, []);

  // settings merge: ignores junk, keeps defaults for new fields
  const m = mergeSettings({ cooldownMin: 'x', rules: { pcr: { hi: 1.4, lo: 'bad' }, nope: {} }, sound: true });
  assert.strictEqual(m.cooldownMin, DEFAULT_SETTINGS.cooldownMin);
  assert.strictEqual(m.rules.pcr.hi, 1.4);
  assert.strictEqual(m.rules.pcr.lo, DEFAULT_SETTINGS.rules.pcr.lo);
  assert.strictEqual(m.sound, true);
  assert(!('nope' in m.rules));
  assert.deepStrictEqual(mergeSettings(null), DEFAULT_SETTINGS);

  console.log('✓ alert rules OK (edge-triggered, directional, threshold-aware, safe settings merge)');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
