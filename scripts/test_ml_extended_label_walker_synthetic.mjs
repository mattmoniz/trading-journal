// Synthetic (no-DB) unit test for mlExtendedLabelWalker.js's computeExtendedLabel(), matching
// this codebase's own precedent (scripts/test_wider_target_walker_synthetic.mjs). Run manually:
// node scripts/test_ml_extended_label_walker_synthetic.mjs
import { computeExtendedLabel, EXTENDED_TARGET_MULT, DEFAULT_MAX_HOLD_BARS } from '../server/services/mlExtendedLabelWalker.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// LONG: entry=100, stop=95, t1=110 -> extendedTarget = 100 + 2.5*(110-100) = 125
{
  const entry = 100, stop = 95, t1 = 110;
  const extendedTarget = entry + EXTENDED_TARGET_MULT * (t1 - entry);
  check('extendedTarget computed correctly (long)', extendedTarget === 125);

  // Case 1: clean target hit on bar 3
  const bars1 = [
    { high: 102, low: 99, close: 101 },
    { high: 108, low: 100, close: 105 },
    { high: 126, low: 104, close: 125 },
  ];
  const r1 = computeExtendedLabel(bars1, { entry, stop, extendedTarget, long: true });
  check('long target hit: label=1', r1.label === 1);
  check('long target hit: exitReason=TARGET', r1.exitReason === 'TARGET');
  check('long target hit: barsHeld=3', r1.barsHeld === 3);
  check('long target hit: exitPrice=125', r1.exitPrice === 125);

  // Case 2: clean stop hit on bar 2
  const bars2 = [
    { high: 102, low: 99, close: 101 },
    { high: 103, low: 94, close: 95 },
  ];
  const r2 = computeExtendedLabel(bars2, { entry, stop, extendedTarget, long: true });
  check('long stop hit: label=0', r2.label === 0);
  check('long stop hit: exitReason=STOP', r2.exitReason === 'STOP');
  check('long stop hit: barsHeld=2', r2.barsHeld === 2);

  // Case 3: same-bar conflict -- stop must win (spec's own mandatory tie-break rule)
  const bars3 = [
    { high: 126, low: 94, close: 100 }, // both stop (<=95) and target (>=125) breached same bar
  ];
  const r3 = computeExtendedLabel(bars3, { entry, stop, extendedTarget, long: true });
  check('same-bar conflict: stop wins, label=0', r3.label === 0 && r3.exitReason === 'STOP');

  // Case 4: TIME barrier -- neither hit within maxHoldBars
  const bars4 = Array.from({ length: 5 }, (_, i) => ({ high: 105, low: 98, close: 102 }));
  const r4 = computeExtendedLabel(bars4, { entry, stop, extendedTarget, long: true, maxHoldBars: 5 });
  check('time expiry: label=0', r4.label === 0);
  check('time expiry: exitReason=TIME', r4.exitReason === 'TIME');
  check('time expiry: barsHeld=5 (capped at maxHoldBars)', r4.barsHeld === 5);
  check('time expiry: exitPrice=last close', r4.exitPrice === 102);

  // Case 5: fewer bars available than maxHoldBars -- still resolves TIME at actual length
  const bars5 = [{ high: 105, low: 98, close: 103 }, { high: 106, low: 99, close: 104 }];
  const r5 = computeExtendedLabel(bars5, { entry, stop, extendedTarget, long: true, maxHoldBars: 60 });
  check('short forward window: barsHeld=2 (actual length, not maxHoldBars)', r5.barsHeld === 2);
  check('short forward window: exitReason=TIME', r5.exitReason === 'TIME');

  // Case 6: no bars at all -- null, not a fabricated TIME_EXPIRED
  const r6 = computeExtendedLabel([], { entry, stop, extendedTarget, long: true });
  check('zero bars: returns null (insufficient data, not TIME)', r6 === null);

  // Case 7: MFE/MAE tracked correctly through the walk before exit
  const bars7 = [
    { high: 103, low: 97, close: 101 },  // mfe=3, mae=3
    { high: 107, low: 99, close: 105 },  // mfe=7, mae=3
    { high: 94, low: 94, close: 94 },    // stop hit here (low<=95)
  ];
  const r7 = computeExtendedLabel(bars7, { entry, stop, extendedTarget, long: true });
  check('mfe tracked as running max', r7.mfe === 7);
  check('mae tracked as running max', r7.mae === 6); // bar3: entry-low = 100-94=6
}

// SHORT: entry=100, stop=105, t1=90 -> extendedTarget = 100 - 2.5*(100-90) = 75
{
  const entry = 100, stop = 105, t1 = 90;
  const extendedTarget = entry - EXTENDED_TARGET_MULT * (entry - t1);
  check('extendedTarget computed correctly (short)', extendedTarget === 75);

  const bars = [
    { high: 102, low: 98, close: 99 },
    { high: 103, low: 74, close: 75 },
  ];
  const r = computeExtendedLabel(bars, { entry, stop, extendedTarget, long: false });
  check('short target hit: label=1', r.label === 1);
  check('short target hit: exitReason=TARGET', r.exitReason === 'TARGET');
}

check('DEFAULT_MAX_HOLD_BARS matches spec Section 0 default (60)', DEFAULT_MAX_HOLD_BARS === 60);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
