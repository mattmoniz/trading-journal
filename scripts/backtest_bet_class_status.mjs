/**
 * bet_class aggregation layer — roster-rebuild roadmap Phase 1, I3 (2026-08-10).
 *
 * "This is what converts 130 fragmented samples into one usable sample" (roadmap Part 4).
 * Reports pooled real (origin_status IN ('ACTIVE','SHADOW')) N/WR/EV per bet_class
 * (VALUE_FADE / CONTINUATION_LEGACY / UNCLASSIFIED — see server/config/setupTypes.js's
 * getBetClass()), with the same resolution filter and chronological-stability rigor check
 * (computeRigor, imported not reimplemented) already established in backtest_setup_status.mjs
 * for individual setup_types.
 *
 * Deliberately NOT a SUPPRESS/PROMOTE decision, and NOT wired into any live stop/target
 * lookup — that's the roadmap's own Phase 2 scope ("a defensible number for VALUE_FADE EV
 * at an affordable stop, from real data, with N in the hundreds"), a real resweep at
 * consolidated N, not a same-commit rewire of acd.js's live risk parameters. This script is
 * the descriptive aggregation layer Phase 2 will read from, and the thing that lets a future
 * session answer "has VALUE_FADE's real N reached the hundreds yet" without a manual query
 * every time. See OPEN_DECISION bet_class_phase2_consolidated_resweep_not_started.
 *
 * Writes signal_type='BET_CLASS_STATUS' rows to performance_audit, one per bet_class.
 * Run:  node scripts/backtest_bet_class_status.mjs
 * Cron: weekly (run_weekly_backtests.sh) — real N grows slowly enough that daily adds no
 * value here, unlike backtest_setup_status.mjs's per-type SUPPRESS/PROMOTE decisions.
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { BET_CLASSES, getBetClass } from '../server/config/setupTypes.js';
import { recordClaim } from './record_claim.mjs';

const SIGNAL_TYPE = 'BET_CLASS_STATUS';

async function run() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);

  // Same population/resolution filter as backtest_setup_status.mjs's allTimeQ, grouped by
  // bet_class instead of setup_type. bet_class is read from the STORED column (populated at
  // insert time going forward, backfilled once for existing rows 2026-08-10) rather than
  // re-derived from setup_type here -- a row's bet_class should reflect what it was tagged
  // with, not a live re-classification that could silently drift from the persisted value.
  const allTimeQ = await query(`
    SELECT
      bet_class,
      COUNT(*) AS n,
      COUNT(*) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW')) AS real_n,
      AVG((resolution='TARGET_HIT')::int)::float AS wr,
      AVG(actual_pnl)::float AS ev,
      AVG((resolution='TARGET_HIT')::int) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW'))::float AS real_wr,
      AVG(actual_pnl) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW'))::float AS real_ev,
      SUM(actual_pnl)::float AS total_pnl,
      COUNT(DISTINCT setup_type) AS distinct_types
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND actual_pnl IS NOT NULL
      AND bet_class IS NOT NULL
    GROUP BY bet_class
    ORDER BY bet_class
  `);

  // For computeRigor's chronological-stability check, need per-trade events (real-origin
  // only -- the same population real_ev/real_wr above describe, not the blended one).
  const eventsQ = await query(`
    SELECT bet_class, trade_date::text as date, actual_pnl::float as pnl
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND actual_pnl IS NOT NULL
      AND bet_class IS NOT NULL
      AND origin_status IN ('ACTIVE','SHADOW')
    ORDER BY trade_date
  `);
  const eventsByClass = new Map();
  for (const r of eventsQ.rows) {
    if (!eventsByClass.has(r.bet_class)) eventsByClass.set(r.bet_class, []);
    eventsByClass.get(r.bet_class).push(r);
  }

  console.log(`[backtest_bet_class_status] ${allTimeQ.rows.length} bet_class(es) with resolved history\n`);

  const rowsByClass = new Map(allTimeQ.rows.map(r => [r.bet_class, r]));
  for (const betClass of BET_CLASSES) {
    const r = rowsByClass.get(betClass);
    if (!r) {
      console.log(`  ${betClass.padEnd(20)} no resolved history yet`);
      continue;
    }
    const n = +r.n, realN = +r.real_n;
    const ev = +r.ev, realEv = r.real_ev != null ? +r.real_ev : null;
    const wr = +r.wr, realWr = r.real_wr != null ? +r.real_wr : null;
    const events = eventsByClass.get(betClass) || [];
    const rigor = computeRigor(events, { dateField: 'date', pnlFn: e => e.pnl });

    console.log(`  ${betClass.padEnd(20)} N=${n} (real=${realN}, ${r.distinct_types} setup_types) blended EV=$${ev.toFixed(2)} WR=${(wr*100).toFixed(1)}%  real EV=$${realEv != null ? realEv.toFixed(2) : 'n/a'} real WR=${realWr != null ? (realWr*100).toFixed(1)+'%' : 'n/a'}  rigor=${rigor.clean === true ? 'clean' : rigor.clean === false ? 'unstable' : 'n/a'} (top5day%=${rigor.top5DayPct ?? 'n/a'})`);

    const notes = {
      distinct_setup_types: +r.distinct_types,
      all_time: { n, wr: +(wr * 100).toFixed(1), ev: +ev.toFixed(2), real_n: realN, real_wr: realWr != null ? +(realWr * 100).toFixed(1) : null, real_ev: realEv != null ? +realEv.toFixed(2) : null },
      rigor: { distinctDates: rigor.distinctDates, top5DayPct: rigor.top5DayPct, clustered: rigor.clustered, stable: rigor.stable, thirds: rigor.thirds, clean: rigor.clean },
      // Phase 2 checkpoint (roadmap Part 6): "N in the hundreds" for the real, origin_status-
      // filtered population -- not blended N, which is >90% synthetic per the 2026-08-04
      // origin_status census (docs/OPEN_THREADS.md). Surfaced here so a future session can
      // check this field instead of re-deriving it.
      phase2_ready: realN >= 200,
    };

    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
      VALUES ($1, 0, $2, $3, $4, $5, $6, $7, 'ANALYSIS_ONLY', $8)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size=$4, win_rate=$5, ev_per_trade=$6, total_pnl=$7, recommendation='ANALYSIS_ONLY', notes=$8
    `, [today, SIGNAL_TYPE, betClass, n, +(wr * 100).toFixed(1), +ev.toFixed(2), +r.total_pnl.toFixed(2), JSON.stringify(notes)]);
  }

  // Record/refresh a standing RESEARCH_CLAIM tracking Phase 2 readiness for VALUE_FADE
  // specifically (the roadmap's own Setup A consolidation target) -- lets
  // `node scripts/record_claim.mjs --list` surface "is Phase 2 ready to start" without a
  // manual query, and its 30-day recheck keeps this current as real N grows.
  const vf = rowsByClass.get('VALUE_FADE');
  const vfRealN = vf?.real_n != null ? +vf.real_n : 0;
  const vfRealEv = vf?.real_ev != null ? +vf.real_ev : null;
  await recordClaim({
    slug: 'bet_class_value_fade_phase2_readiness',
    claimText: `VALUE_FADE (the roadmap's Setup A consolidation of the ${vf?.distinct_types ?? '~166'}-type fade roster) real (origin_status-filtered) N=${vfRealN}, real EV=$${vfRealEv != null ? vfRealEv.toFixed(2) : 'n/a'}/trade. Phase 2's own checkpoint requires real N in the hundreds before a consolidated-N affordable-stop resweep is defensible -- ${vfRealN >= 200 ? 'THRESHOLD CLEARED, Phase 2 can start' : `not yet cleared (${200 - vfRealN} more real trades needed at the current ${vfRealN >= 20 ? 'accumulation rate' : 'very early stage'})`}. This claim self-updates on every run of scripts/backtest_bet_class_status.mjs (weekly).`,
    sourceFile: 'scripts/backtest_bet_class_status.mjs',
    sourceDate: today,
    sampleSize: vfRealN,
    winRate: vf?.real_wr != null ? +(+vf.real_wr * 100).toFixed(1) : null,
    evPerTrade: vfRealEv,
    rigorStatus: vfRealN < 20 ? 'too_thin_to_assess' : 'tracked_weekly_not_yet_a_decision',
    status: 'PROVISIONAL',
  });

  console.log(`\n[backtest_bet_class_status] done`);
  await pool.end();
}

run().catch(e => { console.error('[backtest_bet_class_status] ERROR:', e.message); process.exit(1); });
