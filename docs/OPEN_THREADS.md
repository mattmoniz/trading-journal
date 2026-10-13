# Open Threads / Pending Work

Older resolved/superseded threads are periodically moved to [OPEN_THREADS_ARCHIVE.md](OPEN_THREADS_ARCHIVE.md) (via `node scripts/archive_open_threads.mjs --apply`) to keep this file's per-session read cost down — nothing is deleted, just relocated. Still-pending items are backed by `OPEN_DECISION`/`RESEARCH_CLAIM` rows regardless, so archiving here never buries anything. Since 2026-09-07 this also applies per-bullet inside evergreen sections ("30-day shadow validation", "Pending decisions") — not just whole dated sections.

## 2026-10-12: Globex 44-type rotation-filter expansion shipped live, after DeepSeek caught a real lookahead bug Gemini's own independent re-derivation structurally could not catch

Tested whether 44 RTH-only level-fade setup_types would work in Globex, gated by the already-live 65pt rotation-direction filter. First pass (`scratch/globex_level_fade_rotation_backtest_20261012.mjs`): N=2,207, AGREE-minus-DISAGREE delta=+$35.52/trade, placebo-clean, 7/10 well-powered types individually clean. Dispatched to both Gemini (independent mine-and-run re-derivation + chronological split) and DeepSeek (line-by-line methodology/code review) in parallel, per explicit user request to send it to both.

Gemini reproduced the exact headline number and found it stable/strengthening across a chronological split — but Gemini's re-implementation reused the same `detectSignalEvents()`-based leg-matching approach per its own task instructions, so it could not have caught a bug living in that shared approach. DeepSeek, doing a genuine code read instead of a parallel re-implementation, found exactly that: the label was built by running `detectSignalEvents` ONCE over the FULL session, then matching each touch's bar index against which leg's `[start_idx, end_idx)` window contained it — a leg's `start_idx` is the pivot anchor, set BEFORE the 65pt move that confirms it, so the full-session decomposition retroactively relabeled the `[anchor, confirmation)` window with the FUTURE direction, information a live poller (which only sees bars up to "now") never had. Verified directly against both the buggy script and the live `getCurrentRotationDirection()` (`rotation65ptGateShadow.js`, confirmed to already truncate correctly) before accepting the finding.

Fixed and re-run: truncate bars to each touch's own index before computing the leg. Corrected pooled result: N=1,712 (495 lookahead-mislabeled touches correctly dropped), delta=+$10.90/trade, day-blocked bootstrap CI=[$2.31,$19.54] (excludes zero — real, just far smaller than the headline). 0 of 10 previously-"clean" individual setup_types still clear their own placebo test after the fix — pooled-only effect, several individual types even flip sign.

**Cross-cutting, more consequential**: the identical bug shape (byte-for-byte the same full-session leg lookup) was already sitting in `scratch/poc_65pt_gate_current_leg_verify_20261008.mjs`, the backtest that justified shipping the ALREADY-LIVE `isRotationDirectionConflict()` gate on 2026-10-11. Fixed and re-run the same way: original n=5,474, AGREE +$37.61/DISAGREE -$29.40 → corrected n=5,545, AGREE +$6.62 (CI crosses zero)/DISAGREE -$5.27 (CI crosses zero), pooled delta ~$11.89/trade. The live gate's own code was never wrong (independently verified both times) — only its backing research magnitude was inflated, consistent with the gate's real first live-tagged day (2026-10-09) already showing a much smaller separation than the original backtest predicted.

User's reaction mid-investigation, prompted by "not much firing in RTH" (which turned out to be simply that it was 7:33am ET, RTH hadn't opened yet): "Let move them to live. And review them in 2 months with the poc rotation filters affect" — an explicit instruction to wire the 44-type finding live despite the corrected, much-weaker evidence, which was surfaced plainly before proceeding. Shipped 24 of the 44 (`server/routes/acd.js`'s `WIDER_WINDOW_OVERNIGHT_LEVELS` array), after excluding: `PD2_VAH` (both directions — a dead entry in the research script, no real `level_prices` row under that name ever existed, zero real touches in the whole backtest); `DAILY_OPEN` (both directions — found live-checking this, `level_prices.DAILY_OPEN` has been stale since 2026-08-31, see below); the 16 pairs that already had a direction live elsewhere in the array. Every new entry routes through the exact existing pipeline (dynamic SHADOW→ACTIVE promotion via `getOvernightLevelLiveStatus()`/`PROMOTE_ALL_MODE`'s stat gate, and the rotation filter via `isRotationDirectionConflict()`) with zero new gate code, since both already apply to every candidate in that array. Verified: lint clean, `test_invariants.mjs` identical (120/165) via `git stash`, all 24 new level names confirmed resolving to a real current `level_prices` price, server restarted (the restart itself hit the Bash tool's own 60s foreground timeout and got backgrounded — verified per the standing rule for this exact failure mode that only one `node server/index.js` process existed afterward, correctly bound to port 3002, before trusting it), kill switch auto-rearmed on Sim1 per the standing per-profile exception. Review scheduled: `OPEN_DECISION globex_44type_rotation_filter_2month_review_20261012`, due ~2026-12-12.

**Found along the way, not fixed tonight**: `level_prices.DAILY_OPEN` has not updated since 2026-08-31. Root cause: `scripts/compute_levels.js`'s `DAILY_OPEN` query requires a bar at exactly 9:30:00 ET for the date being computed, but both scheduled crons that call it (`server/index.js`'s Sunday 9:30PM and Mon-Fri 8AM runs) run BEFORE that date's own RTH open exists — structurally can never succeed on either schedule, only ever worked via manual backfill runs that apparently stopped around 8/31. Confirmed this is a safe-but-inert failure, not a mispricing one: the RTH consumer (`acd.js`'s `DAILY_OPEN_FADE` candidate) reads via an exact `trade_date=$1` match with no fallback, so it has simply gone silently dormant since 8/31 (missed real touches, never traded a stale number). `OPEN_DECISION daily_open_level_prices_stale_since_20260831` tracks the real fix (a retroactive "yesterday" catch-up run, not just the existing "today"/"upcoming session" crons).

## 2026-10-11: PROMOTE_ALL_MODE revised to a real statistical gate (DONE, shipped)

Two problems drove this, both raised directly: (1) the user's own 10-day real-trade check on `promote_all_roster_review_20261013` showed primary (real-capital, no live capital at risk — sim/evaluator accounts) trades net negative under the 2026-09-28 unconditional-promote version (mean -$8.91/trade over 250 trades vs +$2.12/trade before); (2) the user pointed out the OLD pre-9/28 `SUPPRESS_MIN_N=20` floor had a real asymmetry bug — LONG and SHORT variants of the same setup_type accumulate real touches at different rates depending on which direction the market favored, so one side could clear the floor and go live while its mirror sat `THIN_N` indefinitely, purely an accumulation-speed artifact, not a quality signal. "The 20 is arbitrary" was the user's framing.

Fix: `scripts/backtest_setup_status.mjs`'s `PROMOTE_ALL_MODE` branch no longer promotes everything unconditionally. Below `MIN_DISTINCT_DAYS_FOR_STAT_GATE=5` real distinct trading days, a type still promotes `ACTIVE` by default (not enough evidence yet — same benefit-of-the-doubt posture, applied symmetrically to both sides of a LONG/SHORT pair). At or above that floor, a `dayBlockedBootstrapCI()` (`server/services/rigorDiagnostics.js`, already built, already used elsewhere — no new statistical machinery) 95% CI is computed on the type's real EV; suppress only if the CI sits entirely below $0 AND the real trades aren't day-clustered (`computeRigor().clustered`, matching the `SETUP_STATUS_DOW` precedent). Deliberately a pure sign test, not a magnitude test — the old `-$5/trade` requirement is gone, per explicit user confirmation ("ignore ev" clarified to mean: EV is the thing being tested, but the dollar-magnitude floor is dropped). Persisted per-type in `notes.stat_gate` for auditability.

