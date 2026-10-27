
### Audit A -- statements that score TIME_EXPIRED at 0 (writers)

| File | Line | Statement |
|---|---|---|
| `scripts/agy_test_magnet_balance.mjs` | 81 | `const pnl = res.result === 'EXPIRED' ? 0 : res.pnl;` |
| `scripts/backfill_monthly_vwap_yearly_poc.mjs` | 140 | `if (resolution === 'TIME_EXPIRED') pnl = 0;` |
| `scripts/backfill_unified_levels.mjs` | 228 | `if (resolution === 'TIME_EXPIRED') pnl = 0;` |
| `scripts/backtest_globex_vwap_fade.mjs` | 79 | `const pnl = res.result === 'EXPIRED' ? 0 : res.pnl;` |
| `scripts/backtest_globex_vwap_magnet.mjs` | 83 | `const pnl = res.result === 'EXPIRED' ? 0 : res.pnl;` |
| `scripts/backtest_rth_vwap_fade.mjs` | 85 | `const pnl = res.result === 'EXPIRED' ? 0 : res.pnl;` |
| `scripts/backtest_vwap_magnet.mjs` | 85 | `const pnl = res.result === 'EXPIRED' ? 0 : res.pnl;` |
| `scripts/repair_backfill_duplicate_bars.mjs` | 192 | `if (resolution === 'TIME_EXPIRED') pnl = 0;` |
| `scripts/repair_cam_r4_s3_window_mismatch.mjs` | 143 | `if (resolution === 'TIME_EXPIRED') pnl = 0;` |
| `scripts/repair_ib_dependent_window_mismatch.mjs` | 157 | `if (resolution === 'TIME_EXPIRED') pnl = 0;` |
| `scripts/repair_remaining_window_mismatch.mjs` | 167 | `if (resolution === 'TIME_EXPIRED') pnl = 0;` |
| `scripts/repair_top8_window_mismatch.mjs` | 156 | `if (resolution === 'TIME_EXPIRED') pnl = 0;` |
| `scripts/repair_weekly_vwap_window_mismatch.mjs` | 126 | `if (resolution === 'TIME_EXPIRED') pnl = 0;` |
(also in the archived generator scripts/archive/backfill_level_fades.js:246, not scanned further)

### Audit B -- queries that read P&L over a resolution list (classification by a +/-12 line text heuristic)

query sites by class: {"REAL-ONLY":98,"BLENDED(includes BACKFILL zeros)":31,"DUAL (blended + real columns in one query)":5,"DECIDED-ONLY(omits expiries)":43,"BACKFILL-ONLY":23} in 134 files

### Audit C -- BLENDED consumers (TIME_EXPIRED included, no real-only filter near the query): scheduled? what do they persist? does server code read it?

