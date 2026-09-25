// Synthetic-price-path proof for the T1-floor runner mechanism (2026-09-25). Exercises
// server/services/t1FloorRunnerWalker.js's stepT1FloorRunner()/t1FloorPnlFromResolution()
// directly -- the SAME functions server/services/resolveSetups.js calls live -- so a pass here
// is proof about the live code path itself, not a separate simulation.
//
// Run: node scripts/test_t1floor_runner_walker_synthetic.mjs

import { stepT1FloorRunner, t1FloorPnlFromResolution } from '../server/services/t1FloorRunnerWalker.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

function bar(hhmm, high, low, close, dateStr = '2026-09-25') {
  const [hh, mm] = hhmm.split(':').map(Number);
  return { ts: `${dateStr} ${hhmm}:00`, mod: hh * 60 + mm, high, low, close };
}

function walk(bars, params) {
  let state = {};
  for (const b of bars) {
    const step = stepT1FloorRunner(state, b, params);
    state = step.state;
    if (step.resolution) return step.resolution;
  }
  return null;
}

const RTH_FIRED_MOD = 630; // 10:30 ET

// T1: runner target hit -- long, entry=100, t1=110, ft=115 (1.5x*10=15, entry+15=115). Bar 2's
// low (110.5) stays ABOVE t1 so this isolates a clean ft hit with no same-bar floor conflict.
{
  const bars = [bar('10:31', 111, 110.5, 111), bar('10:32', 116, 110.5, 116)];
  const r = walk(bars, { t1: 110, ft: 115, long: true, firedMod: RTH_FIRED_MOD });
  assert(r?.resolution === 'TARGET_HIT' && r?.method === 'T1_FLOOR_RUNNER_HIT' && r?.priceAtRes === 115, 'T1: runner target hit');
}

// T2: floor hit (pullback all the way back to t1) before ever reaching ft -- long
{
  const bars = [bar('10:31', 112, 111, 112), bar('10:32', 111, 109.5, 110)]; // low=109.5 <= t1=110
  const r = walk(bars, { t1: 110, ft: 115, long: true, firedMod: RTH_FIRED_MOD });
  assert(r?.resolution === 'TARGET_HIT' && r?.method === 'T1_FLOOR_HIT' && r?.priceAtRes === 110, 'T2: floor hit, long');
}

// T3: floor hit, short direction -- entry=100, t1=90, ft=85
{
  const bars = [bar('10:31', 89, 87, 88), bar('10:32', 90.5, 88, 90)]; // high=90.5 >= t1=90
  const r = walk(bars, { t1: 90, ft: 85, long: false, firedMod: RTH_FIRED_MOD });
  assert(r?.resolution === 'TARGET_HIT' && r?.method === 'T1_FLOOR_HIT' && r?.priceAtRes === 90, 'T3: floor hit, short');
}

// T4: same-bar conflict (floor AND ft both touched in one bar) -- floor wins (conservative,
// matches every other walker's own stop-first-on-conflict convention)
{
  const bars = [bar('10:31', 116, 109, 112)]; // low=109<=t1=110, high=116>=ft=115
  const r = walk(bars, { t1: 110, ft: 115, long: true, firedMod: RTH_FIRED_MOD });
  assert(r?.resolution === 'TARGET_HIT' && r?.method === 'T1_FLOOR_HIT' && r?.priceAtRes === 110, 'T4: same-bar conflict resolves floor-first');
}

// T5: session end before either floor or ft is touched -- MTM at close, price ABOVE t1 (a real
// partial-runner gain, no floor override needed since the raw MTM already beats the floor).
// mod>=960 (16:00 ET) is required to trigger isPastMechanismSessionEnd for an RTH-origin trade.
{
  const bars = [bar('15:58', 112, 111, 112), bar('16:00', 113, 111.5, 112.5)];
  const r = walk(bars, { t1: 110, ft: 115, long: true, firedMod: RTH_FIRED_MOD });
  assert(r?.resolution === 'TIME_EXPIRED' && r?.method === 'T1_FLOOR_MARK_TO_MARKET' && r?.priceAtRes === 112.5, 'T5: session-end MTM above floor');
  const pnl = t1FloorPnlFromResolution(r, { entry: 100, t1: 110, long: true, dollarsPerPoint: 2, commission: 2 });
  const rawPnl = (112.5 - 100) * 2 - 2; // 23
  assert(Math.abs(pnl - rawPnl) < 0.001, 'T5: floor guarantee is a no-op when raw MTM already beats it');
}

// T6: session end where the MTM close itself sits BELOW t1 (intrabar-only excursion below the
// floor that never triggered stepT1FloorRunner's own low/high check because it never printed a
// low/high AT or past t1 -- exercises t1FloorPnlFromResolution's defensive floor directly)
{
  const r = { resolution: 'TIME_EXPIRED', method: 'T1_FLOOR_MARK_TO_MARKET', priceAtRes: 109.9 }; // hypothetical: below t1=110
  const pnl = t1FloorPnlFromResolution(r, { entry: 100, t1: 110, long: true, dollarsPerPoint: 2, commission: 2 });
  const floorPnl = (110 - 100) * 2 - 2; // 18
  assert(Math.abs(pnl - floorPnl) < 0.001, 'T6: floor guarantee overrides a below-floor MTM close');
}

// T7: never resolves within the given bars (still open) -- returns null resolution
{
  const bars = [bar('10:31', 112, 111, 112)];
  const r = walk(bars, { t1: 110, ft: 115, long: true, firedMod: RTH_FIRED_MOD });
  assert(r === null, 'T7: unresolved within given bars returns null');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
