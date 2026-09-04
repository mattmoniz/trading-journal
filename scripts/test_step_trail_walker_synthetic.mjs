// Synthetic-price-path proof for the step-trail runner extension mechanism
// (server/services/stepTrailWalker.js, Opus Audit #12, 2026-09-04). Exercises stepStepTrail()
// directly, which itself calls the REAL live stepWiderTarget() for everything through the
// wider-target hit — so a pass here is proof about composition with the live code path, not a
// separate simulation. Mirrors scripts/test_wider_target_walker_synthetic.mjs's own structure
// and bar()/barVol() helpers exactly.
//
// Run: node scripts/test_step_trail_walker_synthetic.mjs

import { stepStepTrail } from '../server/services/stepTrailWalker.js';

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

function bar(hhmm, high, low, close, dateStr = '2026-09-04') {
  const [hh, mm] = hhmm.split(':').map(Number);
  return { ts: `${dateStr} ${hhmm}:00`, mod: hh * 60 + mm, high, low, close };
}

function runPath(bars, baseParams) {
  let state = { inner: { widening: false }, ratcheting: false, currentStop: null, highestMfe: null };
  let barCount = 0;
  const trace = [];
  for (const b of bars) {
    barCount++;
    const step = stepStepTrail(state, b, { ...baseParams, barCount });
    state = step.state;
    trace.push({ bar: b.ts, barCount, state: { ...state }, resolution: step.resolution });
    if (step.resolution) return { resolution: step.resolution, trace, finalState: state, barCount };
  }
  return { resolution: null, trace, finalState: state, barCount };
}

const BASE = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4 };
const STEP = 20; // stepSize in points, chosen so the arithmetic below is easy to hand-verify

// ── Test 1: never reaches the wider target at all — pure passthrough of a plain TARGET_HIT,
// step-trail logic never engages.
{
  const bars = [bar('09:31', 20005, 19995, 20000)]; // no T1 hit at all
  const params = { ...BASE, stepSize: STEP };
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, null, 'T1: still walking, nothing resolved yet on a quiet bar');
  assert(!finalState.ratcheting, 'T1: never begins ratcheting without ever reaching T1');
}

// ── Test 2 (THE REGRESSION GUARD — v1's catastrophic bug): the stop must snap to
// (widerTarget - stepSize) on the SAME BAR the wider target is crossed, not a bar later.
// v1 left currentStop at the ORIGINAL stop until a full extra step past arming — this test
// would have failed against that version.
{
  const bars = [
    bar('09:31', 20065, 20050, 20060), // barCount=1, hits T1 fast -> arms widening (inner state)
    bar('09:32', 20095, 20085, 20090), // wider target (20090) hit on THIS bar
  ];
  const params = { ...BASE, stepSize: STEP };
  const { resolution, finalState, trace } = runPath(bars, params);
  assertEqual(resolution, null, 'T2: crossing the wider target does not resolve, it starts ratcheting');
  assert(finalState.ratcheting, 'T2: ratcheting begins the instant the wider target is hit');
  assertEqual(finalState.currentStop, 20090 - STEP, 'T2 (REGRESSION GUARD): stop snaps to widerTarget-stepSize on the SAME bar as the crossing, not a bar later');
  assert(finalState.currentStop > BASE.stop, 'T2: the snapped stop is strictly better than the original stop (real, immediate protection)');
  assertEqual(finalState.highestMfe, 20090, 'T2: highestMfe initializes at the wider target price on the crossing bar');
}

// ── Test 3: the snap can only ever be an improvement — if stepSize is absurdly large (bigger
// than the distance from original stop to widerTarget), the snap must not push the stop WORSE
// than the original stop (Math.max/Math.min guard).
{
  const bars = [
    bar('09:31', 20065, 20050, 20060),
    bar('09:32', 20095, 20085, 20090),
  ];
  const params = { ...BASE, stepSize: 500 }; // snapped = 20090-500 = 19590, far below original stop 19960
  const { finalState } = runPath(bars, params);
  assertEqual(finalState.currentStop, BASE.stop, 'T3: an oversized step never snaps the stop WORSE than the original stop');
}