Verified: lint clean, full run against real data (exit 0), `test_invariants.mjs` failure/warning set byte-identical before/after (`git stash` comparison), `stat_gate` confirmed landing correctly in `performance_audit` via direct query. This script is cron-only (Sunday 10:30pm ET + daily 8:20pm ET), not imported live by the server, so no restart was needed.

First live run result, worth knowing before assuming this is already biting: 0 new suppressions. 10 setup_types showed a confidently-negative CI (e.g. `CAM_R3_FADE_LONG` CI=[-57.29,-15.79], `PD_SESSION_MID_FADE_SHORT` CI=[-34.78,-1.50]) but all 10 were held back by the day-clustering guard — most of the roster is only ~7-16 distinct real trading days old since `PROMOTE_ALL_MODE` first shipped 2026-09-28, so `top5DayPct` is mechanically high regardless of real quality (a cold-start artifact, not a flaw in the test). Tracked as `OPEN_DECISION promote_all_mode_stat_gate_coldstart_watch_20261011` — revisit in 2-3 weeks once more distinct days have accumulated to confirm the gate actually starts suppressing, not just sitting permanently lenient. The pending `promote_all_roster_review_20261013` decision (keep-vs-revert `PROMOTE_ALL_MODE` entirely, based on real primary-trade P&L) is unaffected by this change and still due 2026-10-13.

Not done: the standing 3-phase DeepSeek review this codebase's own rule calls for on higher-stakes live-wiring changes. Deferred, not skipped — flag before the next related change in this area.

## 2026-10-05 wrap-up: six open items (status per item)

