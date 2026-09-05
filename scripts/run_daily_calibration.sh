#!/bin/bash
# Daily calibration: runs after market close (8:20 PM ET Mon-Fri per `crontab -l` —
# this comment previously said ~4:20 PM ET, stale/wrong; corrected 2026-07-19 after
# noticing the mismatch while building the target-calibration-coverage endpoint).
# Fills today's MAE/MFE data, recomputes optimal stops, re-evaluates setup status.
# Fast pass — typically completes in under 2 minutes.
# Full backtests (backtest_unified.js, etc.) still run weekly on Sundays.
cd /home/mmoniz/trading-journal
echo "=== Daily calibration: $(date) ==="

# Refresh the materialized historical bar store (2026-07-27, price_bars_primary_materialize_historical_bars)
# first, so today's now-closed session becomes part of the fast indexed path before the
# calibration scripts below query it. ~8s, non-blocking (CONCURRENTLY).
/usr/bin/node scripts/refresh_price_bars_dedup_hist.mjs

/usr/bin/node scripts/backfill_mae_mfe.mjs
/usr/bin/node scripts/update_optimal_stops.mjs
/usr/bin/node scripts/backtest_setup_status.mjs
/usr/bin/node scripts/derive_day_types.js

# Day-type-conditioned IB_BEARISH/IB_BULLISH stop/target (2026-08-03,
# OPEN_DECISION ib_bearish_optimal_stop_not_day_type_conditioned) -- run after
# derive_day_types.js so today's day_type classification is available for the
# (setup_type, day_type) population join.
/usr/bin/node scripts/backtest_ib_daytype_stop_target.mjs

# DAY_TYPE_ALPHA (2026-08-05, RESEARCH_CLAIM ib_bullish_blocked_by_stale_daytype_alpha_realn0)
# -- was weekly-only (run_weekly_backtests.sh), while acd.js's IB real-N floor (~line 4839)
# consults it on EVERY poll to decide whether IB_BULLISH/BEARISH can fire at all. A stale
# real_n=0 cell silently nulled every IB_BULLISH candidate for 2+ days with zero trace, only
# found by reasoning backward from an unexplained RTH outage. This is the class fix: a live
# gate must never be staler than what it gates. Small/cheap (~seconds), safe to run daily
# alongside the IB stop/target calibration right above it.
/usr/bin/node scripts/backtest_day_type_alpha.js

# Wider-target-on-fast-resolving-trades mechanism, daily self-throttling recheck (2026-08-17,
# user request, docs/RUNNER_FOLLOWUPS_SPEC_20260817.md Item 0) -- --daily-check runs the full
# closed-loop audit every weekday while real armed N is thin, then self-throttles to a no-op
# (skips only the write/flag, the cheap computation still runs and logs) once N has already
# cleared the MIN_N=20 floor as of the last check, deferring back to the weekly-only cadence
# (run_weekly_backtests.sh, unflagged, always runs in full) -- no manual cron edit needed
# later when N clears the floor.
/usr/bin/node scripts/audit_wider_target_live.mjs --daily-check

# Standing invariant check (2026-07-17) -- previously only ever run manually ("run after
# any change touching acd.js..."), which meant its checks (including [6]'s
# UNCALIBRATED_SHADOW_TYPES staleness re-verification) only caught a real drift whenever
# someone happened to remember to invoke it by hand. Runs in <1s; placed right after
# backtest_setup_status.mjs since that's the exact script whose fresh SETUP_STATUS rows
# check [6] depends on -- a type can newly earn PROMOTE the same day this runs. Non-zero
# exit is expected/non-gating here (same convention as data_sanity_audit.mjs below) --
# read the output, don't treat exit code as build-breaking in this cron.
/usr/bin/node scripts/test_invariants.mjs

# Docs-split enforcement (2026-08-05, per external audit finding: this tool already existed
# but nothing ever ran it, so OPEN_THREADS.md silently grew back to 386KB/97K tokens between
# runs -- the mechanism was real, the cadence wasn't). --apply is safe/idempotent: it only
# moves already-dated sections older than the keep-window into OPEN_THREADS_ARCHIVE.md,
# nothing is deleted, and it no-ops cleanly when there's nothing old enough to move.
/usr/bin/node scripts/archive_open_threads.mjs --apply

