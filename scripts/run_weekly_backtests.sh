#!/bin/bash
cd /home/mmoniz/trading-journal
echo "=== Weekly backtest run: $(date) ==="

# --- Core calibration pipeline (order matters: unified → stops → status) ---
/usr/bin/node scripts/backtest_unified.js
/usr/bin/node scripts/backfill_mae_mfe.mjs
/usr/bin/node scripts/update_optimal_stops.mjs
/usr/bin/node scripts/backtest_day_type_alpha.js
/usr/bin/node scripts/backtest_pulse_score.mjs
/usr/bin/node scripts/backtest_setup_status.mjs

# --- bet_class aggregation layer (roster-rebuild roadmap Phase 1, I3) — real N grows
# slowly, weekly is the right cadence (unlike per-type SUPPRESS/PROMOTE above, which
# needs daily). See scripts/backtest_bet_class_status.mjs's own header. ---
/usr/bin/node scripts/backtest_bet_class_status.mjs

# --- Bet_class Phase 2 Stage 1 resweeps (roadmap Phase 2 + extension) — both self-
# recalibrating, not one-offs: as real N grows, the walk-forward gets less thin and
# rigor.clean can turn true. Shared methodology: scripts/lib/betClassPhase2Resweep.mjs.
# VALUE_FADE: SHIP_FLAT, not rigor-clean (RESEARCH_CLAIM value_fade_bet_class_phase2_
# stage1_backtest). CONTINUATION_LEGACY: SHIP_CALIBRATED but also not rigor-clean yet
# (RESEARCH_CLAIM continuation_legacy_bet_class_phase2_stage1_backtest) — both 30-day
# recheck. ---
/usr/bin/node scripts/backtest_value_fade_bet_class_phase2.mjs
/usr/bin/node scripts/backtest_continuation_legacy_bet_class_phase2.mjs
# GLOBEX_LEVEL (roadmap Phase 7, Setup F consolidation) resweep, same
# betClassPhase2Resweep.mjs methodology as the two lines above -- found missing from this
# cron file during Phase 8 cleanup (2026-08-11), a real gap: the script existed and had
# already been run once manually, but was never wired in, so it would never self-recalibrate
# per this file's own standing "cron scripts with genuinely open findings" rule. Currently
# SHIP_FLAT, thin, not rigor-clean (RESEARCH_CLAIM globex_level_bet_class_phase7_stage1_backtest).
/usr/bin/node scripts/backtest_globex_level_bet_class_phase7.mjs

# Correlation monitor (roadmap Phase 8, I5, 2026-08-11) -- pairwise Pearson r on
# overlapping-real-trading-days-only daily P&L, both bet_class-level and (restricted to
# currently-live) setup_type-level. Alert-only (scratch/gemini_alerts.txt) on any pair
# overlap_N>=20 with |r|>0.6, the roadmap's own Stage 4 ceiling. Weekly per Part 6.5's
# cadence table (Part 4's own "Daily job" line disagrees with Part 6.5 within the same
# document -- resolved weekly, see this script's own header for the full reasoning,
# confirmed by DeepSeek design critique before being built).
/usr/bin/node scripts/monitor_bet_correlation.mjs

# --- Touch-quality (order-flow) calibration — feeds acd.js's live resolveSetupsByPrice
# classification (informational-only mid-trade flag) and the antigravity/edges-context
# card badge. See server/services/touchQuality.js and docs/OPEN_THREADS.md. ---
/usr/bin/node scripts/calibrate_touch_quality.mjs

