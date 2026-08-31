// Synthetic-price-path proof for the breakeven-then-trail mechanism (roadmap Phase 3,
// I4 — "prove it with a test that asserts the trail actually moved on a synthetic price
// path"). Exercises server/services/breakevenTrailWalker.js's stepBreakevenTrail()
// directly — the SAME function server/routes/acd.js's resolveSetupsByPrice() now calls
// live (extracted 2026-08-10, not reimplemented) — so a pass here is proof about the
// live code path itself, not a separate simulation that could silently diverge from it.
//
// Run: node scripts/test_breakeven_trail_walker_synthetic.mjs

import { stepBreakevenTrail } from '../server/services/breakevenTrailWalker.js';

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

// dateStr optional, mod added 2026-08-30 -- see test_wider_target_walker_synthetic.mjs's
// identical fix for why (isPastMechanismSessionEnd() needs bar.mod, not a ts string).
function bar(hhmm, high, low, close, dateStr = '2026-08-10') {
  const [hh, mm] = hhmm.split(':').map(Number);
  return { ts: `${dateStr} ${hhmm}:00`, mod: hh * 60 + mm, high, low, close };
}

function runPath(bars, params) {
  let state = { armedAt: null, peakPrice: null, trailStopPrice: null };
  const trace = [];
  for (const b of bars) {
    const step = stepBreakevenTrail(state, b, params);
    state = step.state;
    trace.push({ bar: b.ts, state: { ...state }, resolution: step.resolution });
    if (step.resolution) return { resolution: step.resolution, trace, finalState: state };
  }
  return { resolution: null, trace, finalState: state };
}

// ── Test 1: never reaches T1 — stops out on the fixed original stop, mechanism never arms
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, trailWidth: 20, long: true };
  const bars = [
    bar('09:31', 20010, 19995, 20000),
    bar('09:32', 20005, 19958, 19960), // low breaches stop (19960)
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'PRICE_CLEAN', priceAtRes: 19960 }, 'T1: never armed, stops on original stop');
  assert(finalState.armedAt == null, 'T1: never arms if stopped before reaching t1');
}

// ── Test 2: reaches T1, trail actually RATCHETS as price makes new highs, then exits
// on the trail (not on the original stop or target) — the core "does it move" proof.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, trailWidth: 20, long: true };
  const bars = [
    bar('09:31', 20010, 19995, 20005),
    bar('09:32', 20065, 20050, 20060), // hits T1 (20060) -> arms, peak=20065, trailStop=entry=20000
    bar('09:33', 20100, 20090, 20095), // new peak 20100 -> trail ratchets to 20100-20=20080 (low 20090 clears it)
    bar('09:34', 20130, 20115, 20125), // new peak 20130 -> trail ratchets to 20130-20=20110 (low 20115 clears it)
    bar('09:35', 20120, 20105, 20108), // no new peak (high<20130); low=20105 < trailStop(20110) -> TRAIL_EXIT
  ];
  let state = { armedAt: null, peakPrice: null, trailStopPrice: null };
  const trailStopsSeen = [];
  let resolution = null;
  for (const b of bars) {
    const step = stepBreakevenTrail(state, b, params);
    state = step.state;
    if (state.trailStopPrice != null) trailStopsSeen.push(state.trailStopPrice);
    if (step.resolution) { resolution = step.resolution; break; }
  }
  assert(state.armedAt != null, 'T2: mechanism armed once T1 was reached');
  assertEqual(trailStopsSeen, [20000, 20080, 20110, 20110], 'T2: trailStopPrice actually MOVES with new peaks (20000 -> 20080 -> 20110), proving the trail is not static');
  assertEqual(resolution, { resolution: 'TRAIL_EXIT', method: 'BREAKEVEN_TRAIL_HIT', priceAtRes: 20110 }, 'T2: exits at the ratcheted trail price, not the original stop or target');
  assert(resolution.priceAtRes > params.t1, 'T2: trail exit price is BETTER than the original fixed target — the whole point of the mechanism');
}

// ── Test 3: same-bar arm-and-breach scratch (must match backtest_breakeven_trail.mjs's
// own documented scratch-rate convention exactly)
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, trailWidth: 20, long: true };
  const bars = [
    bar('09:31', 20070, 19995, 20050), // hits T1 AND low <= entry(20000) same bar -> arm then immediate scratch
  ];
  const { resolution } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'TRAIL_EXIT', method: 'SAME_BAR_ARM_STOP', priceAtRes: 20000 }, 'T3: same-bar breakeven breach scratches at entry, not a full loss');
}

// ── Test 4: T1 and original stop hit on the same bar before arming — conservative,
// assumes stop hit first (matches the plain fixed-target branch's own convention)
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, trailWidth: 20, long: true };
  const bars = [bar('09:31', 20065, 19955, 20000)];
  const { resolution } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'STOP_HIT', method: 'SAME_BAR_STOP_FIRST', priceAtRes: 19960 }, 'T4: same-bar T1+stop before arming assumes stop-first (conservative)');
}

// ── Test 5: armed, never breaches trail, session ends while still open — marks to
// market at the bar's close, using the TRAIL_TIME_EXPIRED method (not the plain-branch
// MARK_TO_MARKET string — must stay a distinct method or downstream analysis can't
// distinguish a trail-mechanism time-expiry from a plain one)
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, trailWidth: 20, long: true };
  const bars = [
    bar('09:31', 20070, 20050, 20065), // arms, peak=20070, trailStop=entry=20000
    bar('15:59', 20090, 20080, 20085), // new peak 20090 -> trail ratchets to 20090-20=20070; not session end ('15'<'16')
    bar('16:00', 20085, 20075, 20080), // no new peak (high<20090); session end (hour>='16'); low(20075) clears trailStop(20070)
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'TIME_EXPIRED', method: 'TRAIL_TIME_EXPIRED', priceAtRes: 20080 }, 'T5: unbreached trail marks to market at session end with the trail-specific method string');
  assert(finalState.trailStopPrice === 20070, 'T5: trail kept ratcheting right up to session end (20070), never loosened');
}

