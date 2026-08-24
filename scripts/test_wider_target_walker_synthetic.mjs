// Synthetic-price-path proof for the wider-target-on-fast-resolving-trades mechanism
// (docs/OPEN_THREADS.md 2026-08-17). Exercises server/services/widerTargetWalker.js's
// stepWiderTarget() directly — the SAME function server/routes/acd.js's
// resolveSetupsByPrice() calls live — so a pass here is proof about the live code path
// itself, not a separate simulation that could silently diverge from it.
//
// Run: node scripts/test_wider_target_walker_synthetic.mjs

import { stepWiderTarget } from '../server/services/widerTargetWalker.js';

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

function bar(hhmm, high, low, close) {
  return { ts: `2026-08-17 ${hhmm}:00`, high, low, close };
}

function runPath(bars, baseParams) {
  let state = { widening: false };
  let barCount = 0;
  const trace = [];
  for (const b of bars) {
    barCount++; // matches resolveSetupsByPrice()'s own barCount++ at the top of each iteration
    const step = stepWiderTarget(state, b, { ...baseParams, barCount });
    state = step.state;
    trace.push({ bar: b.ts, barCount, state: { ...state }, resolution: step.resolution });
    if (step.resolution) return { resolution: step.resolution, trace, finalState: state, barCount };
  }
  return { resolution: null, trace, finalState: state, barCount };
}

// ── Test 1: T1 reached on bar 1 (fast, eligible), widens, wider target hit — the core
// "does it actually widen" proof.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4 };
  const bars = [
    bar('09:31', 20065, 20050, 20060), // barCount=1, hits T1 (20060) within maxBarsToT1 -> arms widening, stop stays at 19960
    bar('09:32', 20080, 20070, 20075), // no wider hit yet, no stop hit
    bar('09:33', 20095, 20085, 20090), // wider target (20090) hit
  ];
  const { resolution, finalState } = runPath(bars, params);
  assert(finalState.widening, 'T1: mechanism armed (widening) once T1 was reached within maxBarsToT1');
  assertEqual(resolution, { resolution: 'TARGET_HIT', method: 'WIDER_TARGET_HIT', priceAtRes: 20090 }, 'T1: exits at the wider target, not the original T1');
  assert(resolution.priceAtRes > params.t1, 'T1: wider exit price is BETTER than the original fixed target — the whole point of the mechanism');
}

// ── Test 2: T1 reached fast, widens, then reverses and hits the ORIGINAL stop (not a
// T1-floor) — the real flip-to-loss risk this mechanism is deliberately built to allow.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4 };
  const bars = [
    bar('09:31', 20065, 20050, 20060), // barCount=1, arms widening; stop=19960 (unchanged)
    bar('09:32', 20050, 19955, 19980), // reverses hard, low(19955) breaches the ORIGINAL stop (19960)
  ];
  const { resolution } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'WIDER_STOP_HIT', priceAtRes: 19960 }, 'T2: armed trade can still hit the ORIGINAL stop — real flip-to-loss risk, not a T1-floor');
  assert(resolution.priceAtRes < params.t1, 'T2: this loss is WORSE than the original T1 win — proves the stop genuinely never moved to T1');
}

// ── Test 3: T1 reached too slowly (past maxBarsToT1) — banks normally at T1, mechanism
// never arms, behaviorally identical to not having the flag at all.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4 };
  const bars = [
    bar('09:31', 20010, 19995, 20005), // barCount=1
    bar('09:32', 20015, 20000, 20010), // barCount=2
    bar('09:33', 20020, 20005, 20015), // barCount=3
    bar('09:34', 20030, 20015, 20025), // barCount=4
    bar('09:35', 20065, 20050, 20060), // barCount=5, hits T1 but barCount(5) > maxBarsToT1(4) -> banks normally
  ];
  const { resolution, finalState, barCount } = runPath(bars, params);
  assertEqual(barCount, 5, 'T3: sanity — T1 touched on the 5th bar');
  assert(!finalState.widening, 'T3: mechanism does NOT arm when T1 arrives too slowly');
  assertEqual(resolution, { resolution: 'TARGET_HIT', method: 'PRICE_CLEAN', priceAtRes: 20060 }, 'T3: banks at the ORIGINAL T1, same outcome as a plain TARGET_HIT');
}