# --- Conditional-variant backtests (maintain population stats for setup type overrides) ---
/usr/bin/node scripts/backtest_wpp_short_gap.mjs
/usr/bin/node scripts/backtest_or5_low_gap_down.mjs
/usr/bin/node scripts/backtest_momentum60_daytype.mjs
/usr/bin/node scripts/backtest_ib_daytype_stop_target.mjs
# Breakeven-then-trail trail-width calibration for FLOOR_R1_FADE_SHORT_TRAIL (and any of
# the other 5 backtested survivors once they're wired live) — see
# docs/SCALEOUT_RUNNER_SPEC.md. Writes performance_audit signal_type='BREAKEVEN_TRAIL_TEST',
# read live by acd.js at insert time (never hardcode the trail width).
/usr/bin/node scripts/backtest_breakeven_trail.mjs
# Day-type-conditioned breakeven-then-trail test for IB_BULLISH/IB_BEARISH (resolves
# extend_be_trail_to_bad_rr_live_setups) — 0/5 day-type buckets survived as of 2026-08-03
# (RESEARCH_CLAIM ib_daytype_be_trail_no_survivor), kept scheduled so it self-recalibrates
# as real ACTIVE/SHADOW-origin IB trades accumulate, same convention as every other
# calibration in this file — never a dead end just because the first run was negative.
/usr/bin/node scripts/backtest_ib_daytype_breakeven_trail.mjs

# --- Context + anticipation pipelines ---
/usr/bin/node scripts/backtest_permission_slips.mjs
/usr/bin/node scripts/backtest_level_approach.js
# Monday override stats — used live in acd.js keepLevels for MON_BACKTEST signal_type
/usr/bin/node scripts/backtest_monday_deep.js

# --- Audit pipelines ---
/usr/bin/node scripts/level_fade_audit.mjs
/usr/bin/node scripts/audit_mae_mfe.mjs
# Wider-target-on-fast-resolving-trades mechanism (docs/OPEN_THREADS.md 2026-08-17) --
# closed-loop recheck of the SHADOW mechanism's real live outcomes vs. the frozen
# one-time backtest (RESEARCH_CLAIM velocity_fast_wider_target_positive_provisional).
/usr/bin/node scripts/audit_wider_target_live.mjs
# 2D_POC/PD2_VAH/PD2_VAL confirmed-negative-EV recheck (RESEARCH_CLAIM 2d_poc_fade_no_edge)
# — also writes real SETUP_STATUS rows so the live unified suppression pipeline stays
# correctly gated even though these types have ~0 real active_setups history for
# backtest_setup_status.mjs to otherwise pick up. See docs/OPEN_THREADS.md 2026-07-19.
/usr/bin/node scripts/backtest_pd2_2dpoc_complete.mjs

# VWAP reclaim-and-hold Phase 1 (RTH + Globex), 2026-08-04 — RESEARCH_CLAIM
# vwap_reclaim_hold_k{1,2,3}_{long,short}_phase1 (RTH) and _globex_ variants (overnight).
# Neither is wired live -- see docs/VWAP_RECLAIM_HOLD_SPEC.md and OPEN_DECISION
# vwap_reclaim_hold_rth_only_build_worth_it. Added here so both self-recalibrate as more
# real NQ price history accumulates each week, instead of sitting static until a future
# session happens to remember the 30-day recordClaim() recheck-due flag and manually
# re-invokes them -- the same "generic weekly rerun, human decides on promotion" pattern
# scan_regime_combinations.mjs already uses below. Both scripts are read-only against
# price_bars_primary plus a recordClaim() upsert -- no DROP/DELETE/backup side effects,
# safe to rerun unattended.
/usr/bin/node scripts/backtest_vwap_reclaim_hold_phase1.mjs
/usr/bin/node scripts/backtest_vwap_reclaim_hold_globex_phase1.mjs

# --- Session-bias / edge-mining pipelines (feed antigravity/edges-context cards) ---
# mine_session_bias.mjs also runs daily via server/index.js cron; re-running here weekly
# is harmless (idempotent DELETE+INSERT) and keeps it covered if that cron ever stalls.
/usr/bin/node scripts/mine_session_bias.mjs
/usr/bin/node scripts/backtest_ib_retest.mjs
/usr/bin/node scripts/backtest_gap_fill.mjs
/usr/bin/node scripts/backtest_v_pattern.mjs
/usr/bin/node scripts/edge_miner.mjs

# --- Independent research scanners (not level-touch based, tracked forward regardless of current profitability) ---
/usr/bin/node scripts/backtest_minute_bar_scan.mjs
# Dimensional cross-cut mining for the same scanner families (dow/hour/daytype/session/etc.),
# same pattern_discoveries table + ACTIVE/DEGRADED lifecycle as mineLevelFades() uses for levels
/usr/bin/node scripts/mine_minutebar_conditions.mjs

