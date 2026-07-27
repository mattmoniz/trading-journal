// backfill_unified_levels.mjs
//
// Backfills active_setups trade generation for the 22 level types confirmed to have
// real level_prices history but zero real trade-generation history -- see OPEN_DECISION
// unified_level_table_backfill_coverage_gap. Deliberately excludes 3M_VAL/3M_POC (see
// OPEN_DECISION 3m_val_poc_same_day_lookahead_risk, found while scoping this script --
// their compute_levels.js window spans through the current day itself, unlike every
// sibling prior-period level, a real lookahead risk for historical backfill).
//
// Methodology -- matches scripts/repair_top8_window_mismatch.mjs and siblings (the
// established 2026-07-14 window-mismatch repair wave), NOT re-derived from scratch:
//   - First touch ANYWHERE in RTH (9:30-16:00 ET), not a restricted window.
//   - Correct per-level formation gate: all 22 here are confirmed prior-period-derived
//     or otherwise known before 9:30 ET (verified directly against compute_levels.js,
//     2026-07-18) -- gate=570 for all, no special-casing needed (unlike OR_LOW/IB_*,
//     which form same-day and aren't in this set).
//   - origin_status='BACKFILL' set explicitly -- the reference scripts predate that
//     column (added 2026-07-17, 3 days after they were written) and don't set it;
//     this script must.
//
// One real deviation from the reference scripts, deliberate: they hardcode
// stopDist/t1Dist per level (seeded from an earlier calibration pass that doesn't
// exist for these never-before-backfilled levels) and hand-roll their own same-bar-
// conflict resolve(). This script instead:
//   (a) derives stopDist/t1Dist FRESH per level from real touch data (two-pass: pass 1
//       walks every touch to session end with an effectively-unbounded stop/target to
//       measure the level's own true MAE/MFE distribution; p75 MAE -> stop, p50 MFE ->
//       target, the same convention update_optimal_stops.mjs uses elsewhere), instead
//       of inventing a number with nothing to seed it from;
//   (b) uses the shared, live-synced server/services/maeMfeReplay.js replayBars() for
//       resolution, not a hand-rolled resolve() -- that module's own header says it's
//       "used by the backfill script and live resolution path so both stay in sync",
//       making it the more current authority than the 2026-07-14 scripts that predate it.
// mae_points/mfe_points are deliberately left NULL here (not populated from this
// script's own internal replayBars calls) so every row in the table gets them from the
// SAME canonical path (scripts/backfill_mae_mfe.mjs, run as its own step afterward) --
// avoids two subtly different MAE/MFE conventions coexisting in the same column.
//
// Run: node scripts/backfill_unified_levels.mjs [--dry-run]

import { query } from '../server/db.js';
import { replayBars } from '../server/services/maeMfeReplay.js';
import { percentile } from '../server/services/regimeClassificationService.js';

const DRY_RUN = process.argv.includes('--dry-run');
const PT = 2, COMM = 1; // MNQ live instrument -- matches acd.js PNL_PER_POINT/COMMISSION
const TOUCH_TOLERANCE = 15; // pt, matches the established first-touch convention
const GATE = 570;   // 9:30 ET -- all 22 in-scope levels confirmed safe at this gate
const RTH_END = 960; // 16:00 ET
const WIDE = 9999;  // effectively-unbounded stop/target for pass-1 unbiased MAE/MFE

// Pass-1 window cap for the "wide open" MAE/MFE measurement, in bars (minutes).
// FOUND 2026-07-18 (dry-run sanity check, before any real insert): with no cap, an early
// touch could walk all the way to session end (up to ~390 bars), producing p75 MAE of
// 150-250pt for these new levels -- 2-3x every already-calibrated comparable fade
// setup's real p75_mae (67-81pt for PD_POC/FLOOR_S1/CAM_R1/PD_VAH/OR_LOW, queried
// directly from performance_audit OPTIMAL_STOP rows). Root cause: those existing rows'
// mae_points were bounded by their OWN (already-reasonable) original stop/target
// triggering early exit, not by session end -- an unbounded pass-1 measures a
// fundamentally different, much larger thing (total session excursion) than what the
// rest of the system's MAE/MFE convention represents. Fixed by capping pass-1 at the
// SAME system-wide p90 bars-to-resolution across all real, already-resolved FADE-family
// trades (queried directly: 6,041 trades, p75=28 bars, p90=64 bars, p95=117 bars) --
// data-derived, not an invented number, and generous enough (90th percentile) to still
// capture genuinely slower-resolving touches without the multi-hour over-measurement.
const PASS1_MAX_BARS = 64;

