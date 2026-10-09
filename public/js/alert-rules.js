// Pure alert rule engine: no DOM, no storage, no imports (unit-tested in Node).
//
//   evaluateRules(prevState, data, ctx, settings) -> { events, next }
//   createAlertEngine() -> { process(data, ctx, settings, nowMs), reset() }   (adds cooldown + delivery plan)
//
// Design rules that keep this quiet:
//  * Edge-triggered: fire when something *changes*, never because a condition merely holds.
//  * Hysteresis everywhere a value can hover around a threshold (PCR, gamma, VIX, levels, walls),
//    otherwise 1.19 ↔ 1.21 re-fires every cooldown.
//  * State is re-seeded silently on expiry switch, new trading day, a data gap, or time going backwards
//    — catching up after sleep is not "news".
//  * Bursts are grouped, and only warn/high severities interrupt by default.

export const DEFAULT_SETTINGS = {
  enabled: true,
  sound: false,
  desktop: false,
  cooldownMin: 10,
  notifyLevel: 'warn', // lowest severity that pops up / beeps / notifies: info | warn | high (everything is always logged)
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

export const SEVERITY_RANK = { info: 0, warn: 1, high: 2 };

// Tunables (kept as constants rather than settings: sensible defaults beat more knobs)
const PCR_MARGIN = 0.03;          // leave a PCR zone only after moving this far back inside
const LEVEL_BUFFER_PCT = 0.05;    // % of spot a level must be cleared by to count as a crossing (~11 pts on Nifty)
const WALL_SWITCH_RATIO = 1.1;    // a new max-OI strike must beat the old wall's OI by 10%
const GEX_RATIO_BAND = 0.05;      // |net GEX| / (call+put GEX) must exceed this to flip regime
const VIX_EXIT_MARGIN = 1;        // VIX leaves "spike" only after falling this many % points below the trigger
const SPIKE_RETAIN_MS = 10 * 60 * 1000; // a spike key stays "already announced" this long after last seen
const MAX_GAP_MS = 5 * 60 * 1000; // longer than this between snapshots → treat as a fresh start
const MAX_STRIKE_DIST = 0.03;     // flow/spike alerts only for strikes within 3% of spot
const CONFIRM_SNAPSHOTS = 2;      // a state change must hold for this many consecutive snapshots to count
const MAX_BATCH_TOASTS = 2;       // more loud events than this in one snapshot collapse into one summary

const fmt = n => (typeof n === 'number' ? Math.round(n).toLocaleString('en-IN') : '—');

export function pcrZone(pcr, hi, lo) {
  return pcr > hi ? 'bull' : pcr < lo ? 'bear' : 'neutral';
}

function nextPcrZone(prevZone, pcr, hi, lo) {
  if (prevZone === 'bull') return pcr < hi - PCR_MARGIN ? pcrZone(pcr, hi, lo) : 'bull';
  if (prevZone === 'bear') return pcr > lo + PCR_MARGIN ? pcrZone(pcr, hi, lo) : 'bear';
  return pcrZone(pcr, hi, lo);
}

/** Merge saved settings over defaults so newly added rules/fields always exist. */
export function mergeSettings(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!saved || typeof saved !== 'object') return out;
  for (const k of ['enabled', 'sound', 'desktop']) if (typeof saved[k] === 'boolean') out[k] = saved[k];
  if (Number.isFinite(saved.cooldownMin) && saved.cooldownMin >= 0) out.cooldownMin = saved.cooldownMin;
  if (saved.notifyLevel in SEVERITY_RANK) out.notifyLevel = saved.notifyLevel;
  for (const [name, def] of Object.entries(out.rules)) {
    const s = saved.rules && saved.rules[name];
    if (!s) continue;
    for (const f of Object.keys(def)) {
      if (typeof def[f] === typeof s[f] && (typeof s[f] !== 'number' || Number.isFinite(s[f]))) def[f] = s[f];
    }
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Debounce a state change: `candidate` replaces `current` only after it has been proposed on
 * CONFIRM_SNAPSHOTS consecutive snapshots. Pending counters live in next.pending.
 */
function confirm(next, key, candidate, current) {
  if (candidate === current) {
    delete next.pending[key];
    return current;
  }
  const p = next.pending[key];
  const count = p && p.value === candidate ? p.count + 1 : 1;
  if (count >= CONFIRM_SNAPSHOTS) {
    delete next.pending[key];
    return candidate;
  }
  next.pending[key] = { value: candidate, count };
  return current;
}

function oiAt(d, strike, side) {
  const row = (d.strikes || []).find(s => s.strike === strike);
  return row && row[side] ? row[side].openInterest || 0 : null;
}

/** Side of `level` that spot is confirmed on; inside the buffer the previous side is kept. */
function confirmedSide(prevSide, spot, level) {
  const buf = spot * (LEVEL_BUFFER_PCT / 100);
  if (spot > level + buf) return 'above';
  if (spot < level - buf) return 'below';
  return prevSide || null;
}

function levelsFor(d, walls, r) {
  const levels = [];
  if (r.levels.on && d.cpr && d.cpr.source === 'PREV_SESSION') {
    levels.push({ id: 'cprTop', name: 'CPR top', value: d.cpr.tc, severity: 'warn' });
    levels.push({ id: 'cprBottom', name: 'CPR bottom', value: d.cpr.bc, severity: 'warn' });
  }
  if (r.levels.on && d.gex && typeof d.gex.zeroGammaLevel === 'number') {
    levels.push({ id: 'zeroGamma', name: 'zero-gamma level', value: d.gex.zeroGammaLevel, severity: 'high' });
  }
  if (r.walls.on) {
    if (typeof walls.call === 'number') levels.push({ id: 'callWall', name: 'max call wall (resistance)', value: walls.call, severity: 'high' });
    if (typeof walls.put === 'number') levels.push({ id: 'putWall', name: 'max put wall (support)', value: walls.put, severity: 'high' });
  }
  return levels;
}

function spikeCandidates(d, ctx, r) {
  if (!r.flow.on) return [];
  const near = strike => typeof strike === 'number' && Math.abs(strike - d.spot) / d.spot <= MAX_STRIKE_DIST;
  const out = [];
  (ctx.spikeAlerts || []).filter(a => near(a.strike)).forEach(a => {
    out.push({
      key: `flow:${a.type}:${a.strike}`,
      severity: a.type === 'PUT_UNWINDING' || a.type === 'CALL_COVERING' ? 'warn' : 'info',
      title: a.type.replace('_', ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase()) + ` at ${fmt(a.strike)}`,
      body: a.summary
    });
  });
  (d.unusualActivity || []).filter(a => a.intensity === 'CRITICAL' && near(a.strike)).forEach(a => {
    out.push({ key: `flow:unusual:${a.strike}${a.optionType}`, severity: 'high', title: `Unusual ${a.optionType} activity at ${fmt(a.strike)}`, body: a.summary });
  });
  return out;
}

function dayOf(ms) {
  return new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10); // IST calendar day
}

function seedState(d, ctx, settings, asOf, walls) {
  const r = settings.rules;
  const sides = {};
  levelsFor(d, walls, r).forEach(l => { sides[l.id] = confirmedSide(null, d.spot, l.value); });
  const spikes = {};
  spikeCandidates(d, ctx, r).forEach(c => { spikes[c.key] = asOf; }); // already happening ≠ new
  return {
    seeded: true,
    expiry: d.expiry,
    asOf,
    spot: d.spot,
    pcrZone: pcrZone(d.pcr, r.pcr.hi, r.pcr.lo),
    gexRegime: d.gex ? d.gex.gexRegime : null,
    regimeLabel: d.compositeRegime ? d.compositeRegime.regimeLabel : null,
    walls,
    sides,
    spikes,
    pending: {},
    momentum: { up: true, down: true },
    vixZone: d.vix && d.vix.percentChange >= r.vix.pct ? 'spike' : 'normal'
  };
}

// ── rule evaluation ──────────────────────────────────────────────────────

export function evaluateRules(prev, d, ctx = {}, settings = DEFAULT_SETTINGS) {
  const r = settings.rules;
  const events = [];
  const parsed = Date.parse(d.dataAsOf || '');
  const asOf = Number.isFinite(parsed) ? parsed : (ctx.now ?? null);
  const walls = { call: d.maxCallOIStrike, put: d.maxPutOIStrike };

  // Silent re-seed: first snapshot, other expiry, new trading day, clock going backwards, or a long gap.
  const reseed = !prev || !prev.seeded
    || prev.expiry !== d.expiry
    || (asOf !== null && prev.asOf != null && (asOf < prev.asOf || asOf - prev.asOf > MAX_GAP_MS || dayOf(asOf) !== dayOf(prev.asOf)));
  if (reseed) return { events, next: seedState(d, ctx, settings, asOf, walls) };

  const now = asOf ?? prev.asOf ?? 0;
  const next = { ...prev, asOf, spot: d.spot, momentum: { ...prev.momentum }, spikes: { ...prev.spikes }, sides: { ...prev.sides }, pending: { ...prev.pending } };

  // 1. PCR zone (with hysteresis)
  next.pcrZone = confirm(next, 'pcr', nextPcrZone(prev.pcrZone, d.pcr, r.pcr.hi, r.pcr.lo), prev.pcrZone);
  if (r.pcr.on && prev.pcrZone !== next.pcrZone) {
    const label = { bull: 'bullish', bear: 'bearish', neutral: 'neutral' }[next.pcrZone];
    events.push({
      key: `pcr:${next.pcrZone}`,
      severity: next.pcrZone === 'neutral' ? 'info' : 'warn',
      title: `PCR moved to ${label} zone`,
      body: `PCR ${d.pcr.toFixed(2)} (bullish > ${r.pcr.hi}, bearish < ${r.pcr.lo})`
    });
  }

  // 2. OI walls: switch only when the challenger clearly beats the incumbent
  const wallDefs = [['call', 'CE', 'maxCallOIStrike', 'Call', 'highest call OI'], ['put', 'PE', 'maxPutOIStrike', 'Put', 'highest put OI']];
  next.walls = { ...prev.walls };
  wallDefs.forEach(([k, side, field, label, what]) => {
    const challenger = d[field];
    const incumbent = prev.walls[k];
    if (typeof challenger !== 'number' || challenger === incumbent) return;
    const oldOI = oiAt(d, incumbent, side);
    const newOI = oiAt(d, challenger, side);
    const clearlyBigger = oldOI === null || newOI === null || newOI >= oldOI * WALL_SWITCH_RATIO;
    // proposing the incumbent again (challenger not big enough) resets the pending count
    const accepted = confirm(next, `wall:${k}`, clearlyBigger ? challenger : incumbent, incumbent);
    if (accepted !== incumbent) {
      next.walls[k] = accepted;
      if (r.walls.on) events.push({ key: `wallShift:${k}`, severity: 'info', title: `${label} wall shifted`, body: `${fmt(incumbent)} → ${fmt(challenger)} (${what})` });
    }
  });

  // 3. Spot vs levels (CPR, zero-gamma, walls) with a clearance buffer
  levelsFor(d, next.walls, r).forEach(l => {
    const before = prev.sides[l.id] || null;
    const proposed = confirmedSide(before, d.spot, l.value);
    // first confirmed side for a level is just learned; later flips must hold for CONFIRM_SNAPSHOTS
    const after = before === null ? proposed : confirm(next, `side:${l.id}`, proposed, before);
    next.sides[l.id] = after;
    if (before && after && before !== after) {
      const up = after === 'above';
      const isWall = l.id.endsWith('Wall');
      events.push({
        key: `level:${l.id}:${after}`,
        severity: l.severity,
        title: isWall ? `Spot ${up ? 'broke above' : 'broke below'} ${l.name}` : `Spot crossed ${up ? 'above' : 'below'} ${l.name}`,
        body: `${fmt(d.spot)} vs ${fmt(l.value)}`
      });
    }
  });

  // 4. Gamma regime (flip needs a clear margin, not a hair either side of zero)
  if (d.gex && d.gex.gexRegime) {
    let regime = prev.gexRegime || d.gex.gexRegime;
    const total = (d.gex.callGexCr || 0) + (d.gex.putGexCr || 0);
    if (total > 0 && typeof d.gex.totalGexCr === 'number') {
      const ratio = d.gex.totalGexCr / total;
      if (regime === 'POSITIVE_GAMMA' && ratio <= -GEX_RATIO_BAND) regime = 'NEGATIVE_GAMMA';
      else if (regime === 'NEGATIVE_GAMMA' && ratio >= GEX_RATIO_BAND) regime = 'POSITIVE_GAMMA';
    } else {
      regime = d.gex.gexRegime; // no magnitudes available: trust the reported regime
    }
    regime = prev.gexRegime ? confirm(next, 'gex', regime, prev.gexRegime) : regime;
    next.gexRegime = regime;
    if (r.gex.on && prev.gexRegime && prev.gexRegime !== regime) {
      const neg = regime === 'NEGATIVE_GAMMA';
      events.push({
        key: `gex:${regime}`,
        severity: 'high',
        title: `Gamma regime flipped to ${neg ? 'NEGATIVE' : 'POSITIVE'}`,
        body: neg ? 'Dealer hedging now amplifies moves — expect faster, trendier action.' : 'Dealer hedging now dampens moves — expect mean reversion.'
      });
    }
  }

  // 5. Composite regime label change (noisy, off by default)
  next.regimeLabel = d.compositeRegime ? d.compositeRegime.regimeLabel : null;
  if (r.regime.on && prev.regimeLabel && next.regimeLabel && prev.regimeLabel !== next.regimeLabel) {
    events.push({ key: 'regime', severity: 'info', title: 'Market regime changed', body: `${prev.regimeLabel} → ${next.regimeLabel}` });
  }

  // 6. Flow / OI spikes: announce once per (type, strike); stays quiet while it persists
  const flowNew = [];
  const seenNow = new Set();
  spikeCandidates(d, ctx, r).forEach(c => {
    seenNow.add(c.key);
    const last = prev.spikes[c.key];
    if (last === undefined || now - last > SPIKE_RETAIN_MS) flowNew.push(c);
    next.spikes[c.key] = now;
  });
  Object.keys(next.spikes).forEach(k => { if (!seenNow.has(k) && now - next.spikes[k] > SPIKE_RETAIN_MS) delete next.spikes[k]; });
  if (flowNew.length > 2) {
    const top = flowNew.slice().sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]).slice(0, 3);
    events.push({
      key: 'flow:group',
      severity: flowNew.some(e => e.severity === 'high') ? 'high' : 'warn',
      title: `${flowNew.length} strikes with fresh OI / flow activity`,
      body: top.map(e => e.body).join(' · ') + (flowNew.length > 3 ? ` · +${flowNew.length - 3} more` : '')
    });
  } else {
    events.push(...flowNew);
  }

  // 7. Fast spot move vs 5 minutes ago — fires once per move, re-arms after it fades
  if (r.momentum.on && typeof ctx.spot5m === 'number' && ctx.spot5m > 0) {
    const movePct = ((d.spot - ctx.spot5m) / ctx.spot5m) * 100;
    [['up', movePct >= r.momentum.pct, movePct], ['down', movePct <= -r.momentum.pct, -movePct]].forEach(([dir, hit, size]) => {
      if (hit && prev.momentum[dir]) {
        next.momentum[dir] = false;
        events.push({
          key: `momentum:${dir}`,
          severity: 'warn',
          title: `Spot ${dir} ${size.toFixed(2)}% in 5 min`,
          body: `${fmt(ctx.spot5m)} → ${fmt(d.spot)} (${movePct > 0 ? '+' : ''}${fmt(d.spot - ctx.spot5m)} pts)`
        });
      } else if (!prev.momentum[dir] && size < r.momentum.pct / 2) {
        next.momentum[dir] = true;
      }
    });
  }

  // 8. India VIX spike (enter at the trigger, leave only after clearly easing)
  const vixPct = d.vix ? d.vix.percentChange : null;
  let vixCandidate;
  if (vixPct === null) vixCandidate = 'normal';
  else if (prev.vixZone === 'spike') vixCandidate = vixPct < r.vix.pct - VIX_EXIT_MARGIN ? 'normal' : 'spike';
  else vixCandidate = vixPct >= r.vix.pct ? 'spike' : 'normal';
  next.vixZone = confirm(next, 'vix', vixCandidate, prev.vixZone);
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

