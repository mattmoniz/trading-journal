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

# --- Touch-quality (order-flow) calibration — feeds acd.js's live resolveSetupsByPrice
# classification (informational-only mid-trade flag) and the antigravity/edges-context
# card badge. See server/services/touchQuality.js and docs/OPEN_THREADS.md. ---
/usr/bin/node scripts/calibrate_touch_quality.mjs

# --- Conditional-variant backtests (maintain population stats for setup type overrides) ---
/usr/bin/node scripts/backtest_wpp_short_gap.mjs
/usr/bin/node scripts/backtest_momentum60_daytype.mjs

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

# Standing data-sanity audit (2026-07-17) -- catches the class of bug found manually this
# session (impossible MAE/MFE values, a non-uniform $/pt constant defended by a false
# "verified" comment) automatically instead of requiring another multi-hour deep-dive to
# find the next instance. Non-zero exit is expected right now (1 known/standing flag: ES
# symbol data in price_bars_primary) -- not a failure, don't treat this script's exit
# code as a build-breaking signal in this cron; read its output instead.
/usr/bin/node scripts/data_sanity_audit.mjs

echo "=== Weekly backtest run complete: $(date) ==="
