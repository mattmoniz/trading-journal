# Open Threads / Pending Work

Older resolved/superseded threads are periodically moved to [OPEN_THREADS_ARCHIVE.md](OPEN_THREADS_ARCHIVE.md) (via `node scripts/archive_open_threads.mjs --apply`) to keep this file's per-session read cost down — nothing is deleted, just relocated. Still-pending items are backed by `OPEN_DECISION`/`RESEARCH_CLAIM` rows regardless, so archiving here never buries anything. Since 2026-09-07 this also applies per-bullet inside evergreen sections ("30-day shadow validation", "Pending decisions") — not just whole dated sections.## 2026-10-19 (15:15 ET): A2 range rewrites committed, deploy pending after the 16:05 index; page-load baseline; broker-stop gap found

- **Server restarted 14:48 onto HEAD 3e8d7f7** (daily_rth_stats + day caches live; single process, sim auto-armed). Watch DEPLOY row sha `3e8d7f792d`.

- **A2 committed (c2fc728), NOT yet live.** Cast-free `ts` ranges on the recurring bar reads (acd.js per-pass block, setupExpiry, marketPulse, morningBrief VA/overnight, priceRetrieval.getLatestBars, 90-day volume baselines, full-day ATR). `node scripts/test_range_rewrites_20261019.mjs` proves old==new on 8 dates (DST, Monday, roll week, today) for 18 query forms (float sums compared at 1e-9 because a different plan sums in a different order); each rewrite is ~2x faster even before the index. Invariants identical before/after (144 failures / 161 warnings, pre-existing; the 10-12 note of 120 is stale). **Not rewritten (out of scope, still `ts::date`):** the other ~400 sites; re-profile after deploy and take the next shapes by total ms.

- **Pending jobs (detached):** `scratch/index_at_1605.sh` (A1 `idx_pbdh_ts` at 16:05) then `scratch/restart_when_flat_a2.sh` (waits until 16:08 and the index script has exited, then restarts once the account is flat; log `scratch/restart_when_flat_a2.log` + `_waiter.log`). `perf_expect` registered for `db_time_pct` and `detect_avg_ms` down. **Do not edit server files while that waiter is armed** (it restarts whatever is on disk). If it timed out: `./restart.sh`, verify one process.

- **Proof still to do after the restart:** `node scripts/perf_report.mjs` once RTH and Globex are both seen; re-run `node scripts/measure_page_loads.mjs` (needs `npm run client`, stop it afterwards by PID, not `pkill -f`). **Baseline before A1/A2 (14:50 ET): Morning Prep ~20 s / 78 requests / 1.5 MB; Trades ~5 s; Dashboard ~88 s / 59 requests / 8 MB (`/api/stats/rolling` 3.3 MB per call); `/api/case` ~3 s per call alone, 14.7 s under load, polled every 10 s.** If `/api/case` is still ~3 s after A1/A2, wrap it in `microCache` (same pattern as market/pulse) -- deliberately not done yet so the A1/A2 effect stays measurable.

- **Detection-poll outages:** 2 so far on 10-19 (baseline 49-156/day); RESOLVE `detection_poll_chronic_timeouts_rth_20261019` after 3 consecutive RTH days < 10 AND row-to-order median < 10 s.

- **Rotation-flip closes verified working** (real EXIT orders submit and fill, 20+ rows on 10-19). New finding, flagged as `broker_stop_fill_not_reflected_in_app_row_20261019`: a broker STOP fill the app's bar feed did not see (tick 29807.00 vs bar high 29806.75) left rows 136552/136553 open 44 min, then closed as ROTATION_FLIP at +47.5 vs real -37. For real rows `broker_pnl` is the realized number; `actual_pnl` on ROTATION_FLIP rows is a mark against the signal entry.

- **Nightly calibration (~39 min):** per-step timing starts tonight (`job_timings`); look at it tomorrow morning.

- **Needs the user:** Anthropic credit (AI daily review failing since 08-27) -- explicitly set aside this session.

## 2026-10-19 (evening handoff): speed + monitoring work — what is live, what is pending

**Shipped and committed (HEAD 332228e):** DLL-gate unpriced-fill fix; reconciliation false-halt fix; detection-speed round (JIT off, day caches, `?fresh=1` poll, end-of-pass order sweep, micro-cache); DeepSeek Sierra exit review fixes (auto-rearm now also requires the position invariant; last-message position reads; no exit retirement across an account-label mismatch; per-account other-account check; failed snapshot = unclean; sampler serialized); post-deploy performance watch (`perfTelemetry.js`, `perf_snapshots`, `perf_expect.mjs`, `perf_report.mjs`); weekly data-growth check + `explain_check.mjs`; correlation-monitor retention (88k rows pruned, backup `performance_audit_corr_monitor_backup_20261019`, drop after ~2026-11-02); `daily_rth_stats` table + `dailyRthStats.js` fail-soft reader wired into getRollingATR / caseEngine.getOpenGaps / gap-fill setup; day cache on stall `getVolumeBaseline5m`.

**Pending jobs (relaunched DETACHED at ~14:50 ET so they survive a context clear; logs: `scratch/restart_when_flat_waiter.log` + `scratch/restart_when_flat.log`, `scratch/pbdh_index_apply.log`; check with `ps -eo pid,cmd | grep -E 'restart_when_flat_2026|index_at_1605'`; re-run by hand if missing):**
1. Server restart onto the new code, waiting for the account to be flat (`restart_when_flat.sh`, 90 min max). If it timed out: restart when no open positions (`./restart.sh`, verify one process, restarts disarm Sierra then sim auto-rearms). Until restarted, `daily_rth_stats` / day-cache changes are NOT live. The `perf_expect` rows for db_time_pct and detect_avg_ms down are registered for that deploy.
2. `node scripts/apply_pbdh_ts_index_20261019.mjs` (idx_pbdh_ts, A1) scheduled for 16:05 ET 2026-10-19. If it did not run: run it by hand any day between 16:05 and 20:00 ET. Rollback `DROP INDEX idx_pbdh_ts`.

**Open (see decisions):** `price_bars_view_speed_and_startup_lookups_20261019` (A2: rewrite remaining `ts::date` bar reads as ranges; measure each with the watch), `detection_poll_chronic_timeouts_rth_20261019` (needs <10 outages/day for 3 days), first real ROTATION_FLIP close check, per-order account routing unproven, Anthropic credit exhausted (AI daily review failing since 08-27 — needs the user), nightly calibration takes ~39 min (comment says 2; per-step timing starts 2026-10-19 in `job_timings`), page loads (Morning Prep/Trades/Dashboard) and the ML scorer never re-profiled, weekly growth check needs 4 weeks to start judging growth. Review the first post-deploy VERDICT (`node scripts/perf_report.mjs`) after RTH + Globex have both been seen.

## 2026-10-12: Globex 44-type rotation-filter expansion shipped live, after DeepSeek caught a real lookahead bug Gemini's own independent re-derivation structurally could not catch

Tested whether 44 RTH-only level-fade setup_types would work in Globex, gated by the already-live 65pt rotation-direction filter. First pass (`scratch/globex_level_fade_rotation_backtest_20261012.mjs`): N=2,207, AGREE-minus-DISAGREE delta=+$35.52/trade, placebo-clean, 7/10 well-powered types individually clean. Dispatched to both Gemini (independent mine-and-run re-derivation + chronological split) and DeepSeek (line-by-line methodology/code review) in parallel, per explicit user request to send it to both.

Gemini reproduced the exact headline number and found it stable/strengthening across a chronological split — but Gemini's re-implementation reused the same `detectSignalEvents()`-based leg-matching approach per its own task instructions, so it could not have caught a bug living in that shared approach. DeepSeek, doing a genuine code read instead of a parallel re-implementation, found exactly that: the label was built by running `detectSignalEvents` ONCE over the FULL session, then matching each touch's bar index against which leg's `[start_idx, end_idx)` window contained it — a leg's `start_idx` is the pivot anchor, set BEFORE the 65pt move that confirms it, so the full-session decomposition retroactively relabeled the `[anchor, confirmation)` window with the FUTURE direction, information a live poller (which only sees bars up to "now") never had. Verified directly against both the buggy script and the live `getCurrentRotationDirection()` (`rotation65ptGateShadow.js`, confirmed to already truncate correctly) before accepting the finding.

Fixed and re-run: truncate bars to each touch's own index before computing the leg. Corrected pooled result: N=1,712 (495 lookahead-mislabeled touches correctly dropped), delta=+$10.90/trade, day-blocked bootstrap CI=[$2.31,$19.54] (excludes zero — real, just far smaller than the headline). 0 of 10 previously-"clean" individual setup_types still clear their own placebo test after the fix — pooled-only effect, several individual types even flip sign.

**Cross-cutting, more consequential**: the identical bug shape (byte-for-byte the same full-session leg lookup) was already sitting in `scratch/poc_65pt_gate_current_leg_verify_20261008.mjs`, the backtest that justified shipping the ALREADY-LIVE `isRotationDirectionConflict()` gate on 2026-10-11. Fixed and re-run the same way: original n=5,474, AGREE +$37.61/DISAGREE -$29.40 → corrected n=5,545, AGREE +$6.62 (CI crosses zero)/DISAGREE -$5.27 (CI crosses zero), pooled delta ~$11.89/trade. The live gate's own code was never wrong (independently verified both times) — only its backing research magnitude was inflated, consistent with the gate's real first live-tagged day (2026-10-09) already showing a much smaller separation than the original backtest predicted.

