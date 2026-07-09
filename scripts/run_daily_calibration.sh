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

echo "=== Daily calibration complete: $(date) ==="