const LEVEL_NAMES = [
  'PD_HIGH', 'PD_LOW', 'PD_CLOSE', 'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN',
  'FLOOR_R2', 'FLOOR_R3', 'FLOOR_S2', 'FLOOR_S3', 'ONH', 'ONL',
  'PM_HIGH', 'PM_LOW', 'PM_VAH', 'PM_VAL',
  'PW_HIGH', 'PW_LOW', 'PW_VAH', 'PW_VAL', 'PW_POC', '10D_IB_MID',
];

console.log(`Backfill unified levels (${LEVEL_NAMES.length} level types)${DRY_RUN ? ' [DRY RUN]' : ''}`);

const targetTypes = LEVEL_NAMES.flatMap(n => [`${n}_FADE_LONG`, `${n}_FADE_SHORT`]);

if (!DRY_RUN) {
  await query(`DROP TABLE IF EXISTS active_setups_unified_levels_backup_20260718`);
  // resolution_method='BACKFILL' scoping is REQUIRED, not optional -- found live 2026-07-18:
  // several of these exact setup_types (PD_HIGH/PD_LOW/PW_LOW/ONL/FLOOR_S2/10D_IB_MID)
  // already have a small number of genuine ORGANIC live-fired rows (resolution_method=
  // 'PRICE_CLEAN', origin_status SHADOW/UNKNOWN) from real touches over the past weeks --
  // the reference repair scripts (e.g. repair_top8_window_mismatch.mjs) already scope
  // their DELETE this same way; an unscoped DELETE here failed outright on a live FK
  // constraint (trade_timeline_events references one such row), and would have silently
  // destroyed real trade history for the others had it not been FK-protected.
  await query(`CREATE TABLE active_setups_unified_levels_backup_20260718 AS SELECT * FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'`, [targetTypes]);
  const cnt = await query(`SELECT COUNT(*) FROM active_setups_unified_levels_backup_20260718`);
  console.log(`Backed up ${cnt.rows[0].count} pre-existing BACKFILL rows for these setup types (organic/live rows left untouched)`);
  const del = await query(`DELETE FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'`, [targetTypes]);
  console.log(`Deleted ${del.rowCount} rows`);
}

const datesR = await query(`SELECT DISTINCT trade_date::text as d FROM level_prices WHERE level_name = ANY($1) AND trade_date < CURRENT_DATE ORDER BY d`, [LEVEL_NAMES]);
const dates = datesR.rows.map(r => r.d);
console.log(`Processing ${dates.length} dates`);

// ── Phase A: detect first-touches, measure unbounded MAE/MFE per touch ──────────
const touchesByDate = {};
const maeArraysByLevel = {};
const mfeArraysByLevel = {};

