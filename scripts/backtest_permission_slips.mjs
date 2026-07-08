// =============================================================================
// Permission slip mining: discovers which ACD signal combinations reliably bias
// the session direction, so the live "Permission Slip" banner stays fresh as N grows.
//
// Outcome: session closes in predicted direction = close_400 > open_930 (LONG)
//          or close_400 < open_930 (SHORT).
//
// Signals considered:
//   a_up_fired, c_up_confirmed, fh_dir=UP           → LONG bias
//   a_down_fired, c_down_confirmed, fh_dir=DOWN      → SHORT bias
//   day_type filter: TREND / BALANCE / TURBULENT / (any)
//
// Output: PERMISSION_SLIP rows in performance_audit.
//   win_rate      = fraction closing in predicted direction (0–1)
//   recommendation= direction ('LONG' or 'SHORT')
//   notes         = JSON { direction, label, requires: { day_type, a_up_fired, ... } }
//
// Run: node scripts/backtest_permission_slips.mjs
// Weekly cron: Sunday 9:20 PM ET (after DAY_TYPE_ALPHA at 9:10 PM)
// =============================================================================

import { query } from '../server/db.js';

const MIN_N  = 20;
const MIN_PCT = 0.65;

// ── 1. Build enriched dataset ─────────────────────────────────────────────────

async function loadData() {
  const result = await query(`
    WITH bars_data AS (
      SELECT
        (ts AT TIME ZONE 'America/New_York')::date AS trade_date,
        MAX(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60
                    + EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') = 570
             THEN open END) AS open_930,
        MAX(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60
                    + EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 599 AND 601
             THEN close END) AS close_1000,
        MAX(CASE WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60
                    + EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') BETWEEN 959 AND 961
             THEN close END) AS close_400
      FROM price_bars_primary
      GROUP BY 1
    )
    SELECT
      d.trade_date,
      d.day_type,
      d.a_up_fired,
      d.a_down_fired,
      d.c_up_confirmed,
      d.c_down_confirmed,
      CASE
        WHEN b.close_1000 > b.open_930 THEN 'UP'
        WHEN b.close_1000 < b.open_930 THEN 'DOWN'
        ELSE 'FLAT'
      END AS fh_dir,
      CASE
        WHEN b.close_400 > b.open_930 THEN 1
        WHEN b.close_400 < b.open_930 THEN 0
        ELSE NULL
      END AS closed_long
    FROM acd_daily_log d
    JOIN bars_data b ON b.trade_date = d.trade_date
    WHERE d.trade_date < CURRENT_DATE
      AND b.close_400 IS NOT NULL
      AND b.open_930  IS NOT NULL
    ORDER BY d.trade_date
  `);
  return result.rows;
}

// ── 2. Define combination space ───────────────────────────────────────────────

function buildCombinations() {
  const dayTypes = ['TREND', 'BALANCE', 'TURBULENT', null];
  const bools    = [true, null];   // null = "any"
  const combos   = [];

  for (const dir of ['LONG', 'SHORT']) {
    const isLong = dir === 'LONG';

    for (const dt of dayTypes) {
      for (const sig of bools) {       // a_up / a_down
        for (const cSig of bools) {    // c_up / c_down
          for (const fh of bools) {    // fh_dir=UP / fh_dir=DOWN

            // Must have at least one active signal (exclude all-null)
            if (sig === null && fh === null) continue;

            const requires = {
              day_type:          dt,
              a_up_fired:        isLong  ? sig   : null,
              a_down_fired:      !isLong ? sig   : null,
              c_up_confirmed:    isLong  ? cSig  : null,
              c_down_confirmed:  !isLong ? cSig  : null,
              fh_dir:            fh ? (isLong ? 'UP' : 'DOWN') : null,
            };

            // c_signal only makes sense when the matching a_signal is also required
            if (cSig === true && sig === null) continue;

            const name  = buildName(dir, requires);
            const label = buildLabel(dir, requires);
            combos.push({ dir, requires, name, label });
          }
        }
      }
    }
  }
  return combos;
}