# All-time (full-history, not rolling-90-day) level-fade pattern scan -- catches rare/
# low-frequency patterns the 90-day rolling mineLevelFades() call in server/index.js
# structurally can never accumulate enough N for. Independent ACTIVE/DEGRADED lifecycle
# (window_type='ALL_TIME', pattern_key prefixed 'ALLTIME:') in the same pattern_discoveries
# table -- see server/services/patternScannerService.js's mineLevelFades() params. Measured
# ~194s for 417 RTH trading days (2026-07-17) -- cheap enough for weekly, not nightly.
/usr/bin/node scripts/mine_level_fades_alltime.mjs

# Execution-efficiency audit (2026-07-27) -- how real fired setups performed vs their own
# MAE/MFE and vs OPTIMAL_STOP's calibrated-achievable EV. Persists performance_audit
# signal_type='EXECUTION_EFFICIENCY_AUDIT' per setup_type clearing N>=20 real (ACTIVE/
# SHADOW-origin) resolved trades -- currently just IB_BEARISH, self-expands as real N
# grows elsewhere. See docs/OPEN_THREADS.md and RESEARCH_CLAIM ib_bearish_mfe_left_on_table_20260727.
/usr/bin/node scripts/analyze_execution_efficiency.mjs

# Standing data-sanity audit (2026-07-17) -- catches the class of bug found manually this
# session (impossible MAE/MFE values, a non-uniform $/pt constant defended by a false
# "verified" comment) automatically instead of requiring another multi-hour deep-dive to
# find the next instance. Non-zero exit is expected right now (1 known/standing flag: ES
# symbol data in price_bars_primary) -- not a failure, don't treat this script's exit
# code as a build-breaking signal in this cron; read its output instead.
/usr/bin/node scripts/data_sanity_audit.mjs

# Rolling recalibration for the cumulative-delta-confirmation live badge (2026-07-28) --
# RESEARCH_CLAIM cumulative_delta_confirms_breakout_beyond_price_alone /
# cumulative_delta_confirms_fades_stronger_than_breakout. Recomputes the trailing-200-day
# 25th-percentile-of-positive-cumulative-delta floor per category (FADE/BREAKOUT), no
# static threshold per the standing rule -- server/services/deltaConfirmation.js reads
# this back live (12h cache).
/usr/bin/node scripts/calibrate_delta_confirmation.mjs

# Wider-target pressure gate calibration (2026-08-24, RESEARCH_CLAIM
# wider_target_pressure_gate_vs_always_extend) -- recomputes the top-tercile buying/selling
# imbalance threshold that gates the wider-target mechanism's extend decision, on all
# currently-real armed trades. server/routes/acd.js reads this back live (24h cache), same
# convention as calibrate_delta_confirmation.mjs just above -- must stay scheduled so the
# live gate tracks the growing population rather than freezing at whatever it was on
# 2026-08-24, per the standing "RESEARCH_CLAIM recheck is a flag, not an auto-rerun" rule.
/usr/bin/node scripts/calibrate_wider_target_pressure_gate.mjs

# Step-trail runner extension shadow calibration (Opus Audit #12, 2026-09-04) -- derives the
# ratchet step fraction + base-distance floor from the real, growing armed-trade population.
# server/routes/acd.js reads this back live (24h cache) to drive the SHADOW-only step_trail_shadow
# logger (never gates/sizes a real trade). Must stay scheduled -- a stale calibration here means
# the shadow logger silently keeps using an old fraction instead of the current best one, same
# risk this codebase has already been burned by with other calibrated gates.
/usr/bin/node scripts/calibrate_step_trail_fraction.mjs

# Pitch and Catch filter calibration (user idea, 2026-09-04, UNVALIDATED -- see
# server/services/pitchCatchWalker.js's header). Must stay scheduled so the shadow logger's
# qualification filter (RVol band, settle-bars, ADX threshold) tracks the current real
# population rather than freezing at whatever it was on 2026-09-04.
/usr/bin/node scripts/calibrate_pitch_catch_filter.mjs