# Wider-target MULTIPLIER calibration (2026-08-19, OPEN_DECISION
# wider_target_calib_needs_deepseek_review) -- distinct from audit_wider_target_live.mjs
# above, which just monitors the already-live fixed 1.5x mechanism. This sweeps candidate
# multipliers (1.0x/1.2x/1.5x/1.8x/2x/2.5x -- 1.0x deliberately included, see the script's
# own header comment) against real armed trades to ask what the multiplier SHOULD be,
# per-setup_type/bet_class. Daily, not weekly (user-confirmed 2026-08-19): if the market
# shifts regime, waiting up to 6 days for the next weekly run to reflect new real data is
# too slow -- the N>=20 floor, plateau/rigor checks are what prevent chasing noise, not run
# frequency. PROVISIONAL/descriptive only until DeepSeek's code review lands -- writes a
# RESEARCH_CLAIM, does not wire anything live.
/usr/bin/node scripts/backtest_calibrated_wider_target.mjs

# Cross-direction fast-flip live calibration (2026-09-02, moved here from
# run_weekly_backtests.sh per direct user request: "it should check itself daily if its
# firing too much and affecting real money"). Tests every real paired-direction family for a
# fast/medium/slow cross-direction-overlap flip gradient and writes performance_audit
# signal_type='CROSS_DIRECTION_FLIP_CALIB' per family -- both detectGlobexSetup() and the RTH
# level-fade engine read this live (cached per day) to decide which families' fast flips get
# routed to SHADOW instead of ACTIVE. This directly gates real trade eligibility, so -- same
# reasoning as backtest_calibrated_wider_target.mjs just above -- a week is too long to keep
# enforcing a gate against stale data if real forward trades start disagreeing with it. The
# N>=20 floor and the monotonic-pattern check (not just "fast is negative") are what prevent
# chasing daily noise, not the run cadence.
/usr/bin/node scripts/backtest_cross_direction_fast_flip.mjs

# Same-setup-type "refire gate" calibration (2026-09-03, user-designed rule mirroring the
# already-live sibling-reversal gate's event-based reset -- "blocked until a DIFFERENT setup
# fires", never a timer). Writes signal_type='SAME_TYPE_REFIRE_GATE_CALIB' per (setup_type,
# session). Daily per direct user request: same reasoning as the cross-direction-flip gate right
# above it -- this directly informs live trade-eligibility once wired, and per-type day-clustering
# here is severe enough (many rows at distinctDates=1-2) that it needs to react to new real data
# quickly, not wait a week. First real run (2026-09-03): 0 of 52 (type,session) rows + both pooled
# fallbacks cleared GATE -- every candidate is either THIN_N or fails computeRigor()'s clustered
# check, so nothing fires live from this yet. That's the correct, disciplined outcome of the rigor
# bar working as intended, not a bug -- self-recalibrates nightly as real N and distinct-days grow.
/usr/bin/node scripts/backtest_same_setup_refire_gate.mjs

# Direction-alternation-after-loss gate calibration (2026-09-05, user proposal, a variation of
# the sibling rule framed as "prevent sequential losses"). Daily for the same reason as the
# refire-gate/cross-direction-flip calibrations above: this is a candidate for gating real trade
# eligibility, and the recent-regime effect found so far is large enough (real 2026-08-01+ money)
# to want fresh data fast, not wait a week. Writes/updates RESEARCH_CLAIM
# direction_alternation_after_loss_gate_20260905. First run: recent-regime effect (-$2601.50
# avoided since 2026-08-01) is real and large but full-history reverses it (same account-wide
# edge-decay pattern as everything else tested this week) -- not wired live, see OPEN_DECISION
# direction_alternation_after_loss_gate_pending for the ship/shadow/shelve call.
/usr/bin/node scripts/backtest_direction_alternation_after_loss.mjs

echo "=== Daily calibration complete: $(date) ==="