function buildName(dir, req) {
  const parts = [dir];
  if (req.day_type)          parts.push(`DT${req.day_type.slice(0,3).toUpperCase()}`);
  if (req.a_up_fired)        parts.push('AUP');
  if (req.a_down_fired)      parts.push('ADN');
  if (req.c_up_confirmed)    parts.push('CUP');
  if (req.c_down_confirmed)  parts.push('CDN');
  if (req.fh_dir)            parts.push(`FH${req.fh_dir.slice(0,2).toUpperCase()}`);
  return parts.join('_').slice(0, 60);
}

function buildLabel(dir, req) {
  const parts = [];
  if (req.day_type)          parts.push(req.day_type);
  if (req.a_up_fired)        parts.push('A Up');
  if (req.a_down_fired)      parts.push('A Down');
  if (req.c_up_confirmed)    parts.push('C Up confirmed');
  if (req.c_down_confirmed)  parts.push('C Down confirmed');
  if (req.fh_dir === 'UP')   parts.push('first 30-min ↑');
  if (req.fh_dir === 'DOWN') parts.push('first 30-min ↓');
  return parts.join(' + ');
}

// ── 3. Evaluate a combination against the dataset ────────────────────────────

function evaluate(rows, dir, requires) {
  const isLong = dir === 'LONG';
  const subset = rows.filter(r => {
    if (requires.day_type         && r.day_type         !== requires.day_type)         return false;
    if (requires.a_up_fired       && !r.a_up_fired)                                    return false;
    if (requires.a_down_fired     && !r.a_down_fired)                                  return false;
    if (requires.c_up_confirmed   && !r.c_up_confirmed)                                return false;
    if (requires.c_down_confirmed && !r.c_down_confirmed)                              return false;
    if (requires.fh_dir           && r.fh_dir           !== requires.fh_dir)           return false;
    if (r.closed_long === null) return false;
    return true;
  });

  if (subset.length < MIN_N) return null;

  const hits = subset.filter(r => isLong ? r.closed_long === 1 : r.closed_long === 0).length;
  const pct  = hits / subset.length;
  if (pct < MIN_PCT) return null;

  return { n: subset.length, pct };
}

// ── 4. Write to performance_audit ─────────────────────────────────────────────

async function persist(combo, pct, n) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const notes = JSON.stringify({
    direction: combo.dir,
    label:     combo.label,
    requires:  combo.requires,
  });

  await query(`
    INSERT INTO performance_audit
      (run_date, window_days, signal_type, signal_name, sample_size, win_rate, recommendation, notes)
    VALUES ($1, 0, 'PERMISSION_SLIP', $2, $3, $4, $5, $6)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size    = EXCLUDED.sample_size,
      win_rate       = EXCLUDED.win_rate,
      recommendation = EXCLUDED.recommendation,
      notes          = EXCLUDED.notes,
      created_at     = now()
  `, [today, combo.name, n, pct, combo.dir, notes]);
}

// ── 5. Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading enriched dataset...');
  const rows = await loadData();
  console.log(`  ${rows.length} trading days loaded`);

  const combos = buildCombinations();
  console.log(`  ${combos.length} combinations to evaluate`);

  const results = [];
  for (const combo of combos) {
    const hit = evaluate(rows, combo.dir, combo.requires);
    if (!hit) continue;
    await persist(combo, hit.pct, hit.n);
    results.push({ name: combo.name, label: combo.label, pct: hit.pct, n: hit.n, dir: combo.dir });
  }

  results.sort((a, b) => b.pct - a.pct);
  console.log(`\n  ${results.length} qualifying combinations (N≥${MIN_N}, pct≥${MIN_PCT*100}%):\n`);
  for (const r of results) {
    const pctStr = (r.pct * 100).toFixed(1).padStart(5);
    const nStr   = String(r.n).padStart(4);
    console.log(`  ${r.dir.padEnd(6)} ${pctStr}% N=${nStr}  ${r.label}`);
  }
  console.log();
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