# SHORT entry-time selling-pressure sizeMultiplier boost (2026-08-24, RESEARCH_CLAIM
# pressure_entry_sizing_direction_asymmetric) -- same convention as the pressure gate just
# above: must stay scheduled so the live boost tracks the real, growing population and
# floors to 0 automatically on a bad recalibration, rather than freezing at ship time.
/usr/bin/node scripts/calibrate_pressure_entry_sizing_short.mjs

# Regime-combination scanner (2026-08-02) -- the read-back half of the value-area regime
# measurement layer (regime_pos_Nd/regime_label_Nd on active_setups, tagged at insert time
# by acd.js, no gating). Groups real (origin_status IN ACTIVE/SHADOW) resolved touches by
# setup_type x regime_label_Nd, requires real N>=20 per cell, runs computeRigor +
# computeReplication before trusting anything. Every real cell tested gets a RESEARCH_CLAIM
# row regardless of outcome; a cell that clears the FULL gate (rigor-clean, replicates,
# positive EV) additionally gets flagDecision()'d into the OPEN_DECISION queue -- this is
# the actual path "into live," a human call, not an auto-wire. Will find ~nothing for a
# while (2 total real regime-tagged resolved rows as of 2026-08-02) -- that's expected, this
# is infrastructure for the months-long accumulation, see docs/OPEN_THREADS.md.
/usr/bin/node scripts/scan_regime_combinations.mjs

# --- Roadmap Phase 0 (2026-08-10): PROVISIONAL RESEARCH_CLAIM findings wired to weekly
# cron per the roadmap's own Part 6.5 loop design ("if the finding is still open... wire its
# source script into a recurring cron too, or it never actually recomputes itself"). Found
# by cross-referencing scratch/research_claim_unscheduled.txt against every RESEARCH_CLAIM
# whose latest status is PROVISIONAL (not CONFIRMED/settled, not STALE-already-tracked) --
# 82 such claims existed, of which only these 10 both (a) point at a real script under
# scripts/ (not a scratch/ one-off, a UI file, or a "direct query"/"synthesis" non-script
# source) and (b) already call recordClaim() themselves, so adding them here is a pure
# cron-wiring change with no script edits. The other ~18 candidates found by this sweep do
# NOT call recordClaim() at all (their claim was recorded by a separate/manual step) --
# cron-wiring those without first fixing that would just re-print console output weekly
# with no lasting effect, so they're deliberately NOT added here; see OPEN_DECISION
# roadmap_phase0_18_scripts_need_recordclaim_wiring.
/usr/bin/node scripts/backtest_1yr_globex_inclusive_prop_challenge_20260720.mjs
/usr/bin/node scripts/analyze_compression_tail_mfe.mjs
/usr/bin/node scripts/backtest_globex_move_levels.mjs
/usr/bin/node scripts/pilot_ib_bearish_2of3_target_1of3_trail.mjs
/usr/bin/node scripts/analyze_intraday_ib_range_daytype.mjs
/usr/bin/node scripts/analyze_intraday_ib_range_remainder.mjs
# The single most decisive open test in the codebase (roadmap Phase 0's named checkpoint) --
# does RTH OPTIMAL_STOP calibration beat a flat baseline on genuinely chronological,
# held-out data. Corrected 2026-08-10 (order-blind confound + a DISTINCT ON (signal_name)
# staleness bug both fixed same day) -- see RESEARCH_CLAIM rth_calibration_genuine_holdout_test.
/usr/bin/node scripts/backtest_rth_calibration_genuine_holdout.mjs
/usr/bin/node scripts/backtest_structural_breakout_phase0.mjs
/usr/bin/node scripts/backtest_trend_gate_suppression.mjs
/usr/bin/node scripts/backtest_volatility_regime_roster_wide.mjs
# Roadmap Phase 3 (I4) re-run of mfe_runner_target_widening_mining on the uncensored,
# chronological, real-only surface -- unlike the 2026-07-17 original, finds a minority of
# setup_types (VWAP-magnet/IB family) with large but NOT rigor-clean deltas. Cron'd (not
# left one-off) so RESEARCH_CLAIM mfe_runner_target_widening_uncensored_20260810 self-
# recalibrates as real N grows for these actively-firing live types -- per the standing
# "cron the scripts with genuinely open findings" rule, same as this file's other entries.
/usr/bin/node scripts/backtest_mfe_runner_target_widening_uncensored.mjs

