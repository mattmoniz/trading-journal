// Synthetic-price-path proof for the wider-target-on-fast-resolving-trades mechanism
// (docs/OPEN_THREADS.md 2026-08-17). Exercises server/services/widerTargetWalker.js's
// stepWiderTarget() directly — the SAME function server/routes/acd.js's
// resolveSetupsByPrice() calls live — so a pass here is proof about the live code path
// itself, not a separate simulation that could silently diverge from it.
//
// Run: node scripts/test_wider_target_walker_synthetic.mjs

import { stepWiderTarget } from '../server/services/widerTargetWalker.js';
import { isPastMechanismSessionEnd, firedAtToMod, isFiredInRTH } from '../server/services/sessionBoundary.js';

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

// dateStr optional (defaults to the original fixed test date) -- Globex test cases below need a
// bar that lands on the FOLLOWING calendar date once a trade fired in the evening runs past
// midnight. mod matches the real system's convention (every real caller's bar query already
// computes this column) -- added 2026-08-30 alongside stepWiderTarget()'s firedMod param;
// without it isPastMechanismSessionEnd(bar.mod, ...) always saw bar.mod===undefined and every
// session-end check silently went false, which is exactly what broke T6/T9 until this fix.
function bar(hhmm, high, low, close, dateStr = '2026-08-17') {
  const [hh, mm] = hhmm.split(':').map(Number);
  return { ts: `${dateStr} ${hhmm}:00`, mod: hh * 60 + mm, high, low, close };
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

// ── Globex tests (added 2026-08-30, user-flagged real trade id 109426, a PD_POC_FADE_SHORT
// fired at 18:00 ET whose wider-target counterfactual came back "no_bar_data"). Before this
// fix, isSessionEnd was computed as `bar.ts.slice(11,13) >= '16'` with no knowledge of the
// trade's own origin session -- a bar fired at 18:00 ET already has hour 18 >= 16, so the VERY
// FIRST bar of ANY Globex-hour fire was immediately treated as session-end, permanently
// blocking this mechanism from ever arming on an overnight trade (confirmed empirically: no
// real Globex-hour fire has ever armed wider_target_mult, table-wide). These tests prove the
// fix, not just that the RTH regression tests above still pass.

// ── Test 13 (Globex): a trade fired at 18:00 ET hits T1 fast (bar 1) and must ARM widening.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4, firedMod: 18 * 60 };
  const b = bar('18:01', 20065, 20050, 20060);
  const step = stepWiderTarget({ widening: false }, b, { ...params, barCount: 1 });
  assertEqual(step.resolution, null, 'T13 (Globex): fast T1 hit at 18:01 arms widening instead of resolving immediately');
  assert(step.state.widening, 'T13 (Globex): widening state correctly arms for a Globex-hour fire');
}

// ── Test 14 (Globex): once armed, the walk must continue through the evening without
// prematurely marking to market -- neither the wider target nor the stop is hit at 23:30.
{
  const params = { entry: 20000, stop: 20000 - 40, widerTarget: 20000 + 90, long: true, firedMod: 18 * 60 };
  const b = bar('23:30', 20070, 20060, 20065, '2026-08-17');
  const step = stepWiderTarget({ widening: true }, b, { ...params, t1: 20000 + 60, barCount: 30 });
  assertEqual(step.resolution, null, 'T14 (Globex): armed overnight trade stays open mid-session, does not falsely mark-to-market');
}

// ── Test 15 (Globex): once the NEXT RTH open (9:30am ET, following calendar day) arrives with
// the wider target still unhit, the trade correctly marks to market -- proving the session-end
// boundary is judged against the trade's OWN origin session, not a blanket RTH-only cutoff.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, firedMod: 18 * 60 };
  const b = bar('09:31', 20070, 20060, 20065, '2026-08-18');
  const step = stepWiderTarget({ widening: true }, b, { ...params, barCount: 200 });
  assertEqual(step.resolution, { resolution: 'TIME_EXPIRED', method: 'WIDER_TIME_EXPIRED', priceAtRes: 20065 }, 'T15 (Globex): marks to market at the NEXT RTH open, not immediately at fire time');
}

// ── Test 16 (Globex regression guard): the same fired-at-18:00 setup, checked against a quiet
// bar at 18:01 with no T1/stop hit -- proves bar.mod (1081) does NOT trigger session-end now,
// where the old `hour>=16` check would have marked-to-market immediately.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, firedMod: 18 * 60 };
  const b = bar('18:01', 19995, 19990, 19992);
  const step = stepWiderTarget({ widening: false }, b, { ...params, barCount: 1 });
  assertEqual(step.resolution, null, 'T16 (Globex regression guard): a quiet bar at 18:01 does not falsely mark-to-market the way the pre-fix hour>=16 check would have');
}

