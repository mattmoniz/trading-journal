// =============================================================================
// Calibrates whether the momentum_ctx_sameday finding (RESEARCH_CLAIM
// momentum_ctx_sameday_corrected_after_deepseek_audit, CONFIRMED 2026-08-30) still holds on
// the LIVE system's own stored data, and if so, derives a sizeMultiplier delta from it.
//
// INERT SCRIPT: writes one performance_audit row (signal_type='MOMENTUM_CTX_SIZING') and
// nothing else. Does NOT touch sizeMultiplier, active_setups, or any live behavior. Whether
// to wire the result into acd.js's sizeMultiplier IIFE is a separate, deliberately later
// decision (OPEN_DECISION momentum_ctx_sameday_wiring_untested_20260913) gated on this
// script's own real numbers, not on the original research claim's $14.40/trade figure.
//
// WHY A FRESH MEASUREMENT, NOT A RE-PERSIST OF THE ORIGINAL CLAIM (DeepSeek design critique,
// 2026-09-13, scratch/deepseek_response.md): the original claim's N=276 was produced by
// scratch/rerun_all_with_corrected_classifier.mjs, which (1) RE-DERIVED momentumContext from
// bars using today's latest calibration median rather than the value the live system actually
// saw at fire time, (2) filtered resolution IN ('STOP_HIT','TARGET_HIT') only -- excluding
// TIME_EXPIRED/TRAIL_EXIT, and (3) did not apply is_cluster_primary. This script instead:
//   (a) reads active_setups.vol_building_signal->>'momentumContext' -- the value stored on
//       each row AT FIRE TIME by computeLiveVolumeBuildingSignal() (acdLiveCalibration.js),
//       the exact same field the live system already persists on every real fire (never
//       reimplemented -- see CLAUDE.md's "export the real function" rule);
//   (b) includes all RESOLVED trades regardless of resolution method, matching
//       backtest_day_type_alpha.js's own convention (its template for this script);
//   (c) applies the is_cluster_primary filter (CLAUDE.md hard rule -- a cluster-sibling
//       touch double-counts the same touch event if left unfiltered).
// These are each MORE correct than the original research, but will independently shrink and
// shift the population -- DO NOT assume the fresh number matches $14.40/trade. Report
// whatever the real number is.
//
// METHODOLOGY (DeepSeek design critique, applied point-by-point):
//   1. Population: real (origin_status IN ACTIVE/SHADOW), cluster-deduplicated, RESOLVED
//      trades whose setup_type classifies as SAME_DAY_FORMING (classifyLevelFormation() --
//      the real, already-exported classifier, not a hand-rolled list).
//   2. Split into ACTIVE vs QUIET by each trade's own stored momentumContext. Trades with a
//      null momentumContext (touchIdx<30 or no calibration median at fire time -- see
//      acdLiveCalibration.js's own null conditions) are excluded and counted separately, not
//      silently dropped.
//   3. Per-trade economic breakeven, NOT a single per-setup-type OPTIMAL_STOP lookup (unlike
//      backtest_day_type_alpha.js's per-(setup_type,day_type) cells, this population pools
//      MANY different setup_types with different real stop/target geometries) -- each trade's
//      own real entry/stop_level/t1_level (via resolveDirection(), the real exported
//      direction resolver) gives its own real stopPts/targetPts, and breakevenWr() is applied
//      per-trade then averaged (N-weighted) within each group.
//   4. Co-primary tests (matching the 2026-09-13 DAY_TYPE_ALPHA fix's own standard, since this
//      is the identical "short-history, day-clustered real-EV-gap" risk shape):
//        - Breakeven-WR z-test: is QUIET's real WR below its own group's weighted-average
//          breakeven WR?
//        - Day-blocked bootstrap 95% CI on the ACTIVE-minus-QUIET EV difference (resampling
//          whole trading days, not individual trades).
//   5. sizeDelta derived from the z-score of the EV-difference test (min(|z|*0.07, 0.25),
//      the exact DAY_TYPE_ALPHA formula) -- NOT from the raw dollar gap, which has no
//      mechanical bridge to a 0.10-1.5x multiplier (DeepSeek: "inventing one is a new number,
//      the exact thing this codebase's hard rules resist").
//   6. computeRigor() is informational only (day-clustering, chronological stability) --
//      per rigorDiagnostics.js's own header, never a gate.
//
// Run manually: node scripts/calibrate_momentum_ctx_sizing.mjs
// =============================================================================