// ── Test 4: after ratcheting begins, price keeps running favorably — stop should ratchet up
// by exactly one step per stepSize of further favorable movement.
{
  const bars = [
    bar('09:31', 20065, 20050, 20060), // arms
    bar('09:32', 20095, 20085, 20090), // wider target hit, ratchet starts: currentStop=20070, highestMfe=20090
    bar('09:33', 20115, 20100, 20110), // high=20115 >= highestMfe(20090)+STEP(20)=20110 -> 1 step: highestMfe=20110, stop=20090
  ];
  const params = { ...BASE, stepSize: STEP };
  const { finalState } = runPath(bars, params);
  assertEqual(finalState.highestMfe, 20110, 'T4: highestMfe advances by exactly one step when price clears the next step boundary');
  assertEqual(finalState.currentStop, 20090, 'T4: currentStop advances by the same one step, staying stepSize behind highestMfe');
}

// ── Test 5: a single big bar jumps past MULTIPLE step boundaries at once — must advance by
// every step earned, not just one (floor-division, matches step1_ratchet_v3.mjs runArmB()).
{
  const bars = [
    bar('09:31', 20065, 20050, 20060), // arms
    bar('09:32', 20095, 20085, 20090), // ratchet starts: currentStop=20070, highestMfe=20090
    bar('09:33', 20175, 20160, 20170), // high=20175, (20175-20090)/20 = 4.25 -> floor 4 steps
  ];
  const params = { ...BASE, stepSize: STEP };
  const { finalState } = runPath(bars, params);
  assertEqual(finalState.highestMfe, 20090 + 4 * STEP, 'T5: a fast bar advances highestMfe by every step it actually earned (floor division)');
  assertEqual(finalState.currentStop, (20090 - STEP) + 4 * STEP, 'T5: currentStop advances by the same number of steps');
}

// ── Test 6: after ratcheting, price pulls back and hits the (already-ratcheted) stop —
// exits as a real win (TARGET_HIT/STEP_TRAIL_STOP_HIT), never STOP_HIT, since the ratchet
// only ever sits at or above a level the trade already earned.
{
  const bars = [
    bar('09:31', 20065, 20050, 20060), // arms
    bar('09:32', 20095, 20085, 20090), // ratchet starts: currentStop=20070
    bar('09:33', 20080, 20065, 20068), // low=20065 breaches currentStop=20070
  ];
  const params = { ...BASE, stepSize: STEP };
  const { resolution } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'TARGET_HIT', method: 'STEP_TRAIL_STOP_HIT', priceAtRes: 20070 }, 'T6: pulling back into the ratcheted stop exits as a real win (TARGET_HIT), not a loss');
}

// ── Test 7: ratcheting, never breaches the trailing stop, session ends while still open —
// marks to market with the step-trail-specific method string.
{
  const bars = [
    bar('09:31', 20065, 20050, 20060), // arms
    bar('09:32', 20095, 20085, 20090), // ratchet starts
    bar('15:59', 20100, 20092, 20098), // still open
    bar('16:00', 20105, 20095, 20100), // session end, no stop hit
  ];
  const params = { ...BASE, stepSize: STEP, firedMod: 9 * 60 + 31 };
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'TARGET_HIT', method: 'STEP_TRAIL_TIME_EXPIRED', priceAtRes: 20100 }, 'T7: unbreached ratchet marks to market at session end with the step-trail-specific method');
  assert(finalState.ratcheting, 'T7: stayed ratcheting all the way through session end');
}

// ── Test 8: SHORT direction — mirror-image proof the mechanism isn't long-only.
{
  const params = { entry: 20000, stop: 20000 + 40, t1: 20000 - 60, widerTarget: 20000 - 90, long: false, maxBarsToT1: 4, stepSize: STEP };
  const bars = [
    bar('09:31', 19945, 19935, 19940), // arms (T1 <= 19940)
    bar('09:32', 19915, 19905, 19910), // wider target (<=19910) hit -> ratchet starts
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, null, 'T8 (SHORT): crossing the wider target starts ratcheting, does not resolve');
  assertEqual(finalState.currentStop, 19910 + STEP, 'T8 (SHORT): stop snaps to widerTarget+stepSize (mirror direction)');
  assertEqual(finalState.highestMfe, 19910, 'T8 (SHORT): highestMfe initializes at the wider target');
}