// ── Test 4: T1 and original stop hit on the same bar BEFORE eligibility is decided —
// conservative, assumes stop hit first (matches every other branch's own convention).
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4 };
  const bars = [bar('09:31', 20065, 19955, 20000)];
  const { resolution } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'SAME_BAR_STOP_FIRST', priceAtRes: 19960 }, 'T4: same-bar T1+stop before arming assumes stop-first (conservative)');
}

// ── Test 5: stopped out before ever reaching T1 — never arms, exits on the plain
// original stop like a completely ordinary trade.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4 };
  const bars = [
    bar('09:31', 20010, 19995, 20000),
    bar('09:32', 20005, 19958, 19960), // low breaches stop (19960) before ever touching T1
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'PRICE_CLEAN', priceAtRes: 19960 }, 'T5: never armed, stops on original stop');
  assert(!finalState.widening, 'T5: never arms if stopped before reaching T1');
}

// ── Test 6: armed, never breaches the original stop or wider target, session ends while
// still open — marks to market with the widening-specific method (not the plain-branch
// MARK_TO_MARKET string, so downstream analysis can distinguish it).
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4 };
  const bars = [
    bar('09:31', 20065, 20050, 20060), // barCount=1, arms widening
    bar('15:59', 20075, 20065, 20070), // still open, not session end ('15' < '16')
    bar('16:00', 20080, 20072, 20078), // session end (hour>='16'), no stop/target hit
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'TIME_EXPIRED', method: 'WIDER_TIME_EXPIRED', priceAtRes: 20078 }, 'T6: unbreached widening state marks to market at session end with the widening-specific method string');
  assert(finalState.widening, 'T6: stayed armed all the way through session end');
}

// ── Test 7: SHORT direction — mirror-image, proves the mechanism isn't long-only.
{
  const params = { entry: 20000, stop: 20000 + 40, t1: 20000 - 60, widerTarget: 20000 - 90, long: false, maxBarsToT1: 4 };
  const bars = [
    bar('09:31', 19945, 19935, 19940), // barCount=1, hits T1 (<=19940) -> arms widening; stop stays 20040
    bar('09:32', 19920, 19905, 19910), // wider target (<=19910) hit
  ];
  const { resolution } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'TARGET_HIT', method: 'WIDER_TARGET_HIT', priceAtRes: 19910 }, 'T7 (SHORT): exits at the wider (lower) target');
  assert(resolution.priceAtRes < params.t1, 'T7 (SHORT): wider exit price is BETTER (lower) than the original fixed target');
}

// ── Test 8: exactly at the maxBarsToT1 boundary (barCount === maxBarsToT1) is eligible —
// confirms the boundary is inclusive (<=), matching bars_to_resolution<=4 exactly.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4 };
  const bars = [
    bar('09:31', 20010, 19995, 20005), bar('09:32', 20015, 20000, 20010),
    bar('09:33', 20020, 20005, 20015), bar('09:34', 20065, 20050, 20060), // barCount=4, hits T1 exactly at the boundary
  ];
  const { finalState, barCount } = runPath(bars, params);
  assertEqual(barCount, 4, 'T8: sanity — T1 touched on exactly the 4th bar');
  assert(finalState.widening, 'T8: barCount===maxBarsToT1 is eligible (inclusive boundary, matches bars_to_resolution<=4)');
}