// ── Tests 17-20 (added 2026-08-30, DeepSeek code review round 2, finding R8): T13-T16 above
// only ever exercise firedMod=1080 (18:00 exactly). Nothing covered the 4-6pm dead zone (R3's
// fix) or an early-morning Globex fire (R4's fix), and nothing asserted firedAtToMod()'s new
// type guard (R7). These close that gap.

// ── Test 17 (dead zone): a trade fired at 16:10 ET (firedMod=970, inside the POST_RTH dead
// zone) must NOT instantly mark-to-market on its own fire bar -- before the R3 fix,
// firedMod=970 fell through to the RTH branch (`barMod>=960`), and since 970>=960 is already
// true, isSessionEnd fired on bar 1 itself.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4, firedMod: 970 };
  const b = bar('16:11', 20065, 20050, 20060);
  const step = stepWiderTarget({ widening: false }, b, { ...params, barCount: 1 });
  assertEqual(step.resolution, null, 'T17 (dead zone): fast T1 hit at 16:11 (fired 16:10) arms widening instead of instantly marking-to-market');
  assert(step.state.widening, 'T17 (dead zone): widening state correctly arms for a dead-zone fire');
  assert(!isPastMechanismSessionEnd(970, 970), 'T17b: isPastMechanismSessionEnd is false on the dead-zone trade\'s own fire-time bar');
  assert(isPastMechanismSessionEnd(570, 970), 'T17c: a dead-zone-origin trade DOES mark session-end once the next RTH open (9:30am) arrives');
}

// ── Test 18 (early-morning Globex): a trade fired at 03:20 ET (firedMod=200) has its next RTH
// open LATER THE SAME calendar day (9:30am), not the following day -- the walker itself is
// date-agnostic (only acd.js's date arithmetic, fixed separately as R4, needs the calendar-day
// distinction), so this just confirms isFiredInRTH/isPastMechanismSessionEnd route an
// early-morning firedMod through the same "next RTH open" rule as an evening one.
{
  assert(!isFiredInRTH(200), 'T18a: firedMod=200 (03:20 ET) is correctly NOT classified RTH-origin');
  assert(!isPastMechanismSessionEnd(569, 200), 'T18b: bar at 09:29 is still before the next RTH open for a 03:20 fire');
  assert(isPastMechanismSessionEnd(570, 200), 'T18c: bar at 09:30 correctly marks session-end for a 03:20 fire');
}

// ── Test 19 (R2 regression guard): the evening-bar-numerically-larger-than-570 case DeepSeek's
// review specifically flagged -- an 18:01 ET bar (mod=1081) on a Globex-origin trade must NOT
// read as session-end, proving the `barMod<960` upper bound in isPastMechanismSessionEnd is
// load-bearing, not dead code.
{
  assert(!isPastMechanismSessionEnd(1081, 1080), 'T19: an 18:01 ET bar does not falsely mark session-end for an 18:00-fired trade');
}

// ── Test 20 (R7 guard): firedAtToMod() must throw on a UTC-ISO-suffixed string rather than
// silently misparsing it as naive ET wall-clock text.
{
  let threw = false;
  try { firedAtToMod('2026-08-17T22:01:00.000Z'); } catch (e) { threw = true; }
  assert(threw, 'T20: firedAtToMod() throws on a Z-suffixed UTC ISO string instead of silently misparsing it');
  assertEqual(firedAtToMod('2026-08-17 22:01:00'), 22 * 60 + 1, 'T20b: firedAtToMod() still parses the standard naive ET text convention correctly');
}

// ── Test 21 (2026-08-31, OPEN_DECISION wider_target_pressure_gate_fails_open_on_null_reading):
// a calibrated threshold IS supplied, but the reading itself is null (missing aggressor-volume
// data, e.g. bid_volume/ask_volume both DEFAULT 0 -> totalVol<=0 at the live call site) -- must
// now fail CLOSED (bank, do not arm), not fail open the way it used to.
{
  const params = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4, pressureThreshold: 0.10 };
  const b = barVol('09:31', 20065, 20050, 20060, 0, 0); // no volume ingested -> pressureReading null at the live call site
  const step = stepWiderTarget({ widening: false }, b, { ...params, barCount: 1, pressureReading: null });
  assertEqual(step.resolution, { resolution: 'TARGET_HIT', method: 'BANKED_LOW_PRESSURE', priceAtRes: 20060 }, 'T21: a missing pressure reading (threshold set) banks immediately, does not arm');
  assert(!step.state.widening, 'T21: does not arm when the pressure reading is null despite a calibrated threshold existing');
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