for (const date of dates) {
  // ts::text is required, not cosmetic -- found 2026-07-18 (live run, real corrupted
  // fired_at timestamps: 07:08/04:31/05:09 for what should have been RTH-gated 9:30am+
  // touches). price_bars_primary.ts is `timestamp without time zone` (naive ET
  // wall-clock, per this codebase's own established convention). Selecting bare `ts`
  // lets node-postgres auto-convert it to a JS Date object, which gets constructed by
  // interpreting the naive string against the process's ambient timezone -- then
  // round-tripping that Date object back out as an INSERT parameter re-serializes it
  // under a DIFFERENT timezone assumption, shifting the wall-clock value by several
  // hours. The reference script (repair_top8_window_mismatch.mjs) already does this
  // correctly via ts::text -- an established convention this script should have
  // followed from the start instead of reintroducing the exact naive-timestamp bug
  // class CLAUDE.md's own hard rule already documents (sierraParser.js, 2026-07-16).
  const barsR = await query(`
    SELECT ts::text as ts, open::float, high::float, low::float, close::float,
           EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int as tod
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 569 AND 961
    ORDER BY tod
  `, [date]);
  const bars = barsR.rows;
  if (bars.length < 30) continue;

  const lpR = await query(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND level_name = ANY($2)`, [date, LEVEL_NAMES]);
  const levels = {};
  for (const row of lpR.rows) levels[row.level_name] = row.price;
  if (!Object.keys(levels).length) continue;

  const fired = new Set();
  const fires = [];
  // Direction fixed 2026-07-27 (found while re-scoping the WEEKLY_OPEN G-Line
  // recalibration): this used to compare the PREVIOUS bar's close against the LEVEL
  // price (1-bar-vs-level) -- a real mismatch against the live RTH candidate path's
  // actual convention, `approachDir = last5[0].close < currentPrice` (server/routes/
  // acd.js ~line 4865, 5-bar momentum vs the CURRENT price, not the level). Same bug
  // class independently found and fixed the same day in backtest_unified.js's
  // detectLevelFades() (backtest_unified_uses_wrong_direction_formula_for_rth) --
  // this script is a separate reimplementation that had drifted the same way. Loop
  // start moved from i=1 to i=5 so bars[i-5] is always available.
  for (let i = 5; i < bars.length; i++) {
    const b = bars[i];
    if (b.tod < GATE || b.tod >= RTH_END) continue;
    for (const [levelName, lvl] of Object.entries(levels)) {
      if (lvl == null || fired.has(levelName)) continue;
      if (Math.abs(b.close - lvl) > TOUCH_TOLERANCE) continue;
      const fromAbove = !(bars[i - 5].close < b.close);
      const dir = fromAbove ? 'LONG' : 'SHORT';
      fires.push({ levelName, dir, barIdx: i, barTs: b.ts, entryPx: Math.round(b.close * 4) / 4, levelPx: lvl });
      fired.add(levelName);
    }
  }
  for (const f of fires) f.confluenceCount = fires.filter(o => o.barIdx === f.barIdx && o !== f).length;

  touchesByDate[date] = { bars, fires };

  for (const f of fires) {
    const isLong = f.dir === 'LONG';
    const wideStop = isLong ? f.entryPx - WIDE : f.entryPx + WIDE;
    const wideT1 = isLong ? f.entryPx + WIDE : f.entryPx - WIDE;
    // Capped at PASS1_MAX_BARS (see its own comment) -- this is ONLY for measuring the
    // level's own MAE/MFE distribution to derive a stop/target; Phase B below (which
    // determines the row's actual stored resolution) is deliberately NOT capped this way.
    // Starts AT barIdx (not barIdx+1), matching the canonical computeMaeMfe() convention
    // -- see Phase B's own comment on this same point for the full explanation.
    const fromEntryBars = bars.slice(f.barIdx, f.barIdx + PASS1_MAX_BARS).filter(b => b.tod <= RTH_END);
    const r = replayBars(fromEntryBars, f.entryPx, wideStop, wideT1, f.dir);
    if (!r) continue;
    (maeArraysByLevel[f.levelName] ??= []).push(r.mae);
    (mfeArraysByLevel[f.levelName] ??= []).push(r.mfe);
  }
}

// ── Derive stop/target per level from real MAE/MFE percentiles ──────────────────
console.log('\nData-derived stop/target per level (p75 MAE / p50 MFE):');
const LEVEL_PARAMS = {};
for (const name of LEVEL_NAMES) {
  const maeArr = maeArraysByLevel[name] || [];
  const mfeArr = mfeArraysByLevel[name] || [];
  if (maeArr.length < 5) { console.log(`  SKIP ${name}: only ${maeArr.length} touches, too few to derive stop/target`); continue; }
  const stopDist = Math.round(percentile(maeArr, 0.75) * 100) / 100;
  const t1Dist = Math.round(percentile(mfeArr, 0.50) * 100) / 100;
  if (stopDist <= 0 || t1Dist <= 0) { console.log(`  SKIP ${name}: degenerate stop/target (${stopDist}/${t1Dist})`); continue; }
  LEVEL_PARAMS[name] = { stopDist, t1Dist };
  console.log(`  ${name.padEnd(14)} n=${String(maeArr.length).padEnd(4)} stop=${stopDist}pt target=${t1Dist}pt`);
}

// ── Phase B: real resolution against the derived stop/target, insert ────────────
let inserted = 0;
const statsByType = {};

for (const date of dates) {
  const dayData = touchesByDate[date];
  if (!dayData) continue;
  const { bars, fires } = dayData;

  for (const f of fires) {
    const params = LEVEL_PARAMS[f.levelName];
    if (!params) continue;
    const isLong = f.dir === 'LONG';
    const entry = f.entryPx;
    const stop = isLong ? entry - params.stopDist : entry + params.stopDist;
    const t1 = isLong ? entry + params.t1Dist : entry - params.t1Dist;

    // FOUND 2026-07-18 (live run against real data, caught via a resolution vs.
    // replay_resolution mismatch after backfill_mae_mfe.mjs ran): must start AT the
    // touch bar (barIdx), not barIdx+1. server/services/maeMfeReplay.js's own
    // computeMaeMfe() -- the canonical, live-synced convention every other row in this
    // table is computed against -- uses `ts >= firedAt`, which INCLUDES the touch bar.
    // The touch bar's own high/low can already cross the target (it's the bar whose
    // CLOSE triggered the 15pt-proximity detection, not necessarily a narrow-range bar)
    // -- skipping it materially changed outcomes for real rows (27% of the first live
    // run, 766/2795, mostly STOP_HIT/TIME_EXPIRED that were actually TARGET_HIT).
    // Fixed live via a direct UPDATE realigning resolution/actual_pnl/status/resolved_at
    // to replay_resolution for the 2795 already-inserted rows; fixed here so a future
    // re-run doesn't reintroduce the same bug.
    const fromEntryBars = bars.slice(f.barIdx).filter(b => b.tod <= RTH_END);
    const result = replayBars(fromEntryBars, entry, stop, t1, f.dir);
    if (!result) continue;

    const resolution = result.replayResolution === 'EXPIRED' ? 'TIME_EXPIRED' : result.replayResolution;
    let pnl = null;
    if (resolution === 'TARGET_HIT') pnl = Math.round((params.t1Dist * PT - COMM) * 100) / 100;
    if (resolution === 'STOP_HIT') pnl = Math.round((-params.stopDist * PT - COMM) * 100) / 100;
    if (resolution === 'TIME_EXPIRED') pnl = 0;
    const status = resolution === 'TIME_EXPIRED' ? 'EXPIRED' : 'RESOLVED';
    const setupType = `${f.levelName}_FADE_${f.dir}`;
    const t1Label = `T1: ${params.t1Dist}pt (p50 MFE) | Stop: ${params.stopDist}pt (p75 MAE) [first-touch-anytime, data-derived]`;

    if (!statsByType[setupType]) statsByType[setupType] = { total: 0, wins: 0, losses: 0, pnl: 0 };
    statsByType[setupType].total++;
    if (resolution === 'TARGET_HIT') statsByType[setupType].wins++;
    if (resolution === 'STOP_HIT') statsByType[setupType].losses++;
    statsByType[setupType].pnl += pnl || 0;

    if (!DRY_RUN) {
      await query(`
        INSERT INTO active_setups (
          trade_date, setup_type, fired_at, expires_at, resolved_at, status, resolution,
          entry_zone_low, stop_level, t1_level, t1_label,
          structural_level_touched, structural_level_type, price_at_detection,
          confluence_score_at_detection, actual_pnl, resolution_method, origin_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT DO NOTHING
      `, [
        date, setupType, f.barTs, `${date} 16:00:00`, result.resolutionBarTime, status, resolution,
        entry, stop, t1, t1Label, f.levelPx, f.levelName, entry,
        f.confluenceCount, pnl, 'BACKFILL', 'BACKFILL',
      ]);
    }
    inserted++;
  }
}

console.log(`\n${DRY_RUN ? 'Would insert' : 'Inserted'}: ${inserted}`);
for (const [type, s] of Object.entries(statsByType).sort((a, b) => b[1].total - a[1].total)) {
  const resolved = s.wins + s.losses;
  const wr = resolved > 0 ? (s.wins / resolved * 100).toFixed(1) : 'n/a';
  const ev = resolved > 0 ? (s.pnl / resolved).toFixed(2) : 'n/a';
  console.log(`  ${type.padEnd(24)} total=${s.total} resolved=${resolved} WR=${wr}% EV=$${ev}/trade pnl=$${Math.round(s.pnl)}`);
}
process.exit(0);
