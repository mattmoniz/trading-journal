// Row-level audit export, requested by Opus via the user, 2026-08-05.
// One row per fired setup, last 30 days, plus a second file approximating per-poll
// candidate selection ("selected_over"). Read-only, writes nothing to the DB.
//
// Stipulations (all load-bearing, per the request):
//   - preflight_backtest_assertions.mjs run against THIS file, output pasted in the handoff.
//   - Outcomes from the shared resolve() (scripts/backtest_unified.js) -- no inline mae/mfe
//     comparisons anywhere in this file.
//   - origin_status explicit in every query; ACTIVE/SHADOW/other reported separately, never pooled.
//   - Segmented into 3 regimes: pre-2026-08-03 (optStopQ-contaminated), 08-03 to today's
//     restart, and post-tonight's-changes (>= 2026-08-05 13:56:00 ET, when the STOP_SWEEP
//     pause + cascade-breaker disable actually deployed -- confirmed via the server restart
//     timestamps earlier this session, not a guess).
//   - MNQ $/pt (imported PT/COMM from backtest_unified.js, not redeclared).
//   - ORDER BY fired_at.
//   - Every aggregate carries its N.
//   - Raw rows go in the CSV; interpretation stays out of this file.
import fs from 'fs';
import { query } from '../server/db.js';
import { resolve, PT, COMM } from './backtest_unified.js';
import { makeBarIndex } from '../server/services/targetCalibrationService.js';
import { inferDirection } from '../server/config/setupTypes.js';

const TONIGHT_CUTOFF = '2026-08-05 13:56:00'; // ET, naive -- matches active_setups.fired_at convention
const OPTSTOPQ_FIX_DATE = '2026-08-03 00:00:00';
const UNCENSORED_WALK_BARS = 390; // matches targetCalibrationService.js's WALK_WINDOW_BARS convention

function regimeFor(firedAtStr) {
  if (firedAtStr < OPTSTOPQ_FIX_DATE) return 'A_pre_optstopq_fix';
  if (firedAtStr < TONIGHT_CUTOFF) return 'B_post_optstopq_pre_tonight';
  return 'C_post_tonight_changes';
}

// ── 1. Fetch all fires, last 30 days, EVERY origin_status (nothing filtered out silently) ──
const firesRes = await query(`
  SELECT id, trade_date::text, fired_at::text, setup_type, origin_status, suppression_reason,
    status, resolution, resolution_method, actual_pnl::float,
    entry_zone_low::float, entry_zone_high::float, stop_level::float, t1_level::float,
    mae_points::float, mfe_points::float
  FROM active_setups
  WHERE fired_at >= NOW() - INTERVAL '30 days'
  ORDER BY fired_at ASC
`);
console.log(`Loaded ${firesRes.rows.length} fired rows, last 30 days, all origin_status values.`);

// ── 2. Full OPTIMAL_STOP history per setup_type, for point-in-time calibration lookup ──
// Mirrors test_invariants.mjs check [8]'s fix exactly (2026-08-05): each fire compared
// against whatever calibration was live ON ITS OWN fired_at date, not today's snapshot.
const optHistRes = await query(`
  SELECT signal_name, run_date::text, optimal_stop::float as stop, optimal_target::float as target
  FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND optimal_stop IS NOT NULL AND optimal_target IS NOT NULL
  ORDER BY signal_name, run_date ASC
`);
const optHistByType = {};
for (const r of optHistRes.rows) (optHistByType[r.signal_name] ||= []).push(r);
// Strictly `<`, not `<=` -- run_date is a DATE with no time-of-day, but the daily
// calibration cron writes at 4:20pm ET (run_daily_calibration.sh). A `<=` same-day match
// credits a morning/midday fire with calibration that wasn't computed yet (confirmed live:
// 3 fires at 04:20-07:52 ET on 2026-08-03 were matched against that day's own 4:20pm run
// before the fix). Conservative in the other direction (a legitimate late-day match after
// the real cron gets attributed to the prior day instead), but never credits calibration
// before it existed. Same fix applied to test_invariants.mjs check [8] the same night.
function calibAsOf(setupType, firedAtDate) {
  const hist = optHistByType[setupType] || [];
  let asOf = null;
  for (const h of hist) { if (h.run_date < firedAtDate) asOf = h; else break; }
  return asOf;
}

// ── 3. Load NQ bars once, bounded (last 31 days back gives 1 day of slack for entry-index
// lookups on the oldest fires, plus forward room already exists since we're loading through
// present) ──
console.log('Loading NQ bars (last 31 days)...');
const barsRes = await query(`
  SELECT ts, high::float as high, low::float as low
  FROM price_bars_primary WHERE symbol='NQ' AND ts >= NOW() - INTERVAL '31 days' AND ts <= NOW()
  ORDER BY ts ASC
`);
const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
console.log(`${allBars.length} bars loaded.`);
const firstIndexAfter = makeBarIndex(allBars);