User's reaction mid-investigation, prompted by "not much firing in RTH" (which turned out to be simply that it was 7:33am ET, RTH hadn't opened yet): "Let move them to live. And review them in 2 months with the poc rotation filters affect" — an explicit instruction to wire the 44-type finding live despite the corrected, much-weaker evidence, which was surfaced plainly before proceeding. Shipped 24 of the 44 (`server/routes/acd.js`'s `WIDER_WINDOW_OVERNIGHT_LEVELS` array), after excluding: `PD2_VAH` (both directions — a dead entry in the research script, no real `level_prices` row under that name ever existed, zero real touches in the whole backtest); `DAILY_OPEN` (both directions — found live-checking this, `level_prices.DAILY_OPEN` has been stale since 2026-08-31, see below); the 16 pairs that already had a direction live elsewhere in the array. Every new entry routes through the exact existing pipeline (dynamic SHADOW→ACTIVE promotion via `getOvernightLevelLiveStatus()`/`PROMOTE_ALL_MODE`'s stat gate, and the rotation filter via `isRotationDirectionConflict()`) with zero new gate code, since both already apply to every candidate in that array. Verified: lint clean, `test_invariants.mjs` identical (120/165) via `git stash`, all 24 new level names confirmed resolving to a real current `level_prices` price, server restarted (the restart itself hit the Bash tool's own 60s foreground timeout and got backgrounded — verified per the standing rule for this exact failure mode that only one `node server/index.js` process existed afterward, correctly bound to port 3002, before trusting it), kill switch auto-rearmed on Sim1 per the standing per-profile exception. Review scheduled: `OPEN_DECISION globex_44type_rotation_filter_2month_review_20261012`, due ~2026-12-12.

**Found along the way, not fixed tonight**: `level_prices.DAILY_OPEN` has not updated since 2026-08-31. Root cause: `scripts/compute_levels.js`'s `DAILY_OPEN` query requires a bar at exactly 9:30:00 ET for the date being computed, but both scheduled crons that call it (`server/index.js`'s Sunday 9:30PM and Mon-Fri 8AM runs) run BEFORE that date's own RTH open exists — structurally can never succeed on either schedule, only ever worked via manual backfill runs that apparently stopped around 8/31. Confirmed this is a safe-but-inert failure, not a mispricing one: the RTH consumer (`acd.js`'s `DAILY_OPEN_FADE` candidate) reads via an exact `trade_date=$1` match with no fallback, so it has simply gone silently dormant since 8/31 (missed real touches, never traded a stale number). `OPEN_DECISION daily_open_level_prices_stale_since_20260831` tracks the real fix (a retroactive "yesterday" catch-up run, not just the existing "today"/"upcoming session" crons).

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

## 2026-10-13 (continued): DLL gate fixed, market-entry-order-type build in progress, note field added

**The DLL-gate-blocks-everything incident from earlier today is resolved.** A reconstructed EXIT
row for setup 134421 (the real long closed by the manual Reverse -- see the entry above) was
inserted using the broker's own confirmed real fill price (30767.25), and
`recordBrokerPnlForSetup()` computed a real `broker_pnl=$8.50`. Independently verified:
`evaluateDailyLossLimit()` now returns `{blocked:false, reason:'within limit'}`, kill switch
confirmed still armed. Real order placement should be back to normal.

**"Fire at MARKET instead of LIMIT" for specific moving-reference setup_types -- built,
unit-tested, DeepSeek code-review dispatched, NOT yet restarted/deployed.** Per explicit user
decision (overriding DeepSeek's own recommended narrower fix -- the Phase 0 design critique is
in `scratch/deepseek_response.md`, NOT in this doc as an earlier version of this entry
incorrectly said -- it's a 541-line raw response file including DeepSeek's own thinking trace;
the final verdict starts at its own `## Verdict` heading).

**STACK_VOL_BREAK_LIVE_LONG/SHORT -- checked directly against the real code, EXCLUDED.** This was
added to scope mid-build by explicit user request, after the Phase 0 critique had already been
sent, so DeepSeek was never asked about it. Checked directly: `acd.js`'s `computeStackVolSignal()`
(~line 3133) sets `const svEntry = bar.close` -- the triggering bar's own FIXED breakout price at
detection time, not a continuously-recomputed moving reference like `vwap24`/`earlyVwap`. Same
underlying reason `GLOBEX_VWAP_MAGNET` is excluded (entry already a point-in-time snapshot, not
something that keeps drifting away from the frozen LIMIT while unfilled) -- excluded on that
basis. Final scope, 6 setup_types: `GLOBEX_VWAP_FADE_LONG/SHORT`, `RTH_VWAP_FADE_LONG/SHORT`,
`POC_ROTATION_JOIN_LONG/SHORT` (the last pair confirmed moot today -- real N<20, SHADOW-only, can
never place a real order -- but kept in scope per the same principle for when it eventually
promotes, matching DeepSeek's own Phase 0 note).

**Built:**
1. `dtcClient.js`'s `submitOrder()` -- `freeFormText` param (confirmed real against
   `/mnt/c/SierraChart/DTC/DTCProtocol.h`'s `ORDER_FREE_FORM_TEXT_LENGTH=48`), truncated
   defensively to 47 chars at the one wire-serialization point.
2. `reconciliation.js`'s `placeEntryOrder()` -- `marketEntry` param (default `false`, every
   existing caller unaffected) + `freeFormText` pass-through via `submitAndRecord()`. When
   `marketEntry=true`: `orderType: 'MARKET'`, `price1: 0` (matching
   `placeMarketEscalationEntryOrder()`'s own established convention for a MARKET order's
   ignored-but-required wire Price1). `entryPrice` still required/validated even in MARKET mode
   (bookkeeping use by the caller).
3. `orderSweep.js`'s `sweepEntries()` -- `MARKET_ENTRY_SETUP_TYPES` Set (originally 6 types, now
   4 -- see the Phase 2 review outcome below), `fired_at` added to the row SELECT,
   `marketEntry`/`freeFormText` (`setup_type + setup_id + fired_at-time`) passed through. Bracket
   path (`placeBracketEntryOrder`, off by default) untouched -- this only touches the standalone
   LIMIT/MARKET path.

**Phase 2 DeepSeek code review came back (`scratch/deepseek_response.md`, overwritten -- Phase 0's
critique is gone from that file now, only the Phase 2 review remains) with 1 real correctness
defect and 1 real scoping inconsistency, both independently verified against the actual code
before accepting (not taken on faith), both fixed, committed as `3dabe74` (initial build) +
a follow-up commit (the fixes):**

1. **`price1` DB sentinel bug (the one correctness defect, confirmed real).** The first draft
   stored `price1=0` in BOTH the DB row and the wire message for a market entry, copying
   `placeMarketEscalationEntryOrder()`'s own `price1=0` convention -- but that function's row is
   protected from three downstream "treat price1 as a real limit" consumers
   (`escalateUnfilledEntriesToMarket`, `resolveSetups.js`'s chase-abandon check,
   `check_order_lifecycle_health.mjs`'s `checkStuckUnfilled`) by its client_order_id's trailing
   `'M'` suffix, which all three explicitly filter on. A FRESH market entry has no such suffix, so
   `price1=0` flows straight into their chase-distance math as a real (wildly wrong) limit price
   -- and does so ASYMMETRICALLY by side: confirmed directly in `resolveSetups.js` (`orderInfo.
   status === 'OPEN' && Number.isFinite(orderInfo.price1)` -- `Number.isFinite(0)` is `true`, so
   this branch runs) that a BUY reads `current - 0` as "too far to ever chase" (silently never
   escalates/abandons) while a SELL reads `0 - current` as a large negative distance that never
   trips the "too far" guard (pointlessly cancels-and-resubmits MARKET every poll). Fixed by
   decoupling DB `price1` (now `null` for a market entry, matching `fillPriceSanity`'s own
   existing null-as-no-constraint convention -- `orderType==='MARKET' || !Number.isFinite(price1)`
   -- independently re-read and confirmed in `priceMultiplier.js`) from the wire `Price1` (still
   `0`, unaffected). `placeEntryOrder()` now computes `dbPrice1`/`wirePrice1` separately instead
   of one shared value.

2. **POC_ROTATION_JOIN scoping inconsistency (confirmed, dropped from scope).** DeepSeek pointed
   out that `pocRotationJoinDetector.js`'s `entryPx = entryBar.open` (line 153, independently
   re-read and confirmed) is a FIXED point-in-time bar price, not a moving reference -- the
   identical shape to the already-excluded `STACK_VOL_BREAK_LIVE`. Including it was a
   thesis-level argument ("price will join back to a moving fair-value median"), not an
   entry-staleness one, and inconsistent with the rule actually being applied everywhere else.
   Dropped from `MARKET_ENTRY_SETUP_TYPES` for consistency -- was moot anyway (SHADOW-only, real
   N<20). Final scope: `GLOBEX_VWAP_FADE_LONG/SHORT`, `RTH_VWAP_FADE_LONG/SHORT` (4 types, not 6).