| File | Query lines (b = blended, d = dual) | Scheduled in | signal_type written | server files reading it |
|---|---|---|---|---|
| `scripts/backtest_1yr_globex_inclusive_prop_challenge_20260720.mjs` | 63b | run_weekly_backtests.sh | SETUP_STATUS | 8 |
| `scripts/backtest_bet_class_status.mjs` | 79d | run_weekly_backtests.sh + run_weekly_backtests.sh | BET_CLASS_STATUS | 1 |
| `scripts/backtest_setup_status.mjs` | 366d,390d,414d,450b,468b,888d | run_daily_calibration.sh + run_weekly_backtests.sh | SETUP_STATUS | 8 |
| `scripts/backtest_volatility_regime_roster_wide.mjs` | 46b | run_weekly_backtests.sh | (writes performance_audit) | - |
| `scripts/monitor_bet_correlation.mjs` | 162b | run_weekly_backtests.sh | CORRELATION_MONITOR_BET_CLASS | 1 |
| `scripts/test_invariants.mjs` | 521b | run_daily_calibration.sh | SETUP_STATUS | 8 |
| `scripts/backtest_1yr_prop_challenge_bar6_overlay_20260723.mjs` | 77b | - | (no performance_audit write) | - |
| `scripts/backtest_bar6_early_exit.mjs` | 65b | - | (no performance_audit write) | - |
| `scripts/backtest_bar6_exit_rule_annual_pnl.mjs` | 43b | - | (no performance_audit write) | - |
| `scripts/backtest_bar6_stop_width_sweep.mjs` | 97b | - | (no performance_audit write) | - |
| `scripts/backtest_bar6_volume_trajectory.mjs` | 72b | - | (no performance_audit write) | - |
| `scripts/backtest_bar6_worst_point_passed.mjs` | 66b | - | (no performance_audit write) | - |
| `scripts/backtest_bigmove_fade_exit_2yr_robustness.mjs` | 76b | - | (no performance_audit write) | - |
| `scripts/backtest_bigmove_signal_exit_trigger.mjs` | 79b | - | (no performance_audit write) | - |
| `scripts/backtest_bigmove_signal_exit_trigger_fade_direction.mjs` | 78b | - | (no performance_audit write) | - |
| `scripts/backtest_coarser_bar_entry_alignment.mjs` | 63b | - | CONFLUENCE_AUDIT | 3 |
| `scripts/backtest_fade_against_trend_exit.mjs` | 76b | - | (no performance_audit write) | - |
| `scripts/backtest_recovering_exit_predictor.mjs` | 69b | - | (no performance_audit write) | - |
| `scripts/backtest_recovering_exit_predictor_confirmatory.mjs` | 57b | - | (no performance_audit write) | - |
| `scripts/backtest_sigma_signal_as_exit_trigger.mjs` | 99b | - | (no performance_audit write) | - |
| `scripts/backtest_sigma_signal_exit_trigger_fresh.mjs` | 90b | - | (no performance_audit write) | - |
| `scripts/backtest_target_sweep_v2.mjs` | 49b | - | OPTIMAL_STOP | 11 |
| `scripts/backtest_volatility_regime_bar6_split.mjs` | 126b | - | (no performance_audit write) | - |
| `scripts/backtest_wider_stop_ev.mjs` | 68b | - | OPTIMAL_STOP | 11 |
| `scripts/backtest_wider_target_ev.mjs` | 72b | - | POST_RES_SEQ | 0 |
| `scripts/backtest_worst_point_passed_entry_trigger.mjs` | 62b | - | (no performance_audit write) | - |
| `scripts/prop_challenge_trailing_dd_chronological.mjs` | 104b | - | (no performance_audit write) | - |
| `server/services/minuteBarSignalDetector.js` | 102b | - | (no performance_audit write) | - |
| `server/services/monteCarloService.js` | 120b | - | (no performance_audit write) | - |
| `server/services/shadowCompletion.js` | 38b | - | (no performance_audit write) | - |

DECIDED-ONLY consumers (resolution list omits TIME_EXPIRED, so expiries are dropped from expectancy rather than scored 0; includes BACKFILL when no real filter): 20 files, 2 scheduled: `scripts/test_invariants.mjs`, `scripts/update_optimal_stops.mjs`

### Audit D -- size of the effect: BACKFILL TIME_EXPIRED rows re-scored at the expiry-bar close (RTH rows with bars)