// ── 4. Build rows ──
const header = [
  'fired_at', 'trade_date', 'regime', 'setup_type', 'origin_status', 'suppression_reason',
  'direction', 'entry',
  'fired_stop_distance_pt', 'fired_target_distance_pt',
  'calib_stop_at_fire_pt', 'calib_target_at_fire_pt', 'calib_run_date',
  'resolution', 'resolution_method', 'pnl_dollars_mnq',
  'mae_points_stored',
  'uncensored_mae_pt', 'uncensored_mfe_pt', 'uncensored_walk_bars_used', 'uncensored_walk_had_bars',
].join(',');
const lines = [header];

let noEntryCount = 0, noBarsCount = 0, noDirectionCount = 0;
for (const r of firesRes.rows) {
  const entry = r.entry_zone_high ?? r.entry_zone_low;
  const direction = inferDirection(r.setup_type);
  if (entry == null) { noEntryCount++; continue; }
  if (!direction) { noDirectionCount++; continue; }

  const firedStopDist = r.stop_level != null ? Math.abs(r.stop_level - entry) : null;
  const firedTargetDist = r.t1_level != null ? Math.abs(r.t1_level - entry) : null;

  const firedDate = r.fired_at.slice(0, 10);
  const asOf = calibAsOf(r.setup_type, firedDate);

  // Uncensored MAE/MFE: same resolve() function, called with stop/target set impossibly wide
  // so neither ever triggers -- this is NOT a new comparison, it's the identical resolve()
  // logic with candidates chosen so the walk runs the full window and its own mae/mfe fields
  // (already tracked bar-by-bar inside resolve() itself) come back uncensored.
  const barIdx = firstIndexAfter(new Date(r.fired_at + 'Z').getTime());
  let uncensoredMae = null, uncensoredMfe = null, walkBarsUsed = 0, hadBars = false;
  if (barIdx < allBars.length) {
    hadBars = true;
    const isLong = direction === 'LONG';
    const impossibleStop = isLong ? -1e9 : 1e9;
    const impossibleTarget = isLong ? 1e9 : -1e9;
    const walked = resolve(allBars, barIdx, direction, entry, impossibleStop, impossibleTarget, UNCENSORED_WALK_BARS);
    uncensoredMae = walked.mae;
    uncensoredMfe = walked.mfe;
    walkBarsUsed = walked.barsHeld;
  } else {
    noBarsCount++;
  }

  lines.push([
    r.fired_at, r.trade_date, regimeFor(r.fired_at), r.setup_type, r.origin_status, r.suppression_reason || '',
    direction, entry,
    firedStopDist ?? '', firedTargetDist ?? '',
    asOf?.stop ?? '', asOf?.target ?? '', asOf?.run_date ?? '',
    r.resolution || '', r.resolution_method || '', r.actual_pnl ?? '',
    r.mae_points ?? '',
    uncensoredMae ?? '', uncensoredMfe ?? '', walkBarsUsed, hadBars,
  ].join(','));
}

const outPath1 = 'docs/audit_registry_export/row_level_fires_last30d_20260805.csv';
fs.writeFileSync(outPath1, lines.join('\n') + '\n');
console.log(`Wrote ${lines.length - 1} rows to ${outPath1} (excluded: ${noEntryCount} no-entry, ${noDirectionCount} no-direction, ${noBarsCount} no-bars-available).`);

// ── 5. selected_over approximation: bucket by (trade_date, fired_at floored to nearest
// 15s -- matches the real poll cadence documented in CLAUDE.md) and list every setup_type
// that got ANY row in that bucket, marking which (if any) has origin_status='ACTIVE'. This
// is explicitly an approximation, not the real thing -- it can only see candidates that
// produced SOME row (a real fire or an audit-log entry), not ones silently filtered before
// ever reaching an INSERT (e.g. liveStats._suppressedSetups check, acd.js line ~6351) --
// those remain invisible until the real selected_over column exists.
const bucketed = {};
for (const r of firesRes.rows) {
  const t = new Date(r.fired_at + 'Z').getTime();
  const bucketKey = `${r.trade_date}__${Math.floor(t / 15000)}`;
  (bucketed[bucketKey] ||= []).push(r);
}
const header2 = ['trade_date', 'bucket_time_approx', 'candidates_in_bucket', 'setup_types', 'origin_statuses', 'winner_setup_type'].join(',');
const lines2 = [header2];
const bucketKeysSorted = Object.keys(bucketed).sort();
for (const key of bucketKeysSorted) {
  const rows = bucketed[key];
  const [tradeDate] = key.split('__');
  const winner = rows.find(r => r.origin_status === 'ACTIVE');
  const bucketTime = rows[0].fired_at;
  lines2.push([
    tradeDate, bucketTime, rows.length,
    `"${rows.map(r => r.setup_type).join('|')}"`,
    `"${rows.map(r => r.origin_status).join('|')}"`,
    winner ? winner.setup_type : '(none)',
  ].join(','));
}
const outPath2 = 'docs/audit_registry_export/selected_over_approx_last30d_20260805.csv';
fs.writeFileSync(outPath2, lines2.join('\n') + '\n');
console.log(`Wrote ${lines2.length - 1} poll-buckets to ${outPath2}.`);
console.log(`PT=${PT} COMM=${COMM} (from backtest_unified.js, MNQ).`);

process.exit(0);
