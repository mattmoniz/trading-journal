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

# --- Conditional-variant backtests (maintain population stats for setup type overrides) ---
/usr/bin/node scripts/backtest_wpp_short_gap.mjs

# --- Context + anticipation pipelines ---
/usr/bin/node scripts/backtest_permission_slips.mjs
/usr/bin/node scripts/backtest_level_approach.js
# Monday override stats — used live in acd.js keepLevels for MON_BACKTEST signal_type
/usr/bin/node scripts/backtest_monday_deep.js

# --- Audit pipelines ---
/usr/bin/node scripts/level_fade_audit.mjs
/usr/bin/node scripts/audit_mae_mfe.mjs

# --- Session-bias / edge-mining pipelines (feed antigravity/edges-context cards) ---
# mine_session_bias.mjs also runs daily via server/index.js cron; re-running here weekly
# is harmless (idempotent DELETE+INSERT) and keeps it covered if that cron ever stalls.
/usr/bin/node scripts/mine_session_bias.mjs
/usr/bin/node scripts/backtest_ib_retest.mjs
/usr/bin/node scripts/backtest_gap_fill.mjs
/usr/bin/node scripts/backtest_v_pattern.mjs
/usr/bin/node scripts/edge_miner.mjs

echo "=== Weekly backtest run complete: $(date) ==="
