#!/bin/bash
# Daily calibration: runs after market close (~4:20 PM ET Mon-Fri).
# Fills today's MAE/MFE data, recomputes optimal stops, re-evaluates setup status.
# Fast pass — typically completes in under 2 minutes.
# Full backtests (backtest_unified.js, etc.) still run weekly on Sundays.
cd /home/mmoniz/trading-journal
echo "=== Daily calibration: $(date) ==="

/usr/bin/node scripts/backfill_mae_mfe.mjs
/usr/bin/node scripts/update_optimal_stops.mjs
/usr/bin/node scripts/backtest_setup_status.mjs
/usr/bin/node scripts/derive_day_types.js

# Standing invariant check (2026-07-17) -- previously only ever run manually ("run after
# any change touching acd.js..."), which meant its checks (including [6]'s
# UNCALIBRATED_SHADOW_TYPES staleness re-verification) only caught a real drift whenever
# someone happened to remember to invoke it by hand. Runs in <1s; placed right after
# backtest_setup_status.mjs since that's the exact script whose fresh SETUP_STATUS rows
# check [6] depends on -- a type can newly earn PROMOTE the same day this runs. Non-zero
# exit is expected/non-gating here (same convention as data_sanity_audit.mjs below) --
# read the output, don't treat exit code as build-breaking in this cron.
/usr/bin/node scripts/test_invariants.mjs

echo "=== Daily calibration complete: $(date) ==="