BACKFILL TIME_EXPIRED rows scored 0: 930; re-scored 763 (unmeasured: {"notRth":1,"noDir":0,"noBar":2,"mismatch":164}); mean re-scored P&L -16.58 dollars (share positive 0.36), i.e. each row was scored 16.58 dollars too high on average.
setup_types with measured expiries: 105; change in blended EV (new - old): median -0.91, min -185.00, max 77.42; types whose blended EV crosses 0: 9, crosses the -5 SUPPRESS bar: 6
| setup_type | BACKFILL expiries | blended N | blended EV (stored) | blended EV (expiries re-scored) | delta | latest SETUP_STATUS |
|---|---|---|---|---|---|---|
| PY_POC_FADE_LONG | 1 | 1 | 0.00 | -185.00 | -185.00 | ACTIVE |
| MONTHLY_VWAP_FADE_SHORT | 61 | 107 | 22.81 | 2.63 | -20.19 | ACTIVE |
| PW_POC_FADE_SHORT | 9 | 48 | 11.28 | -5.65 | -16.93 | ACTIVE |
| PM_VAH_FADE_SHORT | 3 | 21 | 25.71 | 9.71 | -16.00 | ACTIVE |
| PD_CLOSE_FADE_SHORT | 18 | 176 | 11.33 | 1.36 | -9.97 | ACTIVE |
| PW_VAH_FADE_SHORT | 14 | 83 | 6.18 | -3.73 | -9.91 | ACTIVE |
| PM_VAH_FADE_LONG | 3 | 21 | -36.93 | -45.95 | -9.02 | ACTIVE |
| WS2_FADE_LONG | 1 | 16 | -73.25 | -80.97 | -7.72 | ACTIVE |
| MONTHLY_OPEN_FADE_LONG | 4 | 56 | 30.58 | 34.02 | 3.45 | ACTIVE |
| PY_VAH_FADE_LONG | 3 | 8 | -150.50 | -135.56 | 14.94 | ACTIVE |
| MONTHLY_VWAP_FADE_LONG | 71 | 119 | -35.95 | 8.83 | 44.78 | ACTIVE |
| PY_VAH_FADE_SHORT | 9 | 12 | 49.92 | 127.33 | 77.42 | ACTIVE |
DAY_TYPE_CONDITIONAL set (scripts/backtest_setup_status.mjs L206) has 0 members after the 2026-08-31 removal, so its blended per-day-type EV query (L448-457) currently decides nothing.

### Audit E -- BACKFILL stop/target construction and observed shares

scripts/backfill_unified_levels.mjs: stopDist = percentile(MAE, 0.75) at line 184, t1Dist = percentile(MFE, 0.50) at line 185 (measured on the same touches in pass 1, resolved in pass 2), TIME_EXPIRED pnl = 0 at line 228; pass 1 is capped at PASS1_MAX_BARS (line 66) while pass 2 is not.
observed RTH fade BACKFILL shares: TIME_EXPIRED 8.8%, TARGET_HIT 59.8%, STOP_HIT 31.4%  (N=9633); a p75-MAE stop implies about 25 percent stopped by construction, a p50-MFE target about 50 percent reached before any stop.

### Audit F -- manual reading of the server-side and scheduled hits (the text heuristic over-reports)

- server/services/minuteBarSignalDetector.js getLiveStatus (L99-108): live SHADOW/ACTIVE gate (N<20 -> SHADOW, EV<-5 -> SHADOW) reads AVG(actual_pnl) over setup_type LIKE 'MOMENTUM_60m_60m_TREND_%' with NO origin filter. Rows in that family: 0 of which BACKFILL 0 (the zero convention only matters if that is > 0).
- server/services/monteCarloService.js L120-128: the Monte Carlo simulation input includes TIME_EXPIRED rows with no origin filter; its own comment says these rows carry a real mark-to-market actual_pnl, which is true for live rows and FALSE for the BACKFILL ones (stale "verified" comment).
- server/services/shadowCompletion.js L38: false positive (WIDER_TIME_EXPIRED resolution_method, live rows only).
- scripts/backtest_setup_status.mjs (scheduled daily + weekly): L359-373 persists BLENDED n / win_rate / ev_per_trade / total_pnl (columns sample_size, win_rate, ev_per_trade, total_pnl, notes.all_time_ev) next to real_n/real_ev; the live SUPPRESS / PROMOTE_ALL_MODE stat-gate branches (L622-654, L684) key on realN / real EV only. L448-457 (DAY_TYPE_CONDITIONAL per-day-type EV) is blended but the DAY_TYPE_CONDITIONAL set is empty after 2026-08-31. L468 (per-trade rigor list) is blended and informational.
- scripts/update_optimal_stops.mjs L650 reads origin_status IN (ACTIVE, SHADOW) only: the live OPTIMAL_STOP stop/target widths do not use BACKFILL zeros. The ~76-point stop in the 5,324-trade set is a BACKFILL-row property (generator p75 MAE), not the live OPTIMAL_STOP value.
