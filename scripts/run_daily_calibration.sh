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

echo "=== Daily calibration complete: $(date) ==="
