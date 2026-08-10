// Backtests the "Morning high pulled back / Morning low bounced" V-pattern card shown
// live in server/routes/antigravityEdges.js. Found 2026-07-13: hardcoded pct:73, n:338
// with no computation behind it — 5th instance of this pattern found in this file this
// session. Writes the real historical rate into performance_audit under
// signal_type='SESSION_BIAS' (signal_name SB_V_PATTERN_LONG / SB_V_PATTERN_SHORT) so
// the existing sbQ fetch in antigravityEdges.js picks it up without touching its
// Promise.all ordering.
//
// Definition matches the live detection exactly:
//   - First-30 window = bars with et_min in [570, 595] (9:30-9:55 ET).
//   - fmove = close of last first-30 bar minus its open. Only days with |fmove| >= 10pt
//     qualify.
//   - Pullback level = 25% retracement from the first-30 extreme back toward the open.
//   - "Pulled back" = any bar in [600, 719] (10:00-11:59 ET) touches the pullback level.
//   - "Re-extends" = after the pullback bar, price later trades beyond the first-30
//     extreme (high for an up-move, low for a down-move) before 12:00 ET. No lookahead
//     concern — this is an offline backtest computing a historical rate, not a live
//     decision using future data.

import { query } from '../server/db.js';

const MIN_N = 20;

const { rows } = await query(`
  SELECT
    (ts AT TIME ZONE 'America/New_York')::date AS td,
    (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60 +
     EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York'))::int AS et_min,
    open::float, high::float, low::float, close::float
  FROM price_bars_primary
  WHERE symbol = 'NQ'
    AND (ts AT TIME ZONE 'America/New_York')::date < CURRENT_DATE
    AND (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60 +
         EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 719
  ORDER BY td, et_min
`);

const byDay = new Map();
for (const r of rows) {
  if (!byDay.has(r.td)) byDay.set(r.td, []);
  byDay.get(r.td).push(r);
}

console.log(`Loaded ${byDay.size} trading days of 9:30-11:59 bars\n`);

let longN = 0, longExtend = 0, shortN = 0, shortExtend = 0;

for (const [, bars] of byDay) {
  const fhm30 = bars.filter(b => b.et_min >= 570 && b.et_min <= 595);
  const postBars = bars.filter(b => b.et_min > 599 && b.et_min < 720);
  if (fhm30.length < 4 || postBars.length < 2) continue;

  const open930 = fhm30[0].open;
  const fhHigh  = Math.max(...fhm30.map(b => b.high));
  const fhLow   = Math.min(...fhm30.map(b => b.low));
  const close10 = fhm30[fhm30.length - 1].close;
  const fmove   = close10 - open930;
  if (Math.abs(fmove) < 10) continue;

  const isUp = fmove > 0;
  const pbLevel = isUp
    ? fhHigh - (fhHigh - open930) * 0.25
    : fhLow  + (open930 - fhLow)  * 0.25;

  let pbIdx = -1;
  for (let i = 0; i < postBars.length; i++) {
    const b = postBars[i];
    if ((isUp && b.low <= pbLevel) || (!isUp && b.high >= pbLevel)) { pbIdx = i; break; }
  }
  if (pbIdx === -1) continue; // no pullback seen — card wouldn't fire this day

  const after = postBars.slice(pbIdx + 1);
  const reExtended = isUp
    ? after.some(b => b.high >= fhHigh)
    : after.some(b => b.low  <= fhLow);

  if (isUp) { longN++; if (reExtended) longExtend++; }
  else      { shortN++; if (reExtended) shortExtend++; }
}

const longPct  = longN  >= MIN_N ? Math.round(1000 * longExtend  / longN)  / 10 : null;
const shortPct = shortN >= MIN_N ? Math.round(1000 * shortExtend / shortN) / 10 : null;

console.log(`Morning high pulled back (LONG re-entry): N=${longN}  re-extend=${longPct}%`);
console.log(`Morning low bounced (SHORT re-entry):      N=${shortN}  re-extend=${shortPct}%`);

const today = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;

await query(`DELETE FROM performance_audit WHERE signal_type='SESSION_BIAS' AND signal_name IN ('SB_V_PATTERN_LONG','SB_V_PATTERN_SHORT')`);

if (longPct != null) {
  await query(`
    INSERT INTO performance_audit (signal_type, signal_name, recommendation, win_rate, sample_size, run_date, window_days, notes)
    VALUES ('SESSION_BIAS','SB_V_PATTERN_LONG','LONG',$1,$2,$3,$4,$5)
  `, [longPct / 100, longN, today, longN, JSON.stringify({
    label: 'Morning high pulled back',
    action: `Look for re-entry in the morning direction — ${longPct}% chance it re-extends past the first-hour extreme before noon, historically.`,
  })]);
  console.log('  Wrote SB_V_PATTERN_LONG');
} else {
  console.log(`  SKIP SB_V_PATTERN_LONG — only N=${longN} (need >=${MIN_N})`);
}

if (shortPct != null) {
  await query(`
    INSERT INTO performance_audit (signal_type, signal_name, recommendation, win_rate, sample_size, run_date, window_days, notes)
    VALUES ('SESSION_BIAS','SB_V_PATTERN_SHORT','SHORT',$1,$2,$3,$4,$5)
  `, [shortPct / 100, shortN, today, shortN, JSON.stringify({
    label: 'Morning low bounced',
    action: `Look for re-entry in the morning direction — ${shortPct}% chance it re-extends past the first-hour extreme before noon, historically.`,
  })]);
  console.log('  Wrote SB_V_PATTERN_SHORT');
} else {
  console.log(`  SKIP SB_V_PATTERN_SHORT — only N=${shortN} (need >=${MIN_N})`);
}

process.exit(0);