// ── Test 9: original stop hit BEFORE ever reaching the wider target (still in stepWiderTarget's
// own "widening" phase) — passes through as the plain WIDER_STOP_HIT, ratcheting never begins.
{
  const bars = [
    bar('09:31', 20065, 20050, 20060), // arms
    bar('09:32', 20010, 19955, 19980), // reverses hard, breaches the ORIGINAL stop before ever hitting widerTarget
  ];
  const params = { ...BASE, stepSize: STEP };
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'WIDER_STOP_HIT', priceAtRes: BASE.stop }, 'T9: original-stop breach before the wider target is a clean passthrough of stepWiderTarget\'s own outcome');
  assert(!finalState.ratcheting, 'T9: never begins ratcheting if stopped out before reaching the wider target');
}

// ── Test 10: T1 arrives too slowly (past maxBarsToT1) — banks normally, step-trail logic
// never engages at all, pure passthrough.
{
  const bars = [
    bar('09:31', 20010, 19995, 20005), bar('09:32', 20015, 20000, 20010),
    bar('09:33', 20020, 20005, 20015), bar('09:34', 20030, 20015, 20025),
    bar('09:35', 20065, 20050, 20060), // barCount=5 > maxBarsToT1(4) -> plain bank
  ];
  const params = { ...BASE, stepSize: STEP };
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'TARGET_HIT', method: 'PRICE_CLEAN', priceAtRes: 20060 }, 'T10: slow T1 arrival passes through as a plain bank, step-trail never engages');
  assert(!finalState.ratcheting, 'T10: never ratchets when the mechanism never even arms');
}

// ── Test 11: pressure gate fails (real live gate, inherited via composition) — banks
// immediately at T1, step-trail logic never gets a chance to engage.
{
  function barVol(hhmm, high, low, close, bidVol, askVol) {
    return { ts: `2026-09-04 ${hhmm}:00`, high, low, close, bid_volume: bidVol, ask_volume: askVol };
  }
  const b = barVol('09:31', 20065, 20050, 20060, 600, 400); // dirImbalance = -0.20, below threshold
  const dirImbalance = (b.ask_volume - b.bid_volume) / (b.ask_volume + b.bid_volume);
  const params = { ...BASE, stepSize: STEP, pressureThreshold: 0.10, pressureReading: dirImbalance };
  const state = { inner: { widening: false }, ratcheting: false, currentStop: null, highestMfe: null };
  const step = stepStepTrail(state, b, { ...params, barCount: 1 });
  assertEqual(step.resolution, { resolution: 'TARGET_HIT', method: 'BANKED_LOW_PRESSURE', priceAtRes: 20060 }, 'T11: real pressure gate (inherited from stepWiderTarget) still applies — weak pressure banks, never reaches ratcheting');
  assert(!step.state.ratcheting, 'T11: never ratchets when the pressure gate itself never let it arm');
}

// ── Test 12: same-bar wider-target-hit AND original-stop-hit conflict during phase 2 (armed,
// not yet ratcheting) — must respect stepWiderTarget's own conservative stop-first convention,
// never start ratcheting on an ambiguous bar.
{
  const bars = [
    bar('09:31', 20065, 20050, 20060), // arms
    bar('09:32', 20095, 19955, 19980), // same bar: high clears widerTarget(20090) AND low breaches stop(19960)
  ];
  const params = { ...BASE, stepSize: STEP };
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'WIDER_STOP_HIT', priceAtRes: BASE.stop }, 'T12: same-bar conflict during phase 2 respects stepWiderTarget\'s stop-first convention, never starts ratcheting on an ambiguous bar');
  assert(!finalState.ratcheting, 'T12: no ratchet begins on a same-bar stop/target conflict');
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
