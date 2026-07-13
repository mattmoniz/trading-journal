// Backtests the "Gapped UP/DOWN at open — gap fill target" card shown live in
// server/routes/antigravityEdges.js. Found 2026-07-13: that card hardcoded pct:72/62,
// n:29/21, and an entirely fictional "85% in last 30 days" drift claim with no
// computation behind any of it — third instance of this pattern found in the same file
// this session (after SESSION_BIAS_ROWS and the IB re-test cards). This computes the
// real historical gap-fill rate and writes it into performance_audit under
// signal_type='SESSION_BIAS' (signal_name SB_GAP_UP_FILL / SB_GAP_DOWN_FILL) so the
// existing sbQ fetch in antigravityEdges.js picks it up without touching its
// Promise.all ordering.
//
// Definition matches the live gate: gap = |open_930 - prior close_400| >= 8pt (the
// live threshold — an existing, separate hardcoded trigger-size choice, not touched
// here). Filled = any RTH bar (9:30-4:00) trades back through the prior close before
// end of session (low <= pc for gap-up, high >= pc for gap-down) — standard gap-fill
// definition, not just "closes there."

import { query } from '../server/db.js';

const MIN_N = 20;
const GAP_THRESHOLD = 8;

const { rows } = await query(`
  WITH et_bars AS (
    SELECT
      (ts AT TIME ZONE 'America/New_York')::date AS td,
      (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60 +
       EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York'))::int AS et_min,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol = 'NQ'
  ),
  daily AS (
    SELECT td,
      MAX(CASE WHEN et_min = 570 THEN open END) AS open_930,
      MAX(CASE WHEN et_min BETWEEN 959 AND 961 THEN close END) AS close_400
    FROM et_bars
    WHERE et_min BETWEEN 570 AND 959
    GROUP BY td
  )
  SELECT
    d.td::text AS trade_date,
    d.open_930,
    LAG(d.close_400) OVER (ORDER BY d.td) AS prior_close
  FROM daily d
  WHERE d.td < CURRENT_DATE AND d.open_930 IS NOT NULL AND d.close_400 IS NOT NULL
  ORDER BY d.td
`);

const { rows: barRows } = await query(`
  SELECT
    (ts AT TIME ZONE 'America/New_York')::date AS td,
    (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60 +
     EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York'))::int AS et_min,
    high::float, low::float
  FROM price_bars_primary
  WHERE symbol = 'NQ'
    AND (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') * 60 +
         EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 959
`);

const barsByDay = new Map();
for (const b of barRows) {
  const key = b.td.toISOString ? b.td.toISOString().slice(0, 10) : String(b.td);
  if (!barsByDay.has(key)) barsByDay.set(key, []);
  barsByDay.get(key).push(b);
}

let upN = 0, upFilled = 0, downN = 0, downFilled = 0;
for (const r of rows) {
  if (r.prior_close == null) continue;
  const gap = r.open_930 - r.prior_close;
  if (Math.abs(gap) < GAP_THRESHOLD) continue;
  const dayBars = barsByDay.get(r.trade_date) || [];
  if (!dayBars.length) continue;

  const isGapUp = gap > 0;
  const filled = isGapUp
    ? dayBars.some(b => b.low  <= r.prior_close)
    : dayBars.some(b => b.high >= r.prior_close);

  if (isGapUp) { upN++; if (filled) upFilled++; }
  else         { downN++; if (filled) downFilled++; }
}

const upPct   = upN   >= MIN_N ? Math.round(1000 * upFilled   / upN)   / 10 : null;
const downPct = downN >= MIN_N ? Math.round(1000 * downFilled / downN) / 10 : null;

console.log(`Gap UP:   N=${upN}   fill=${upPct}%`);
console.log(`Gap DOWN: N=${downN}  fill=${downPct}%`);

const today = new Date().toISOString().slice(0, 10);

await query(`DELETE FROM performance_audit WHERE signal_type='SESSION_BIAS' AND signal_name IN ('SB_GAP_UP_FILL','SB_GAP_DOWN_FILL')`);

if (upPct != null) {
  await query(`
    INSERT INTO performance_audit (signal_type, signal_name, recommendation, win_rate, sample_size, run_date, window_days, notes)
    VALUES ('SESSION_BIAS','SB_GAP_UP_FILL','SHORT',$1,$2,$3,$4,$5)
  `, [upPct / 100, upN, today, upN, JSON.stringify({
    label: 'Gap fill — gapped UP at open',
    action: `${upPct}% of gap-up opens (>=${GAP_THRESHOLD}pt) fill the gap before close, historically.`,
  })]);
  console.log('  Wrote SB_GAP_UP_FILL');
} else {
  console.log(`  SKIP SB_GAP_UP_FILL — only N=${upN} (need >=${MIN_N})`);
}

if (downPct != null) {
  await query(`
    INSERT INTO performance_audit (signal_type, signal_name, recommendation, win_rate, sample_size, run_date, window_days, notes)
    VALUES ('SESSION_BIAS','SB_GAP_DOWN_FILL','LONG',$1,$2,$3,$4,$5)
  `, [downPct / 100, downN, today, downN, JSON.stringify({
    label: 'Gap fill — gapped DOWN at open',
    action: `${downPct}% of gap-down opens (>=${GAP_THRESHOLD}pt) fill the gap before close, historically.`,
  })]);
  console.log('  Wrote SB_GAP_DOWN_FILL');
} else {
  console.log(`  SKIP SB_GAP_DOWN_FILL — only N=${downN} (need >=${MIN_N})`);
}

process.exit(0);