// ── engine: rules + cooldown + delivery plan ─────────────────────────────

export function createAlertEngine() {
  let state = null;
  const lastFired = new Map();

  return {
    reset() { state = null; },
    /**
     * Returns { fired, notify }.
     *  fired  — every event that passed cooldown (all go to the log)
     *  notify — what should actually interrupt the user (toast / sound / desktop), already
     *           filtered by notifyLevel and collapsed to one summary when a burst is large.
     */
    process(d, ctx, settings, nowMs = Date.now()) {
      if (!settings.enabled) {
        state = null; // keep re-seeding while off, so turning alerts on never replays what happened meanwhile
        return { fired: [], notify: [] };
      }
      const { events, next } = evaluateRules(state, d, ctx, settings);
      state = next;

      const cooldown = settings.cooldownMin * 60 * 1000;
      const fired = events.filter(ev => {
        const last = lastFired.get(ev.key);
        if (last !== undefined && nowMs - last < cooldown) return false;
        lastFired.set(ev.key, nowMs);
        return true;
      });

      const minRank = SEVERITY_RANK[settings.notifyLevel] ?? 1;
      const loud = fired.filter(ev => SEVERITY_RANK[ev.severity] >= minRank);
      let notify = loud;
      if (loud.length > MAX_BATCH_TOASTS) {
        const worst = loud.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a] ? b.severity : a), 'info');
        notify = [{
          key: 'batch',
          severity: worst,
          title: `${loud.length} new alerts`,
          body: loud.slice(0, 3).map(e => e.title).join(' · ') + (loud.length > 3 ? ' …' : '')
        }];
      }
      return { fired, notify };
    }
  };
}
