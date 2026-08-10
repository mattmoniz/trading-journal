// =============================================================================
// Day-type-conditioned breakeven-then-trail test for IB_BULLISH/IB_BEARISH.
//
// Resolves OPEN_DECISION extend_be_trail_to_bad_rr_live_setups: IB_BULLISH/IB_BEARISH
// are the highest-real-volume setup_types with a genuinely bad stop:target ratio
// (median ~1.08-1.56 across the live roster). breakeven-then-trail (backtest_breakeven_trail.mjs)
// is an already-validated mechanism for exactly this class of problem, wired live
// (SHADOW-only) for 6 fade-family setup_types — but never tested on IB, and never
// tested against a day-type-conditioned population.
//
// Both Gemini and DeepSeek independently critiqued the design before this was built
// (2026-08-03, scratch/antigravity_response.md + scratch/deepseek_response_v2.md) and
// converged on: split by day-type from the start (never blend — reintroduces the exact
// heterogeneity today's IB day-type OPTIMAL_STOP conditioning was built to fix), and
// run a cheap descriptive continuation check first (scratch/ib_daytype_posttarget_check.mjs
// confirmed real median post-target extension of 78-247pt across all 5 buckets, well
// past both models' "is there anything to trail" floor).
//
// Reuses testTrailForPopulation() from lib/breakevenTrailCore.mjs — the exact same
// bar-by-bar walk/pullback/plateau/IS-OOS/rigor pipeline the original 6 fade-family
// TRAIL survivors were validated with, not a reimplementation (see that file's header
// for why: a second hand-copy of this exact state machine is the failure class this
// codebase has been burned by before with classifyRegime()).
//
// Trade population + day_type join follows backtest_ib_daytype_stop_target.mjs's own
// established pattern (JOIN acd_daily_log ON trade_date, require non-null day_type).
// Writes BREAKEVEN_TRAIL_TEST rows keyed `{tier}_{setup_type}_{day_type}` (e.g.
// A_IB_BEARISH_TURBULENT) — this naming is disjoint from anything the blended script
// in backtest_breakeven_trail.mjs could ever produce (that script's setupType keys are
// literal active_setups.setup_type values, which never carry a _BALANCE/_TREND/
// _TURBULENT suffix), so each script's own stale-row cleanup can stay scoped to its own
// namespace without a cross-script overwrite race (see
// conditional_variant_setup_status_daily_overwrite_race for the bug class this avoids).
// =============================================================================

import { query } from '../server/db.js';
import fs from 'fs';
import {
  testTrailForPopulation, MIN_N,
} from './lib/breakevenTrailCore.mjs';

const SETUP_TYPES = ['IB_BEARISH', 'IB_BULLISH'];
const DAY_TYPES = ['BALANCE', 'TREND', 'TURBULENT'];

