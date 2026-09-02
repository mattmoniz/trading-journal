// Part 3 of OPEN_DECISION wire_flush_post_entry_exit_signals_globex: the real promotion/
// retirement trigger for the post-entry exit signals acd.js's resolveSetupsByPrice() has been
// persisting onto open GLOBEX_FLUSH_* positions (active_setups.post_entry_exit_signals) since
// 2026-09-02. Once a mechanism/mode combination accumulates N>=20 real (ACTIVE/SHADOW-origin)
// fires, re-runs computeRigor() on the REAL paired delta (hypothetical_pnl - actual_pnl, i.e.
// "would this exit have beaten what the trade's real target/stop actually did"), segmented
// ALL-fires vs BIG-MOVE-ONLY (top tercile by realized mfe_points) per CLAUDE.md's pooled-
// verdict-hides-opposite-signed-subgroups mantra and per the decision's own explicit
// requirement -- "catch more of a big move" is the whole point of this thread, not marginal
// average EV. Below N=20, this is a silent no-op (the pilot-derived PROVISIONAL claim already
// stands) -- once N clears 20, this ALWAYS writes a fresh verdict (CONFIRMED positive -> flags
// a new OPEN_DECISION proposing to actually change globexFlushDetector.js's live target logic;
// CONFIRMED negative -> closes the mechanism out) so nothing sits at PROVISIONAL indefinitely.
//
// Run manually via node, or scheduled in run_weekly_backtests.sh -- not imported by the app.

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { flagDecision } from './flag_decision.mjs';

const MIN_REAL_N = 20;

// Mirrors RANGE_SLOPE_LIVE_CONFIG/VOL_ROLLOVER_LIVE_CONFIG in pilot_exits_extended.mjs --
// only mode combinations acd.js actually tracks live have a promotion path here.
const MECHANISMS = [
  { key: 'range_slope', modes: ['CONTINUATION', 'REVERSAL'], claimSlug: 'flush_post_entry_range_expansion_slope_exit' },
  { key: 'vol_rollover', modes: ['REVERSAL'], claimSlug: 'flush_post_entry_volume_rollover_exit' },
];

function modeOf(setupType) {
  return setupType.includes('REVERSAL') ? 'REVERSAL' : 'CONTINUATION';
}

function evalBucket(bucket, mechKey) {
  if (bucket.length < MIN_REAL_N) return { n: bucket.length, thin: true };
  const delta = (r) => Number(r.post_entry_exit_signals[mechKey].hypothetical_pnl) - Number(r.actual_pnl);
  const avgDelta = bucket.reduce((s, r) => s + delta(r), 0) / bucket.length;
  const rigor = computeRigor(bucket, { dateField: 'trade_date', pnlFn: delta });
  const beatsBaseline = avgDelta > 0 && !!rigor?.clean && !!rigor?.stable;
  return { n: bucket.length, avgDelta, rigor, beatsBaseline, thin: false };
}