// ── Test 9: T1 hit fast (within maxBarsToT1) but on/after the 16:00 session-end bar — the
// exact contradiction B2 fixed (docs/OPEN_THREADS.md 2026-08-18, DeepSeek-QA'd): before the
// fix this would BOTH arm (newState.widening=true) AND resolve TIME_EXPIRED/MARK_TO_MARKET
// in the same return, violating stepWiderTarget()'s own {state, resolution} contract. Correct
// behavior (DeepSeek-confirmed): do not arm — there's no remaining session time to benefit
// from arming anyway — and bank as a plain TARGET_HIT, not a mark-to-market (T1 genuinely
// printed; mark-to-market could misprice it below T1).
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4 };
  const bars = [
    bar('16:00', 20065, 20050, 20060), // barCount=1 (<=maxBarsToT1), but hour>='16' -- session end
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'TARGET_HIT', method: 'PRICE_CLEAN', priceAtRes: 20060 }, 'T9: fast T1 hit exactly at session-end banks as a plain TARGET_HIT, not a mark-to-market');
  assert(!finalState.widening, 'T9: does not arm when there is no session time left to benefit from arming');
}

// ── Test 10-12: pressure gate (2026-08-24, RESEARCH_CLAIM
// wider_target_pressure_gate_vs_always_extend). Adds bid_volume/ask_volume to the bar so
// pressureReading can be computed the same way the live call site does.
function barVol(hhmm, high, low, close, bidVol, askVol) {
  return { ts: `2026-08-24 ${hhmm}:00`, high, low, close, bid_volume: bidVol, ask_volume: askVol };
}

// ── Test 10: fast T1 hit, but pressure is BELOW the calibrated threshold — should bank
// immediately with the new BANKED_LOW_PRESSURE method, not arm.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4, pressureThreshold: 0.10 };
  const bars = [
    barVol('09:31', 20065, 20050, 20060, 600, 400), // dirImbalance = (400-600)/1000 = -0.20, well below 0.10
  ];
  let state = { widening: false };
  const b = bars[0];
  const dirImbalance = ((b.ask_volume) - (b.bid_volume)) / (b.ask_volume + b.bid_volume);
  const step = stepWiderTarget(state, b, { ...params, barCount: 1, pressureReading: dirImbalance });
  assertEqual(step.resolution, { resolution: 'TARGET_HIT', method: 'BANKED_LOW_PRESSURE', priceAtRes: 20060 }, 'T10: fast T1 hit with weak pressure banks immediately, does not arm');
  assert(!step.state.widening, 'T10: does not arm when pressure is below the calibrated threshold');
}

// ── Test 11: fast T1 hit, pressure ABOVE the threshold — should arm exactly as before the
// gate was added.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4, pressureThreshold: 0.10 };
  const b = barVol('09:31', 20065, 20050, 20060, 300, 700); // dirImbalance = (700-300)/1000 = +0.40
  const dirImbalance = (b.ask_volume - b.bid_volume) / (b.ask_volume + b.bid_volume);
  const step = stepWiderTarget({ widening: false }, b, { ...params, barCount: 1, pressureReading: dirImbalance });
  assertEqual(step.resolution, null, 'T11: strong pressure arms rather than resolving immediately');
  assert(step.state.widening, 'T11: arms when pressure clears the calibrated threshold');
}

// ── Test 12: no threshold supplied (pressureThreshold/pressureReading both null, the
// default) — must behave EXACTLY like the pre-gate mechanism (backward compatibility for
// any caller that hasn't wired pressure through yet).
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4 };
  const bars = [
    bar('09:31', 20065, 20050, 20060),
    bar('09:32', 20080, 20070, 20075),
    bar('09:33', 20095, 20085, 20090),
  ];
  const { resolution, finalState } = runPath(bars, params);
  assert(finalState.widening, 'T12: with no threshold supplied, gate is a no-op — arms exactly as pre-2026-08-24');
  assertEqual(resolution, { resolution: 'TARGET_HIT', method: 'WIDER_TARGET_HIT', priceAtRes: 20090 }, 'T12: unaffected downstream behavior when the gate is disabled');
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