# ATR-compression breakout pilot (2026-08-11, user-sourced strategy) -- three bar widths
# (15/30/60-min). CORRECTED same session (Opus consultation 6, docs/OPUS_AUDIT_PROMPT_6.md)
# after the original "skip the same-bar stop check, can't resolve intrabar ordering without
# tick data" rationale was found to be wrong -- the bars are aggregated from 1-min data
# already on hand, and resolving fills at that resolution (plus fixing a real entry-anchor
# spec deviation) flipped 60-min from a reported +$65.84/trade to a corrected, decisively
# negative -$14 to -$30/trade band. All three timeframes are now negative findings
# (RESEARCH_CLAIM atr_compression_breakout_60m/_30m/_15m, all CONFIRMED as negative) --
# kept scheduled anyway, per this file's own standing "never a dead end just because the
# first run was negative" rule, so this self-recalibrates if real forward data ever
# changes the picture.
/usr/bin/node scripts/pilot_atr_compression_breakout_mtf.mjs 15
/usr/bin/node scripts/pilot_atr_compression_breakout_mtf.mjs 30
/usr/bin/node scripts/pilot_atr_compression_breakout_mtf.mjs 60
# Follow-up threads (2026-08-11) -- BOTH RETRACTED/DOWNGRADED same session, still cron'd
# because the underlying 60-min baseline they depend on might get revisited later, but as
# of now both were computed on the pre-correction (broken-fill-engine) 121-trade population
# and have NOT been re-run on the corrected engine (see atr_breakout_plateau/
# atr_breakout_confluence RESEARCH_CLAIM notes for the full retraction account) -- these two
# scripts still contain their OWN local copy of the old same-bar-stop-skipping logic and
# need the same fix ported before their weekly re-runs mean anything. Not yet done --
# flag if picked back up.
/usr/bin/node scripts/pilot_atr_breakout_badge_confluence.mjs
/usr/bin/node scripts/pilot_atr_breakout_parameter_sensitivity.mjs

# Post-ATR-thread forward-return checks (2026-08-11) -- both self-recalibrate as real
# forward NQ history accumulates. Bollinger squeeze: clean negative (edge negative at all 5
# horizons tested, RESEARCH_CLAIM bollinger_squeeze_forward_return). STACK_VOL_BREAK_LIVE
# horizon profile: genuinely mixed/inconclusive, not a clean kill -- no cell reaches
# significance at the signal level, but real trade-level backtests with actual stop/target
# machinery already show modest provisional positive EV that this test doesn't contradict
# (RESEARCH_CLAIM STACK_VOL_BREAK_HORIZON). See docs/OPEN_THREADS.md.
/usr/bin/node scripts/pilot_bollinger_squeeze_forward_return.mjs
/usr/bin/node scripts/pilot_stackvol_horizon_profile.mjs

# "Slow+deep adverse-grind early exit" (2026-08-18) -- consolidated/scheduled version of
# scripts/pilot_zero_mfe_early_stop.mjs's Part 4, per docs/SLOW_DEEP_EARLY_EXIT_SPEC.md's
# numbered build plan. PROVISIONAL as of first run: bet_class split found CONTINUATION_LEGACY
# opposite-sign from the pooled result and computeRigor not clean -- self-recalibrates weekly
# as real N grows per this file's own standing rule, RESEARCH_CLAIM
# slow_deep_adverse_grind_early_exit. Does not wire anything live.
/usr/bin/node scripts/backtest_slow_deep_early_exit.mjs

# Same-direction fire-density throttle, "Build 1" (2026-08-19, Opus Audit 8 §2.4/R4 re-test).
# CONFIRMED negative as of first run per DeepSeek's bar (A): the 4+ rebound IS explained by
# day clustering and the K=2/W=30 K/W plateau DOES pass, but the kept arm fails
# computeRigor().clean (chronological instability -- EV declines into a negative final third).
# Still open, not a hard structural rejection -- scheduled so it self-recalibrates as real
# ACTIVE N grows and the instability either resolves or hardens. RESEARCH_CLAIM
# same_direction_throttle_stage1. Does not wire anything live.
/usr/bin/node scripts/pilot_same_direction_throttle.mjs