async function main() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  const { rows } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, actual_pnl::float as actual_pnl,
           mfe_points::float as mfe_points, post_entry_exit_signals
    FROM active_setups
    WHERE setup_type LIKE 'GLOBEX_FLUSH%'
      AND origin_status IN ('ACTIVE','SHADOW')
      AND actual_pnl IS NOT NULL
      AND post_entry_exit_signals IS NOT NULL
  `);

  for (const m of MECHANISMS) {
    for (const mode of m.modes) {
      const fires = rows.filter(r => modeOf(r.setup_type) === mode && r.post_entry_exit_signals?.[m.key]);
      const n = fires.length;
      console.log(`\n=== ${m.key} / ${mode}: ${n} real fires ===`);
      if (n < MIN_REAL_N) {
        console.log(`  N=${n} < ${MIN_REAL_N} -- not enough real data yet, leaving PROVISIONAL as-is.`);
        continue;
      }

      const withMfe = fires.filter(f => f.mfe_points != null);
      let bigMoveOnly = [];
      if (withMfe.length >= 3) {
        const sorted = [...withMfe].sort((a, b) => a.mfe_points - b.mfe_points);
        const tercileCut = sorted[Math.floor(sorted.length * 2 / 3)].mfe_points;
        bigMoveOnly = fires.filter(f => f.mfe_points != null && f.mfe_points >= tercileCut);
      }

      const allResult = evalBucket(fires, m.key);
      const bigResult = evalBucket(bigMoveOnly, m.key);
      console.log(`  ALL: n=${allResult.n} avgDelta=${allResult.avgDelta?.toFixed(2)} beatsBaseline=${allResult.beatsBaseline} thin=${allResult.thin}`);
      console.log(`  BIG_MOVE_ONLY: n=${bigResult.n} avgDelta=${bigResult.avgDelta?.toFixed(2)} beatsBaseline=${bigResult.beatsBaseline} thin=${bigResult.thin}`);

      const promoted = allResult.beatsBaseline || bigResult.beatsBaseline;
      const slug = `${m.claimSlug}_live_verdict`;

      if (promoted) {
        const which = bigResult.beatsBaseline && !allResult.beatsBaseline ? 'BIG_MOVE_ONLY only' :
          allResult.beatsBaseline && !bigResult.beatsBaseline ? 'ALL only' : 'both ALL and BIG_MOVE_ONLY';
        await recordClaim({
          slug,
          claimText: `LIVE VERDICT (real ${mode}-mode ${m.key} fires on open GLOBEX_FLUSH_* positions, N=${n}): beats the trade's own real actual_pnl on ${which}. ALL: n=${allResult.n}, avgDelta=$${allResult.avgDelta?.toFixed(2)}/trade, rigor clean=${allResult.rigor?.clean} stable=${allResult.rigor?.stable} top5DayPct=${allResult.rigor?.top5DayPct}%. BIG_MOVE_ONLY (top tercile by mfe_points): n=${bigResult.n}, avgDelta=${bigResult.thin ? 'N<20, thin' : '$' + bigResult.avgDelta?.toFixed(2) + '/trade, rigor clean=' + bigResult.rigor?.clean + ' stable=' + bigResult.rigor?.stable}. Promoting to CONFIRMED and flagging a live-wiring decision.`,
          sourceFile: 'scripts/backtest_flush_post_entry_exit_signals_promotion.mjs',
          sourceDate: today,
          sampleSize: n,
          evPerTrade: allResult.avgDelta,
          rigorStatus: allResult.rigor?.clean ? 'clean' : 'unclean',
          status: 'CONFIRMED',
        });
        await flagDecision({
          slug: `promote_${m.key}_${mode.toLowerCase()}_to_globex_flush_live_target`,
          decisionText: `${m.key} (${mode} mode) cleared its real-N promotion bar (N=${n}, MIN_REAL_N=${MIN_REAL_N}) via scripts/backtest_flush_post_entry_exit_signals_promotion.mjs -- beats the trade's own real actual_pnl on ${which}, rigor-clean+stable. Per OPEN_DECISION wire_flush_post_entry_exit_signals_globex's original spec: this is the point where a human decision is needed on whether to actually change globexFlushDetector.js's live target logic for ${mode}-mode GLOBEX_FLUSH_* trades to use this exit instead of the current fixed/tiered target, not an automatic live-wiring flip. See RESEARCH_CLAIM ${slug} for the full numbers.`,
          sourceFile: 'scripts/backtest_flush_post_entry_exit_signals_promotion.mjs',
        });
        console.log(`  -> PROMOTED. Flagged OPEN_DECISION promote_${m.key}_${mode.toLowerCase()}_to_globex_flush_live_target.`);
      } else {
        await recordClaim({
          slug,
          claimText: `LIVE VERDICT (real ${mode}-mode ${m.key} fires on open GLOBEX_FLUSH_* positions, N=${n}): does NOT beat the trade's own real actual_pnl on either bucket once real N cleared ${MIN_REAL_N}. ALL: n=${allResult.n}, avgDelta=$${allResult.avgDelta?.toFixed(2)}/trade, rigor clean=${allResult.rigor?.clean} stable=${allResult.rigor?.stable}. BIG_MOVE_ONLY: n=${bigResult.n}, avgDelta=${bigResult.thin ? 'N<20, thin' : '$' + bigResult.avgDelta?.toFixed(2) + '/trade, rigor clean=' + bigResult.rigor?.clean + ' stable=' + bigResult.rigor?.stable}. Closing out negative -- real forward data didn't confirm the pilot's sweep result.`,
          sourceFile: 'scripts/backtest_flush_post_entry_exit_signals_promotion.mjs',
          sourceDate: today,
          sampleSize: n,
          evPerTrade: allResult.avgDelta,
          rigorStatus: allResult.rigor?.clean ? 'clean_but_negative' : 'unclean',
          status: 'CONFIRMED',
        });
        console.log(`  -> RESOLVED negative. Recorded RESEARCH_CLAIM ${slug}.`);
      }
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