async function main() {
  console.log('Loading day-type OPTIMAL_STOP rows...');
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, optimal_stop::float as stop, optimal_target::float as target
    FROM performance_audit
    WHERE signal_type='OPTIMAL_STOP' AND signal_name ~ '^(IB_BEARISH|IB_BULLISH)_(BALANCE|TREND|TURBULENT)$'
    ORDER BY signal_name, run_date DESC
  `);
  const optMap = {};
  for (const r of optRes.rows) optMap[r.signal_name] = { stop: r.stop, target: r.target };
  console.log('Buckets with a calibrated row:', Object.keys(optMap));

  console.log('Loading real resolved IB trades joined to day_type...');
  const tradesRes = await query(`
    SELECT a.setup_type, d.day_type, a.fired_at, a.entry_zone_low::float as entry_zone_low,
      a.entry_zone_high::float as entry_zone_high, a.actual_pnl::float as actual_pnl,
      a.resolution, a.replay_resolution
    FROM active_setups a
    JOIN acd_daily_log d ON d.trade_date = a.trade_date
    WHERE a.setup_type = ANY($1)
      AND a.status IN ('RESOLVED', 'EXPIRED')
      AND a.mae_points IS NOT NULL AND a.mfe_points IS NOT NULL
      AND a.mae_points <= 300 AND a.mfe_points <= 300
      AND a.entry_zone_low IS NOT NULL
      AND d.day_type IS NOT NULL
      AND a.origin_status IN ('ACTIVE', 'SHADOW')
    ORDER BY a.fired_at ASC
  `, [SETUP_TYPES]);
  // preflight_backtest_assertions.mjs check [1], roadmap Phase 0 sweep, 2026-08-10: the
  // "real IB trades" language above and in the log line below was aspirational, not actual
  // -- this query had no origin_status filter until now, despite IB_BULLISH/IB_BEARISH being
  // this system's only currently fully-live-firing-eligible RTH family. Added the same
  // filter every other IB day-type calibration path already uses (see
  // backtest_ib_daytype_stop_target.mjs).

  const byCell = {};
  for (const t of tradesRes.rows) {
    const key = `${t.setup_type}_${t.day_type}`;
    (byCell[key] ??= []).push(t);
  }
  console.log(`${tradesRes.rows.length} real IB trades across ${Object.keys(byCell).length} (setup_type, day_type) cells.`);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), dateObj: new Date(b.ts), high: b.high, low: b.low, close: b.close }));

  const barRangeRes = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high-low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
  const MIN_TRAIL_WIDTH = parseFloat(barRangeRes.rows[0].median_range);
  const MIN_TIGHT_TRAIL = 2 * MIN_TRAIL_WIDTH;

  const cells = Object.keys(byCell).filter(key => {
    if (!optMap[key]) return false;
    const ts = byCell[key].filter(t => t.replay_resolution === 'TARGET_HIT' || t.resolution === 'TARGET_HIT');
    return ts.length >= MIN_N;
  });
  console.log('Cells clearing MIN_N=20 TARGET_HIT (historical) with a calibrated row:', cells);

  const results = { A: {}, B: {} };
  const funnel = { A: { total: cells.length, tooFewWalked: 0, noPullbackData: 0, thinTail: 0, noPlateauPass: 0, failedOosOrBaseline: 0, notRigorClean: 0, survived: 0 },
                   B: { total: cells.length, tooFewWalked: 0, noPullbackData: 0, thinTail: 0, noPlateauPass: 0, failedOosOrBaseline: 0, notRigorClean: 0, survived: 0 } };

  let responseMd = '# IB Day-Type-Conditioned Breakeven-Then-Trail Test Results\n\n';

  for (const tier of ['A', 'B']) {
    responseMd += `## Tier ${tier} (${tier === 'A' ? 'Snug Trail / Take-a-little-extra' : 'Real Runner / Continuation Capture'})\n\n`;

    for (const cell of cells) {
      const trades = byCell[cell];
      const { stop, target: originalTarget } = optMap[cell];
      const long = cell.startsWith('IB_BULLISH');

      const outcome = testTrailForPopulation({
        trades, long, stop, originalTarget, allBars, tier,
        minTrailWidth: MIN_TRAIL_WIDTH, minTightTrail: MIN_TIGHT_TRAIL,
      });

      funnel[tier][outcome.funnelReason] = (funnel[tier][outcome.funnelReason] ?? 0) + 1;
      if (outcome.funnelReason !== 'survived') continue;

      const r = outcome.result;
      results[tier][cell] = r;

      responseMd += `### ${cell}\n- **Baseline (stop=${stop}/target=${originalTarget})**\n- **T1 Reach Count**: ${r.t1Reached}\n- **Best Config**: Trail=${r.trail}pt\n- **Baseline EV (100% T1, full)**: $${r.baselineEv.toFixed(2)}\n- **Baseline EV (100% T1, OOS)**: $${r.baselineOosEv.toFixed(2)}\n- **Breakeven-Then-Trail EV (full)**: $${r.fullEv.toFixed(2)}\n- **Breakeven-Then-Trail EV (OOS)**: $${r.oosEv.toFixed(2)}\n- **Breakeven Scratch Rate**: ${(r.scratchRate * 100).toFixed(1)}% (${r.scratches}/${r.t1Wins} T1-reaches scratched)\n- **2D Grid Trail Neighbors**: ${r.trailNeighborsNotes}\n\n`;
    }
    if (Object.keys(results[tier]).length === 0) {
      responseMd += `No cells survived Tier ${tier}.\n\n`;
    }
  }

  console.log('Guardrail funnel Tier A:', JSON.stringify(funnel.A));
  console.log('Guardrail funnel Tier B:', JSON.stringify(funnel.B));

  fs.writeFileSync('scratch/ib_daytype_breakeven_trail_report.md', responseMd);
  console.log('Done, wrote results to scratch/ib_daytype_breakeven_trail_report.md');

  const todayRow = await query(`SELECT CURRENT_DATE::text as d`);
  const today = todayRow.rows[0].d;

  const allSurvivorNames = [];
  for (const tier of ['A', 'B']) {
    for (const [cell, r] of Object.entries(results[tier])) {
      const signalName = `${tier}_${cell}`;
      allSurvivorNames.push(signalName);
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
        VALUES ($1, 0, 'BREAKEVEN_TRAIL_TEST', $2, $3, $4, $5)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
          SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
      `, [today, signalName, r.t1Reached, r.fullEv, JSON.stringify(r)]);
    }
  }

  // Scoped ONLY to the day-type-suffixed IB namespace this script owns — never touches
  // rows the blended backtest_breakeven_trail.mjs wrote or manages.
  const staleRes = await query(`
    DELETE FROM performance_audit
    WHERE signal_type='BREAKEVEN_TRAIL_TEST'
      AND signal_name ~ '^[AB]_(IB_BEARISH|IB_BULLISH)_(BALANCE|TREND|TURBULENT)$'
      AND NOT (signal_name = ANY($1))
    RETURNING signal_name
  `, [allSurvivorNames]);
  if (staleRes.rows.length) console.log(`Cleaned up ${staleRes.rows.length} stale row(s) no longer surviving: ${staleRes.rows.map(r => r.signal_name).join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
