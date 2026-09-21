// Synthetic (no-DB) unit test for mlFeatureSnapshot.js's computeDevelopingValueFeatures().
// Run manually: node scripts/test_ml_developing_value_synthetic.mjs
import { computeDevelopingValueFeatures } from '../server/services/mlFeatureSnapshot.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// A simple, hand-verifiable session: price grinds from 100 up to 110 over 20 bars, heavier
// volume clustered near 105 (so POC should land near there, not at the extremes).
const bars = [];
for (let i = 0; i < 20; i++) {
  const base = 100 + i * 0.5;
  const nearMiddle = Math.abs(base - 105) < 2;
  bars.push({
    high: base + 0.5, low: base - 0.5, close: base,
    bid_volume: nearMiddle ? 50 : 10,
    ask_volume: nearMiddle ? 60 : 10, // net buyer-heavy throughout, more so near the middle
  });
}

const r = computeDevelopingValueFeatures(bars, 108);
check('returns a real object for a real bars array', r !== null);
check('barsInSessionSoFar matches input length', r.barsInSessionSoFar === 20);
check('distToDevPoc is a finite number', Number.isFinite(r.distToDevPoc));
check('distToDevVah is a finite number', Number.isFinite(r.distToDevVah));
check('distToDevVal is a finite number', Number.isFinite(r.distToDevVal));
check('distToDevVwap is a finite number', Number.isFinite(r.distToDevVwap));
check('VAH >= VAL (dist to VAH from entry should be <= dist to VAL, since VAH is the higher level and entry=108 is high in the range)', r.distToDevVah <= r.distToDevVal);
check('sessionCumulativeDelta is positive (net buyer-heavy throughout)', r.sessionCumulativeDelta > 0);
check('recentDelta15Bars is positive too', r.recentDelta15Bars > 0);
check('recentDelta15Bars <= sessionCumulativeDelta in magnitude (fewer bars)', Math.abs(r.recentDelta15Bars) <= Math.abs(r.sessionCumulativeDelta));

// Edge cases
check('empty bars array -> null (not a crash, not a fabricated zero)', computeDevelopingValueFeatures([], 100) === null);
check('null entry -> null', computeDevelopingValueFeatures(bars, null) === null);
check('null bars -> null', computeDevelopingValueFeatures(null, 100) === null);

// Single-bar session with real range (very first bar of the day) -- computeProfile's own
// >=3-price-levels guard is about distinct TICK levels spanned, not bar count, so a single
// bar with a real high-low range (here 2pts = 8 ticks) already clears it. Verified directly
// against the function's actual output before asserting, not assumed.
const oneBar = [{ high: 101, low: 99, close: 100, bid_volume: 5, ask_volume: 5 }];
const r2 = computeDevelopingValueFeatures(oneBar, 100);
check('single-bar session still returns an object (not null)', r2 !== null);
check('single-bar session with real range: distToDevPoc IS computable (range spans >=3 ticks)', Number.isFinite(r2.distToDevPoc));
check('single-bar session: distToDevVwap computable (VWAP needs only 1 bar)', Number.isFinite(r2.distToDevVwap));

// Genuinely narrow single bar (range < 3 ticks) -- THIS is where computeProfile's own
// guard should actually return null.
const narrowBar = [{ high: 100.05, low: 100, close: 100, bid_volume: 5, ask_volume: 5 }];
const r2b = computeDevelopingValueFeatures(narrowBar, 100);
check('genuinely narrow single bar: distToDevPoc is null (fewer than 3 tick levels)', r2b.distToDevPoc === null);

// Missing volume fields (bid_volume/ask_volume null, matching the real column's
// DEFAULT 0 NOT NULL -- but defensive in case a caller passes an incomplete row)
const barsNoVol = [{ high: 101, low: 99, close: 100, bid_volume: null, ask_volume: null }];
const r3 = computeDevelopingValueFeatures(barsNoVol, 100);
check('null volume fields do not crash, coerce to 0', r3 !== null && r3.sessionCumulativeDelta === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