import { query } from '../server/db.js';
import { computeRigor, breakevenWr, dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { classifyLevelFormation, resolveDirection } from '../server/config/setupTypes.js';

const REAL_N_FLOOR  = 20;   // CLAUDE.md N>=20 rule
const SCALE_FACTOR  = 0.07; // matches DAY_TYPE_ALPHA's own size_delta formula exactly
const Z_SIZE_DOWN   = 1.5;
const Z_SUPPRESS    = 2.0;
const EV_FLOOR       = -5;  // matches SETUP_STATUS/DAY_TYPE_ALPHA precedent, not a new number

async function run() {
  console.log('MOMENTUM_CTX_SIZING calibration starting…');

  const res = await query(`
    SELECT setup_type, actual_pnl::float, origin_status, is_cluster_primary,
           trade_date::text as trade_date, entry_zone_low::float, entry_zone_high::float,
           stop_level::float, t1_level::float, vol_building_signal
    FROM active_setups
    WHERE status = 'RESOLVED'
      AND origin_status IN ('ACTIVE', 'SHADOW')
      AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND actual_pnl IS NOT NULL
  `);
  console.log(`  ${res.rows.length} real, cluster-deduplicated, resolved trades (pre-classification filter).`);

  const groups = { ACTIVE: [], QUIET: [] };
  let excludedNotSameDayForming = 0, excludedNullContext = 0, excludedBadGeometry = 0;

  for (const r of res.rows) {
    if (classifyLevelFormation(r.setup_type) !== 'SAME_DAY_FORMING') { excludedNotSameDayForming++; continue; }

    const ctx = r.vol_building_signal?.momentumContext ?? null;
    // Strict === check, no else-branch fallthrough -- DeepSeek code-review flag: both
    // 'ACTIVE' and 'QUIET' are truthy, so a naive if(ctx)/if(ctx!=='QUIET') would silently
    // misclassify null (thin-history/no-calibration-yet) trades as one side or the other.
    if (ctx !== 'ACTIVE' && ctx !== 'QUIET') { excludedNullContext++; continue; }

    const direction = resolveDirection(r);
    const entry = r.entry_zone_low; // level-fade inserts always set entry_zone_low === entry_zone_high === active.entry
    if (direction == null || r.stop_level == null || r.t1_level == null || entry == null) { excludedBadGeometry++; continue; }
    const stopPts   = direction === 'LONG' ? entry - r.stop_level : r.stop_level - entry;
    const targetPts = direction === 'LONG' ? r.t1_level - entry   : entry - r.t1_level;
    if (!(stopPts > 0) || !(targetPts > 0)) { excludedBadGeometry++; continue; } // inverted/degenerate geometry -- exclude, don't guess

    groups[ctx].push({
      setup_type: r.setup_type, pnl: r.actual_pnl, date: r.trade_date,
      win: r.actual_pnl > 0 ? 1 : 0, breakeven_wr: breakevenWr(stopPts, targetPts),
    });
  }

  console.log(`  Excluded: ${excludedNotSameDayForming} not SAME_DAY_FORMING, ${excludedNullContext} null momentumContext, ${excludedBadGeometry} bad stop/target geometry.`);
  console.log(`  ACTIVE n=${groups.ACTIVE.length}, QUIET n=${groups.QUIET.length}.`);

  function summarize(events) {
    const n = events.length;
    if (!n) return null;
    const wins = events.reduce((s, e) => s + e.win, 0);
    const pnlSum = events.reduce((s, e) => s + e.pnl, 0);
    const wr = wins / n;
    const ev = pnlSum / n;
    const avgBreakevenWr = events.reduce((s, e) => s + e.breakeven_wr, 0) / n;
    const rigor = n >= 5 ? computeRigor(events, { dateField: 'date', pnlFn: e => e.pnl }) : null;
    const effectiveN = Math.max(rigor?.distinctDates ?? n, 5);
    const seBk = Math.sqrt(avgBreakevenWr * (1 - avgBreakevenWr) / effectiveN) || 0.001;
    const zBreakeven = (wr - avgBreakevenWr) / seBk;
    return { n, wins, wr, ev, avgBreakevenWr, zBreakeven, rigor, events };
  }

  const active = summarize(groups.ACTIVE);
  const quiet  = summarize(groups.QUIET);

  console.log('\nACTIVE:', active ? { n: active.n, wr: +active.wr.toFixed(3), ev: +active.ev.toFixed(2), breakevenWr: +active.avgBreakevenWr.toFixed(3), zBreakeven: +active.zBreakeven.toFixed(2), clustered: active.rigor?.clustered, distinctDates: active.rigor?.distinctDates } : 'N=0');
  console.log('QUIET: ', quiet  ? { n: quiet.n,  wr: +quiet.wr.toFixed(3),  ev: +quiet.ev.toFixed(2),  breakevenWr: +quiet.avgBreakevenWr.toFixed(3),  zBreakeven: +quiet.zBreakeven.toFixed(2),  clustered: quiet.rigor?.clustered,  distinctDates: quiet.rigor?.distinctDates } : 'N=0');

  let recommendation = 'INSUFFICIENT_DATA', sizeDelta = 0, evDiffCi = null, zEvDiff = null;

  if (active && quiet && active.n >= REAL_N_FLOOR && quiet.n >= REAL_N_FLOOR) {
    // Day-blocked bootstrap on the ACTIVE-minus-QUIET difference: resample ACTIVE and QUIET
    // independently (each within its own day-blocks), take the difference of the two
    // resampled means each iteration. Reuses dayBlockedBootstrapCI per side then combines --
    // simpler and equally valid to combining two independently-seeded bootstraps by
    // subtraction, since ACTIVE/QUIET trades are drawn from largely non-overlapping days.
    const activeCi = dayBlockedBootstrapCI(active.events, 'momentum_ctx_active', { iters: 2000 });
    const quietCi  = dayBlockedBootstrapCI(quiet.events,  'momentum_ctx_quiet',  { iters: 2000 });
    // Difference-of-CIs approximation: conservative (wider than a true joint bootstrap of the
    // difference) but avoids assuming independence needed for a cleaner closed-form combine --
    // acceptable for an inert calibration-only script; the live-wiring decision (if any) would
    // warrant the more careful joint version.
    evDiffCi = { lo: activeCi.lo - quietCi.hi, hi: activeCi.hi - quietCi.lo };
    const evDiff = active.ev - quiet.ev;
    const pooledSd = Math.sqrt(
      (active.events.reduce((s, e) => s + (e.pnl - active.ev) ** 2, 0) / active.n) / active.n +
      (quiet.events.reduce((s, e) => s + (e.pnl - quiet.ev) ** 2, 0) / quiet.n) / quiet.n
    ) || 0.001;
    zEvDiff = evDiff / pooledSd;

    const quietBelowBreakeven = quiet.zBreakeven <= -Z_SUPPRESS ? 'SUPPRESS' : quiet.zBreakeven <= -Z_SIZE_DOWN ? 'SIZE_DOWN' : 'NEUTRAL';
    const evDiffNegative = evDiffCi.hi < 0 ? (evDiffCi.hi < EV_FLOOR ? 'SUPPRESS' : 'SIZE_DOWN') : 'NEUTRAL';
    const SEVERITY = { SUPPRESS: 3, SIZE_DOWN: 2, NEUTRAL: 1 };
    recommendation = SEVERITY[quietBelowBreakeven] >= SEVERITY[evDiffNegative] ? quietBelowBreakeven : evDiffNegative;
    if (recommendation !== 'NEUTRAL') sizeDelta = Math.min(Math.abs(zEvDiff) * SCALE_FACTOR, 0.25);

    console.log(`\nEV diff (ACTIVE-QUIET): $${evDiff.toFixed(2)}/trade, z=${zEvDiff.toFixed(2)}, bootstrap CI=[${evDiffCi.lo.toFixed(2)}, ${evDiffCi.hi.toFixed(2)}]`);
    console.log(`QUIET breakeven test: ${quietBelowBreakeven} (z=${quiet.zBreakeven.toFixed(2)})`);
    console.log(`EV-diff-bootstrap test: ${evDiffNegative}`);
    console.log(`\nFINAL: recommendation=${recommendation}, sizeDelta=${sizeDelta.toFixed(3)}`);
  } else {
    console.log(`\nInsufficient real N (need >=${REAL_N_FLOOR} per side): ACTIVE=${active?.n ?? 0}, QUIET=${quiet?.n ?? 0}. No recommendation possible yet.`);
  }

  const notes = JSON.stringify({
    active_n: active?.n ?? 0, active_wr: active ? +active.wr.toFixed(3) : null, active_ev: active ? +active.ev.toFixed(2) : null,
    quiet_n: quiet?.n ?? 0, quiet_wr: quiet ? +quiet.wr.toFixed(3) : null, quiet_ev: quiet ? +quiet.ev.toFixed(2) : null,
    quiet_breakeven_wr: quiet ? +quiet.avgBreakevenWr.toFixed(3) : null, quiet_z_breakeven: quiet ? +quiet.zBreakeven.toFixed(2) : null,
    ev_diff: active && quiet ? +(active.ev - quiet.ev).toFixed(2) : null,
    z_ev_diff: zEvDiff != null ? +zEvDiff.toFixed(2) : null,
    ev_diff_bootstrap_ci: evDiffCi ? [+evDiffCi.lo.toFixed(2), +evDiffCi.hi.toFixed(2)] : null,
    size_delta: +sizeDelta.toFixed(3),
    excluded_not_same_day_forming: excludedNotSameDayForming, excluded_null_context: excludedNullContext, excluded_bad_geometry: excludedBadGeometry,
    active_rigor_clustered: active?.rigor?.clustered ?? null, quiet_rigor_clustered: quiet?.rigor?.clustered ?? null,
    active_distinct_dates: active?.rigor?.distinctDates ?? null, quiet_distinct_dates: quiet?.rigor?.distinctDates ?? null,
    note: 'INERT: this row does not feed sizeMultiplier. See OPEN_DECISION momentum_ctx_sameday_wiring_untested_20260913.',
  });

  const combinedN = (active?.n ?? 0) + (quiet?.n ?? 0);
  const pooledWr = combinedN ? ((active?.wins ?? 0) + (quiet?.wins ?? 0)) / combinedN : null;
  const evDiffForRow = active && quiet ? +(active.ev - quiet.ev).toFixed(2) : null; // the headline effect size, matching DAY_TYPE_ALPHA's convention of storing the cell's own EV as ev_per_trade

  const today = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;
  await query(`
    INSERT INTO performance_audit
      (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation, notes)
    VALUES ($1, 9999, 'MOMENTUM_CTX_SIZING', 'SAME_DAY_FORMING_ACTIVE_VS_QUIET', $2, $3, $4, $5, $6)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size    = EXCLUDED.sample_size,
      win_rate       = EXCLUDED.win_rate,
      ev_per_trade   = EXCLUDED.ev_per_trade,
      recommendation = EXCLUDED.recommendation,
      notes          = EXCLUDED.notes,
      created_at     = now()
  `, [today, combinedN, pooledWr != null ? +pooledWr.toFixed(3) : null, evDiffForRow, recommendation, notes]);

  console.log('\nWrote 1 row to performance_audit (MOMENTUM_CTX_SIZING). Inert -- no live behavior changed.');
  process.exit(0);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
