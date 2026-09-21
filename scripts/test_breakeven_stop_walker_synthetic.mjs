// Synthetic-price-path proof for the breakeven-stop-on-order-flow-rejection mechanism
// (promoted live 2026-09-21, DeepSeek design critique F3 point 1). Exercises
// server/services/breakevenStopWalker.js's stepBreakevenStop() directly -- the SAME function
// server/services/resolveSetups.js's resolveSetupsByPrice() calls live -- so a pass here is
// proof about the live code path itself, not a separate simulation that could diverge from it.
// Same convention as test_wider_target_walker_synthetic.mjs/test_breakeven_trail_walker_
// synthetic.mjs.
//
// This complements, not replaces, the real-data byte-diff verification run before shipping
// (feeds each of the ~591 production-eligible historical trades through this same function
// bar-by-bar and confirms it reproduces breakevenStopShadow.js's own retrospective
// classification exactly, given the same bars -- see docs/OPEN_THREADS.md's 2026-09-21 entry
// for that verification's own numbers). This script covers the SHAPE of the logic with clean,
// hand-constructed cases; the byte-diff run is what proves it against real market noise.
//
// Run: node scripts/test_breakeven_stop_walker_synthetic.mjs

import { stepBreakevenStop, Z_CUT, D_CUT } from '../server/services/breakevenStopWalker.js';

let pass = 0, fail = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; }
  else { fail++; console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}
