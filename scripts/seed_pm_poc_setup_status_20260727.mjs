// scripts/seed_pm_poc_setup_status_20260727.mjs
// One-off: seed SETUP_STATUS rows for PM_POC_FADE_LONG/SHORT before wiring PM_POC_FADE
// into acd.js's keepLevelsAll — per CLAUDE.md's "new setup type checklist" item 11
// (a level with zero real active_setups history is NOT automatically SHADOW-safe; an
// absent SETUP_STATUS row means "not suppressed", so it would fire as a full
// unsuppressed ACTIVE candidate on its very first real touch). Same pattern as the
// 2026-07-19 3M_VAL_FADE/PY_POC_FADE/PY_VAL_FADE seeds.
//
// Source data: scripts/backtest_pm_poc_short_reverify_20260727.mjs (sweepOptimalStopAndTarget
// re-derivation on corrected level_prices data, following the volume-profile bucketing fix),
// docs/WIDER_WINDOW_BACKTEST_20260720.md's independent flat-90/40 check, AND a THIRD,
// fully independent re-derivation dispatched to Gemini (own methodology, own queries, not
// shown this script) which landed on the same N=29/both-directions, the same fragile
// single-digit-point optimal stop, and the same stability-check failure — full report:
// scratch/gemini_independent_verification_pm_poc_20260727.md. All three agree:
// PM_POC_FADE_SHORT is a real, thin, positive-but-chronologically-unstable candidate
// (N=29 fires/27 decided, sweep stop=9pt/target=50pt EV=$7.89/trade sweep-estimate,
// re-simulated N=29 WR=24.1% EV=$9.48/trade, Gemini independently: stop=9pt/target=53.75pt
// EV=$11.29/trade — rigor: NOT stable, 3rd third turns negative in both derivations) —
// seeded THIN_N, not ACTIVE/PROMOTE, since it hasn't cleared this codebase's own stability
// bar. PM_POC_FADE_LONG is weak/unstable on all three checks (flat-rule doc: -$27.86/-$25.22;
// this sweep: WR=20.7%, EV=$1.28; Gemini: WR=20.7%, EV=$5.41, also stability-unstable) —
// seeded SUPPRESS.
import { recordClaim } from './record_claim.mjs';
import { query } from '../server/db.js';

async function seedStatus({ signalName, recommendation, winRate, sampleSize, notes }) {
  const { rows } = await query(`SELECT CURRENT_DATE::text as today`);
  const today = rows[0].today;
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, recommendation, notes)
    VALUES ($1, 0, 'SETUP_STATUS', $2, $3, $4, $5, $6)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size = EXCLUDED.sample_size, win_rate = EXCLUDED.win_rate,
          recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
  `, [today, signalName, sampleSize, winRate, recommendation, JSON.stringify(notes)]);
  console.log(`Seeded SETUP_STATUS ${signalName} -> ${recommendation}`);
}

async function main() {
  await seedStatus({
    signalName: 'PM_POC_FADE_SHORT',
    recommendation: 'THIN_N',
    winRate: 24.1,
    sampleSize: 29,
    notes: {
      source: 'manual seed — re-added to keepLevelsAll 2026-07-27 after the 2026-07-02 exclusion was found to be based on level_prices data corrupted by the volume-profile bucketing bug (fixed 2026-07-17)',
      reason: 'scripts/backtest_pm_poc_short_reverify_20260727.mjs: N=29 fires/27 decided, real sweepOptimalStopAndTarget()-derived stop=9pt/target=50pt, re-simulated N=29 WR=24.1% EV=$9.48/trade — real and positive but thin (sweep thin-tail gate only accepted the p25 MAE candidate; every wider percentile failed the requiredN floor) and chronologically UNSTABLE (3-way stability check fails — final third of history turns negative). Independently confirmed by Gemini (own methodology, not shown this script): N=29, stop=9pt/target=53.75pt, EV=$11.29/trade, same stability failure (scratch/gemini_independent_verification_pm_poc_20260727.md). Seeded THIN_N (not ACTIVE) since this has not cleared the rigor bar; backtest_setup_status.mjs will self-heal to a real calibration as live SHADOW touches accumulate, same self-healing pattern as every other THIN_N seed.',
      research_claim: 'pm_poc_fade_short_rth_reverify_20260727',
    },
  });
  await seedStatus({
    signalName: 'PM_POC_FADE_LONG',
    recommendation: 'SUPPRESS',
    winRate: 20.7,
    sampleSize: 29,
    notes: {
      source: 'manual seed — same 2026-07-27 re-verification pass as PM_POC_FADE_SHORT',
      reason: 'Three independent checks agree PM_POC_FADE_LONG is not a real edge: docs/WIDER_WINDOW_BACKTEST_20260720.md flat-90/40 rule (RTH EV=-$27.86, 24hr EV=-$25.22, N=29 both), this session\'s own sweepOptimalStopAndTarget() re-derivation (N=29, WR=20.7%, EV=$1.28/trade — noise-level), and Gemini\'s independent re-derivation (N=29, WR=20.7%, EV=$5.41/trade using a similarly fragile 9pt stop, also stability-unstable across chronological thirds). Seeded SUPPRESS so it never fires as a live alert; wired into keepLevelsAll anyway (SHORT and LONG share one entry) purely so real touches keep accumulating and backtest_setup_status.mjs can re-evaluate it on real data going forward.',
      research_claim: 'pm_poc_fade_short_rth_reverify_20260727',
    },
  });

  await recordClaim({
    slug: 'pm_poc_fade_short_rth_reverify_20260727',
    claimText: 'PM_POC_FADE_SHORT (RTH-only) is a real, positive-but-thin-and-chronologically-unstable candidate after correcting for the 2026-07-17 volume-profile bucketing bug that had corrupted the level data behind its original 2026-07-02 exclusion. Real sweepOptimalStopAndTarget()-derived stop=9pt/target=50pt, N=29 fires (27 decided), re-simulated WR=24.1% EV=$9.48/trade — but the sweep thin-tail gate only accepted the tightest (p25) MAE candidate, and the 3-way chronological stability check fails (final third negative). Independently confirmed via a from-scratch Gemini re-derivation (not shown this methodology): N=29, stop=9pt/target=53.75pt, EV=$11.29/trade, same stability failure — scratch/gemini_independent_verification_pm_poc_20260727.md. PM_POC_FADE_LONG remains a confirmed non-edge on all three independent checks (flat-rule doc, this sweep, and Gemini\'s). Resolved by wiring PM_POC_FADE (both directions) into acd.js keepLevelsAll, SHORT seeded THIN_N and LONG seeded SUPPRESS so neither fires as a live alert yet, and both accumulate real SHADOW data via the standard backtest_setup_status.mjs weekly pipeline going forward.',
    sourceFile: 'scripts/backtest_pm_poc_short_reverify_20260727.mjs',
    sourceDate: '2026-07-27',
    sampleSize: 29,
    winRate: 24.1,
    evPerTrade: 9.48,
    rigorStatus: 'independently_confirmed_unstable',
    status: 'PROVISIONAL',
  });

  console.log('Done.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
