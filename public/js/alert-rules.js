// Pure alert rule engine: no DOM, no storage, no imports (unit-tested in Node).
// evaluateRules(prevState, data, ctx, settings) -> { events, next }
//
// Rules are *edge-triggered*: they fire when something changes between two consecutive
// snapshots (zone entered, level crossed, regime flipped), never merely because a condition holds.
// The first snapshot after page load only seeds state, so a refresh never replays old news.

export const DEFAULT_SETTINGS = {
  enabled: true,
  sound: false,
  desktop: false,
  cooldownMin: 5,
  rules: {
    pcr: { on: true, hi: 1.2, lo: 0.8 },
    levels: { on: true },
    walls: { on: true },
    gex: { on: true },
    regime: { on: false },
    flow: { on: true },
    momentum: { on: true, pct: 0.3 },
    vix: { on: true, pct: 5 }
  }
};

const fmt = n => (typeof n === 'number' ? Math.round(n).toLocaleString('en-IN') : '—');

export function pcrZone(pcr, hi, lo) {
  return pcr > hi ? 'bull' : pcr < lo ? 'bear' : 'neutral';
}

/** Merge saved settings over defaults so newly added rules/fields always exist. */
export function mergeSettings(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!saved || typeof saved !== 'object') return out;
  for (const k of ['enabled', 'sound', 'desktop']) if (typeof saved[k] === 'boolean') out[k] = saved[k];
  if (Number.isFinite(saved.cooldownMin) && saved.cooldownMin >= 0) out.cooldownMin = saved.cooldownMin;
  for (const [name, def] of Object.entries(out.rules)) {
    const s = saved.rules && saved.rules[name];
    if (!s) continue;
    for (const f of Object.keys(def)) {
      if (typeof def[f] === typeof s[f] && (typeof s[f] !== 'number' || Number.isFinite(s[f]))) def[f] = s[f];
    }
  }
  return out;
}

