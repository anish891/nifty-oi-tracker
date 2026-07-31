const assert = require('assert');

// ── TEST 1: BLACK-SCHOLES GAMMA & GEX VERIFICATION ──
function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function calculateOptionGamma(S, K, T, v, r = 0.065) {
  if (S <= 0 || K <= 0 || T <= 0 || v <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));
  const gamma = normalPdf(d1) / (S * v * Math.sqrt(T));
  return isNaN(gamma) ? 0 : gamma;
}

// Test known Black-Scholes ATM Gamma value: S=24000, K=24000, T=7/365, IV=15%, r=6.5%
const testGamma = calculateOptionGamma(24000, 24000, 7 / 365, 0.15);
assert(testGamma > 0.0004 && testGamma < 0.0008, `Gamma ${testGamma} should be ~0.0006`);
console.log('✓ Test 1 Passed: Black-Scholes Gamma calculation is mathematically accurate.');

// ── TEST 2: MAX PAIN O(N log N) ALGORITHM VS BRUTE FORCE BENCHMARK ──
function computeMaxPainBruteForce(strikes) {
  let minPain = Infinity;
  let maxPainStrike = strikes[0].strike;

  strikes.forEach(target => {
    const K = target.strike;
    let totalPain = 0;

    strikes.forEach(s => {
      const cOI = s.CE?.openInterest || 0;
      const pOI = s.PE?.openInterest || 0;
      if (s.strike < K) totalPain += cOI * (K - s.strike);
      if (s.strike > K) totalPain += pOI * (s.strike - K);
    });

    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = K;
    }
  });

  return maxPainStrike;
}

function computeMaxPainOptimized(allExpiryStrikes) {
  const nStrikes = allExpiryStrikes.length;
  if (nStrikes === 0) return 0;

  const sorted = [...allExpiryStrikes].sort((a, b) => a.strike - b.strike);
  const sumCE_OI = new Float64Array(nStrikes);
  const sumCE_W = new Float64Array(nStrikes);
  const sumPE_OI = new Float64Array(nStrikes);
  const sumPE_W = new Float64Array(nStrikes);

  let runCE_OI = 0, runCE_W = 0;
  let runPE_OI = 0, runPE_W = 0;

  for (let i = 0; i < nStrikes; i++) {
    const cOI = sorted[i].CE?.openInterest || 0;
    const pOI = sorted[i].PE?.openInterest || 0;
    const k = sorted[i].strike;

    runCE_OI += cOI;
    runCE_W += cOI * k;
    sumCE_OI[i] = runCE_OI;
    sumCE_W[i] = runCE_W;

    runPE_OI += pOI;
    runPE_W += pOI * k;
    sumPE_OI[i] = runPE_OI;
    sumPE_W[i] = runPE_W;
  }

  const totalPE_OI = sumPE_OI[nStrikes - 1];
  const totalPE_W = sumPE_W[nStrikes - 1];

  let maxPain = sorted[0].strike;
  let minTotalPain = Infinity;

  for (let i = 0; i < nStrikes; i++) {
    const K = sorted[i].strike;
    const callOI_left = i > 0 ? sumCE_OI[i - 1] : 0;
    const callW_left = i > 0 ? sumCE_W[i - 1] : 0;
    const callLoss = K * callOI_left - callW_left;

    const putOI_right = totalPE_OI - sumPE_OI[i];
    const putW_right = totalPE_W - sumPE_W[i];
    const putLoss = putW_right - K * putOI_right;

    const totalPain = callLoss + putLoss;
    if (totalPain < minTotalPain) {
      minTotalPain = totalPain;
      maxPain = K;
    }
  }

  return maxPain;
}

// Synthetic strike chain test
const mockChain = [
  { strike: 23800, CE: { openInterest: 1000 }, PE: { openInterest: 5000 } },
  { strike: 23900, CE: { openInterest: 2000 }, PE: { openInterest: 4000 } },
  { strike: 24000, CE: { openInterest: 8000 }, PE: { openInterest: 8000 } },
  { strike: 24100, CE: { openInterest: 5000 }, PE: { openInterest: 2000 } },
  { strike: 24200, CE: { openInterest: 6000 }, PE: { openInterest: 1000 } },
];

const brutePain = computeMaxPainBruteForce(mockChain);
const optPain = computeMaxPainOptimized(mockChain);

assert.strictEqual(brutePain, optPain, `Optimized Max Pain (${optPain}) must equal Brute Force (${brutePain})`);
console.log('✓ Test 2 Passed: Fast O(N log N) Max Pain matches brute-force baseline exactly.');

// ── TEST 3: CENTRAL PIVOT RANGE (CPR) VERIFICATION ──
function calculateCPR(H, L, C) {
  const pivot = (H + L + C) / 3;
  const bc = (H + L) / 2;
  const tc = (pivot - bc) + pivot;
  const width = Math.abs(tc - bc);
  return { pivot, tc, bc, width };
}

const cprRes = calculateCPR(24100, 23900, 24000);
assert.strictEqual(cprRes.pivot, 24000);
assert.strictEqual(cprRes.bc, 24000);
assert.strictEqual(cprRes.tc, 24000);
assert.strictEqual(cprRes.width, 0);
console.log('✓ Test 3 Passed: Central Pivot Range (CPR) formulas are verified.');

console.log('\n✅ ALL MATHEMATICAL VERIFICATION TESTS PASSED SUCCESSFULLY!\n');