# CONFIRMED negative as of first run (2026-08-19): IB-break-direction-match (live-knowable
# at 10:30 ET, computeIbBullBear()) as a replacement for MOMENTUM_60m_60m_TREND's dead
# EOD-day_type admission gate. Correlates only weakly with actual TREND days (47.4% vs a
# ~39% base rate) and stays net-negative EV even beating the unconditioned baseline
# (-$2.55 vs -$7.27/trade, same stop/target) -- not rigor-clean. Resolves
# OPEN_DECISION promotion_pipeline_structural_fix_2026_08_16. Scheduled so it
# self-recalibrates as real bar history/day-type calibration accumulates, not a hard
# structural rejection. RESEARCH_CLAIM momentum60_ib_break_admission_gate_test. Does not
# wire anything live.
/usr/bin/node scripts/pilot_momentum60_ib_break_gate.mjs

# RTH_FLUSH_LONG/SHORT + GLOBEX_FLUSH_LONG/SHORT calibration (2026-08-27) --
# docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md sec 4.4-4.14. Writes SETUP_STATUS + OPTIMAL_STOP
# rows read live by server/services/rthFlushDetector.js / globexFlushDetector.js. RTH side is
# solid (N=336, clean/stable). GLOBEX side was found to have a real session-boundary bug
# (OPEN_DECISION globex_session_boundary_4to5pm_misattribution_bug) that materially weakened its
# backtested edge after the fix -- wired SHADOW-only, self-recalibrates as real forward data
# accumulates.
/usr/bin/node scripts/backtest_flush_patterns.mjs

# VOLUME_BUILDING_CALIBRATION/ROSTER_WIDE_FADE (2026-08-28) -- recalibrates the median and p60
# cutoffs for the volume-building signal wired live INFORMATIONAL-ONLY onto every real FADE fire
# (active_setups.vol_building_signal, both RTH and Globex insert paths in acd.js). Does not
# gate/size anything yet -- self-recalibrates as real forward data accumulates. See
# docs/OPEN_THREADS.md's 2026-08-28 entry and RESEARCH_CLAIMs fade_roster_volume_building_
# pooled_vs_pertype / volz_day_relative_vs_timeofday_reference_frame / fade_roster_volume_
# building_dose_response_cutoff.
/usr/bin/node scripts/backtest_volume_building_signal.mjs

# SAME_DAY_FORMING (IB/OR family) volume-building fade-quality re-verification (2026-09-01) --
# re-checks docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md sec 6b's parked walk-forward finding
# (original N=324, $11.95-12.19/trade gap, "stable") against the CURRENT real trade population.
# CORRECTED SAME DAY (user caught 2 real methodology bugs): the first re-check used a 30-bar
# smoothed backdrop average + tercile split, inconsistent with the RUN/HELD test's own measure
# (at-touch compositeStrength) and bucketing (quartile) -- see scripts/lib/volbuildWalkforward
# AtTouch.mjs's header for the full story. Corrected version is STRONGER, not weaker: genuinely
# monotonic Q1-Q4 ($-7.28/$1.25/$10.17/$26.87), Q4 chronologically stable=true. Sole remaining
# blocker is day-diversity: Q4 spans only 12 distinct days (67.2% from top 5) -- too day-thin to
# wire yet, NOT a live gate/size factor. Standing promotion trigger (OPEN_DECISION
# same_day_forming_volbuild_quartile_promotion_trigger): re-run weekly: promote to a real
# size-multiplier factor once Q4 spans >=25 distinct days, day-clustering (top5DayPct) under 50%,
# the split stays monotonic and chronologically stable, AND no negative chronological period.
# This is a staleness-preventing weekly recompute, not a fixed-calendar wait -- promotes the
# moment the DATA clears the bar, which real trade volume (15-30 real IB/OR fires/day recently)
# suggests is a few weeks out, not months, if the pattern holds.
/usr/bin/node scripts/backtest_ib_or_volbuild_walkforward_refresh.mjs