// ── Test 6: SHORT direction — mirror-image of test 2, proves the mechanism isn't
// long-only by construction (peak tracks the LOW, trail sits above price)
{
  const params = { entry: 20000, stop: 20000 + 40, t1: 20000 - 60, trailWidth: 20, long: false };
  const bars = [
    bar('09:31', 19945, 19935, 19940), // hits T1 (<=19940) -> arms, peak(low)=19935, trailStop=entry=20000
    bar('09:32', 19920, 19900, 19905), // new low 19900 -> trail ratchets to 19900+20=19920
    bar('09:33', 19925, 19921, 19923), // high 19925 >= trailStop(19920) -> TRAIL_EXIT
  ];
  const { resolution, finalState } = runPath(bars, params);
  assertEqual(resolution, { resolution: 'TRAIL_EXIT', method: 'BREAKEVEN_TRAIL_HIT', priceAtRes: 19920 }, 'T6 (SHORT): trail ratchets downward with new lows and exits above them');
  assert(resolution.priceAtRes < params.t1, 'T6 (SHORT): trail exit price is BETTER (lower) than the original fixed target');
}

// ── Test 7: trail never loosens even if price pulls back without making a new peak
// then a shallower pullback occurs later (ratchet-only invariant)
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, trailWidth: 20, long: true };
  const bars = [
    bar('09:31', 20070, 20050, 20065), // hits T1 -> arms; trailStop snaps to entry=20000 (breakeven), NOT peak-trailWidth
    bar('09:32', 20072, 20055, 20060), // tiny new peak 20072 -> trail ratchets to 20072-20=20052
    bar('09:33', 20068, 20053, 20060), // pulls back, no new peak, low 20053 > trailStop(20052) -> survives, stop unchanged
    bar('09:34', 20090, 20080, 20085), // new peak 20090 -> trail ratchets to 20090-20=20070
  ];
  let state = { armedAt: null, peakPrice: null, trailStopPrice: null };
  const seen = [];
  for (const b of bars) {
    const step = stepBreakevenTrail(state, b, params);
    state = step.state;
    seen.push(state.trailStopPrice);
    if (step.resolution) break;
  }
  assertEqual(seen, [20000, 20052, 20052, 20070], 'T7: arms at breakeven (not peak-trailWidth), then ratchet-only from there — increases on new peaks, holds flat on a pullback, never resets backward');
}

// ── Globex tests (added 2026-08-30, same incident as test_wider_target_walker_synthetic.mjs's
// Globex tests -- the identical `hour>=16` bug was independently hand-rolled here too).

// ── Test 9 (Globex): armed at 18:01 ET (Globex hours), must NOT immediately mark to market --
// the old bug would have treated the very first bar of any Globex fire as session-end.
// (Renumbered 2026-08-30, DeepSeek code review round 2 finding R8 -- this block used to be
// labeled T6-T8, colliding with the RTH tests' own T6/T7 above.)
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, trailWidth: 20, long: true, firedMod: 18 * 60 };
  const b = bar('18:01', 20070, 20050, 20065);
  const step = stepBreakevenTrail({ armedAt: null, peakPrice: null, trailStopPrice: null }, b, params);
  assertEqual(step.resolution, null, 'T9 (Globex): arms at 18:01 instead of marking to market immediately');
  assert(step.state.armedAt != null, 'T9 (Globex): armedAt is correctly set for a Globex-hour fire');
}

// ── Test 10 (Globex): armed trail stays open overnight through a quiet 23:30 bar.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, trailWidth: 20, long: true, firedMod: 18 * 60 };
  const state = { armedAt: '2026-08-17 18:01:00', peakPrice: 20070, trailStopPrice: 20050 };
  const b = bar('23:30', 20075, 20060, 20065, '2026-08-17');
  const step = stepBreakevenTrail(state, b, params);
  assertEqual(step.resolution, null, 'T10 (Globex): armed overnight trail stays open mid-session, does not falsely mark-to-market');
}

// ── Test 11 (Globex): once the NEXT RTH open (9:30am ET, following calendar day) arrives with
// the trail unbreached, marks to market with the trail-specific method string.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, trailWidth: 20, long: true, firedMod: 18 * 60 };
  const state = { armedAt: '2026-08-17 18:01:00', peakPrice: 20070, trailStopPrice: 20050 };
  const b = bar('09:31', 20065, 20060, 20062, '2026-08-18');
  const step = stepBreakevenTrail(state, b, params);
  assertEqual(step.resolution, { resolution: 'TIME_EXPIRED', method: 'TRAIL_TIME_EXPIRED', priceAtRes: 20062 }, 'T11 (Globex): marks to market at the NEXT RTH open, not immediately at fire time');
}

// ── Test 12 (dead zone, R3 fix): a trade fired at 16:10 ET (firedMod=970) must NOT instantly
// mark-to-market on its own fire bar -- before the fix, firedMod=970 fell through to the RTH
// branch (barMod>=960), and 970>=960 is already true.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, trailWidth: 20, long: true, firedMod: 970 };
  const b = bar('16:11', 20070, 20050, 20065);
  const step = stepBreakevenTrail({ armedAt: null, peakPrice: null, trailStopPrice: null }, b, params);
  assertEqual(step.resolution, null, 'T12 (dead zone): arms at 16:11 (fired 16:10) instead of instantly marking to market');
  assert(step.state.armedAt != null, 'T12 (dead zone): armedAt is correctly set for a dead-zone fire');
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
