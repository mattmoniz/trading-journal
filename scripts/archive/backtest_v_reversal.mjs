// Backtest: V-reversal by noon — bar-by-bar sequence detection
// Q: If morning makes a directional move, then pulls back ≥38%, how often does it
// re-extend past the first-hour extreme before noon?
// Direction-agnostic. We measure pattern completion probability, not bias.

import { query } from '../server/db.js';

// Fetch all 5-min bars from 9:30 (570) to noon (720) per day
const { rows: bars } = await query(`
  SELECT
    (ts AT TIME ZONE 'America/New_York')::date AS td,
    EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60 +
    EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') AS et_min,
    open::float, high::float, low::float, close::float
  FROM price_bars_primary
  WHERE symbol = 'NQ'
    AND (ts AT TIME ZONE 'America/New_York')::date < CURRENT_DATE
    AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60 +
        EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 719
  ORDER BY td, et_min
`);

console.log(`Loaded ${bars.length} bars across all days\n`);

// Group by day
const byDay = new Map();
for (const bar of bars) {
  if (!byDay.has(bar.td)) byDay.set(bar.td, []);
  byDay.get(bar.td).push(bar);
}

const MIN_MOVE = 10; // NQ points — minimum first-hour move to be directional
const PULLBACK_PCT = 0.38; // 38% pullback of first move triggers "reversal detected"

let upReversal = 0, upVComplete = 0;
let downReversal = 0, downVComplete = 0;
let noReversal = 0, flatMorning = 0;
let sampleDays = 0;

for (const [td, dayBars] of byDay) {
  // First-hour bars: 9:30 (570) to 9:55 (595) = 6 bars
  const firstHourBars = dayBars.filter(b => b.et_min >= 570 && b.et_min <= 595);
  const restBars      = dayBars.filter(b => b.et_min > 595);

  if (firstHourBars.length < 4 || restBars.length < 4) continue;
  sampleDays++;

  const open930    = firstHourBars[0].open;
  const fhHigh     = Math.max(...firstHourBars.map(b => b.high));
  const fhLow      = Math.min(...firstHourBars.map(b => b.low));
  const close1000  = firstHourBars[firstHourBars.length - 1].close;
  const firstMove  = close1000 - open930;

  if (Math.abs(firstMove) < MIN_MOVE) { flatMorning++; continue; }

  const pullbackLevel = firstMove > 0
    ? fhHigh - (fhHigh - open930) * PULLBACK_PCT   // UP: how far down is a 38% pullback?
    : fhLow  + (open930 - fhLow)  * PULLBACK_PCT;   // DOWN: how far up is a 38% bounce?

  // Walk through post-first-hour bars in sequence
  // State machine: looking for pullback, then looking for re-extension
  let pullbackSeen    = false;
  let vCompleteSeen   = false;
  let pullbackBarIdx  = -1;

  for (let i = 0; i < restBars.length; i++) {
    const bar = restBars[i];

    if (!pullbackSeen) {
      // Check if this bar pulled back to the pullback level
      if (firstMove > 0 && bar.low  <= pullbackLevel) { pullbackSeen = true; pullbackBarIdx = i; }
      if (firstMove < 0 && bar.high >= pullbackLevel) { pullbackSeen = true; pullbackBarIdx = i; }
    }

    if (pullbackSeen && i > pullbackBarIdx) {
      // After the pullback, check if price re-extended past the first-hour extreme
      if (firstMove > 0 && bar.high >= fhHigh) { vCompleteSeen = true; break; }
      if (firstMove < 0 && bar.low  <= fhLow)  { vCompleteSeen = true; break; }
    }
  }

  if (!pullbackSeen) {
    noReversal++;
  } else if (firstMove > 0) {
    upReversal++;
    if (vCompleteSeen) upVComplete++;
  } else {
    downReversal++;
    if (vCompleteSeen) downVComplete++;
  }
}

const totalReversal = upReversal + downReversal;
const totalV        = upVComplete + downVComplete;

console.log(`=== V-REVERSAL STAT (38% pullback of first-hour move, bar-by-bar) ===`);
console.log(`Days analyzed: ${sampleDays}  |  Flat mornings skipped: ${flatMorning}`);
console.log(`No reversal (continued straight): ${noReversal}`);
console.log(``);
console.log(`UP mornings: reversal=${upReversal}  →  V-complete (re-exceeded first-hour high by noon): ${upVComplete}  (${Math.round(100*upVComplete/Math.max(upReversal,1))}%)`);
console.log(`DOWN mornings: reversal=${downReversal}  →  V-complete (re-breached first-hour low by noon): ${downVComplete}  (${Math.round(100*downVComplete/Math.max(downReversal,1))}%)`);
console.log(``);
console.log(`COMBINED: ${totalReversal} reversal days → ${totalV} V-completions (${Math.round(100*totalV/Math.max(totalReversal,1))}%) by noon`);

// Also try 25% and 50% pullback thresholds
for (const pct of [0.25, 0.50]) {
  let u = 0, uV = 0, d = 0, dV = 0;
  for (const [td, dayBars] of byDay) {
    const firstHourBars = dayBars.filter(b => b.et_min >= 570 && b.et_min <= 595);
    const restBars      = dayBars.filter(b => b.et_min > 595);
    if (firstHourBars.length < 4 || restBars.length < 4) continue;
    const open930 = firstHourBars[0].open;
    const fhHigh  = Math.max(...firstHourBars.map(b => b.high));
    const fhLow   = Math.min(...firstHourBars.map(b => b.low));
    const fmove   = firstHourBars[firstHourBars.length - 1].close - open930;
    if (Math.abs(fmove) < MIN_MOVE) continue;
    const pl = fmove > 0 ? fhHigh - (fhHigh - open930) * pct : fhLow + (open930 - fhLow) * pct;
    let pbSeen = false, vcSeen = false, pbIdx = -1;
    for (let i = 0; i < restBars.length; i++) {
      const bar = restBars[i];
      if (!pbSeen) {
        if (fmove > 0 && bar.low  <= pl) { pbSeen = true; pbIdx = i; }
        if (fmove < 0 && bar.high >= pl) { pbSeen = true; pbIdx = i; }
      }
      if (pbSeen && i > pbIdx) {
        if (fmove > 0 && bar.high >= fhHigh) { vcSeen = true; break; }
        if (fmove < 0 && bar.low  <= fhLow)  { vcSeen = true; break; }
      }
    }
    if (pbSeen) {
      if (fmove > 0) { u++; if (vcSeen) uV++; }
      else           { d++; if (vcSeen) dV++; }
    }
  }
  const tot = u + d, totV = uV + dV;
  console.log(`Pullback ${Math.round(pct*100)}%: UP=${u}→${uV}(${Math.round(100*uV/Math.max(u,1))}%)  DOWN=${d}→${dV}(${Math.round(100*dV/Math.max(d,1))}%)  COMBINED=${tot}→${totV}(${Math.round(100*totV/Math.max(tot,1))}%)`);
}

process.exit(0);