3. **GLOBEX_VWAP_FADE RTH/Globex naming collision (a real landmine the Phase 0 critique hadn't
   fully flagged, since it wasn't asked specifically about this).** Independently re-confirmed by
   reading both insert sites directly (I had already read the RTH-hours copy myself earlier this
   session, lines ~3630-3680): `detectGlobexSetup()` fires `GLOBEX_VWAP_FADE_LONG/SHORT` with
   `level: vwap24` (the genuinely moving reference), but a SEPARATE RTH-hours `shadowCandidates`
   block (`globexVwapFadeRTH`) fires the SAME setup_type string with `entry: currentPrice` -- a
   fixed snapshot, the exact shape `GLOBEX_VWAP_MAGNET` is excluded for. A setup_type-keyed set
   can't distinguish the two by name alone. Fixed via a `wantsMarketEntry(row)` guard (exported
   from `orderSweep.js` for direct unit testing) that additionally checks `row.is_rth` -- the two
   insert paths are time-exclusive (the Globex path only runs during `inGlobex`, the RTH-hours
   block only runs when NOT `inGlobex`), so `is_rth` (a real, persisted GENERATED column derived
   from `fired_at`'s time-of-day, already selected in `sweepEntries()`'s row for
   `selectTradeAccount()`) reliably tells them apart without needing a new column.

4. **Structural-advantage confound (already a known, flagged risk -- `OPEN_DECISION
   primary_phantom_resolution_no_fill_gate_20261012`) -- now documented at THIS decision site
   too**, since this change makes a mechanism that was a rare escalation fallback into the
   default entry path for 4 setup_types: a MARKET fill's real price can differ from the frozen
   `entry_zone_low` the stop/target were calibrated against, so the real risk distance on a
   market-filled trade isn't exactly what `OPTIMAL_STOP` assumed for that setup_type. Not a new
   mechanism, just a wider blast radius for an already-accepted one -- documented inline, not
   separately re-litigated.

5. **Minor, not fixed (deliberately, low-value):** `wantsMarketEntry()` is not consulted on the
   OCO-bracket branch (`SIERRA_USE_OCO_BRACKET`, off by default) -- a bracket parent can't itself
   be MARKET. Documented inline at that branch so flipping the flag on later doesn't silently and
   confusingly revert these 4 types to LIMIT with no explanation.

**Re-verified after the fixes (not just the first pass):** `npx eslint` clean, both files import
cleanly under real ESM, `node scripts/test_invariants.mjs` unchanged at 139/166 via `git stash`.
Extended `scratch/test_market_entry_20261013.mjs` to 7 cases (added: DB `price1` is `null` not
`0` for a market entry; `wantsMarketEntry()`'s `is_rth` guard, 4 sub-cases; `POC_ROTATION_JOIN`
confirmed dropped from scope) -- all 7 pass. Residue/real-position check re-run clean (setup_id
134421 untouched).