# PRIOR_DAY_OR_DEVELOPING (PD_POC/VAH/VAL, VWAP, pivots) volume-building fade-quality follow-up
# (2026-09-01, "chase it" per user) -- the SAME_DAY_FORMING correction above applies here too
# (at-touch compositeStrength, quartile split, not the original smoothed-backdrop/tercile
# version). CORRECTED RESULT: still NOT a clean positive -- U-shaped, not monotonic ($2.44/-$9.02/
# -$6.01/$3.14), Q4 unstable (63.5% day-clustering) and declining over chronological thirds
# ($9.30->$7.30->-$7.63). Genuinely INCONCLUSIVE, not confirmed-negative -- despite a much larger,
# cleaner bar-level RUN/HELD signal for this family than SAME_DAY_FORMING has (RESEARCH_CLAIM
# volume_building_run_held_by_level_formation_type, N=28,984, stable), no quartile bucket of real
# fade P&L shows a decisive, stable edge either way. Kept scheduled per this codebase's own
# no-dead-ends convention rather than declared permanently closed -- self-recalibrates as real N
# grows. Do NOT re-run with yet another ad hoc bucket/measure choice hunting for a positive --
# multiple-comparisons fishing risk already flagged once this thread.
/usr/bin/node scripts/backtest_priorday_volbuild_walkforward.mjs

# Approach-pace fade-quality signal (2026-09-01) -- found while root-causing why GLOBEX_VWAP_MAGNET/
# PD_VAH_FADE_SHORT refires lose (user: "find a more strict way to trade it" rather than just a
# cooldown). Points-traveled-per-bar over the 15 bars into the touch. Full-roster walk-forward
# result (N=1354, 22+ distinct days): clean monotonic quartile EV ($-7.22/$-0.43/$5.59/$7.44),
# stable, holds in both RTH (AUC=0.540) and Globex (AUC=0.563), broad across 76 setup_types (top
# type only 9.1% share -- not a single-setup artifact like the exploratory N=58 pass looked like).
# RESEARCH_CLAIM approach_pace_fade_quality_full_roster. NOT wired live yet -- OPEN_DECISION
# wire_approach_pace_as_size_factor scopes what's needed first (real stop/target bar-by-bar
# simulation, not just raw P&L correlation, per this codebase's own new-setup-type checklist item
# 5). Self-recalibrates weekly as real N grows.
/usr/bin/node scripts/backtest_approach_pace_fade_quality.mjs

# Displacement-since-last-visit fade-quality test (2026-09-01) -- user's idea: instead of a
# time-based refire cooldown, does how far price has traveled from a level since it was last
# visited predict quality (clustering=bad, real departure-and-return=legitimate)? CONFIRMED
# NEGATIVE at full-roster scale (N=958): pooled AUC=0.514 (noise), and family breakdown
# genuinely disagrees in SIGN (SAME_DAY_FORMING favors clustering, OTHER favors displacement) --
# not just thin data, a real inconsistency. The single-setup exploratory read (11/12 refires from
# one day showing clustering=better) was describing one unusual session, not a real pattern.
# Approach pace (above) remains the validated lead from this investigation. Kept scheduled per
# this codebase's no-dead-ends convention.
/usr/bin/node scripts/backtest_displacement_since_last_visit.mjs

# Promotion-gate placebo-control test (2026-09-01) -- does the SETUP_STATUS PROMOTE gate admit
# setup_types that underperform MORE than a statistically-matched "just missed the bar" placebo
# group, or is the observed post-promotion underperformance just regression to the mean (winner's
# curse)? v2 of this test, built after DeepSeek's design critique killed v1 for being doubly
# confounded (overlap with the already-confirmed stop-tightening cohort, plus regression-to-mean
# on its own). First run: SUPPORTS pure regression to the mean (JUST_MISSED underperformed its own
# estimate MORE than PROMOTED did, -$42.59 vs -$15.57, computeReplication replicates=true) -- but
# PROMOTED N=7 is far below this codebase's N>=20 floor and computeRigor shows clean=false for it.
# RESEARCH_CLAIM promotion_gate_regression_to_mean_thin_20260901 (PROVISIONAL, not decision-grade).
# Self-recalibrates weekly as real N grows toward the N>=20 recheck floor.
/usr/bin/node scripts/backtest_promotion_gate_placebo_control.mjs