- **Unfilled cluster siblings shown as open (HIGH):** no open-ACTIVE unfilled siblings remain today; expiry is clearing them. Display fix is live. **Still needs your call:** whether an unfilled sibling should keep `ACTIVE` status at all, or get a `PENDING_FILL` status. Left open as a design decision (`unfilled_sibling_shown_as_open_position_20261005`).
- **Replay timestamp shift (HIGH):** audited by grep across scripts/ and server/. No JS `Date` is bound as a query parameter; the `Z`-suffix conversions are all ms arithmetic between naive timestamps. Resolved (`replay_date_param_4h_shift_20261005`). Grep-based, not exhaustive.
- **Downstream rebuild of flagged BACKFILL rows (HIGH):** wired `bad_bars_basis IS NOT TRUE` into `backtest_day_type_alpha.js` (both queries) and into the two all-origin queries in `update_optimal_stops.mjs` (DPP and first raw-trade pull). The other `update_optimal_stops.mjs` queries already filter to ACTIVE/SHADOW origin, which excludes the flagged rows. Still open: the remaining all-origin consumers across the ~300 scripts that aggregate `active_setups` (grep pass not complete), and the decision on re-running the chain (`nq_window_downstream_rebuild_decision`).
- **Sep 22–27 NQ bar gap (MEDIUM):** no bar-count gap in `price_bars_primary`. Sep 22, 23, 24 and 28 each have 1380 bars; Sep 25 has 1020 (Friday close, expected); Sundays have 360 (Globex evening). There are minute-to-minute jumps of 25–75 pts on Sep 22–24 that look like real volatility. I can't rule out a contract error from the bars alone. Open, needs the original source of the flag.
- **2024–2025 bar gaps (MEDIUM):** measured. 2023 is almost entirely thin (229 of 252 weekdays under 300 bars). 2024 Jan 2 to Aug 20 is thin (117 weekdays at 1 bar/day, the known placeholder issue in KNOWN_ISSUES #17). 2025 is clean except Thanksgiving. The thin 2023 and 2024 days are unflagged in the DB. Open, needs a bad_bars-style flag or a decision to exclude the window.
- **ML promotion gate (MEDIUM):** the 2026-10-05 `ML_CHECKPOINT_PROMOTION` report does not meet the promotion rule. 1,219 comparable unseen trades is enough, but only 10 distinct days against the 20-day floor. Candidate policy mean is -$0.15 vs checkpoint -$0.61, with a day-blocked CI of [-1.87, 2.95] (crosses zero). The checkpoint stays `metalabel_v20260928_202126`. Stop-width check is still due Oct 6 (not yet due).
- **Exit test, per setup (MEDIUM):** done. `scripts/backtest_exit_tightening_20261005.mjs` now prints and stores a per-setup breakdown (`perSetup` in `scratch/exit_tightening_20261005.json`). Of 320 verdicted cells (20 setups, N>=20 each): 281 FLAT, 26 NEGATIVE, 13 POSITIVE. The one consistent positive is `GLOBEX_VWAP_FADE_SHORT` (6 of 16 cells, mean +$4.58 to +$16.78/trade). Recorded as PROVISIONAL (`exit_tightening_per_setup_20261005`). It is grid-searched, so it needs a placebo test and a chronological split before any use.## 2026-10-06 wrap-up: broker-truth recording, Sim2 routing, open broker position

**RESOLVED 2026-10-07 (user go-ahead):** the open long 1 MNQZ6.CME (avg 31559.50, Sim1) was flattened with a one-off MARKET SELL, clientOrderId `FLAT-20261007-*`, filled at 31500.25. Broker now shows flat across MNQU6/MNQZ6/NQM6. Gross loss on that long is about -$118.50 (59.25 pts x $2), not recorded in `active_setups` because no app setup owns it. Its origin was most likely setup 131378's stop fill, as described above. The existing `/api/sierra-chart/stop` route would NOT have flattened it: `panicStopAppOrders` returns "already closed by stop" for 131378. Still open: the sim fill-semantics decision (`sim_fills_ignore_order_price_stop_entry_race_20261007`). The system remains DISARMED.

Done this session (merged to main, restarted, switch OFF):
- Fill check keeps real market fills (bid/ask quote check) and flags them.

- Converted broker prices rounded to the 0.25 MNQ tick.

- Raw-unit fill repair (10 rows) and missing stop/exit price repair (5 rows), both backed up.

- Broker-derived P&L written on close (`broker_pnl`, `pnl_source`), tested, live on restart. Not yet verified on a live close.

- Globex entries routed to Sim2 (Sim2 confirmed on the broker's account list). Not yet verified on a live order.

- Daily loss-limit gate (`dllGate.js`) built and tested; NOT wired into the entry path.

Still open:

- OCO bracket (stop + target), not built. Depends on Sim1 filling limits and stops correctly, which is not confirmed.

- Skip reasons not persisted; loss-limit gate not enforced at entry.

- 127681 and 127693: app says closed, but the broker has no exit fill (exit rows still OPEN).

- 131237: stop and exit both show broker fills, which is impossible for one flat position. Part of the open-position investigation.

- Sim1 fill behaviour: limits and stops fill at the quoted bid/ask, not at their prices (see DeepSeek day-scope review).

- Morning pre-placed limits: pilot only, not built.## ✅ 2026-10-05: NQ bad-bar repair, Sep 28 to Nov 19 2025 — DONE (one gap left, flagged)
The Sep 28 to Nov 19 2025 NQ window was stored only as the NQH26 back-month contract (about 2 contracts per minute, against about 215 per minute for the real front month NQZ25). Nothing in the DB held the front-month bars for those dates; the NQZ5 text export starts 2025-11-19 16:15. Rebuilt the 52,395 front-month 1-minute bars directly from the raw `NQZ5.CME.scid` tick file with `scripts/tick_microstructure/build_1m_bars_from_scid.py` (aggregator reuses the canonical `scid_reader.py`). Validated against Sierra's own 1-minute export first: OHLC exact on all 4,545 overlapping minutes, volume/bid/ask/trades exact on all but 2 minutes (a 53-contract difference at 2025-11-19 16:35). Applied `scripts/repair_nq_front_month_bars_sep_nov2025_20261005.mjs --write` after a dry run: backup of 9,899 bad rows (`price_bars_nqh26_sep_nov2025_backup_20261005`, catalogued), transactional delete + insert, calendar reconcile, matview refresh. Verified through the app's own view (`price_bars_primary`): calendar picks NQZ25 for every day in the window, zero open-vs-prior-close gaps over 50pt except real weekend gaps (including Oct 10's Sunday rebound after the Friday selloff). Server stayed up throughout; no new entries in `scratch/server_errors.jsonl`.
- **Not verified / deliberately not changed:** the 2 minutes with a small volume difference against Sierra's export, and whether any research claim or calibration was computed on the old NQH26 rows for this window. NOT checked yet; that is the next step before trusting any result that spans Sep 28 to Nov 19 2025. The volume-piling claim already re-ran from 2025-11-20.




- **Downstream fix, done 2026-10-05 (your go-ahead):** (1) `developing_value_log`, `acd_daily_log` (OR/A), and `level_prices` recomputed for 2025-09-29..2025-11-21 through the real live functions (`computeAndPersistSession`, `computeORLevelsOnly` with a new opt-in `{ overwrite: true }` flag, default off, and `compute_levels.js` per date). Verified PD_HIGH/PD_CLOSE against corrected prior-session bars on all 40 dates, 0 mismatches (15:59 close convention — the first verify pass used 16:00 and falsely flagged correct values; fixed). Backups: `*_nqbad_backup_20261005`. (2) The 1,333 contaminated `active_setups` rows were FLAGGED, not re-simulated: new column `active_setups.bad_bars_basis`, set true on all 1,333, backup `active_setups_badbars_flag_backup_20261005`. Re-simulation was rejected because the old repair script (`repair_backfill_duplicate_bars.mjs`) is not importable and deletes every BACKFILL row globally. Wired into `REAL_TRADE_FILTER` and the two all-origin blended queries in `backtest_setup_status.mjs`. **Not yet wired:** other scripts that aggregate all-origin BACKFILL rows directly (UNIFIED_BACKTEST, DAY_TYPE_ALPHA, pooled studies) still include the 1,333 rows — a grep for `FROM active_setups` aggregates is the next check. (3) Weekly calibration chain (`run_weekly_backtests.sh`, 81 steps) re-run manually at `nice -n 19` during RTH, log `scratch/weekly_backtests_manual_20261005.log`. Server health checked throughout: 200. Results pending at time of writing; check the log tail and `performance_audit` before reporting any SUPPRESS/ACTIVE change.




- **Next, per the handoff:** cumulative session volume in the ML loop, now unblocked by this repair.




- Uncommitted: this repair's scripts and docs. Not committed, awaiting your say-so.

## 🔴 CURRENT TOP PRIORITY (set 2026-07-29): risk management, not more entry-signal research

**STALE NUMBER CORRECTED 2026-08-19 (Opus Audit 8, `scratch/opus_audit_8_results.md`):** the
"118 of 122 (97%) have a stop wider than target" figure cited below is no longer current — a
fresh census of the latest `OPTIMAL_STOP` row per type found **14 of 138 (10.1%)**, median
stop/target ratio **0.86** (was 1.67). The risk-ceiling machinery visible in `OPTIMAL_STOP`'s
`notes.risk_capping` has evidently fixed the raw ratio problem since this was written. **This
does NOT mean risk management is solved** — the realized payoff shape has not followed: ACTIVE
population (n=344, real capital) shows avg win $85.30 vs avg loss $118.00 (1.38 loss/win ratio),
driven by (a) a fatter loss tail on fade-family setups specifically (STOP_HIT MAE overshoots the
stop by >50% at 13.2% of the time vs 3.6% for breakout-family, both N≥20) and (b) a much larger,
newly-found structural bug: `IB_BULLISH`/`IB_BEARISH` — which together produce 67% of real-capital
big losses — have their entire day-type-conditioned stop/target/suppression wired to
`acd_daily_log.day_type`, a column that's NULL for the entire live session (written by cron at
8:20 PM ET). Four real, correctly-swept day-type `OPTIMAL_STOP` rows have never once been read
live. See `OPEN_DECISION ib_daytype_calibration_structurally_unreachable` (HIGH, flagged same
session) — **this, not the stop/target ratio, is the re-aimed top priority.**

**User directive, verbatim intent**: the system needs to find a way to manage risk effectively — throttling losing trades, achieving a better R:R, or some other mechanism — because right now it fires sequential counter-trend/low-R:R trades that produce small wins and large losses. This is the top priority over further signal-discovery work. Stated end goal: make the system **autonomous and profitable** — both halves matter, not just finding more signals. Recorded as `OPEN_DECISION` `prioritize_risk_management_over_signal_research` (HIGH) so it resurfaces every session start regardless of whether this file gets read carefully.

**Third lead tested and closed out, same night (2026-07-30): the user's own 4H-50-EMA trend filter idea (only fade LONG above it, only fade SHORT below it) — discard, real negative on 3 independent checks.** Built with genuine no-lookahead (`scratch/run_ema_filter_test.js` — Claude verified this directly by reading the code, not just trusting Gemini's summary: the DB session timezone is America/New_York, so the hour-based 4H bucket boundaries are correctly ET-midnight-anchored, and a touch only ever sees the EMA as of the previous CLOSED 4H bucket). A 9-combination sensitivity sweep (period ∈ {20,50,100} × timeframe ∈ {1H,2H,4H}, RTH) showed no consistent neighborhood — e.g. 1H/50 gap=-$2.87 vs 4H/50 gap=+$10.10 — the same brittle, parameter-specific signature that already killed the Regime A/B/C classifiers. The Globex/overnight leg fully INVERTED the RTH result (ALIGNED EV=-$2.06 vs COUNTER EV=+$5.27) — a real trend-alignment relationship shouldn't flip sign between sessions. Chronological rigor on the RTH headline failed (thirds -$4.20/-$1.42/+$17.42) with the entire apparent edge concentrated in the most recent third of ~3.5 years of history — independently corroborated by the 80/20 train/test split showing the identical pattern (two different slices of the same data agreeing it's a recent-history artifact, not a bug). `RESEARCH_CLAIM ema_4h_trend_filter_brittle_overfit_discard` (CONFIRMED negative). Not wired. **This closes out all 3 risk-management leads tested this session** (drawdown-velocity, risk-adjusted stop/target re-optimization, EMA trend filter) — all 3 real, honestly negative/inconclusive results, none wireable. Remaining un-tried angles: lean into `STACK_VOL_BREAK_LIVE` (the one breakout-family setup, naturally better R:R by construction — matches the user's own stated trading style, see memory `user-trading-style-breakout-preference`), or the never-built SPC/Kelly position-sizing ideas.

**Follow-up, same day, after the two threads below were exhausted**: user asked Claude+Gemini to work together on the root cause directly, and mentioned two new pieces of context — (a) they personally prefer trading breakouts, not fades, and (b) confirmed the objective-function hypothesis is worth pursuing. Investigation found: **118 of 122 calibrated setup_types (97%) have a stop wider than target** (median ratio 1.67, several need 65-81%+ WR to break even) — a direct, structural consequence of `update_optimal_stops.mjs` picking stop/target to maximize raw mean EV with zero penalty for variance/drawdown. This is very likely the real driver of "PnL volleys too much." Separately, the ONE live breakout-family setup, `STACK_VOL_BREAK_LIVE`, already has a healthy R:R by construction (LONG 40pt stop/70pt target, SHORT 40/40) — much better than the fade family, matching the user's stated preference; saved as memory `user-trading-style-breakout-preference`. User chose to pursue the root-cause fix. Ran the full 3-phase Gemini workflow:
   - **Phase 0 (design critique)**: Gemini recommended a Sortino-like ratio (`mean(pnl)/stdev(negative pnl)`), the plateau+chronological-rigor-check combo over full walk-forward (correctly judged walk-forward impractical given most setups have well under 150 total trades), and a hard EV-retention floor (`candidate_EV >= 0.5 * maxEV`) so the optimizer can't pick a near-zero-trade "solution." Also flagged that any resulting narrow-target pick deserves scrutiny since this codebase's backtests don't model slippage.
   - **Phase 1 (mine-and-run), attempt 1 — failed audit**: Gemini's Sortino-based pilot produced nonsensical ratios (values in the billions/trillions). Root-caused directly: this codebase's synthetic MAE/MFE-threshold stop-hit resolution resolves every stop-out to an *identical* dollar loss for a given (stop,target) candidate — downside stdev is ~0 by construction for nearly any candidate, so any per-trade Sortino/Sharpe computed on it is structurally degenerate, not just noisy. A real, reusable methodological finding for future risk-adjusted-objective work in this codebase, not a one-off bug. Also caught a second issue: 4 of the 8 pilot setups' live baseline EV comes from the corrected-resimulation target-calibration path, not the simpler function the pilot reused for speed — an apples-to-oranges baseline for those 4.
   - **Phase 1, attempt 2 (correction, per the standing 2-attempts rule)**: redirected to a Calmar-like objective (`EV / maxDrawdown` of the real resimulated equity curve) instead. Results genuinely promising: across the 6 evaluable pilot setups (2 of 8 failed the N≥20 gate), **maxDrawdown fell in 6/6** (12-72% reductions), EV improved or turned positive in 5/6. But the pilot's own overfitting guard (a plateau/neighbor-stability check) failed 100% of the time, including on the two highest-N setups (N=3026, N=1481) that shouldn't have a grid-resolution problem — inconsistent with a genuine instability finding. Root-caused directly (Gemini's 2 attempts were used, Claude took over per the standing rule): the check requires a neighboring grid cell within a hardcoded ±20% band of the chosen candidate's Calmar ratio — too tight for a compound ratio (EV/maxDrawdown, both independently noisy) at N~100 scale, and itself a static-threshold violation of this codebase's own standing rule.
   - **Round 3, same thread, next day (2026-07-30) — RESOLVED NEGATIVE.** Fixed the plateau tolerance (MAD-based, data-derived — no more hardcoded %) and re-ran on a clean 8-setup sample confirmed to all be on the plain-EV-sweep baseline (avoiding round 2's corrected-resim confound entirely): `OR_LOW_FADE_LONG`, `OR_HIGH_FADE_SHORT`, `IB_HIGH_FADE_SHORT`, `IB_LOW_FADE_LONG`, `IB_BEARISH`, `ONH_FADE_SHORT`, `ONL_FADE_LONG`, `WEEKLY_VWAP_FADE_LONG`. Result: **0 of 8 produced both a genuinely different AND a robustly-validated improvement.** 4/8 already sit at the risk-adjusted optimum (legitimate no-change result). 1/8 (`IB_BEARISH`, already EV-negative) correctly found no positive-EV candidate exists anywhere in its grid — the profitability floor working as designed. Of the 3 that did produce a different pick: `ONH_FADE_SHORT` cut maxDrawdown 37% but EV declined slightly and failed its own stability check (independently re-verified this setup really is plain-sweep, not corrected-resim — Gemini's report had mislabeled it, caught on audit); `IB_LOW_FADE_LONG` cut maxDrawdown 60% in dollars but its losing-STREAK LENGTH more than doubled (7→15 consecutive losses) — a real tradeoff (many small losses vs fewer big ones) that may not solve the user's actual "PnL feels like it volleys" complaint even though the dollar metric improved, and it also failed its own stability check; `ONL_FADE_LONG` showed no real improvement on any axis and failed all 3 checks. `RESEARCH_CLAIM risk_adjusted_stop_target_pilot_promising_unproven` updated to `CONFIRMED` status describing this final negative result (superseding round 2's promising-looking PROVISIONAL read, which is now understood to have been inflated by the round-2 baseline-mismatch confound). `OPEN_DECISION fix_plateau_tolerance_before_scaling_risk_adjusted_objective` RESOLVED: **do not scale this technique (Calmar-ratio re-optimization over the existing fixed MAE/MFE percentile grid) to the other 114 setup_types.** The underlying 97%-stop>target problem remains real and unaddressed — a genuinely different technique (finer/continuous candidate grid, or a different lever entirely) would be needed. **Not wired. Nothing changed live.**

**What was actually built/tried this session, and what's still open (original entries):**

1. **Drawdown-velocity circuit breaker — RESOLVED (as far as today's data allows): only the 15min leg is trustworthy, and it's the wrong-direction leg for risk management.** Same-day follow-up (2026-07-29, `scratch/pilot_drawdown_velocity_window_sweep.mjs`) ran a finer 11-point window sweep (10-60min, chronological 80/20 train/test, thresholds derived from TRAIN only) instead of just the original 15min/30min pair. Pooled EV across the sweep looked like a strikingly smooth, monotonic crossover around 25-30min — but two follow-up checks undercut treating that shape as real corroboration: (a) the TEST severe buckets are day-clustered at *every* window (top5DayPct 61-100%, only 4-15 distinct days behind each number — inherent to a volatility-conditioned bucket, not a bug); (b) chronological 3-way stability only passes at the ORIGINAL 15min window — every wider window, including large-N ones (30min N=160 train, 40min N=208 train), flips sign across its own history. Dispatched a Gemini methodology critique (`scratch/gemini_review_drawdown_rigor_methodology.md`) per direct user request to sanity-check whether `computeRigor()` itself was too strict — Gemini's independent read: the day-clustering flag is reasonably dismissed as structural for this kind of signal, but the large-N stability failures at 30min+ are a **real red flag, not an artifact of an overly strict check**, and the smooth crossover shape is mostly autocorrelation (adjacent windows share most of the same underlying touches) rather than 11 independent confirmations. **Net: the only trustworthy piece is the 15min "severe drawdown → BETTER next trade" (capitulation) leg (N=31 test, EV=+$18.35, rigor-clean)** — and that's the *opposite* direction from what a risk-management circuit breaker needs (it argues for re-engaging after a fast flush, not throttling). The useful leg (severe drawdown 30min+ → worse next trade) remains statistically unresolved. `RESEARCH_CLAIM drawdown_velocity_window_dependent_effect` updated with the full account (still PROVISIONAL). **Not wired, and not expected to be wireable from this angle without new data or a different technique** — Gemini recommends a GAM/spline regression treating window length as a continuous covariate (not built) as the correct way to actually pin down the crossover with a confidence band, rather than more discrete-bucket sweeps.

2. **R:R / bank-vs-extend (wider targets) — RESOLVED negative: fixed the broken replication check, real cross-setup held-out test does not replicate.** Same-day follow-up (`scratch/pilot_bank_vs_extend_replication_fix.mjs`) fixed both problems named below: (a) selection of the "best" extend multiple per setup is now reachability-weighted (must clear that setup's own median reachability across its 5 candidates, plus ≥10 trades that actually entered extending mode) instead of picking whichever multiple has the single highest raw EV — the prior pass's "best" picks were often driven by rare, barely-reachable outsized winners (0-20% reachability); (b) replication is now genuinely cross-setup (`idFn=setupType`, matching every other `computeReplication()` caller in this codebase) — top-half of the 17 tested setups by improvement-over-baseline selected as "winners," bottom half genuinely held out (the original bug: `selectedIds` was every trade id in the population being tested, so `heldOut` was always empty). **Result: does not replicate.** At the primary top-9-of-17 cut, selected pooled improvement is +$7.03/trade (N=827) vs. held-out −$3.61/trade (N=642) — opposite sign. Sensitivity-checked across cut points (K=3/5/9/13): only K=3 barely replicates (held-out +$0.17, weak), K=5/9/13 all fail, and the held-out favorable fraction degrades monotonically (0.79→0.75→0.63→0.25) as more setups are counted as "winners." 6 of 17 setups have every candidate multiple below the 10-trade reachability floor regardless of method — genuinely too thin to select on at all. `RESEARCH_CLAIM bank_vs_extend_wider_target_replication_check` recorded (new, PROVISIONAL). **Wider/extended targets are not currently a validated R:R lever. Not wired.**

3. **A specific gate idea (hivol_lopace_at_detection) was tested as a suppression mechanism and rejected** — 95.7% of the time it fires, it's on setup_types already suppressed by the existing system, so gating on it would be mostly redundant. Not a risk-management win, but a real negative result, properly recorded (`RESEARCH_CLAIM hivol_lopace_gate_promotion_not_supported`) rather than silently dropped.

4. **Two ideas raised early this session were never actually built or tested**: equity-curve/SPC (statistical-process-control) style self-throttling, and Kelly-criterion dynamic position sizing. Both respond to the system's own realized P&L/variance rather than trying to classify market conditions — structurally different from everything tried above, and still on the table as the next thing to actually scope.

**How this session's work got built (new standing process, see CLAUDE.md's Collaboration section for the durable rule)**: a 3-phase Gemini workflow — (0) send Gemini the intended approach for critique BEFORE writing code, (1) full mine-and-run for the actual test, (2) a separate code-review pass on the resulting script before trusting any number. Adopted mid-session after Claude shipped a live change (the `hivol_lopace_at_detection` badge) without any of this and a real off-by-one bug reached production undetected until the user asked "did gemini review your code?" Used properly for the gate-backtest above and caught real, load-bearing problems (a broken level-name mapping, a buried marginal-utility number, a stability-check failure the first write-up ignored) before anything was trusted. **Apply this to whatever risk-management work comes next — it's higher-stakes than signal discovery, not lower.**

**Also shipped this session, lower-stakes**: a standalone external dashboard (`server/public/quick-check.html`, exposed via a persistent Cloudflare Tunnel + Access at `tj.6claire.page` — see CLAUDE.md's new "Where to look" entry) and a fix for `active_setups` firing duplicate live rows when several levels cluster within a few polls of each other (`cluster_attributed_setups`).

## ✅ 2026-07-17: built `scripts/flag_decision.mjs` — pending decisions are now actively monitored, not buried in prose

Direct follow-on to the "no structural way to tell live pipeline from abandoned" thread below, after the user pushed further: "anything that needs to be reevaluated should [be] flagged with something and actively monitored. Nothing can be buried." Considered and rejected overloading `RESEARCH_CLAIM` (`scripts/record_claim.mjs`) directly — a pending product/architecture decision ("wire this in or delete it," "merge this branch") has no statistical content and doesn't go stale the way a tested research finding does; it just sits until a human decides. Built a deliberate sibling instead, reusing the same underlying mechanism (same `performance_audit` table, same JSON-notes-with-date shape, same session-start-hook integration pattern) rather than a parallel table/file — this codebase already has a documented anti-pattern of uncataloged ad hoc tables (see `docs/DB_BACKUP_CATALOG.md`'s own origin story).

**Built**: `scripts/flag_decision.mjs` (`flagDecision`/`resolveDecision`/`listDecisions`, `signal_type='OPEN_DECISION'`, vocabulary `PENDING`/`RESOLVED` — deliberately not `RESEARCH_CLAIM`'s `CONFIRMED`/`PROVISIONAL`/`STALE`, which wouldn't make sense for a yes/no decision). `.claude/hooks/session-start.sh` gained an `OPEN_DECISIONS` section, printed unconditionally every session, sorted oldest-first with age since first flagged (computed in SQL via `CURRENT_DATE - date`, not JS `Date()` — caught and fixed a real naive-timezone rounding bug during testing, exactly the class of bug this codebase's own `parseDateTime` writeup already warns about). **The hook section is the actual fix, not the table** — a row nobody ever queries again is exactly as buried as a paragraph nobody re-reads; printing it every session unconditionally is what makes it un-buriable.

**Seeded with 10 real pending decisions**, each written with full context (what's being decided, why it matters, what resolving it looks like — not a bare fact), pulled from this session and the prior day's SSOT/dead-end audit: `unrendered_dashboard_cards_5`, `rule_overrides_noop_pipeline`, `dead_backend_routes_20`, `premarket_walkthrough_and_screenshot_upload_orphaned`, `main_branch_55_commits_behind`, `latency_audit_sunday_only_cadence`, `vol_regime_history_cron_undecided`, `value_area_responsive_short_runner_followup`, `pd2_2dpoc_ev_magnitude_needs_scrutiny`, `backtest_pipeline_freshness_consumption_report`. Full text for each lives in the `OPEN_DECISION` rows themselves (`node scripts/flag_decision.mjs --list`), not duplicated here — this file's job now is narrative history, not the live pending-items list.

**Verified end-to-end**: smoke-tested add/list/resolve cycle before seeding for real; ran the hook standalone and confirmed all 10 print with correct 0-day age; confirmed `--resolve` correctly removes an item from the default `--list` (still visible via `--list-all`). Documented as a new convention in `CLAUDE.md` alongside the `RESEARCH_CLAIM` entry.

**Not done**: the actual "freshness + consumption cross-reference report" idea (querying every `performance_audit` signal_type's cron-wiring and live-consumer status automatically, instead of hand-archaeology each time) is tracked as its own pending `OPEN_DECISION` (`backtest_pipeline_freshness_consumption_report`), not built tonight — this session built the *tracking mechanism*, not that specific report.

## ✅ Dedup pass finished 2026-07-15 (picked up from the "READ THIS FIRST" item below) — went from ~86-102 requests to a stable 72-75, settle time now mostly hitting the 5-6s target

Picked up the explicit next step from the section below ("finishing the dedup pass... should be done regardless"). Found and fixed several real independent-fetcher duplicates beyond the 7 named there — the earlier sweep's own components (`useSharedPollData`, `refreshSharedPollData`) generalized cleanly to all of them:

## ⏱️ EXPLICIT TARGET, READ THIS FIRST: Morning Prep full-page settle time ≤ 5-6s

User-set threshold, restated explicitly here (2026-07-15) so it isn't buried in prose in the section below. Measure with the convention already established: Playwright, `page.locator('text=Loading…').locator('visible=true').count()` polled ~every 500ms-1s from page load until it hits 0. Current state: **6-11s range, hit the target on at least one run, not consistently.**

**Honest math on how much further pure deduplication can take this, worked out directly rather than assumed:** a real Morning Prep load fires **34 unique API endpoints**. React StrictMode (dev-mode only, always on in this project's normal day-to-day workflow — it doesn't run a production build) double-invokes every effect, so even a *theoretically perfect* app with zero redundant fetchers still fires **68 requests** (34 × 2) — this is not fixable in app code short of disabling StrictMode (loses a real safety net) or moving off dev-server workflow (not how this app runs). Chrome caps 6 concurrent connections per origin; 68 ÷ 6 ≈ 11 sequential waves is a real structural floor even with every individual request fast. Currently measuring **88 total requests** — ~20 above that 68 floor, meaning **7 more endpoints are still duplicated beyond StrictMode's unavoidable 2x**, found via the same request-tracing method used all session (`market/pulse`, `case`, `accounts`, `morning-brief/trade-alerts`, `acd/feedback`, `behavioral-patterns`, `acd/today` — each 4x instead of 2x — plus `setups/today` at 6x, see below).

**Conclusion: getting under 5-6s *consistently* via deduplication alone is not guaranteed.** Finishing the dedup pass (bringing 88 → ~70, close to the 68 floor) is real, available, safe work and should be done regardless — but the last mile past that floor likely needs one of the two levers already deliberately deferred earlier this session (see "connection-starvation fix" entry below for the full reasoning on why they weren't done):
1. **HTTP/2 for the dev server** — removes the 6-connection cap via multiplexing entirely. Real tradeoff: changes the URL scheme (`https://`) and needs a one-time self-signed cert acceptance in the actual daily-use browser — a workflow change, not a code change, needs explicit confirmation before doing.
2. **Fewer distinct backend calls** — combine several small independent endpoints into one combined response (e.g. one "Morning Prep bundle" endpoint instead of 34 separate ones). Real engineering, not a quick fix — redesigns the API surface `useSharedPollData` currently subscribes to per-URL.
Don't reflexively reach for either without re-measuring first — finishing the dedup pass alone might get close enough that the remaining gap no longer matters in practice. Re-run the request-count + settle-time trace after the dedup pass before deciding whether (1) or (2) is actually still needed.

## Pending decisions / unconfirmed proposals

- ~~**HomeAssistant hosting (future, no timeline).** Access journal from HA sidebar via Cloudflare Tunnel (already running). Easiest: add `panel_iframe` to HA `configuration.yaml` pointing at tunnel URL — no backend/frontend changes. Prerequisite: verify tunnel URL is stable (not ephemeral trycloudflare.com free tier).~~ — **Resolved 2026-07-29.** Built as a persistent named tunnel (not the ephemeral free-tier concern this entry worried about) at `tj.6claire.page`, serving a dedicated standalone page (`server/public/quick-check.html`, `GET /quick-check`) rather than an iframe of the full app, with Cloudflare Access (Google OAuth) + exact-path ingress allowlisting in front of it. This entry sat here describing already-built work as "future, no timeline" for long enough that it was actively misleading — see CLAUDE.md's "Where to look" section (new entry, same date) for the real, current pointer, and Claude's own memory `reference_ha_cloudflare_tunnel.md` for full history.


## 2026-10-07: DeepSeek review of branch fix/sierra-wiring-items-3-6-7-8-20261007 — one fix applied, two open

Read-only review (plan mode, auto-approve off, full diff embedded in the prompt so no tool calls were needed) found nothing blocking arming, with one real fix applied and two items left open, not blocking:

- **Fixed**: `dllGateDecision()` (`server/services/sierraChart/dllGate.js`) used to report `unknownCount > 0` (a trade closed with no broker_pnl recorded yet) without blocking — fail-open exactly when reconciliation is lagging and a real loss could be hiding past the limit. Now blocks. Test added to `scripts/test_broker_guards.mjs`.


- **Not a bug (verified against the DB, not just re-asserted)**: the reviewer flagged `scripts/repair_stale_exit_rows_20261007.mjs`'s hardcoded `IDS=[4,16]` against setups 127681/127693 as a discrepancy to confirm — already confirmed earlier the same day via a direct query (row 4 = 127681's EXIT, row 16 = 127693's EXIT).


- **Open, not blocking**: the position invariant's baseline assumes the broker was flat at `order_placements_invariant_baseline`'s own baseline id — never independently confirmed, just asserted in a comment. `getBrokerSnapshot`'s 3-second collection window could miss a position message in some environment, which would fail-closed (refuse every exit) rather than silently misbehave — also not independently tested against a real DTC session dropping a position message.

## 2026-10-07: Native OCO bracket test on Sim1 -- FAILED, decisive negative, real position opened and closed

Live test (user-authorized): a parent SELL LIMIT far from market (33000, last price ~31267) followed
immediately by the OCO children (STOP BUY @33200, LIMIT BUY @32800), via the new `placeBracketEntryOrder()`
build. Intended to be unfillable by all three legs. Instead: the parent filled INSTANTLY at market
(31267.25, not its 33000 limit -- the same sim-fills-at-market behavior documented 2026-10-05/07), and
both OCO children were REJECTED with "There is no parent order for child OCO order" -- the parent had
already transitioned to FILLED before the server processed the OCO submission, even though the two
messages were sent back to back with no `await` between them. Result: a real, completely unprotected
short position (-1 MNQZ6), zero stop, zero target. Flattened immediately (BUY @31272.00, -$10.50 before
commission) and recorded in the ledger (`scripts/record_oco_test_trade_20261007.mjs`); invariant confirmed
back to 0 against a flat broker.

**This is not "untested" anymore -- it's a decisive negative for Sim1 specifically.** Sierra's own
documented bracket procedure requires the parent to still be pending/working when the OCO message
arrives. Sim1's simulator resolves a fill synchronously at order-submission time, before the next
message can be processed as "parent still pending" -- so ANY parent order (not just one at an extreme
price) will outrun the OCO submission on this venue, every time. `SIERRA_USE_OCO_BRACKET` must stay off
on Sim1 -- enabling it would systematically produce naked, unprotected positions, worse than today's
existing standalone-stop-after-fill path, not just an unverified improvement on it.

**Not yet determined**: whether this is purely a Sim1 (local-fill-simulation) artifact that a venue which
actually rests orders (the real Rithmic-backed sim, or further up the stack) would not share, or a more
general DTC-server-side race this build's own back-to-back-no-await submission can't close no matter the
venue. The message ordering is correct per the protocol doc; the failure is in how fast the venue resolves
the parent, not in this app's own submission logic. `OPEN_DECISION oco_bracket_sim1_structurally_broken_20261007`
tracks the follow-up: find a venue that genuinely rests a LIMIT order before testing bracket linking again,
or confirm this fails the same way there too.

## 2026-10-07: Sierra Chart depth-data recurring cleanup -- PRIORITY, not yet built

One-off cleanup done (746 files/214.58 GB deleted, everything over 90 days, all symbols) during the
OCO investigation. Still needed: a recurring job (Windows Task Scheduler, daily) running the PowerShell
delete-older-than-N-days command against `C:\SierraChart\Data\MarketDepthData\*.depth`, matched on the
real filename date (`SYMBOL.YYYY-MM-DD.depth`, UTC), not file mtime. Also still open: check which other
symbols (ES confirmed) have "Record Market Depth"=yes in Global Symbol Settings and decide whether that's
intentional before deciding the recurring window (30 vs 90 days). This is Windows/Sierra-Chart-side
infrastructure, not app code -- nothing in this repo depends on it, flagged here only so it isn't lost
across sessions.

## 2026-10-07: Resting-order investigation RESOLVED -- real cause was symbol/exchange format, not the venue

Confirmed via a real round-trip test against the new Trading Evaluator instance (SierraChart-DTC,
account DTC-Live-Simulator, port 11199): a SELL LIMIT far from market (40000) submitted with Symbol and
Exchange as separate fields ("MNQZ26"/"CME") rested for the full 15-second test window with no fill, and
canceled cleanly ("Simulated order canceled") -- the first clean resting-order result all session.

**Root cause of every earlier failure (Sim1 AND the first several Trading Evaluator attempts): the order
symbol was sent as one combined string ("MNQZ26.CME"/"MNQZ6.CME") with Exchange left empty -- matching
this app's existing Rithmic convention (contractSymbol.js/dtcClient.js). The Trading Evaluator service
rejects that format outright ("Order is not allowed based on the symbol"), before ever reaching real
order-matching logic.** This is NOT the same bug as Sim1's instant-fill-at-market behavior -- it's a
separate, earlier-stage rejection that looked superficially similar (both prevented an order from
resting) but has a completely different cause and fix.

Two other real blockers found and fixed along the way, both specific to the new simulated account, not
the symbol-format bug: (1) Symbol/Product Limits on the account defaulted to Trade Position Limit=0 /
Order Quantity Limit=0 for ALL_SYMBOLS -- raised to 10, matching the app's own existing position-limit
convention; (2) the account had $0.00 funded balance with margin required, confirmed via a real manual-UI
rejection message ("Insufficient Account Value (NLV)... Account Value: 0.00") -- funded to $1,000,000 to
unblock testing, NOT yet reconciled against MNQ's real margin requirement (the $4,361 margin figure cited
in that rejection looks like NQ-sized margin, not MNQ -- MNQ is 1/10th NQ's size by design --
`OPEN_DECISION mnq_margin_config_may_be_using_nq_values_20261007` tracks checking the MNQ symbol's own
margin setting for a literal NQ-value copy-paste before trusting any further margin-gated test here).

**What this means for the OCO bracket build:** the earlier `oco_bracket_sim1_structurally_broken_20261007`
finding is correct for Sim1 specifically (it fills everything at submission, confirmed via its own
"Simulated order accepted" -> immediate fill signature, a real and different behavior from this symbol
rejection) but does NOT mean native OCO brackets can't work at all. The actual bracket (parent + OCO
children, not just a single resting order) has STILL NOT been tested on this corrected venue/format --
`placeBracketEntryOrder()`'s current code sends the combined Symbol.Exchange format everywhere, which
would hit this same rejection on this venue. Before retrying the bracket test here, either add a
per-connection symbol-format mode to contractSymbol.js/orderSweep.js, or construct the split-field
request manually for this one-off test, matching what test_evaluator_resting5.mjs did.

## 2026-10-07: OCO bracket -- REAL FIX FOUND AND CONFIRMED LIVE, two gaps remain before arming

Root cause of every "no parent order for child OCO order" rejection, found after extensive dead-end
troubleshooting (symbol format, timing, account settings, a restart, a secondhand DeepSeek guess that
was checked and disproven): `IsParentOrder`/`IsAutomatedOrder` are `uint8_t` in the real DTCProtocol.h
struct, not `bool`. dtcClient.js was sending them as JSON `true`/`false`. The Trading Evaluator server
silently never registered the order as a parent when sent that way -- the order itself was accepted
fine, but `IsParentOrder` effectively never took, so every subsequent OCO child submission correctly
(if confusingly) found "no parent order." Switching both fields to the integer 1 fixed it immediately,
confirmed via the real `submitOrder()`/`submitOcoOrder()` methods, not just a hand-built message: parent
shows "Server side bracket order," both children come back `PENDING_CHILD` (status 3) correctly
referencing the parent's real ServerOrderID, and canceling the parent correctly cascades to cancel both
children automatically. Fixed in `server/services/sierraChart/dtcClient.js`; `scripts/test_oco_submission.mjs`'s
assertions updated to check for the integer (the old assertions had been checking for `true`, which is
why this bug shipped unnoticed in the first place -- a number computed twice by the same code isn't
verification, same lesson, now caught in a test rather than a comment).

**Two real gaps before this can be armed in production, not yet closed:**

1. **Never tested against Sim1/Rithmic, only against the Trading Evaluator test instance.** The split
   Symbol/Exchange field format (`"MNQZ26"`/`"CME"`, not `"MNQZ26.CME"`/`""`) was required by the
   Evaluator specifically. Production's `contractSymbol.js`/`orderSweep.js` still build the combined
   format, matching Rithmic's own convention (confirmed working for plain ENTRY/STOP orders all session).
   Whether Rithmic/Sim1 needs the same split-format fix for a bracket submission, or accepts the combined
   format brackets use fine, is unverified -- this fix was proven on a different venue than the one
   `SIERRA_USE_OCO_BRACKET` would actually route through.
2. **No independent review of this fix**, per the standing higher-stakes-work rule. This is real-money-
   adjacent code (even though today's testing was entirely on sim/eval accounts) and hasn't been through
   DeepSeek or a second pass.

`OPEN_DECISION oco_bracket_fix_needs_rithmic_test_review_20261007` tracks both before
`SIERRA_USE_OCO_BRACKET` is ever set true against the production connection.

## 2026-10-07: Symbol/exchange wire-format fix shipped, isolated to dtcClient.js alone

Resolves item 1 of the decision above (the Rithmic-vs-Evaluator discrepancy) by making the fix
venue-agnostic rather than venue-specific. Real root cause, confirmed by a controlled A/B test on
one unchanged account earlier the same day: this app has always sent the order symbol to Sierra
Chart as one combined string (`"MNQZ6.CME"`) with `Exchange` left empty, matching an assumption in
`contractSymbol.js`'s own header comment that turned out to be wrong -- the real DTC wire protocol
wants `Symbol`/`Exchange` as two separate fields, and sending them combined produces two different
failure modes depending on account/server: Sim1 silently fills at market instantly regardless of
price (why every real stop today filled far from its calibrated `stop_level`); the Trading
Evaluator rejects the order outright ("not allowed based on the symbol").

**Fix is isolated to exactly one file.** `dtcClient.js` gained a small module-level helper,
`_splitSymbolForWire(symbol, exchange)`, called inside `submitOrder()`/`submitOcoOrder()` right
before the wire message is built -- it splits a combined `"SYMBOL.EXCHANGE"` string on its last
`.` into the two real fields, or passes through unchanged if the caller already supplied a split
`exchange`. **Deliberately does NOT touch `orderSweep.js`, `reconciliation.js`, or
`connectionManager.js`** -- all three keep passing/storing the combined form exactly as before,
which is correct for them: `order_placements.symbol` (the DB identity column),
`extractPositionForSymbol()` (matches broker-reported `positionMessages[].Symbol`, which the broker
always reports in combined form), and `checkPositionInvariant()`'s `WHERE symbol = $1` lookup all
depend on the combined string staying the single identity key used consistently throughout the
app. Splitting anywhere upstream of the wire-serialization layer would have silently broken
position-invariant matching (the DB column would stop matching what the broker reports) -- this
was checked and specifically avoided, not just an oversight that happened not to bite.
`contractSymbol.js`'s header comment, which had incorrectly asserted the venue "embeds the
exchange directly into the Symbol field" as a convention, is corrected to describe the real
mechanism and explicitly flag which call sites need the combined form.

Also fixed in the same edit: `IsParentOrder` is now always sent explicitly as `0` or `1`, never
omitted when false (previously conditionally added to the message only when true).

Verified before committing: `scripts/test_oco_submission.mjs` updated (checks the split actually
happens for a combined-form caller, checks an already-split caller and a bare no-dot symbol both
pass through unchanged, checks `IsParentOrder` is explicit 0) and passing; `npx eslint` clean on
all 3 touched files; both edited modules confirmed to import cleanly under real ESM (not just
`no-undef`); `test_invariants.mjs` byte-identical failure/warning count (129/170) before and after
via `git stash`. Not yet done: a live round-trip test of this exact diff, and independent review --
tracked at `OPEN_DECISION oco_bracket_wire_split_fix_needs_review_20261007`, which also carries
forward that the account switch (new DTC-Live-Globex account on the Evaluator instance), `.env`
change, restart, and re-arm are all still explicitly deferred pending your separate go-ahead.

## 2026-10-07: `requestSecurityDefinition()` checked, deliberately left unsplit

Per DeepSeek's Q3/S6 ask to grep every Symbol/Exchange construction site, not just order
submission: `requestSecurityDefinition(symbol, exchange)` (dtcClient.js, called by
`priceMultiplier.js` with the combined form, no exchange) builds the wire message the same
unsplit way `submitOrder()` used to. **Deliberately not changed.** This call site is confirmed
*working* today with the combined format (`priceMultiplier.js`'s own header: a live
`SECURITY_DEFINITION_FOR_SYMBOL_REQUEST` for `"MNQZ6.CME"` correctly returned
`DisplayPriceMultiplier`, verified 2026-09-29), and `getPriceMultiplier()`'s response matching
(`msg.Symbol !== symbol`) depends on the response echoing back the exact combined string sent in
the request. Splitting the request side without being able to verify from here whether the
response's `Symbol` field would still come back combined or split risks silently breaking a
correctness-critical, already-working mechanism (fill-price interpretation) for no demonstrated
bug -- unlike order submission, which was confirmed broken two separate ways. If this is ever
revisited, it needs a live A/B on the response format first, not a blind copy of the order-path
fix.



## 2026-10-13: Multi-position-stacking build -- shipped, NOT yet live, DeepSeek review drafted not dispatched

Per explicit user directive ("Yea build it and raise to 10"): the DeepSeek-reviewed design to
allow multiple same-direction real positions (direction-aware, opposite-direction still blocked,
capped at MAX_CONCURRENT_POSITIONS=10 -- the user's own override of DeepSeek's recommended cap
of 2, matching the broker's real Trade Position Limit) is built, unit-tested, and committed as
`575e27f`. See that commit and `checkEntryGates()`/`brokerExitDecision()`'s own header comments
in `server/services/sierraChart/reconciliation.js` for the full design.

**Status at session pause, exact next steps:**
1. The `position_slot` schema migration was run manually by the user (the sandbox's auto-mode
   classifier denied it as a schema-altering Bash action) -- independently verified afterward
   (information_schema + a direct read of the one real open position, correctly backfilled to
   slot=1). Done, not pending.
2. The entry-gate rewrite itself (`checkEntryGates()` replacing `isAnotherPositionOpen()` at
   both real insert sites; `brokerExitDecision()` relaxed to sign+magnitude-floor) is committed.
   Verified: lint clean, both files import cleanly under real ESM, `test_invariants.mjs`
   byte-identical (138/166) before/after via `git stash`, `brokerExitDecision()` unit-tested
   against 7 cases including the original misattribution-bug shape, `checkEntryGates()`
   exercised against the real live DB state.
3. **A DeepSeek code-review request for the actual diff was DRAFTED (`scratch/claude_request_
   deepseek.md`, the diff itself exported to `/tmp/stacking_diff_for_review.txt`) but NOT YET
   DISPATCHED** -- the session paused before calling `invoke_gemini.sh`'s DeepSeek sibling
   (`scripts/invoke_deepseek.sh`). This review is the real next step, before restarting live --
   matches this codebase's own standing "a fix applied in response to a review finding needs the
   same discipline as the original change" rule, since the original DeepSeek pass only reviewed
   the PLAN, not this actual code.
4. **The server has NOT been restarted** -- the old strict 0-or-1-position singleton is still
   what's actually running live. Per the standing restart rule, a restart disarms the kill
   switch; `DTC_AUTO_REARM_SAFE=true` is set on the active Sim1 profile, so it should auto-rearm
   on its own once a fresh post-restart reconciliation comes back clean -- but the restart itself
   should only happen after the DeepSeek review above, and the user should be told it's
   happening (per the standing restart-disarms rule), not treated as a silent follow-up.
5. Three real follow-on gaps from the same review, deliberately NOT built in this pass, flagged
   as `OPEN_DECISION`s (`node scripts/flag_decision.mjs --list` to see full text):
   - `dual_account_position_snapshot_blind_spot_20261013` (HIGH) -- confirmed, not just
     theorized: `getBrokerSnapshot()` never even requests the Globex account's positions at all
     (`requestCurrentPositions()` defaults to `this._tradeAccount` only), so
     `checkPositionInvariant()`/`brokerExitDecision()` are structurally blind to any real Globex
     position. Predates this build but is more consequential now that RTH+Globex positions can
     coexist under stacking.
   - `dll_gate_blind_to_open_exposure_20261013` (MEDIUM-HIGH) -- `evaluateDailyLossLimit()` only
     sums realized broker P&L; has zero visibility into unrealized exposure across up to 10
     stacked open positions.
   - `same_setup_type_stacking_rule_undecided_20261013` (MEDIUM) -- no same-setup-type-specific
     cap exists at the real-order layer; governed only by whatever the upstream simulated-layer
     refire gate already filters before a candidate reaches ACTIVE.

**If a future session picks this thread up cold: read `575e27f`'s diff and `scratch/claude_
request_deepseek.md` first, then either dispatch that review as-is or re-derive whether it's
still accurate against any code that's changed since.**

**UPDATE, same session: the DeepSeek review above WAS dispatched and came back.** Found 2 real
issues (verified independently before accepting, not taken on faith): (1) `sweepExits()` hardcoded
`tradeAccount: dtcClient.tradeAccount` for every exit instead of reusing the entry's own stored
account -- a Globex-originated exit was being submitted to the wrong account; (2) the new slot
index only enforces capacity, not direction (the old singleton index was a true table-wide "at
most one, ever" constraint that made opposite-direction coexistence structurally impossible as a
side effect -- the new one doesn't have an equivalent). Both fixed, committed as `d150292`
(verified: lint clean, both files import under real ESM, `test_invariants.mjs` byte-identical
138/166, and a new real-DB test exercising the actual SQL against two borrowed-inert setup_ids).
A third, minor issue (the escalation UPDATE could throw a real exception on a rare slot race
instead of returning "no slot") was fixed in the same commit.

The `dual_account_position_snapshot_blind_spot_20261013` decision was updated with DeepSeek's
sharper assessment -- the SUBMISSION-routing half is now fixed by `d150292`, but the pre-exit
SAFETY GUARD (`brokerExitDecision()`/`checkPositionInvariant()`, fed by `getBrokerSnapshot()`)
remains account-blind, which DeepSeek thinks should be a near-term priority, not an indefinitely-
deferred item, since it's a live misattribution risk on the exit path, not just a halt risk.

**Status: both rounds of fixes committed (`575e27f`, `d150292`). Server NOT YET restarted** --
still pending, and separately, the real broker-side mismatch from the earlier manual "Reverse"
incident (setup 134421, kill switch currently halted/disarmed, real broker position short 1 that
this app has no record of) needs the user's own resolution before a restart/re-arm makes sense
regardless of this code being ready.