**RESOLVED, same session -- restarted, live, verified clean.** User gave the explicit
go-ahead ("Yea restart"). `./restart.sh` timed out once under an EXTERNAL 100s Bash-tool
timeout (not the script's own logic) -- per the standing rule, verified directly with
`ps -ef` afterward rather than assumed: zero duplicate processes, the server was simply
fully stopped (systemd `inactive (dead)`, no node/nodemon running at all), not a dangerous
duplicate-supervisor state. Re-ran via `run_in_background: true` with no external
timeout; completed cleanly -- single `nodemon`/`node server/index.js` pair, kill switch
armed (`auto-rearm-on-simulation-boot`), reconciliation clean (`brokerPositionCount:0`,
`clean:true`). Confirmed the new code is actually live (not just "server is up"): the ML
tab's `resolved_at_str` column (added in the equity-curve fix below) is present in a live
`/api/ml-silo/range-trades` response, which only happens on a genuine process restart since
that file is server-side JS, not a static asset. `node scripts/test_invariants.mjs`
unchanged (139/166) post-restart; no new `scratch/server_errors.jsonl` entries since.

**Separately, a real, previously-undiagnosed root cause for the "1 trade still without
broker P&L" DLL block was found and flagged, not just patched around -- CORRECTED after a
second, deeper pass the same session (the first pass below got the mechanism half right and
mischaracterized the other half; read this version, not an earlier description).** Traced
directly from the raw broker messages in `order_placements_updates` and
`journalctl`/`checkPositionInvariant()`'s own logged output (not guessed): Sierra Chart's
"Reverse and Cancel" command (12:54:42pm ET) canceled the resting stop order
(`client_order_id=S134421`) normally, then submitted a MARKET flatten + a new bracket pair
per Sierra's own documented Reverse mechanism (fetched, not assumed) -- but those 3
resulting orders carried an EMPTY `ClientOrderID` (`""`), so this app's LIVE event-stream
handler (`handleOrderUpdate()`) never received them at all, not even as an unattributed
`UNOWNED:` entry (confirmed: zero `UNOWNED:` rows in `order_placements_updates` that day).
They only ever surfaced via the SEPARATE periodic reconciliation snapshot path
(`checkPositionInvariant()`, which polls broker state rather than consuming the live push
stream) -- **and that path caught the mismatch and halted the kill switch 4 SECONDS after
the Reverse action** (`UNKNOWN-TO-APP MISMATCH (TERMINAL_TRANSITION)`, logged at 12:54:46).
Detection was fast and visible (`quick-check.html`'s `checkFlagsBanner()`, 30s poll, shows
"SIERRA CHART DISARMED" with the halt reason) -- an EARLIER draft of this entry wrongly
claimed the reconciliation backstop "didn't catch this in real time," based on a LATER,
unrelated `lastInvariantCheck: {checked:false, reason:"no broker response"}` reading that
was conflated with the original incident; that claim is retracted. **The real, still-open
gap is RECOVERY, not detection**: `checkPositionInvariant()`'s own mismatch report already
contained the broker's real average fill price (30767.25 -- the exact number later used in
the manual reconstruction), but nothing automatically turns "a confidently-attributable
unknown-to-app fill" into a `broker_pnl`/`active_setups.status` correction -- it just halts
and waits for a human to read the log and hand-write the fix, which is why this sat broken
for hours despite being flagged in seconds. Flagged as `OPEN_DECISION
manual_sierra_action_no_broker_pnl_visibility_20261013` (HIGH, text updated with the
corrected mechanism) -- two real follow-ups, neither built yet: (1) auto-reconciling an
unknown-to-app fill against `broker_pnl`/`active_setups` when it can be confidently matched
to the single currently-open real position, instead of requiring a manual reconstruction
every time (explicit user request to look into this, not yet started -- a real-P&L-writing
change, needs the user's sign-off on the approach before building, not just proceeding); (2)
WHY Reverse's orders carry an empty `ClientOrderID` at the DTC level is understood only via
Sierra's own Trade Window documentation (what Reverse mechanically does), not via official
documentation of the DTC-visibility consequence itself -- treat as a strong, evidence-based
inference (confirmed against real traffic), not a verified protocol guarantee. **Both
findings (and the general "manual Sierra Chart actions can bypass this app's live event
visibility" lesson) are now also recorded in [docs/SIERRA_CHART_NOTES.md](SIERRA_CHART_NOTES.md)**
-- a new running notebook for this exact purpose, added the same session per direct user
request ("I feel like you need to keep a notebook of how you need to interact with sierra
chart dtc" -> broadened to "a sierra chart notes file for anything you need").

**One small, separate loose end, not yet chased:** of the 15 trades that resolved in a
batch at RTH close the same day (the equity-curve-ordering bug below), one real-eligible
(`origin_status='ACTIVE'`) cluster-sibling row (`C_PAIRED_LONG`, id 134731,
`is_cluster_primary=false`, fired 15:58:00) got no `gated_candidates` skip logged at all --
unlike its sibling at 134708, which was correctly logged as blocked by the DLL gate. Not
investigated further this session; flagged in conversation, not yet in `flag_decision.mjs`.

This fix round's own diff was NOT sent back to DeepSeek for a second review pass (matching
this codebase's own "2 correction attempts then Claude takes over" convention is about
Gemini/DeepSeek being WRONG twice, not about every follow-up fix needing a fresh dispatch --
both findings here were independently verified against the real code directly, not just
trusted).

**If a future session picks this up cold:** read this entry in full (it now contains the
complete before/after), then `scratch/deepseek_response.md` if more of DeepSeek's own reasoning
is needed (it currently holds the Phase 2 review only -- the Phase 0 critique was overwritten,
its conclusions are already folded into this entry and the earlier one above it).

## 2026-10-13 (continued): equity curve/maxDD was sorted by fire time, not resolve time -- fixed

**RESOLVED, same session.** User-caught live: quick-check.html's Net P&L chart showed negative
most of the day, then jumped to +$419 on a single refresh with no warning -- "the chart did not
accurately reflect what I saw all day... and it suddenly changes." Root-caused, not assumed:
15 trades fired between 10:05am-3:58pm but all resolved in one `TIME_EXPIRED` batch at RTH close
(4:00:00-4:00:22pm, +$649.50 net) -- `getDecidedRows()`'s cumulative curve was sorted by
`fired_at_str` (when each trade STARTED), not `resolved_at_str` (when its P&L actually became
known), so the moment those 15 trades resolved, they were spliced into the MIDDLE of the
already-drawn curve at their original fire-time slots -- retroactively shifting every later point
and rewriting hours of already-displayed chart shape with no real-time event to explain it. This
also silently corrupted `maxDD` (computed by walking the same mis-ordered sequence peak-to-trough)
-- a real risk-management number, not just a cosmetic chart issue.

Fixed in `getDecidedRows()` (sort key: `resolved_at_str || fired_at_str`, falls back for ~578
all-time pre-2026-07-20 rows that predate `resolved_at` being reliably populated -- 0 for any date
this sort actually matters for live) and the equity curve's x-axis time labels to match. Found and
fixed the SAME bug shape in the ML tab's `computeMlRangeStats()`/`renderMlSiloRangeEquityChart()`
(mlSiloService.js's `getRangeTrades()` needed `resolved_at_str` added to its SELECT -- it didn't
have the column at all). Committed `2e8821d`. Verified: `node --check` on the extracted inline
script (clean -- no Playwright/browser tool was available this session, said explicitly rather than
claiming an interactive check was done), live page confirmed serving the edit immediately
(`quick-check.html` is a static file, no restart needed), `/api/ml-silo/range-trades` confirmed
returning `resolved_at_str` post-restart, `test_invariants.mjs` unchanged (139/166), no new
`CLIENT_ERROR`/`SERVER_ERROR` entries since.

**Of the $649.50 batch itself, a direct follow-up question ("if those fired trades actually
traded we would have been up +$649?") was checked against the real data, not assumed: NO.**
13 of 15 were `SHADOW`-origin (never real alerts, background-tracked only, $596.50 of the total)
-- not money that was ever going to trade regardless of anything else. Only 2 were
`origin_status='ACTIVE'` ($53 combined), and NEITHER got a real order placed: one (+$55.50,
`OR10_HIGH_FADE_LONG`) was explicitly blocked by the DLL-gate incident (see the entry above --
skip logged at 15:54, before the 16:27 fix); the other (-$2.50, `C_PAIRED_LONG` cluster sibling)
has no logged skip reason at all, the small loose end flagged above. The real, honest "cost of
today's incident" figure is +$55.50, not +$649.50.


## 2026-10-13/14: Silent-close auto-reconciliation shipped; two more real "stuck pending" bugs found and fixed live

**Silent-close auto-reconciliation (`attemptSilentCloseReconciliation()`, reconciliation.js) --
built, DeepSeek-reviewed (Phase 0 design critique, independently verified before accepting),
real DB-backed unit + end-to-end tests, shipped.** Addresses the manual-Reverse incident
documented above: when `checkPositionInvariant()` confirms a real quantity mismatch, and exactly
one real `active_setups` row still believes it has an open position that could explain it, this
auto-writes the real closing price (recovered from the broker's own settled position snapshot,
not guessed) and calls `recordBrokerPnlForSetup()` -- same bookkeeping fix done manually this
morning, now automatic. Deliberately auto-WRITE, not pending-approval (explicit user decision,
"fire this market" / "lets try autoapprove for now" -- argued through directly: a pending-
approval queue doesn't actually help if nobody's watching, which was the whole problem today).
Never re-arms the kill switch, never places an order -- bookkeeping only. User explicitly
confirmed understanding the real risk (an estimated, not directly-confirmed, price) before
approving.

**A real bug was found and fixed via the feature's own end-to-end test, not assumed clean**:
`checkPositionInvariant()` does its own internal retry with a FRESH broker snapshot when the
first reading is stale, but never returned that fresher snapshot to its caller -- so
`attemptSilentCloseReconciliation()` was reading price data from the ORIGINAL, possibly-stale
snapshot instead of the one that actually confirmed the real mismatch. Fixed by having
`checkPositionInvariant()` return `freshSnapshot` (excluded from the persisted reconciliation
log to avoid bloating every row with a full position-message array). Caught specifically
because the E2E test modeled a REALISTIC broker (the retry call returns only the settled state,
not a replay of the original in-flux window) rather than a naive fake that happened to mask the
bug. 5/5 E2E cases + 7/7 unit cases pass after the fix.

**Two more real, independently-discovered "stuck pending" bugs, found live while investigating
user reports, both fixed the same night:**

1. **Missing-order resolution was too slow (user: "It needs to be seconds nor minutes" /
   "We're too slow").** The existing MISSING_ORDER auto-resolve (5-min cron + a deliberate
   5-10min visibility buffer) meant a real setup with no order ever placed could show
   misleading "pending fill" for up to 15 minutes -- confirmed live: 3 real setups
   (134732/134735/134736) sat that way from 18:30 until the cron caught them at 18:45. The
   buffer was NEVER about correctness (the code's own comment said so) -- it assumed a human
   would be watching and benefit from seeing the alert first, which this exact session already
   established isn't true in practice (nobody's watching the dashboard in real time). Extracted
   the resolve logic into `server/services/missingOrderAutoResolve.js` and wired it into the
   main 15s live poll loop (acd.js) as well as the 5-min cron (now a redundant backstop only) --
   resolves within one poll cycle instead of minutes.

2. **A real order CANCELED fast (by something outside this app) falls through every existing
   resolution path.** Found live: setup 134741 (`PD_POC_FADE_SHORT`, 7:05pm fire) had its real
   entry order canceled only ~93 seconds after submission -- confirmed via `journalctl`, zero
   app-side activity at that moment, not this app's own escalation logic. Traced precisely by
   timestamp comparison against two OTHER real cancels that DID resolve cleanly (134738/134739,
   canceled at exactly ~15 minutes, crossing `resolveSetups.js`'s own `CHASE_ABANDON_MINUTES=15`
   threshold while still `status='OPEN'`) -- chase-abandon only fires for an order still OPEN
   past 15 minutes; an order canceled THIS fast is no longer OPEN by the time 15 minutes pass,
   so it can never satisfy that condition. The existing MISSING_ORDER check doesn't apply either
   (a real order row exists). Sat stuck ~11.5 hours before being found and manually resolved.
   Built `autoResolveDeadCanceledEntries()` (same file) -- catches a real ENTRY order CANCELED
   with zero fill and no market-escalation resubmit (`client_order_id NOT LIKE '%M'`, confirmed
   that suffix is what a successful resubmit actually gets) after a 3-min buffer. Wired into the
   live loop and the cron the same way as the missing-order fix. 4/4 real DB-backed test cases
   pass (the dead-cancel shape resolves, an escalated order is left alone, a too-recent cancel
   waits out the buffer, no residue).

**Also fixed in passing**: both resolve functions now set `actual_outcome='NOT_FILLED'`
(the original missing-order fix didn't -- every OTHER resolution writer in this codebase does,
confirmed by grep before fixing, a real inconsistency even if nothing was actively broken by it).

**Not yet investigated**: WHY setup 134741's order was canceled from outside the app in the
first place (cause unknown -- broker/Trading Evaluator side, no explanation in the raw message
beyond "Simulated order canceled"). The two new auto-resolve functions are a safety net for the
SYMPTOM (a dead order that will never get a real position), not a fix for whatever caused the
fast external cancel. Worth a closer look if this recurs with any frequency -- not chased
tonight given the fixes already close the user-facing "stuck pending" problem regardless of
root cause.

**Verification, all of it, not assumed**: lint clean on all touched files;
`node scripts/test_invariants.mjs` byte-identical (141/168, confirmed via a live `git stash`
comparison against the exact same baseline, not the earlier-in-session 139/166 number -- real
data drift over hours, not a regression); real DB-backed tests for all three mechanisms
(unit + end-to-end for silent-close, unit for both new resolve functions); the real stuck
trades (134741, and the earlier 3 missing-order cases) all confirmed resolved in the live DB,
not just in test fixtures.

## 2026-10-18/19 overnight session (Sierra incident + bias-state research) — handoff
- **Done and committed (last commit `49af673`):** stranded short 136064 flattened by a guarded manual close; baseline reset id 4; order-account label bug found (the default order path never sends the per-session account; 63 orders 2026-10-13..18 were labelled Globex but ran under DTC-Live-Simulator) — repaired labels (backup `order_placements_trade_account_backup_20261019`), set `DTC_GLOBEX_TRADE_ACCOUNT=DTC-Live-Simulator`, mismatch now DETECTED not rewritten, boot warning; `POSITION_SAMPLE` trigger migration; ML scoring supervisor hardened (reap stale scorer, retry, kill on exit, banner on scorer down / gate fail-closed); daily-loss gate unblocked by repairing 136064's entry price (29784) and `broker_pnl` (+161.00). Details: CLAUDE.md "Where to look" first Sierra entries, `docs/SIERRA_CHART_NOTES.md`.

- **Directional bias state study (crack size + open single print + stretch):** market-level L1 failed its pre-registered kill rule; roster-level "with the prior-2-session direction beats against" exists only in the BACKFILL simulation and does not replicate for the same setup families in the real era; nothing built or wired. `docs/DIRECTIONAL_BIAS_STATE_SPEC.md` sections 10-12, claims `bias_state_*`, `ib_break_hold_continuation_bar_level_20261018`, `globex_heavy_leg_leads_rth_lag_20261018`. Successor decision `bias_state_real_era_recheck_20261019` (data-gated).

- **Open (all flagged as OPEN_DECISIONs, see `node scripts/flag_decision.mjs --list`):** `dll_gate_blocks_entries_if_entry_price_missing_20261019` (HIGH, will recur), `sierra_post_fix_first_live_trade_verification_20261019`, `server_logs_too_noisy_for_incident_diagnosis_20261019`, `shadow_no_reason_rows_leak_to_live_20261019`, `poc_exit_shakeout_in_trend_test_20261019`, `catchup_select_distinct_order_by_error_20261019`, `per_order_account_routing_unproven_20261019`; existing `manual_sierra_action_no_broker_pnl_visibility_20261013` is again relevant (the manual close had no broker P&L until set by hand).

- **Standing user-stated facts from this session:** shadow is a pipeline to live; the declustered lens is the primary one; DeepSeek peak pricing is 21:00-24:00 and 02:00-06:00 ET (off-peak 00:00-02:00 and 06:00-21:00, Fri 20:00-Sun 21:00); the user reads setups as IB break + hold + open TPO single prints below and watches velocity live — none of that is tracked in the app, and the single-print magnet effect was NOT supported in 11 months of data (22-36% reached vs 55-67% for a mirror level, n=9/11).

## 2026-10-19 (day): daily-loss gate no longer dies on an unpriced fill
- **Root cause (confirmed from the journal + raw message log, not guessed):** `getPriceMultiplier()` cached a 4s-timeout lookup as `null` for the process lifetime. After the roll to `MNQZ26.CME`, the first fill (setup 136064, 23:29 ET 10-18) and every update after it (10 "no price multiplier known" lines through 23:33) stored `avg_fill_price` NULL, so `dllGate.js` had no worst case and refused all entries until a hand repair + restart.

- **Fixed (live, server restarted 07:50 ET, single process, auto-armed on sim):** short retry window + shared in-flight lookup (`priceMultiplier.js`); `fillPriceRepair.js` repairs NULL fill prices from the kept raw message each sweep; the gate prices a missing-entry trade from the order price / setup entry level instead of blocking everything (no stop or no price at all still blocks). `scripts/test_fill_price_gap.mjs` passes; `test_broker_guards.mjs` passes.

- **Remaining caveats:** the estimate uses the limit price as an upper bound on risk, which does not hold for a MARKET entry that slips (setup entry level is used there). The 3 Sim1 rows from 2026-10-06 (ids 31/33/35) were refused by the sanity check, not a multiplier failure, and are outside the 3-day repair window. Not yet independently reviewed — see `OPEN_DECISION dll_gate_price_fix_needs_independent_review_20261019`.

- **Prevention added (same day):** multiplier warm-up for the current and next contract month every 15s; "SIERRA NEEDS YOU" banner kinds `UNPRICED_FILL` and `ENTRIES_BLOCKED_BY_DATA_GAP`. Not yet observed firing for real (no unpriced fill since); the alerts are covered by `scripts/test_fill_price_gap.mjs` part 4 only. Server restarted 07:57 ET, single systemd process, auto-armed on sim.

## 2026-10-19 (day, cont.): the 6:33 PM signal and the "no-reason shadow" rows
- **6:33 PM Sunday signal (setup 136052) was NOT the daily-loss gate.** Row bar time 18:33, inserted 18:41:34 (8.6 min late), expired 18:42:01. The order sweep only enters rows under 3 min old (`ENTRY_LOOKBACK_MINUTES`), so it could never get an order. Why the row was written late is NOT fully established (journal for that window is gone; bars for 18:25-18:49 exist now but their arrival time is unknown). Facts: `process_log` shows 8 SERVER_SHUTDOWN (SIGTERM) events between 17:49 and 18:49 that night (the stranded-short session restarting the server repeatedly), one at 18:40:33; the row was inserted at 18:41:34, on the first poll after that restart. The old process (up since 18:04) did not insert it in the ~7 min after the bar time, which is unexplained (candidates: late Sierra bar export at the Sunday reopen, or the known stale-live-bars issue in the `price_bars_primary` hard rule). `ORDER_LIFECYCLE ... AUTO_RESOLVED MISSING_ORDER` in `scratch/server_errors.jsonl` (18:42) did record that no order ever existed. 4 of ~44 POC rotation rows in 14 days were >3 min late.

- **"No-reason" SHADOW rows = a missing label.** See `OPEN_DECISION shadow_no_reason_rows_leak_to_live_20261019` (updated) for the cause breakdown; the shadowCandidates insert never writes `suppression_reason`, the early-touch insert is hardwired SHADOW. Fix shipped in code (`SHADOW_CAUSE` rows in `gated_candidates`) but the server restart is pending because a real position (setup 136090) was open. `momentumChaseDetector.js` is hardwired SHADOW with no promotion path (new decision `momentum_chase_hardwired_shadow_no_promotion_path_20261019`).

- **Gate-cost test (history only, `scripts/analyze_shadow_gate_cost_20261019.mjs`, `RESEARCH_CLAIM shadow_gate_cost_by_reason_20261019`, PROVISIONAL):** no gate is shown to cost money. Post-10-12 (primaries, REAL_TRADE_FILTER, POC separate): OPPOSITE_DIRECTION_OPEN blocked N=37 at -$15.21/trade (CI -$54..+$2.5; the earlier 5 weeks were +$2.01, N=102); ROTATION_DIRECTION_CONFLICT blocked N=29 at +$9.93 (CI -$58..+$75, 3 days, not decisive); SAME_TYPE_REFIRE N=16 +$13.90 (earlier window -$21.40, N=14: sign flips); STOP_NEVER_SWEPT N=22 -$42.55 (CI excludes zero, the gate is right). The unlabeled SHADOW bucket was +$6.35/trade over N=101 on 5 days that week, but -$5.99/trade over N=419 on 25 days in the previous 5 weeks (sum -$2,509). So the one-week "+$1,994 shadow shorts" is not a repeating pattern. The live baseline for the same week is thin (N=19, 4 days), so deltas vs live are weak. Caveat: a gate-blocked trade is not independent of the position that blocked it, so this is a guide, not collectable P&L.

- **Follow-ups 2-4 done (2026-10-19 08:39 restart, single systemd process, auto-armed on sim):** (2) `/api/setups/today` now returns `shadow_cause` for unlabeled SHADOW rows (batched query, ~1 ms, endpoint 0.16 s) and `quick-check.html`'s Shadow tab maps it to plain English (`blockedReasonText`/`abbrevReasonCode`); rows from before 2026-10-19 08:13 have none and keep the generic text. (3) `scripts/analyze_momentum_chase_shadow_record_20261019.mjs` is now in `run_daily_calibration.sh` and auto-flags `momentum_chase_n20_promotion_review_20261019` once the live SHADOW record reaches N>=20 (now N=14). (4) The last unexplained row, `RSI_DIV_BULLISH` id 136051, is explained: it was that type's first-ever fire (15:57 on 10-16) and its first SETUP_STATUS row was created at 20:22 that night, so `isLiveEligible()` treated it as an unknown type (fail-closed by design). All 6 formerly unexplained rows are accounted for. (1) Verifying SHADOW_CAUSE rows on a real RTH session is still pending (no SHADOW rows existed before 08:37); a background watcher prints the result when 5 cause rows exist.



## 2026-10-19 (day, cont.): review of the gate fix, catch-up, logs, late-signal note, POC exit shakeout
- **DeepSeek review of the daily-loss gate fix** (`scratch/deepseek_response_dll_gate_price_fix_review_20261019.md`): 7 findings, all verified against the code, all fixed (rolling-p95 slippage allowance in the unknown-trade worst case, `NULLIF(price1,0)` for escalated MARKET rows, 5% magnitude guard in the repair, shared banner text constant, qty floor, LastFillPrice fallback, failedAt stamped at request time). Side find: the market-escalation UPDATE set `filled_quantity = NULL` on a NOT NULL column and could never run (proved in a rolled-back txn) -> now 0; that one-line change was not separately reviewed.

- **Logs**: db.js logs only queries >=500 ms; DTC type 600 (ACCOUNT_BALANCE_UPDATE, confirmed in the local DTCProtocol.h) is handled; ~600 -> far fewer lines/min. **Too-old signals** now always leave a `SIERRA_ENTRY_SKIP` note (once per row, also for rows that already expired). `getFullDayATR` bounded + cached (31 dates byte-identical).

- **POC exit shakeout test** (`scripts/backtest_poc_exit_shakeout_trend_state_20261019.mjs`, `RESEARCH_CLAIM poc_exit_shakeout_trend_state_20261019`): NO state-conditional disable supported (all DiD CIs cross zero, halves flip sign, permutation p>0.3). Incidental, NOT acted on: removing the rotation-flip close beat keeping it by ~$7.91/trade overall (CI $1.03..$16.43, both halves positive; Globex +$9.12 CI $0.09..$19.69, RTH +$5.05 CI crosses zero); the breakeven snap helps (-$4.21 when removed, CI -$6.74..-$1.65). Per the 2026-10-11/12 confound rule the flip-close is judged on forward data, not reverted: see `OPEN_DECISION poc_flip_close_marginal_value_review_20261019`.

- **Harness validated, and the shipped BE-hold headline restated:** the shakeout script reproduces `poc_rotation_breakeven_hold_100pt_stop_20261008` (day-weighted +$37.40 vs claimed +$39.13), but the per-trade mean is +$12.32, CI [$5.20,$20.39] -- still positive, about 3x smaller than the headline (`RESEARCH_CLAIM poc_be_hold_claim_per_trade_vs_dayweighted_20261019`).

- **Chronic detection-poll timeouts found (2026-10-19, HIGH)**: the 15 s poll timed out 49-156 times per RTH day for at least two weeks (92 outages / ~55 min on 10-16). Caches + a query profiler shipped today; objective metric is the `SETUP_DETECTION_POLL` outage count in `process_log` (baseline 49-156/day). See `OPEN_DECISION detection_poll_chronic_timeouts_rth_20261019`.

## 2026-10-19 (afternoon): speed round, Monday gate, order latency
- **Result of round 1 (steady state, after warm-up):** DB time 113% -> 22% of wall clock, detection pass avg 9.8 s -> 2.6 s, 0 poll outages in 30 min (baseline 49-156/day). Remaining top queries were 60 s-TTL cache misses (fixed with `DAY_CACHE_TTL`).

- **Shipped after that:** JIT off per connection; 15 s micro-cache on market/pulse + live-session-context; event-loop reading in the profiler; server poller uses `?fresh=1` (the 20 s cache was swallowing every 2nd poll => real passes ~30 s); end-of-pass order sweep; reconciliation confirm-then-halt + 45 s halt recheck (false "unknown order" halt 10:32-10:43 cost >=5 entries); `getFullDayATR`/`getRollingATR`/volume baseline/prior-day range/prior-5 brackets/IB-OR values cached; raw-table window anchors (10x). Monday gate removed (user decision).

- **Order-latency baseline BEFORE the end-of-pass sweep + fresh polls:** row -> ENTRY order median 25.5 s / p90 34.4 s / max 63.5 s (9:30-10:30, n=9); 35.8 s / 60.7 s / 64.0 s (10:30-12:05, n=12). Re-measure after the deploy with `node scratch/...q66` equivalent (`order_placements.created_at - active_setups.created_at` for purpose ENTRY).

- **Open:** compare steady state again after the restart; consider `random_page_cost = 1.1` (volume baseline 170 -> 121 ms in a test) one change at a time; persist day caches across restarts (cold start still costs ~60 s of DB on JIT-off? re-measure first).

- **Post-deploy measurement (restart 12:23, 14 min steady state; `?fresh=1` polls + end-of-pass sweep + JIT off + caches):** row -> ENTRY order delay median 0.8 s, p90 1.0 s, max 1.1 s (n=2 only, 12:25-13:00 was quiet -- thin, re-measure over a full active session; baseline was median 25-36 s, p90 34-61 s, max 64 s). Real passes now run every poll (33 passes / 517 s), avg 2.6 s incl. the end-of-pass sweep; DB time 23% of wall clock; 0 poll outages since 12:25; event loop NOT blocked (mean 20.6 ms = the 20 ms timer resolution, p99 20.9 ms, one 288 ms spike) => remaining time is database wait, not CPU. Top remaining per-pass queries (each ~130-390 ms): rth_low/rth_high, AVG(volume), recent-close series, ib_high/ib_low -- diminishing returns; first poll after a restart still takes ~46 s (cache fill).



## 2026-10-19 evening: derived tables extended to 3.5 years, level-reaction study, roster replay NEXT

- **Done: derived rows for the 433 missing RTH sessions (2023-03-06..2025-05-21).** `scripts/backfill_derived_tables_long_history_20261019.mjs --write` created developing_value_log (433), acd_daily_log OR/A levels (433; NO a_up/c_up/day_type/daily_score, so A/C/TRT/IB_BULL-BEAR/day-type-gated setups are NOT replayable on these dates) and level_prices (433 dates, 0 failures) through the real producers, insert-only. Created dates are listed in `scratch/longhist_derived_created_dates.json` (delete those dates from the 3 tables to undo). developing_value_log.session_high matches the bars on 433/433.
- **Open data problem: 6 quarterly-roll Fridays (2023-12-15, 2024-03-15, 2024-06-21, 2024-09-20, 2024-12-20, 2025-03-21) have PD_HIGH/PD_CLOSE ~275 pt off the bars** (derived levels sit on the expiring contract). Any replay must skip days where PD_CLOSE disagrees with the prior session's last RTH close by >0.1 ATR (the level study skipped ~58 days this way, roll days plus a few others; cause of the non-roll mismatches NOT traced). Root cause (compute_levels.js contract choice on roll days) not fixed.
- **Level-reaction study (user: "does price react at levels, should we fire/time differently") -> NO.** `scripts/study_level_reaction_timing_20261019.mjs`; real vs shifted-placebo levels, 12 families: 60-min difference -0.011..+0.010 ATR, CIs cross zero (IB_today +0.010 vanishes at proximity 0.05); delaying entry 5/15/30 min no help; overshoot past a level median 0.01-0.04 ATR. Independently re-derived by Gemini 3.8 Flash(High) (`scratch/gemini_level_reaction.mjs`, report `reports/gemini_level_reaction_2026-10-19.md`), agrees within ~0.005 ATR. `RESEARCH_CLAIM named_levels_no_reaction_beyond_placebo_20261019` (CONFIRMED). Caveats: levels so dense an isolated-level contrast is untestable; this is an unconditional touch average, not the selected roster with stops/targets.
- **Gemini note:** its settings model is now `Gemini 3.8 Flash (High)`; `invoke_gemini.sh` refuses non-Pro unless `ALLOW_FLASH=1`. The user chose Flash(High) 2026-10-19; it completed a spec-driven, read-only re-derivation fine (response file stays empty until the run ends -- the wrapper captures stdout, so empty mid-run is normal; check `scratch/gemini_*.mjs` for progress). Old staged request preserved at `scratch/claude_request_20261013_poc_timing_preserved.md`.
- **NEXT (user asked for a clear-context first): roster-wide 3.5-year replay.** Non-writing script importing `loadData/detectLevelFades/resolve/aggregate` etc. from `scripts/backtest_unified.js` (never its `main()`, which overwrites UNIFIED_BACKTEST/SYSTEM_BACKTEST rows live fallbacks read); skip roll-mismatch days; report per setup N/days/per-trade EV/day-blocked CI/by-year and half splits, family-pooled with multiple-testing control, vs live SETUP_STATUS; only replayable families (level fades with level_prices; NOT A/C/TRT/day-type). Gemini can run long loops, Claude audits.
- **Queued, awaiting user "go":** force-SHADOW counter-gate for WITH-prior-session MAJOR_PIVOT RTH breaks; "Live means fired" design A; read/audit `scratch/deepseek_response_trendshift_gates_20261019.md`; CLAUDE.md documentation pass (rotation gate disabled 10-14, flip-close disabled 10-19, `server/config/rotationGateExemptions.js`).
- **Live watch:** POC_ROTATION_JOIN_SHORT id 137375 (fired 19:58 ET, 1 MNQ sold 29748.25, ~+70pt at 20:35, stop 100pt above, breakeven snap due ~20:58) is the first real-money run of the 100pt-stop/breakeven-hold exit shipped without a shadow period; report POC_ROTATION separately from the roster.
- **Roster replay run mode (user directive 2026-10-19):** Gemini and Claude build and run the replay SIMULTANEOUSLY and independently (Gemini gets the spec only -- definitions, population, skip rules -- never Claude's script; Claude writes its own). Compare per-setup numbers when both finish; trace any material disagreement before reporting. Dispatch Gemini first (`ALLOW_FLASH=1 ./scripts/invoke_gemini.sh 30m`, run_in_background, no `&`), then build Claude's version while it runs.
- **Two new research ideas from the user, 2026-10-19 (both flagged as OPEN_DECISIONs, run with the roster replay):** `value_traversal_edge_to_edge_target_guidance_20261019` (price broke PD_VAH and went edge-to-edge to PD_VAL: do value edges work as setups vs target guidance?) and `early_globex_rotation_direction_session_bias_20261019` (a 65pt rotation in the first 10 min of Globex: gate the rest of Globex/next RTH to that direction?). Full test designs are in the decision texts (`node scripts/flag_decision.mjs --list`).

## 2026-10-19 night: roster replay + value traversal + early-Globex rotation DONE (Claude and Gemini in parallel, converged)

- **Roster replay (Task A):** `scripts/study_roster_replay_20261019.mjs` (Gemini: `scratch/gemini_roster_replay.mjs`, report `reports/gemini_roster_replay_2026-10-19.md`). 127 live RTH level-fade types, 3.5y, today's OPTIMAL_STOP stop/target, first touch per level per day: N=22,421, -$4.01/trade (CI -5.7..-2.3), flipped-direction placebo +$0.21; 0 of 122 types significantly positive, 15 significantly negative; per-type pre/post correlation -0.03. Gemini: N=22,408, -$4.04. `RESEARCH_CLAIM roster_replay_3p5yr_level_fades_negative_20261019` (CONFIRMED). Caveat: touch-level, no one-position/cluster dedupe. Own-script bug found by comparing with Gemini: first version dropped half-day sessions (<300 bars) and mis-gated the roll check after them; fixed to >60 bars, results then matched.
- **Value traversal (Task B):** NARROW test only (80%-rule re-entry into the prior-day value area; far-edge reach 40.2% vs 37.5% shifted-placebo, CI crosses zero; reach rate is set by band width/ATR). `RESEARCH_CLAIM value_area_edge_to_edge_no_edge_vs_placebo_20261019` (PROVISIONAL, lists what is untested). The user's live example turned out to be today's RTH session against that session's own finished value area (VAH 29848.25 / VAL 29709; re-entered 12:45, low 29704.75 at 14:35) -- a hindsight value area, and tonight's Globex POC rotation short ran straight through the VAL. User then dropped the thread ("price kept moving"). `OPEN_DECISION value_traversal_setup_vs_guidance_untested_parts_20261019` stays open at low urgency; untested: opposite-edge-as-target guidance on roster/POC rotation trades, developing (not finished) value area, Globex.
- **Early-Globex rotation (Task C):** first 65pt leg within 10 min of 18:00: +0.12 ATR in leg direction to 09:29 vs +0.04 for later first legs (gap CI crosses zero), UP-only (overnight drift), next RTH wrong-signed. `RESEARCH_CLAIM early_globex_rotation_session_bias_not_supported_20261019`. Decision `early_globex_rotation_direction_session_bias_20261019` resolved negative. Permutation p differs between versions only because mine is one-sided (0.018) and Gemini's two-sided (0.0725).
- **quick-check.html fix:** the POC Gate tab ignored session scoping (still listed finished RTH trades after the 6PM roll); `getPocGateRows()` now uses `inCurrentSession()` like the Timeline and Shadow tabs.

## 2026-10-19 late: rotation_events table built (user: "watchers at every rotation high/low that record what they see")

- Built `server/services/rotationEvents.js` (pure builder over `detectRotationLegs`), table `rotation_events` and `scripts/backfill_rotation_events_20261019.mjs` (idempotent; second run inserted 0): 15,342 pivots, 2023-03-06..2026-10-16 (RTH 9,908 / Globex 5,434; median 5 pivots per session; 78 roll-gap sessions flagged `roll_gap_day`). Hand-traced Friday 2026-10-16 RTH: pivot prices and leg sizes match the bars. `server/schema.sql` regenerated, ARCHITECTURE.md service row added.
- **Not done (flagged: `rotation_events_mining_digest_and_live_recorder_20261019`):** nightly incremental step + live recorder, a weekly mining digest with drift/placebo control, linking real trades (POC rotation join etc.), multi-scale thresholds.
- **Pause-and-go (user chart story: stair-step trend, stuffed pause at stacked levels, continuation):** `scripts/study_pause_and_go_20261019.mjs` first pass: RTH continuation after a pause-break +0.06 ATR at 240m vs +0.02 for any bar in a leg; Globex nothing; later pauses (2nd/3rd) +0.19/+0.27 at 240m N=198/115 (a lead, unchecked for day clustering); the level-stacking contrast is UNTESTABLE as defined (98% of pauses sit near some level). Gemini's independent version (`scratch/gemini_pause_and_go.mjs`) was still running -- compare before recording a claim.
- **Agreed plan with the user:** (1) rotation event table (done), (2) POC rotation join review: which legs/pullbacks pay, what is near the join, breakeven-hold exit vs old exit, (3) join at other anchors (VWAP, value area, level reclaim), (4) ML only as a ranker over the event table, judged against a simple rule split out-of-sample.

## 2026-10-20 early morning: POC rotation join review (Claude + Gemini; nothing live changed)

- **Exit variants (3.5y, 3,972 events from the real `detectSignalEvents`):** `scripts/study_poc_join_exit_review_20261020.mjs` (REALISTIC=1 env = market fills), Gemini `scratch/gemini_poc_join_exit_review.mjs` + `_realistic.mjs`, reports in `reports/`. Ideal fills made profit-locks (L50/L75) look +6.6/+14.7 better than the live exit; with realistic fills nothing beats the live exit (all deltas about -1..-2 dollars/trade, CIs include zero). The two builds agree to the cent. The spec flaw was mine (fill at stop price even when the stop was already beyond the market). Claims: `poc_join_exit_realistic_fills_profit_lock_no_edge_20261020`, `poc_join_breakeven_hold_advantage_overstated_20261020`.
- **Bigger consequence (HIGH decision `poc_rotation_join_exit_decision_after_fill_artifact_20261020`, user call needed):** the live breakeven-hold exit was shipped on the same artifact: realistic advantage about +2.5 vs a plain 100pt/60min exit (n.s.) and +6.0 vs the old 20pt exit (+2.8 n.s. out of sample). POC join averages +0.4/trade before 2025-06 and +14.2 after; 20 percent of trades win, the top 20 events exceed the total. 8 of 14 live BE exits resolved at the arming bar booked at -2 (model) while the broker closes at the market: `real_ev` for POC join is flattered. Also audit every other arm-a-stop-at-a-time mechanism. CLAUDE.md convention added.
- **What the system sees at the join:** `scripts/study_poc_join_context_20261020.mjs` (21 causal features -> `scratch/poc_join_context_features_20261020.csv`) + `scripts/ml_meta_labeling/pilot_poc_join_context_walkforward_20261020.py`: walk-forward over 11 quarters finds NO out-of-sample ranking (top-half minus all: -1.9..+1.1 dollars/trade, p 0.35-0.71); a planted weak signal is detected by the same pipeline, so the null is meaningful. Claim `poc_join_context_ranker_no_oos_signal_20261020` (PROVISIONAL). Weekday/time-of-day were never the interesting features (user's point); the context features did not rank either.
- **Next ideas, not started:** tick-level large-print/absorption features (Sierra .scid only, not in the DB), defended-level history at the join, rotation_events linked to real trades; the pause-and-go stuffed-volume lead stays a lead.

## 2026-10-20 morning: DeepSeek critique of the POC join review, audited

- Response `scratch/deepseek_response_poc_join_review_20261020.md` (review-only; it ran nothing). **Verified against code by me:** (1) the original 2026-10-08 backtest (`simulateBreakevenHold`) and the live walker/resolver (`pocBreakevenHoldWalker.js:39-53`, `resolveSetups.js:408-426`) book an underwater-at-arming trade at the entry price (-2 dollars) while `placeExitOrder` flattens at MARKET (`reconciliation.js:647`) -- the fill artifact claim stands; (2) `ONH`/`ONL` for trade date d cover 18:00 prior evening to 09:29 (`compute_levels.js:7`, confirmed in the DB), so the context features had a mild lookahead for Globex entries -- FIXED (excluded before 09:30), rerun, conclusion unchanged; (3) the "planted signal" control was not committed -- FIXED (`--plant` flag in the pilot script, reproducible).
- **Accepted:** top-half-minus-all cannot see a lottery-shaped payoff; added top-decile and big-win metrics. Result: still no better mean, but the top-scored decile has more big wins AND more big losses (an expected-range signal, not better entries).
- **Caveat accepted:** the realistic fill (exit at the arming bar's open) is if anything lenient -- the real flatten goes out on a later poll -- so E1's realistic +6.76 is an upper bound.
- **Self-correction from its T2 stress test idea:** the "later pauses +0.19/+0.27 at 240m, N=198/115" lead I reported earlier mixed event counts with outcome counts; only 27 (and 4) events have a 240m outcome; at 120m it is +0.02 n.s.; top-5 share 73 percent. Retracted in the claim.
- **Not taken:** its T1 (fix the live booking, revert if market-booked real_ev <= 0) is a live-code change and a user call -- already flagged HIGH (`poc_rotation_join_exit_decision_after_fill_artifact_20261020`). Its T3 (one pre-registered discriminator with a tail metric) is a candidate next step; no new tests started.

## 2026-10-20 midday: pre-registered value-edge rule FAILED; multi-day value area exploration

- **Pre-registered rule** (`docs/POC_JOIN_VALUE_EDGE_RULE_PREREG_20261020.md`, committed before any outcome): fails 5 of 6 criteria; Claude and Gemini builds identical (3,889 events, 929 pass, +5.78 vs +6.69, diff -0.91 CI [-9.9,+9.3], real minus shifted -1.24, top-5 share 116 percent). `RESEARCH_CLAIM poc_join_value_edge_rule_prereg_fails_20261020`. Conclusion: POC join winners are not identifiable with this rule; sizing should treat the strategy as lottery-shaped.
- **Multi-day value area position** (`scripts/study_poc_join_multiday_value_20261020.mjs`, exploratory, user question about rolling 3/5/10-session value areas, breakout vs staying inside, and target extension): no class is consistent across windows/eras; one weak both-eras-negative cell (10-day BREAKOUT -5.3, CI includes zero); 5-day ENTERING +22.2 is a lead only (top-5 share 76 percent). A value-area-edge take-profit does not beat the live no-target exit (price reaches the edge only 2-27 percent of the time). `RESEARCH_CLAIM poc_join_multiday_value_area_position_exploratory_20261020`.
- Still open for the user: `poc_rotation_join_exit_decision_after_fill_artifact_20261020` (HIGH) -- keep/revert/shadow the live breakeven-hold exit and fix the -2 booking.

## 2026-10-20 midday: VWAP ideas tested (gate, bad-day, RTH anchor, outer band) + DeepSeek review audited

- **VWAP-slope direction gate** (`docs/POC_JOIN_VWAP_SLOPE_GATE_PREREG_20261020.md`, 01faffe): fails; aligned +6.1 vs all +7.1, opposed +9.6, within-direction permutation p 0.586; RTH +4.5 (n.s.) / GLOBEX -5.2. **Bad-day variant** (`..._BAD_DAY_VWAP_...`, 772d043): fails 6 of 7; bad-state joins 151 on 45 dates after the lookahead fix. **RTH-anchor check (test A)**: fails (aligned +10.0 vs +4.4, CI includes zero, permutation p 0.188). **Flat x outer band (test B)**: untestable (1 qualifying join per session type: a join converges to the centre of value and points away from VWAP when far from it). Claims: `poc_join_vwap_slope_direction_gate_fails_20261020`, `poc_join_bad_day_vwap_gate_fails_20261020`, `poc_join_rth_anchor_vwap_slope_gate_fails_20261020`, `poc_join_flat_outer_band_untestable_20261020`.
- **DeepSeek review** (`scratch/deepseek_response_vwap_review_20261020.md`): verified by me: slope class tied to price side (price above VWAP in 90 percent of UP joins), short side thin (254), flat cut calibrated on whole-session slopes, state lookahead (41 percent of joins marked at the next entry bar close), top-5 criterion passing on a non-positive total, permutation should be within direction. All fixed/disclosed. Its Proposal 1 (flat x outer band) turned out untestable for the structural reason above; Proposal 3 (RTH-open anchor) done (fails).
- **Independent build discrepancy traced:** Gemini's first VWAP report used a bar query without `volume`, so `computeRunningVwapSeries` weighted every bar 1 (an equal-weight average, not VWAP) and its UP/DOWN/FLAT counts came out balanced (1,186/1,231/1,202 vs my 2,552/352/722 with real volume). My VWAP matches an SQL recomputation to the cent. Same verdict, different numbers; a corrected Gemini rerun of tests 1, 2, A, B (with `volume::float`) is queued.
- **Standing lesson:** a shared helper that silently falls back when a field is missing (`Number(b.volume) || 1`) hides a wrong input; check the field exists in the bars you pass in.

## 2026-10-20 afternoon: MAJOR -- POC join research ran on a degenerate (no-volume) detector; breakout/circuit-breaker follow-ups

- **What happened:** Gemini's corrected VWAP rerun (which, by loading `volume` into its bars, accidentally also passed volume to `detectSignalEvents`) disagreed with my numbers (events 3,692 vs 3,972; mean +0.40 vs +7.08). Tracing it: the LIVE poller passes bar volume (`pocRotationJoinDetector.js:131`) and so did the original backtest (`scripts/backtest_poc_rotation_vbp.mjs:198`), but the 2026-10-08/12 scratch scripts and everything written from their loader on 10-19/20 did not. Without volume `getMed50()` returns the profile's highest price (NaN total volume) -- a different, degenerate signal. Overlap Sep20-Oct16: 27 of ~100 events; live rows match the with-volume events 60/91 vs 25/91.
- **Live-construction result (3,692 events, realistic fills):** E1 +0.83/trade (CI [-5.2,+7.6]), old 20pt exit +1.15 (CI [-1.6,+4.3]), 100pt/60min -0.55; PRE +0.6, POST +1.1; 2026 -0.1. No significant edge. The +14 recent edge, the +39 exit advantage and the 10-19/20 selection tests were about the other signal. 10 claims marked STALE; new claim `poc_join_research_no_volume_degenerate_detector_20261020`; HIGH decision `poc_join_edge_unproven_live_construction_20261020` (is POC join still justified at its size/stop; re-validate the original volume backtest end to end). CLAUDE.md convention added; `scripts/lib/pocJoinLoader.mjs` now defaults to withVolume true.
- **Circuit breaker (pre-registered `docs/POC_JOIN_CIRCUIT_BREAKER_PREREG_20261020.md`):** on the no-volume population the 2-minute breaker looked strong (-48 on 59 skipped joins, p 0.001, one trade short of the N>=60 floor); on the LIVE construction it vanishes (skipped joins +43.8, placebo p 0.99; every duration fails). Artifact of the degenerate detector's flip-flop behavior.
- **Breakout-and-hold test (`docs/POC_JOIN_BREAKOUT_HOLD_PREREG_20261020.md`, 8f6746c):** bar-level, independent of the POC detector, so unaffected; NOT YET RUN.
- **What still stands from today:** the fill-at-market convention (realistic fills), the pre-registration/placebo/hold-out process, the roster replay (level fades -4/trade, uses no POC detector), value-traversal and early-Globex rotation (bar-level), pause-and-go (bar-level), the scale check's frequency finding (fixed 65pt fires ~2x as often in 2026 as 2023).

## 2026-10-20 late afternoon: rotation-direction gate (the "POC Gate" pill) -- is it the one thing that works?

- User: the POC Gate toggle is "pretty good compared to everything else we have". Live tags (collapsed, 8 dates 2026-10-09..20, 817 decided): AGREE -2.9 vs DISAGREE -2.4 per trade overall; RTH +4.1 (CI [-12.5,+17.1]); GLOBEX -17.5 (reversed); AGREE better on only 3 of 8 days (10-09, 10-19, 10-20 strongly; 10-12..16 the other way). Today (declustered, RTH): AGREE +803 on 19 decided vs DISAGREE -734 on 64 (tab), +633/-590 by my stored-P&L query; collapsed +402/-430.
- **Pre-registered replay on 3.5 years of RTH level fades** (`docs/ROTATION_GATE_ROSTER_REPLAY_PREREG_20261020.md`, 7758670; `scripts/study_rotation_gate_roster_replay_20261020.mjs`): AGREE-DISAGREE +1.57/trade (CI [-3.5,+6.5]), PRE +3.5, POST -2.9, 2026 -4.7; AGREE-only roster -2.77; fails 4 of 5 criteria. `RESEARCH_CLAIM rotation_gate_roster_replay_3p5yr_not_supported_20261020`. Gemini independent build running. The gate is unaffected by the 10-20 volume finding (leg direction is price-only; direction logic verified equal to the live gate on 220 samples) -- the weakness is that the effect is small and era-dependent, not that it was mis-specified.
- Implementation note: a pre-registered permutation stratum (date x direction) was degenerate (p=1.0000 from ties); corrected to direction-only strata in the script and disclosed in the claim.
- Open: the gate is still tag-only; not promoted. A fair next test would be a frozen RTH-only forward tag plus multi-scale agreement, but the replay says do not expect a large effect.
- **Gemini confirmed the gate replay (same verdict)** and the **scale/regime follow-up** was run: pre-registered adaptive gate fails the hold-out; a larger scaled gate (k=0.3 x ATR20, ~105pt now) is the only consistently positive slice (+4.5 explore, +4.4 hold-out, +5.4/+3.0 by year; each CI includes zero) but not confirmed on the live roster rows. `RESEARCH_CLAIM rotation_gate_scale_regime_explore_holdout_20261020`. User asked how "driving" is determined: my test used a range-expansion proxy, the dashboard EXPAND chip is the volume-building composite gauge and MOMENTUM CHASE is the PDH/PDL breakout state; next step offered: test the gate inside the dashboard's own driving reads and add a shadow-only k=0.3 tag for forward data (needs a server restart, which disarms the order switch -- ask first).
- **Gate forward monitor built (no live change):** `docs/ROTATION_GATE_FORWARD_MONITOR_PREREG_20261020.md`, `scripts/monitor_rotation_gate_forward.mjs` (weekly in `scripts/run_weekly_backtests.sh`; test mode `TEST_FORWARD_START=<date>` skips recording), decision `rotation_gate_forward_first_look_20261020`. The gate direction is reconstructed retroactively from bars at each live row's fire time, so no restart/disarm and no new live tag are needed; the dashboard EXPAND composite is already persisted on rows (`vol_building_signal`). Exploratory on 2,203 live roster rows (35 dates): fixed 65 gate AGREE-DISAGREE -22.1 (CI [-39,-5]) at LOW EXPAND vs +9.9/+13.2 MID/HIGH; beyond PDH/PDL -2.6 vs +2.1 inside (n.s.).
