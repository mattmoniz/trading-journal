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
/usr/bin/node scripts/backtest_ib_daytype_stop_target.mjs
# Breakeven-then-trail trail-width calibration for FLOOR_R1_FADE_SHORT_TRAIL (and any of
# the other 5 backtested survivors once they're wired live) — see
# docs/SCALEOUT_RUNNER_SPEC.md. Writes performance_audit signal_type='BREAKEVEN_TRAIL_TEST',
# read live by acd.js at insert time (never hardcode the trail width).
/usr/bin/node scripts/backtest_breakeven_trail.mjs

# --- Context + anticipation pipelines ---
/usr/bin/node scripts/backtest_permission_slips.mjs
/usr/bin/node scripts/backtest_level_approach.js
# Monday override stats — used live in acd.js keepLevels for MON_BACKTEST signal_type
/usr/bin/node scripts/backtest_monday_deep.js

# --- Audit pipelines ---
/usr/bin/node scripts/level_fade_audit.mjs
/usr/bin/node scripts/audit_mae_mfe.mjs
# 2D_POC/PD2_VAH/PD2_VAL confirmed-negative-EV recheck (RESEARCH_CLAIM 2d_poc_fade_no_edge)
# — also writes real SETUP_STATUS rows so the live unified suppression pipeline stays
# correctly gated even though these types have ~0 real active_setups history for
# backtest_setup_status.mjs to otherwise pick up. See docs/OPEN_THREADS.md 2026-07-19.
/usr/bin/node scripts/backtest_pd2_2dpoc_complete.mjs

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

echo "=== Weekly backtest run complete: $(date) ==="
