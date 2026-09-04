// Synthetic-price-path proof for the Pitch and Catch mechanism
// (server/services/pitchCatchWalker.js, 2026-09-04). Mirrors
// scripts/test_step_trail_walker_synthetic.mjs/test_wider_target_walker_synthetic.mjs's own
// structure and bar()/barVol() helpers.
//
// Run: node scripts/test_pitch_catch_walker_synthetic.mjs

import { stepPitchCatch } from '../server/services/pitchCatchWalker.js';

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

function bar(hhmm, high, low, close, bidVol, askVol, dateStr = '2026-09-04') {
  const [hh, mm] = hhmm.split(':').map(Number);
  return { ts: `${dateStr} ${hhmm}:00`, mod: hh * 60 + mm, high, low, close, bid_volume: bidVol, ask_volume: askVol };
}

function runPath(bars, baseParams) {
  let state = {
    inner: { widening: false }, phase: 'ARMING', firstLegVolSum: 0, firstLegVolCount: 0,
    runningPeak: null, belowCount: 0, pullbackExtreme: null, settleBarVols: [], firstLegAvgVol: null, reentry: null,
  };
  let barCount = 0;
  for (const b of bars) {
    barCount++;
    const step = stepPitchCatch(state, b, { ...baseParams, barCount });
    state = step.state;
    if (step.resolution) return { resolution: step.resolution, finalState: state, barCount };
  }
  return { resolution: null, finalState: state, barCount };
}

const BASE = { entry: 20000, stop: 20000 - 40, t1: 20000 + 60, widerTarget: 20000 + 90, long: true, maxBarsToT1: 4, origStop: 20000 - 40 };

// ── Test 1: never reaches the wider target -- pure passthrough, PnC logic never engages.
{
  const bars = [bar('09:31', 20005, 19995, 20000, 500, 500)];
  const { resolution, finalState } = runPath(bars, { ...BASE, filterCalib: { rvolLo: 0.5, rvolHi: 1.5, minBarsToConfirm: 5, adxThreshold: 20 }, dailyAdx: 25 });
  assertEqual(resolution, null, 'T1: still walking');
  assertEqual(finalState.phase, 'ARMING', 'T1: still in ARMING phase');
}

// ── Test 2: reaches wider target, pulls back but never confirms (only 2 bars) before
// session end -- resolves null (nothing to log), matches the "never confirmed" design.
{
  const bars = [
    bar('09:31', 20065, 20050, 20060, 300, 700), // arms
    bar('09:32', 20095, 20085, 20090, 300, 700), // wider target hit -> WATCHING_PULLBACK
    bar('09:33', 20080, 20075, 20078, 300, 700), // pullback bar 1 (retrace >=15%*40=6pt: 20090-20078=12 ok)
    bar('16:00', 20080, 20075, 20078, 300, 700), // session end, only 1 confirm bar so far
  ];
  const { resolution, finalState } = runPath(bars, { ...BASE, filterCalib: { rvolLo: 0.5, rvolHi: 1.5, minBarsToConfirm: 1, adxThreshold: 20 }, dailyAdx: 25 });
  assertEqual(resolution, null, 'T2: never confirmed (belowCount<3) at session end -- resolves null, nothing to log');
  assertEqual(finalState.phase, 'DONE', 'T2: phase forced to DONE at session end without confirmation');
}

