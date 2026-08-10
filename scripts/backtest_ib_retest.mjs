// Backtests the "IB HIGH/LOW re-tested after 10:30am" cards shown live in
// server/routes/antigravityEdges.js. Those cards used to hardcode pct/n literals
// (found 2026-07-13, same fabricated-stat issue as SESSION_BIAS_ROWS in
// mine_session_bias.mjs). This computes the real historical rate and writes it into
// performance_audit under signal_type='SESSION_BIAS' with signal_name
// SB_IB_HIGH_RETEST / SB_IB_LOW_RETEST, so the existing sbQ fetch in
// antigravityEdges.js (already SELECTs signal_type='SESSION_BIAS') picks them up with
// no change needed to that file's Promise.all ordering.
//
// Touch/resolution definition mirrors the live detection in antigravityEdges.js as
// closely as a forward-resolving backtest allows:
//   - IB = high/low extremes over bars with et_min in [570, 629] (9:30-10:29 ET),
//     matching the live code's Math.max/min over ibBars, NOT the close-based
//     ib_max_close/ib_min_close used elsewhere in this codebase for IB-break checks.
//   - Touch = first post-10:30 bar whose high (for IB HIGH) enters [ibHigh-3, ibHigh+15],
//     or whose low (for IB LOW) enters [ibLow-15, ibLow+3] — same tolerance/band as live.
//   - Resolution = looking at the 6 bars strictly after the touch bar (~30min, same
//     window size the live code uses for its rolling touch check): RETRACE if price
//     never closes beyond level+/-5 in that window, BREAK if it does. No lookahead
//     concern here — this is an offline backtest computing a historical rate, not a
//     live decision using future data.

import { query } from '../server/db.js';

const MIN_N = 20;

const { rows } = await query(`
  SELECT
    (ts AT TIME ZONE 'America/New_York')::date AS td,
    (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60 +
     EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York'))::int AS et_min,
    high::float, low::float, close::float
  FROM price_bars_primary
  WHERE symbol = 'NQ'
    AND (ts AT TIME ZONE 'America/New_York')::date < CURRENT_DATE
    AND (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60 +
         EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 959
  ORDER BY td, et_min
`);

const byDay = new Map();
for (const r of rows) {
  if (!byDay.has(r.td)) byDay.set(r.td, []);
  byDay.get(r.td).push(r);
}

console.log(`Loaded ${byDay.size} trading days of RTH bars\n`);

function classify(bars, level, isHigh) {
  const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min <= 629);
  const postIB = bars.filter(b => b.et_min > 630);
  if (ibBars.length < 4 || postIB.length < 1) return null;

  const tol = 3, band = 15, breakBuffer = 5;
  for (let i = 0; i < postIB.length; i++) {
    const b = postIB[i];
    const touched = isHigh
      ? (b.high >= level - tol && b.high <= level + band)
      : (b.low  <= level + tol && b.low  >= level - band);
    if (!touched) continue;

    // Resolve using the next 6 bars strictly after the touch (forward-looking backtest,
    // not a live decision — see file header).
    const window = postIB.slice(i + 1, i + 7);
    if (window.length < 3) return null; // not enough bars left in the session to resolve
    const broke = isHigh
      ? window.some(w => w.close >= level + breakBuffer)
      : window.some(w => w.close <= level - breakBuffer);
    return broke ? 'BREAK' : 'RETRACE';
  }
  return null; // no touch this day
}

let highN = 0, highRetrace = 0, lowN = 0, lowRetrace = 0;
for (const [, bars] of byDay) {
  const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min <= 629);
  if (ibBars.length < 4) continue;
  const ibHigh = Math.max(...ibBars.map(b => b.high));
  const ibLow  = Math.min(...ibBars.map(b => b.low));

  const hResult = classify(bars, ibHigh, true);
  if (hResult) { highN++; if (hResult === 'RETRACE') highRetrace++; }

  const lResult = classify(bars, ibLow, false);
  if (lResult) { lowN++; if (lResult === 'RETRACE') lowRetrace++; }
}

const highPct = highN >= MIN_N ? Math.round(1000 * highRetrace / highN) / 10 : null;
const lowPct  = lowN  >= MIN_N ? Math.round(1000 * lowRetrace  / lowN)  / 10 : null;

console.log(`IB HIGH re-test: N=${highN}  retrace=${highPct}%`);
console.log(`IB LOW  re-test: N=${lowN}   retrace=${lowPct}%`);

const today = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;

await query(`DELETE FROM performance_audit WHERE signal_type='SESSION_BIAS' AND signal_name IN ('SB_IB_HIGH_RETEST','SB_IB_LOW_RETEST')`);

if (highPct != null) {
  await query(`
    INSERT INTO performance_audit (signal_type, signal_name, recommendation, win_rate, sample_size, run_date, window_days, notes)
    VALUES ('SESSION_BIAS','SB_IB_HIGH_RETEST','SHORT',$1,$2,$3,$4,$5)
  `, [highPct / 100, highN, today, highN, JSON.stringify({
    label: 'IB HIGH re-tested after 10:30am',
    action: `${highPct}% of IB HIGH re-tests retrace (pull back from the level) within ~30min. ${(100 - highPct).toFixed(1)}% break through.`,
  })]);
  console.log('  Wrote SB_IB_HIGH_RETEST');
} else {
  console.log(`  SKIP SB_IB_HIGH_RETEST — only N=${highN} (need >=${MIN_N})`);
}

if (lowPct != null) {
  await query(`
    INSERT INTO performance_audit (signal_type, signal_name, recommendation, win_rate, sample_size, run_date, window_days, notes)
    VALUES ('SESSION_BIAS','SB_IB_LOW_RETEST','SHORT',$1,$2,$3,$4,$5)
  `, [lowPct / 100, lowN, today, lowN, JSON.stringify({
    label: 'IB LOW re-tested after 10:30am',
    action: `${lowPct}% of IB LOW re-tests retrace (pull back from the level) within ~30min. ${(100 - lowPct).toFixed(1)}% break through.`,
  })]);
  console.log('  Wrote SB_IB_LOW_RETEST');
} else {
  console.log(`  SKIP SB_IB_LOW_RETEST — only N=${lowN} (need >=${MIN_N})`);
}

process.exit(0);
