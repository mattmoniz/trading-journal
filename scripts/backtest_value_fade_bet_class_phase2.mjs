/**
 * Roster-rebuild roadmap Phase 2 — Setup A (Value Fade) consolidation.
 * scratch/MASTER_OPUS_ROSTER_REBUILD_ROADMAP.md Part 3 "Setup A" / Part 6 "Phase 2".
 *
 * STAGE 0 PRE-REGISTRATION (written before this script was first run, 2026-08-10 — see
 * Part 5 Stage 0, "a hypothesis formed after seeing the result is not a hypothesis." Setup
 * A is a consolidation of an already-running roster, not a from-scratch idea, so this is
 * necessarily somewhat retrospective — but the specific numeric question below had not
 * been asked at bet_class-pooled N before this script existed):
 *
 *   Bet: price returns to established value (any of the ~166 existing *_FADE-family
 *     level types, pooled as ONE bet_class='VALUE_FADE' population) after extending
 *     away from it.
 *   Mechanism: mean reversion. Expected to work on BALANCE days, expected to lose on
 *     TREND days (roadmap 1.3/3-A) — regime tagging can't condition on this yet, see the
 *     regime-coverage note in the persisted result.
 *   Entry/exit/gates: entry = whatever the live candidate array already fires on
 *     (unchanged by this script); exit = a stop/target pair swept from the UNCENSORED
 *     bar-history surface (update_optimal_stops.mjs's shared chronological-sweep
 *     primitives — imported, never reimplemented), never derived from the setup's own
 *     already-resolved mae_points/mfe_points (right-censored by whatever stop was live
 *     at the time).
 *   Population: origin_status IN ('ACTIVE','SHADOW') only.
 *   Pre-registered success threshold: a walk-forward OOS EV > $0/trade that (a) beats the
 *     flat volatility-scaled default ("if the flat version wins, the calibration is
 *     overfitting and the setup ships flat," roadmap Stage 1) and (b) is sign-stable
 *     across the 3 chronological thirds of the OOS sample (computeRigor).
 *   Pre-registered kill condition: OOS EV <= $0/trade under BOTH arms.
 *   Known limitation: real history is only weeks long (origin_status tracking began
 *     2026-07-17) — nowhere near the roadmap's "months 1..T, roll" framing. Uses WEEKLY
 *     walk-forward folds as the closest honest analog; re-run at monthly cadence once
 *     real history extends past a few months (scripts/lib/betClassPhase2Resweep.mjs's
 *     FOLD_DAYS is a named constant for exactly that future change).
 *   Correlation: N/A — Setup A is the pre-existing base roster.
 *
 * What this script does NOT do: touch any live stop/target lookup, change what fires
 * live, or retire any individual setup_type. It answers the roadmap's Phase 2 checkpoint
 * question ("a defensible number for VALUE_FADE EV at an affordable stop, from real data,
 * with N in the hundreds").
 *
 * Shared methodology lives in scripts/lib/betClassPhase2Resweep.mjs (extracted 2026-08-11
 * when the sibling CONTINUATION_LEGACY resweep was built, to avoid hand-copying the same
 * ~200 lines twice — see that file's header).
 *
 * Writes performance_audit rows with signal_type='BET_CLASS_RESWEEP', signal_name=
 * 'VALUE_FADE', and a RESEARCH_CLAIM (value_fade_bet_class_phase2_stage1_backtest).
 * Run: node scripts/backtest_value_fade_bet_class_phase2.mjs
 */

import { runBetClassPhase2Resweep } from './lib/betClassPhase2Resweep.mjs';

runBetClassPhase2Resweep({
  betClass: 'VALUE_FADE',
  claimSlug: 'value_fade_bet_class_phase2_stage1_backtest',
  scriptFile: 'scripts/backtest_value_fade_bet_class_phase2.mjs',
  decisionSlug: 'bet_class_phase2_consolidated_resweep_not_started',
  mechanismNote: 'This is the roadmap\'s "172-398pt question... at a sample size that can answer it," answered.',
  regimeNote: 'Regime-tag coverage is near-zero as expected since day_type_at_fire tagging (roadmap I1) shipped 2026-08-10, so this run cannot yet condition on BALANCE-vs-TREND; re-run once regime-tagged real N accumulates.',
}).catch(e => { console.error('[bet_class_phase2] ERROR:', e); process.exit(1); });
