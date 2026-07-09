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

# --- Context + anticipation pipelines ---
/usr/bin/node scripts/backtest_permission_slips.mjs
/usr/bin/node scripts/backtest_level_approach.js
# Monday override stats — used live in acd.js keepLevels for MON_BACKTEST signal_type
/usr/bin/node scripts/backtest_monday_deep.js

# --- Audit pipelines ---
/usr/bin/node scripts/level_fade_audit.mjs
/usr/bin/node scripts/audit_mae_mfe.mjs

echo "=== Weekly backtest run complete: $(date) ==="