function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${label}`); }
}

// A baseline where every minute-of-day has the same avg/std, so a bar's own z-score is fully
// controlled by its own volume -- easiest to reason about by hand.
const baseline = new Map();
for (let m = 0; m < 1440; m++) baseline.set(m, { avg_vol: 100, std_vol: 20 });

function bar(hhmm, { high, low, close, bid = 100, ask = 100 }, dateStr = '2026-09-21') {
  const [hh, mm] = hhmm.split(':').map(Number);
  return { ts: `${dateStr} ${hhmm}:00`, mod: hh * 60 + mm, high, low, close, bid_volume: bid, ask_volume: ask };
}

function runPath(bars, params) {
  let state = { pendingPush: null, armed: false, armedAtTs: null, breakevenStop: null, sawRejection: false, pushEvaluated: false };
  const trace = [];
  for (let i = 0; i < bars.length; i++) {
    const barsRemainingAfter = bars.length - 1 - i;
    const step = stepBreakevenStop(state, bars[i], { ...params, barsRemainingAfter });
    state = step.state;
    trace.push({ bar: bars[i].ts, state: { ...state }, resolution: step.resolution });
    if (step.resolution) return { resolution: step.resolution, trace, finalState: state };
  }
  return { resolution: null, trace, finalState: state };
}

// A bar whose bid_volume dominates (net SELLING -- adverse to a LONG position) with a clearly
// elevated total volume, closing in the upper half (so it does NOT fail same-bar) -- a genuine
// push candidate. delta = ask - bid = -220 (negative -> adverse for long, matching
// isAdverse = long && delta < 0).
const pushBarLong = (hhmm) => bar(hhmm, { high: 20010, low: 19998, close: 19999, bid: 260, ask: 40 }); // tot=300, z=(300-100)/20=10, |delta|/tot=0.73 -- both well past Z_CUT/D_CUT; closePos=(19999-19998)/12=0.08, well under 0.5 -- does not fail same-bar

// ── Test 1: plain path, no push ever detected -- stops out on the original stop
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, long: true, baseline };
  const bars = [
    bar('09:31', { high: 20010, low: 19995, close: 20000 }),
    bar('09:32', { high: 20005, low: 19958, close: 19960 }), // low breaches stop
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'PRICE_CLEAN', priceAtRes: 19960 }, 'T1: plain stop, no push detected');
  assert(!finalState.armed, 'T1: never armed');
}

// A confirm bar that does NOT flip relative to pushBarLong's delta (-220): same-direction
// (bid-dominant again, less extreme) so nDelta*pendingPush.delta stays positive regardless of
// its own z-score.
const noFlipConfirm = (hhmm) => bar(hhmm, { high: 20009, low: 20001, close: 20005, bid: 110, ask: 90 }); // low kept > 20000 so this bar itself doesn't also breach the fresh breakeven stop
// A confirm bar that DOES flip: opposite direction (ask-dominant) with nz clearly over 1.0.
const flipConfirm = (hhmm) => bar(hhmm, { high: 20012, low: 20005, close: 20010, bid: 40, ask: 260 });
// A push candidate that fails same-bar (closePos > 0.5 for a long -- closing in the upper
// half): same range/volume shape as pushBarLong, just a higher close.
const failsSameBarPush = (hhmm) => bar(hhmm, { high: 20010, low: 19998, close: 20008, bid: 260, ask: 40 });

// ── Test 2: push detected, fails same-bar (closePos on the wrong side for a LONG) -> REJECTED,
//    falls through to the plain path.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, long: true, baseline };
  const bars = [
    failsSameBarPush('09:31'),
    bar('09:32', { high: 20005, low: 19999, close: 20003 }), // margin bar, nothing happens
    bar('09:33', { high: 20005, low: 19958, close: 19960 }), // then genuinely stops out on the ORIGINAL stop
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'PRICE_CLEAN', priceAtRes: 19960 }, 'T2: same-bar-fail REJECTED, plain stop still applies');
  assert(!finalState.armed && finalState.sawRejection, 'T2: rejected, never armed');
}

// ── Test 3: push detected, confirm bar flips hard the other way (nz>1.0, opposite delta) ->
//    REJECTED, falls through to the plain path.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, long: true, baseline };
  const bars = [
    pushBarLong('09:31'),
    flipConfirm('09:32'),
    bar('09:33', { high: 20005, low: 19958, close: 19960 }), // then genuinely stops out on the ORIGINAL stop
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'PRICE_CLEAN', priceAtRes: 19960 }, 'T3: next-bar-flip REJECTED, plain stop still applies');
  assert(!finalState.armed && finalState.sawRejection, 'T3: rejected via flip, never armed');
}

// ── Test 4: push detected, confirm bar does NOT flip -> REWARDED, arms starting the confirm
//    bar itself, and a subsequent breach of the (now-breakeven) stop resolves BE_STOP_HIT --
//    NOT the wider original stop, proving the effective stop actually moved.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, long: true, baseline };
  const bars = [
    pushBarLong('09:31'),
    noFlipConfirm('09:32'), // confirms REWARDED, arms at 20000
    bar('09:33', { high: 20003, low: 19995, close: 19996 }), // breaches the BREAKEVEN stop (20000) but NOT the original stop (19960)
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'BE_STOP_HIT', priceAtRes: 20000 }, 'T4: REWARDED, resolves at the breakeven stop, not the original');
  assert(finalState.armed && finalState.armedAtTs === '2026-09-21 09:32:00', 'T4: armed on the confirm bar');
}

// ── Test 5: push confirmed REWARDED, but price reaches the target before ever breaching the
//    breakeven stop -- still resolves TARGET_HIT, proving BE never blocks a real winner.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, long: true, baseline };
  const bars = [
    pushBarLong('09:31'),
    noFlipConfirm('09:32'), // confirms REWARDED, arms at 20000
    bar('09:33', { high: 20065, low: 20010, close: 20062 }), // reaches T1 (20060) cleanly
  ];
  const { resolution } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'TARGET_HIT', method: 'PRICE_CLEAN', priceAtRes: 20060 }, 'T5: REWARDED but still reaches target -- not blocked');
}

// ── Test 6: same-bar conflict once armed -- stop wins, matching the plain branch's own
//    SAME_BAR_STOP_FIRST convention (conservative, worst case for the trader).
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, long: true, baseline };
  const bars = [
    pushBarLong('09:31'),
    noFlipConfirm('09:32'), // confirms REWARDED, arms at 20000
    bar('09:33', { high: 20065, low: 19990, close: 20062 }), // breaches BOTH breakeven stop (20000) and t1 (20060) in one bar
  ];
  const { resolution } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'BE_STOP_SAME_BAR', priceAtRes: 20000 }, 'T6: same-bar conflict once armed, stop wins');
}

// ── Test 7: only the FIRST push candidate in the trade's life is ever evaluated -- a REJECTED
//    first push must NOT let a later, genuinely-REWARDED-shaped push arm the mechanism. Matches
//    the offline classifier's own unconditional `break` right after evaluating one candidate
//    (caught by the real byte-diff verification against 1,921 historical trades, 2026-09-21 --
//    an earlier draft kept scanning for a second push and diverged on 108/1921 real trades).
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, long: true, baseline };
  const bars = [
    failsSameBarPush('09:31'), // REJECTED (same-bar-fail) -- the ONE candidate this trade ever gets
    bar('09:32', { high: 20005, low: 19999, close: 20003 }),
    pushBarLong('09:33'), // would be a genuine push if evaluated -- must be ignored
    noFlipConfirm('09:34'), // would confirm REWARDED if evaluated -- must be ignored
    bar('09:35', { high: 20003, low: 19995, close: 19996 }), // would breach a breakeven stop if (wrongly) armed
    bar('09:36', { high: 20005, low: 19958, close: 19960 }), // genuinely stops out on the ORIGINAL stop
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'PRICE_CLEAN', priceAtRes: 19960 }, 'T7: first-candidate-only, never arms on a later push');
  assert(!finalState.armed, 'T7: never armed despite a later genuine-looking push');
}

// ── Test 8: a push candidate within 2 bars of the end of the CURRENTLY KNOWN array is never
//    even considered -- matches the offline classifier's `i < bars.length - 2` bound exactly
//    (DeepSeek F7 / the second real-data correction, 2026-09-21).
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, long: true, baseline };
  const bars = [
    pushBarLong('09:31'), // only 1 bar remains after this one in THIS array -- barsRemainingAfter=0
  ];
  const { resolution, finalState } = runPath(bars, params);
  assert(resolution === null, 'T8: no resolution -- not enough margin to even consider the push yet');
  assert(!finalState.pendingPush && !finalState.pushEvaluated, 'T8: push candidate not yet considered, will be re-evaluated once more bars arrive');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