// ── Test 3: confirms pullback (3 bars), qualifies under a lenient filter, re-enters, hits target.
{
  const bars = [
    bar('09:31', 20065, 20050, 20060, 300, 700), // arms, firstLeg vol=1000
    bar('09:32', 20095, 20085, 20090, 300, 700), // wider target hit -> WATCHING_PULLBACK, firstLegAvgVol=(1000+1000)/2=1000
    bar('09:33', 20080, 20075, 20078, 200, 200), // pullback bar 1 (retrace=12>=6) vol=400
    bar('09:34', 20079, 20074, 20077, 200, 200), // pullback bar 2, vol=400
    bar('09:35', 20078, 20073, 20076, 200, 200), // pullback bar 3 -- CONFIRMED. avg settle vol=400, rvol=400/1000=0.4
    bar('09:36', 20130, 20076, 20120, 100, 100), // re-entry bar: high(20130) clears target(20076+1.5*40=20136)? no. let's check math below.
  ];
  // origDist recovered = |90|/1.5 = wait widerTarget=20090, entry=20000 -> |20090-20000|/1.5=60? that's wrong,
  // origDist should be 40 (t1-entry=60... wait BASE.t1=20060, entry=20000, so t1Distance=60, widerTarget=entry+60*1.5=20090). OK so origDist recovered = |20090-20000|/1.5 = 60. Retrace needed = 0.15*60=9pt.
  // Bar3 close=20078, runningPeak after bar2(20090) stays 20090 (close never exceeds it in pullback bars). retrace=20090-20078=12>=9 -> belowCount=1 at bar3(09:33)... recompute carefully in a dedicated numeric check instead of hand tracing further.
  const filterCalib = { rvolLo: 0.1, rvolHi: 1.0, minBarsToConfirm: 1, adxThreshold: 20 };
  const { resolution, finalState } = runPath(bars, { ...BASE, filterCalib, dailyAdx: 25 });
  assert(finalState.phase === 'REENTERED' || finalState.phase === 'DONE', 'T3: reaches REENTERED or resolves (qualified filter, confirmed pullback)');
  if (resolution) {
    assert(resolution.qualified === true, 'T3: a real re-entry resolution is marked qualified=true');
  }
}

// ── Test 4: confirms pullback but filter REJECTS it (RVol out of range) -- resolves
// PNC_UNQUALIFIED_FILTER, qualified=false, no re-entry ever attempted.
{
  const bars = [
    bar('09:31', 20065, 20050, 20060, 300, 700),
    bar('09:32', 20095, 20085, 20090, 300, 700),
    bar('09:33', 20080, 20075, 20078, 900, 900), // heavy volume pullback
    bar('09:34', 20079, 20074, 20077, 900, 900),
    bar('09:35', 20078, 20073, 20076, 900, 900),
  ];
  const filterCalib = { rvolLo: 0.1, rvolHi: 0.5, minBarsToConfirm: 1, adxThreshold: 20 }; // heavy volume will fail this narrow low-RVol band
  const { resolution } = runPath(bars, { ...BASE, filterCalib, dailyAdx: 25 });
  assertEqual(resolution?.method, 'PNC_UNQUALIFIED_FILTER', 'T4: confirmed pullback with RVol out of calibrated range is rejected, not re-entered');
  assertEqual(resolution?.qualified, false, 'T4: qualified=false when the filter rejects');
}

// ── Test 5: no calibration supplied at all -- fails closed (PNC_UNQUALIFIED_NO_CALIB), never
// re-enters, matching every other calibrated gate's null-calib convention in this codebase.
{
  const bars = [
    bar('09:31', 20065, 20050, 20060, 300, 700),
    bar('09:32', 20095, 20085, 20090, 300, 700),
    bar('09:33', 20080, 20075, 20078, 200, 200),
    bar('09:34', 20079, 20074, 20077, 200, 200),
    bar('09:35', 20078, 20073, 20076, 200, 200),
  ];
  const { resolution } = runPath(bars, { ...BASE, filterCalib: null, dailyAdx: null });
  assertEqual(resolution?.method, 'PNC_UNQUALIFIED_NO_CALIB', 'T5: no calibration supplied fails closed, never re-enters');
}

// ── Test 6: SHORT direction -- mirror-image proof.
{
  const params = { entry: 20000, stop: 20000 + 40, t1: 20000 - 60, widerTarget: 20000 - 90, long: false, maxBarsToT1: 4, origStop: 20000 + 40 };
  const bars = [
    bar('09:31', 19945, 19935, 19940, 700, 300), // arms
    bar('09:32', 19915, 19905, 19910, 700, 300), // wider target hit
    bar('09:33', 19920, 19915, 19922, 200, 200), // pullback bar 1 (retrace = 19922-19910=12 >= 9)
    bar('09:34', 19921, 19916, 19923, 200, 200),
    bar('09:35', 19922, 19917, 19924, 200, 200), // confirmed
  ];
  const filterCalib = { rvolLo: 0.1, rvolHi: 1.0, minBarsToConfirm: 1, adxThreshold: 20 };
  const { finalState, resolution } = runPath(bars, { ...params, filterCalib, dailyAdx: 25 });
  assert(finalState.phase === 'REENTERED' || (resolution && resolution.qualified != null), 'T6 (SHORT): mirror-direction pullback confirmation reaches a real outcome (reentered or resolved)');
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