export function evaluateRules(prev, d, ctx = {}, settings = DEFAULT_SETTINGS) {
  const r = settings.rules;
  const events = [];

  const next = {
    seeded: true,
    spot: d.spot,
    pcrZone: pcrZone(d.pcr, r.pcr.hi, r.pcr.lo),
    gexRegime: d.gex ? d.gex.gexRegime : null,
    regimeLabel: d.compositeRegime ? d.compositeRegime.regimeLabel : null,
    maxCall: d.maxCallOIStrike,
    maxPut: d.maxPutOIStrike,
    vixZone: d.vix && d.vix.percentChange >= r.vix.pct ? 'spike' : 'normal'
  };
  if (!prev || !prev.seeded) return { events, next };

  // 1. PCR changes sentiment zone
  if (r.pcr.on && prev.pcrZone !== next.pcrZone) {
    const label = { bull: 'bullish', bear: 'bearish', neutral: 'neutral' }[next.pcrZone];
    events.push({
      key: `pcr:${next.pcrZone}`,
      severity: next.pcrZone === 'neutral' ? 'info' : 'warn',
      title: `PCR moved to ${label} zone`,
      body: `PCR ${d.pcr.toFixed(2)} (bullish > ${r.pcr.hi}, bearish < ${r.pcr.lo})`
    });
  }

  // 2. Spot crosses a key level (levels may move between ticks, so test sides against *current* values)
  if (r.levels.on && typeof prev.spot === 'number') {
    const levels = [];
    if (d.cpr && d.cpr.source === 'PREV_SESSION') {
      levels.push({ id: 'cprTop', name: 'CPR top', value: d.cpr.tc, severity: 'warn' });
      levels.push({ id: 'cprBottom', name: 'CPR bottom', value: d.cpr.bc, severity: 'warn' });
    }
    if (d.gex && typeof d.gex.zeroGammaLevel === 'number') {
      levels.push({ id: 'zeroGamma', name: 'zero-gamma level', value: d.gex.zeroGammaLevel, severity: 'high' });
    }
    levels.forEach(l => {
      if ((prev.spot - l.value) * (d.spot - l.value) < 0) {
        const up = d.spot > l.value;
        events.push({
          key: `level:${l.id}`,
          severity: l.severity,
          title: `Spot crossed ${up ? 'above' : 'below'} ${l.name}`,
          body: `${fmt(d.spot)} vs ${l.name} ${fmt(l.value)}`
        });
      }
    });
  }

  // 3. OI walls: a breach is a stronger signal than a shift
  if (r.walls.on) {
    if (typeof prev.spot === 'number') {
      [['callWall', 'max call wall (resistance)', d.maxCallOIStrike], ['putWall', 'max put wall (support)', d.maxPutOIStrike]].forEach(([id, name, v]) => {
        if (typeof v === 'number' && (prev.spot - v) * (d.spot - v) < 0) {
          events.push({
            key: `level:${id}`,
            severity: 'high',
            title: `Spot ${d.spot > v ? 'broke above' : 'broke below'} ${name}`,
            body: `${fmt(d.spot)} vs ${fmt(v)}`
          });
        }
      });
    }
    if (prev.maxCall !== next.maxCall) {
      events.push({ key: 'wallShift:call', severity: 'info', title: 'Call wall shifted', body: `${fmt(prev.maxCall)} → ${fmt(next.maxCall)} (highest call OI)` });
    }
    if (prev.maxPut !== next.maxPut) {
      events.push({ key: 'wallShift:put', severity: 'info', title: 'Put wall shifted', body: `${fmt(prev.maxPut)} → ${fmt(next.maxPut)} (highest put OI)` });
    }
  }

  // 4. Gamma regime flip
  if (r.gex.on && prev.gexRegime && next.gexRegime && prev.gexRegime !== next.gexRegime) {
    const neg = next.gexRegime === 'NEGATIVE_GAMMA';
    events.push({
      key: `gex:${next.gexRegime}`,
      severity: 'high',
      title: `Gamma regime flipped to ${neg ? 'NEGATIVE' : 'POSITIVE'}`,
      body: neg ? 'Dealer hedging now amplifies moves — expect faster, trendier action.' : 'Dealer hedging now dampens moves — expect mean reversion.'
    });
  }

  // 5. Composite regime label change (noisy, off by default)
  if (r.regime.on && prev.regimeLabel && next.regimeLabel && prev.regimeLabel !== next.regimeLabel) {
    events.push({ key: 'regime', severity: 'info', title: 'Market regime changed', body: `${prev.regimeLabel} → ${next.regimeLabel}` });
  }

  // 6. Smart-money flow and fast OI builds
  if (r.flow.on) {
    (ctx.spikeAlerts || []).forEach(a => {
      events.push({
        key: `flow:${a.type}:${a.strike}`,
        severity: a.type === 'PUT_UNWINDING' || a.type === 'CALL_COVERING' ? 'warn' : 'info',
        title: a.type.replace('_', ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase()) + ` at ${fmt(a.strike)}`,
        body: a.summary
      });
    });
    (d.unusualActivity || []).filter(a => a.intensity === 'CRITICAL').forEach(a => {
      events.push({ key: `flow:unusual:${a.strike}${a.optionType}`, severity: 'high', title: `Unusual ${a.optionType} activity at ${fmt(a.strike)}`, body: a.summary });
    });
  }

  // 7. Fast spot move vs 5 minutes ago (needs stored history)
  if (r.momentum.on && typeof ctx.spot5m === 'number' && ctx.spot5m > 0) {
    const movePct = ((d.spot - ctx.spot5m) / ctx.spot5m) * 100;
    if (Math.abs(movePct) >= r.momentum.pct) {
      const up = movePct > 0;
      events.push({
        key: `momentum:${up ? 'up' : 'down'}`,
        severity: 'warn',
        title: `Spot ${up ? 'up' : 'down'} ${Math.abs(movePct).toFixed(2)}% in 5 min`,
        body: `${fmt(ctx.spot5m)} → ${fmt(d.spot)} (${up ? '+' : ''}${fmt(d.spot - ctx.spot5m)} pts)`
      });
    }
  }

  // 8. India VIX spike (entering the zone)
  if (r.vix.on && prev.vixZone !== 'spike' && next.vixZone === 'spike') {
    events.push({
      key: 'vix',
      severity: 'warn',
      title: 'India VIX spiking',
      body: `VIX ${d.vix.last.toFixed(2)} (+${d.vix.percentChange.toFixed(1)}% today, threshold ${r.vix.pct}%)`
    });
  }

  return { events, next };
}