# Flush post-entry exit-signal promotion/retirement trigger (2026-09-02) -- part 3 of
# OPEN_DECISION wire_flush_post_entry_exit_signals_globex. acd.js's resolveSetupsByPrice()
# persists a real hypothetical_pnl onto every open GLOBEX_FLUSH_* position whenever the
# range-expansion-slope or volume-rollover exit fires (active_setups.post_entry_exit_signals).
# Once N>=20 real fires accumulate for a mechanism/mode combination, this re-verifies against
# real forward data (paired vs the trade's own actual_pnl, segmented ALL vs BIG-MOVE-ONLY) and
# writes a final CONFIRMED verdict -- positive flags a live-wiring OPEN_DECISION, negative closes
# the mechanism out. No-op below N=20 (the pilot's own PROVISIONAL claim stands until then).
/usr/bin/node scripts/backtest_flush_post_entry_exit_signals_promotion.mjs

# PD-level-fade VWAP-deviation-magnitude filter + volume-size follow-up (2026-09-02) --
# RESEARCH_CLAIM pd_level_fade_vwap_deviation_magnitude_filter / pd_level_fade_volume_size_as_
# live_knowable_substitute. Both auto-refresh their own claim on every run (real GLOBEX-only
# PD_POC/PD_VAH/PD_VAL fade population keeps growing weekly) so this stays a real, monitored
# thread instead of a one-off scratch result -- user-flagged 2026-09-02: a PROVISIONAL claim
# with no standing recheck path is a dead end in practice. Not yet decision-grade (design
# critique flagged several remaining checks, see docs/OPEN_THREADS.md) -- these two scripts are
# what keeps it moving toward that bar on its own.
/usr/bin/node scripts/pilot_pd_level_fade_vwap_deviation_filter.mjs
/usr/bin/node scripts/pilot_low_deviation_volume_size_filter.mjs
/usr/bin/node scripts/pilot_opposite_direction_post_win_pause.mjs

# Cross-direction fast-flip live calibration: MOVED to run_daily_calibration.sh 2026-09-02
# (user request -- this gates real live/SHADOW trade eligibility, waiting up to 6 days for a
# weekly recheck is too slow if it's firing too much and costing real trades; same reasoning
# already established here for backtest_calibrated_wider_target.mjs). See that file for the
# script invocation -- do not also run it here, the daily cadence already covers weekly.

# Per-setup-type daily loss cap recheck (2026-09-05) -- RESEARCH_CLAIM
# perSetup_daily_loss_cap_reversion_trap_20260904. Full history says this cap would be net
# harmful (a reversion-trap, see feedback_reactive_exposure_cutting_reversion_trap in Claude's
# memory); the recent-regime subset (trade_date>=2026-08-01) currently reverses that but is thin
# (single-digit distinct days). Self-recalibrates weekly so the finding firms up or fades as real
# data accumulates instead of sitting as a dead one-off analysis. Not wired live -- see
# OPEN_DECISION per_setup_daily_loss_cap_recent_regime_reversal for the ship/shadow/shelve call.
/usr/bin/node scripts/backtest_per_setup_daily_loss_cap.mjs

# Per-(setup_type x time-of-day) step-trail calibration (2026-09-05, user request: monitor and
# calibrate the step-trail runner extension for every setup automatically, not just the 3 leads
# a one-off backtest happened to find). Writes STEP_TRAIL_PER_CELL_CALIB rows -- a real
# GATE/NO_GATE/THIN_N verdict per cell, including a real-vs-SHADOW subgroup-reversal check (added
# after this script's own first run GATEd an already-retracted pooled finding). Monitoring/
# calibration only -- see OPEN_DECISION step_trail_per_cell_live_wiring_pending for whether/how
# this ever feeds live wiring once the overall step-trail mechanism itself clears its own
# Phase 2 bar (still at zero real armed data as of 2026-09-05).
/usr/bin/node scripts/calibrate_step_trail_per_setup_time.mjs

echo "=== Weekly backtest run complete: $(date) ==="
