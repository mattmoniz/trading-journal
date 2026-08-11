/**
 * Roster-rebuild roadmap Phase 7 — Setup F (Globex Level Test) consolidation.
 * scratch/MASTER_OPUS_ROSTER_REBUILD_ROADMAP.md Part 3 "Setup F" / Part 6 "Phase 7".
 *
 * STAGE 0 PRE-REGISTRATION (written same day the bet_class fix landed, 2026-08-11 — see
 * Part 5 Stage 0). Setup F, like Setup A, is a consolidation of an already-running roster
 * (detectGlobexSetup(), server/routes/acd.js), not a from-scratch idea:
 *
 *   Bet: overnight/Globex levels hold or reject during the low-liquidity session (the
 *     original PD_VAH/VAL/POC fades plus the GLOBEX_VWAP_MAGNET/FADE family plus the 8
 *     wider-window _OVERNIGHT types, pooled as ONE bet_class='GLOBEX_LEVEL' population).
 *   Mechanism: mean reversion, same shape as Setup A, but structurally different session
 *     (different liquidity, different participants, per the roadmap's own Part 3 framing)
 *     — kept as its own bet_class rather than folded into VALUE_FADE for exactly that
 *     reason, not because the underlying trade logic differs.
 *   Entry/exit/gates: entry = whatever detectGlobexSetup() already fires on (unchanged by
 *     this script); exit = a stop/target pair swept from the UNCENSORED bar-history
 *     surface (update_optimal_stops.mjs's shared chronological-sweep primitives, imported
 *     not reimplemented), never derived from the setup's own already-resolved mae_points/
 *     mfe_points.
 *   Population: origin_status IN ('ACTIVE','SHADOW') only.
 *   Pre-registered success threshold / kill condition: identical to Setup A's — OOS EV
 *     beats the flat volatility-scaled default AND is sign-stable across the 3
 *     chronological thirds (computeRigor), else ships flat / kills.
 *
 * IMPORTANT PROVENANCE NOTE, not a footnote: this script only became possible to run
 * correctly today. Found live, same session: detectGlobexSetup()'s own INSERT was calling
 * getBetClass(c.type) for its bet_class column -- but 4 of its own setup_type names
 * (PD_VAH_FADE_SHORT/PD_VAL_FADE_LONG/PD_POC_FADE_SHORT/PD_POC_FADE_LONG) are IDENTICAL
 * strings to their RTH siblings, so getBetClass() silently classified every Globex fire of
 * those 4 as 'VALUE_FADE' (name-based inference has no way to know which session fired
 * it). Confirmed live: 5,132 historical rows across the 12 UNAMBIGUOUS Globex-only type
 * names (GLOBEX_VWAP_MAGNET/FADE + the 8 _OVERNIGHT types) were ALSO mistagged
 * 'VALUE_FADE' this whole time (getBetClass() itself had no GLOBEX_LEVEL branch at all
 * until today). Backfilled those 12 types' historical bet_class to 'GLOBEX_LEVEL' (backup:
 * active_setups_globex_betclass_backup_20260811) and fixed detectGlobexSetup()'s INSERT to
 * hardcode 'GLOBEX_LEVEL' directly (it has ground truth -- every row it writes IS a Globex
 * fire -- so it doesn't need getBetClass()'s name-based inference at all). The 4 ambiguous
 * PD_VAH/VAL/POC names are NOT backfilled (their historical rows are overwhelmingly
 * RTH-fired and correctly VALUE_FADE; the small Globex-fired subset among them is not yet
 * separable without a session-aware backfill) -- see OPEN_DECISION
 * globex_ambiguous_names_need_session_backfill. Re-running the EARLIER
 * VALUE_FADE Phase 2 resweep after this fix (scripts/backtest_value_fade_bet_class_
 * phase2.mjs) found its real population had been ~15% contaminated by these mislabeled
 * Globex rows (228 of 1525) -- corrected and re-recorded in place (RESEARCH_CLAIM
 * value_fade_bet_class_phase2_stage1_backtest, still SHIP_FLAT, numbers updated).
 *
 * Shared methodology: scripts/lib/betClassPhase2Resweep.mjs (same core as Setup A/B's
 * bet_class resweeps).
 *
 * Writes performance_audit rows with signal_type='BET_CLASS_RESWEEP', signal_name=
 * 'GLOBEX_LEVEL', and a RESEARCH_CLAIM (globex_level_bet_class_phase7_stage1_backtest).
 * Run: node scripts/backtest_globex_level_bet_class_phase7.mjs
 */

import { runBetClassPhase2Resweep } from './lib/betClassPhase2Resweep.mjs';

runBetClassPhase2Resweep({
  betClass: 'GLOBEX_LEVEL',
  claimSlug: 'globex_level_bet_class_phase7_stage1_backtest',
  scriptFile: 'scripts/backtest_globex_level_bet_class_phase7.mjs',
  decisionSlug: 'globex_level_bet_class_phase7_not_started',
  mechanismNote: 'Setup F is the highest-real-N population in the system (GLOBEX_VWAP_MAGNET_LONG alone has real_n~88+, the largest of any single setup_type) -- this is the roadmap\'s own "keep this" call for exactly that reason, pooled at bet_class level for the first time.',
  regimeNote: 'Regime dependence is overnight volatility regime, measured separately from RTH per the roadmap -- day_type_at_fire tagging (roadmap I1) is an RTH-session concept and does not apply to Globex fires; this run cannot condition on overnight regime yet (no equivalent tag exists), a real gap worth a future I1-style addition scoped to Globex.',
}).catch(e => { console.error('[bet_class_phase7] ERROR:', e); process.exit(1); });
