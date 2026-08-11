/**
 * Roster-rebuild roadmap Phase 2 (extended) — CONTINUATION_LEGACY consolidated resweep.
 *
 * Not one of the roadmap's own A-F setups — scratch/MASTER_OPUS_ROSTER_REBUILD_ROADMAP.md
 * explicitly carves CONTINUATION_LEGACY out as a third bucket, distinct from both the
 * ~130-type fade roster (Setup A's target) and the not-yet-built B-F setups, and the
 * roadmap's own Part 6 build sequence never schedules a validation pass for it. Built
 * 2026-08-11 per direct user decision (after seeing VALUE_FADE's Phase 2 result land on
 * SHIP_FLAT/not-rigor-clean, and given CONTINUATION_LEGACY's real EV already looks
 * stronger — see OPEN_DECISION continuation_legacy_reprioritization_still_open) to apply
 * the exact same Stage 1 methodology here before deciding whether to build the roadmap's
 * next brand-new setup (Setup B) or deepen these 15 already-live bets instead.
 *
 * STAGE 0 PRE-REGISTRATION (written before this script was run, per Part 5 Stage 0):
 *
 *   Bet: directional momentum persists (the 15 pre-existing continuation-shaped bets --
 *     IB_BULLISH/BEARISH, OPEN_DRIVE_LONG/SHORT, BRACKET_BREAKOUT_LONG/SHORT,
 *     STACK_VOL_BREAK_LIVE_LONG/SHORT, C_STANDALONE_UP/DOWN, A_UP/DOWN_STRONG/WEAK,
 *     C_PAIRED_LONG/SHORT, MOMENTUM_60m_60m_TREND, VWAP_RECLAIM_SHORT -- pooled as ONE
 *     bet_class='CONTINUATION_LEGACY' population), pooled the same way VALUE_FADE was.
 *   Mechanism: trend continuation -- the structural OPPOSITE of Setup A's mean-reversion
 *     thesis. Expected to work on TREND days, expected to be neutral-to-negative on
 *     BALANCE/TURBULENT days (roadmap 1.3's own framing, applied to the inverse bet).
 *     Regime tagging can't condition on this yet (I1 shipped 2026-08-10) -- see the
 *     regime-coverage note in the persisted result.
 *   Entry/exit/gates: entry = whatever each live setup's own detection logic already
 *     fires on (unchanged by this script); exit = a stop/target pair swept from the
 *     UNCENSORED bar-history surface, identical methodology to the VALUE_FADE resweep
 *     (scripts/lib/betClassPhase2Resweep.mjs -- same primitives, same walk-forward, same
 *     flat-default comparison, so the two results are directly comparable, not just
 *     independently computed).
 *   Population: origin_status IN ('ACTIVE','SHADOW') only.
 *   Pre-registered success threshold: identical to VALUE_FADE's -- walk-forward OOS EV
 *     > $0/trade that beats the flat volatility-scaled default AND is sign-stable across
 *     the 3 chronological thirds.
 *   Pre-registered kill condition: OOS EV <= $0/trade under BOTH arms -- would mean the
 *     already-known-positive real EV (+$15.27/trade, unswept, RESEARCH_CLAIM
 *     bet_class_value_fade_phase2_readiness) doesn't survive a properly calibrated
 *     stop/target either, the same overfitting risk VALUE_FADE's resweep just exposed.
 *   Known limitation: same as VALUE_FADE's -- real history is only weeks long, weekly
 *     (not monthly) walk-forward folds, likely even thinner here since CONTINUATION_LEGACY
 *     has less than 1/6th of VALUE_FADE's real N.
 *   Correlation: not tested here -- these 15 types firing off genuinely different
 *     detection logic (IB break, opening drive, bracket breakout, etc.) rather than one
 *     parameterized bet, unlike VALUE_FADE's ~166 level variants of a single idea. Whether
 *     they're correlated with EACH OTHER (the roadmap's I5 correlation-monitor concern) is
 *     a separate, not-yet-built check -- this resweep only asks whether the POOLED bet
 *     survives a real stop/target sweep, same question asked of VALUE_FADE.
 *
 * Shared methodology: scripts/lib/betClassPhase2Resweep.mjs.
 * Writes performance_audit rows with signal_type='BET_CLASS_RESWEEP', signal_name=
 * 'CONTINUATION_LEGACY', and a RESEARCH_CLAIM (continuation_legacy_bet_class_phase2_stage1_backtest).
 * Run: node scripts/backtest_continuation_legacy_bet_class_phase2.mjs
 */

import { runBetClassPhase2Resweep } from './lib/betClassPhase2Resweep.mjs';

runBetClassPhase2Resweep({
  betClass: 'CONTINUATION_LEGACY',
  claimSlug: 'continuation_legacy_bet_class_phase2_stage1_backtest',
  scriptFile: 'scripts/backtest_continuation_legacy_bet_class_phase2.mjs',
  decisionSlug: 'continuation_legacy_reprioritization_still_open',
  mechanismNote: 'Trend-continuation thesis (the structural opposite of VALUE_FADE\'s mean-reversion bet) -- same Stage 1 methodology applied to test whether the already-known-positive raw real EV (+$15.27/trade, unswept) survives a properly calibrated stop/target.',
  regimeNote: 'Regime-tag coverage is near-zero as expected since day_type_at_fire tagging (roadmap I1) shipped 2026-08-10, so this run cannot yet condition on TREND-vs-BALANCE (the thesis-relevant split for a continuation bet); re-run once regime-tagged real N accumulates.',
}).catch(e => { console.error('[bet_class_phase2] ERROR:', e); process.exit(1); });
