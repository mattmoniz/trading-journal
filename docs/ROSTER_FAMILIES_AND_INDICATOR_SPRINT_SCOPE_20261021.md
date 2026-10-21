# Scope: family-level roster narrowing + indicator discovery sprint — 2026-10-21

Written so a fresh session can continue after a context clear. Nothing here is built or changed live. Every step needs the user's go. Origin: user, 2026-10-21: "just shooting off levels alone sucks ... Scope this all out ... if one of the setups is part of a family, I want the family to survive."

## Standing constraints (from the user, this session)
- **Family rule:** if any member of a setup family earns its place, the whole family survives. Never cut siblings individually.
- Levels are NOT added to the ML model (user decision). The ML gate stays log-only (`ML_VETO_GATE.enforce=false`).
- POC join exit change, any restart, and any live-behavior change are the user's call. A restart disarms Sierra (re-arm is automatic on Sim1 only). Check for an open sim position before restarting.
- Pre-register (commit) before running anything; explore/hold-out split; placebo; day-blocked bootstrap; cluster-sibling collapse; say "NOT SHOWN" for nulls and state what could not be shown.

## Part A — Roster narrowing at the FAMILY level

### What the data says today (`scratch/family_preview_20261021.mjs`, live-detected ACTIVE+SHADOW rows since 2026-07-09, post-close junk and basis-flagged rows dropped, cluster siblings collapsed)
- 247 setup types with live-detected rows; 115 families if direction and `_OVERNIGHT` are stripped by regex.
- Demonstrated-edge bar used: n>=20 collapsed events, >=10 distinct days, day-blocked 95% CI lower bound above 0, and both chronological halves positive.
- **Only 3 types pass:** IB_HIGH_FADE_SHORT (n126/38d, +17.2, CI +4.8..+30.0), IB_LOW_FADE_LONG (n84/31d, +21.6, CI +1.3..+44.4), OR30_LOW_FADE_LONG (n39/18d, +17.9, CI 0.0..+38.1; borderline).
- Under the family rule these three families would keep 6 types (the three plus their opposite-direction siblings) and move ~241 types to SHADOW.

### Two tensions to decide BEFORE building (flag to user; do not decide silently)
1. **The surviving family includes siblings the data says lose.** IB_LOW_FADE_SHORT is n47/19d, -34.7, CI -61.2..-7.0 (significantly negative); IB_HIGH_FADE_LONG is -12.4 (CI crosses 0). "Family survives" as a literal rule keeps these live. Options: (a) literal rule, whole family live; (b) family stays *eligible* but a sibling whose own CI is entirely below 0 is SHADOW (this is what `PROMOTE_ALL_MODE`'s stat gate already does per type once day-clustering allows). Recommend (b) and ask the user, since it reads as a mild exception to what they said.
2. **A regex family map is wrong in places.** The regex splits OR5/OR10/OR15/OR30 HIGH/LOW/MID into separate families; the user likely means "OR family". Needs an explicit, reviewed family map in one place (`server/config/setupTypes.js`, next to `CONDITIONAL_VARIANTS`) rather than a regex. Draft families to confirm with the user: IB_* fades (HIGH/LOW/MID); OR5/10/15/30 (HIGH/LOW/MID); sweep family (FAILED_SWEEP_REVERSAL, STOP_SWEEP, merged detector, ONH/ONL/PDH/PDL sweeps); ONH/ONL fades; GLOBEX_FLUSH_* (4 types); POC_ROTATION_JOIN LONG/SHORT; PD_* (VAH/VAL/POC/HIGH/LOW); FLOOR_*/CAM_*/WPP/VWAP level families; MOMENTUM_CHASE; case-engine family (C_PAIRED/TRT/A_UP_STRONG...).

### Mechanism (do not build another hardcoded list)
- Family-level status is a *calibration output*: extend `scripts/backtest_setup_status.mjs` (source of SETUP_STATUS) with a family roll-up row (`signal_type='SETUP_STATUS'`, `signal_name='FAMILY:<name>'`, or a distinct signal_type per the performance_audit collision rule) computed by pooling the family's collapsed events and applying the same day-blocked CI rule; a type is live if its family row passes OR its own row passes. Weekly recalibration comes for free, and a family can lose its place later.
- Needs the 4-part no-dead-ends checklist: persisted in performance_audit, recalibrates weekly, consumer wired (`computeSuppressionSets` / `PROMOTE_ALL_MODE` path), entry in ARCHITECTURE.md.
- Exempt from narrowing regardless: MANUAL_SUPPRESS_OVERRIDE types stay suppressed; POC_ROTATION_JOIN is judged separately (see Part D).
- Higher-stakes (changes what fires live): run the 3-phase review. DeepSeek design critique of the plan first, then implementation, then a review-only pass on the diff. Test with the real `isLiveEligible()`/`getCanonicalLiveStatus()` against live rows before any restart.
- Verification that matters: byte-diff old vs new `SETUP_STATUS` for types the change should not touch; confirm which of 241 types actually change status; report the expected fires/day before and after (take-all is ~-3 to -4/trade, so fewer fires is the point, but say what the user gives up).

### Expected effect, honestly
Live roster shrinks from ~241 ACTIVE to a few families. Fire count drops sharply. Evidence for the survivors: IB fades are the one consistent positive (+18.8 all live-detected, +13.4 forward). Nothing here shows the survivors keep working; this is "stop trading what shows no edge", not "found a winner". Re-run the family preview weekly (script already written) and let the pooled gate move families in and out.

## Part B — Indicator / order-flow discovery sprint (bar-level first)

Principle (CLAUDE.md): market-behavior hypotheses are tested on raw `price_bars_primary` first (dense, not selection-biased by which setups fired); only then ask whether this system's own setups capture it. Phase-1 forward-return screens are necessary, not sufficient; any shortlist needs a real stop/target resimulation with placebo before it means anything (stall-fade lesson, 2026-09-14).

### Candidate families (pre-register the list and definitions before touching data; data-derived cutoffs only)
1. Multi-timeframe trend/momentum regime (e.g. direction and strength of 15/60/240-bar net move, scale-free, vs its own rolling distribution).
2. Order-flow persistence (signed aggression runs, delta z-scored against per-minute-of-day baseline, `lib_delta_baseline.mjs`). Expect RTH vs Globex to differ (Globex reversal rule).
3. Volume-profile acceptance/rejection (price accepted vs rejected outside developing value; use `computeProfile`, never re-code it).
4. Volatility expansion timing (compression to expansion; GARCH scale and range pctile already exist).
5. Day-type context (`acd_daily_log.day_type`, rotation count) as a conditioner, not a signal.
6. Regime variable: fade vs continuation flipped between 2023-mid 2025 and the last ~16 months; test whether a data-derived regime read (not a calendar split) explains it, with the classifier itself validated first (parameter sensitivity, independent predictive power).

### Protocol
- Pre-reg doc committed first: events, horizons, outcome definition, explore (earlier ~60% of days) vs hold-out (later ~40%), comparisons counted up front (multiple-comparison surface stated), pass bar.
- Each candidate is a point-in-time bar-level event study: conditional vs UNCONDITIONAL forward return at several horizons (never vs zero), RTH and Globex both, day-blocked CI, random-timestamp placebo, chronological half-split. Cut anything with 60%+ top-5-day concentration.
- Survivors only: real stop/target bar-walk with market-fill rule, gambler's-ruin placebo for asymmetric geometry, then walk-forward. Then SHADOW forward collection, then the new-setup-type checklist.
- Use Gemini for mining/sweeps per house rule (audit its output; 2 correction attempts then Claude takes over); DeepSeek for design critique of the pre-reg and code review.
- Record every tested claim with `recordClaim()` (positive or negative); flag unresolved forks with `flagDecision()`.

## Part C — User's discretionary read (morning)
- 40-moment rating exercise: https://claude.ai/artifact/BVxmv9dsWcqLbt8mDMsFYb. Outcomes are hidden on the page.
- Analysis plan: take-vs-step-aside P&L with an interval; which of the user's cues match measurable features (feeds Part B's candidate list). Report what the ratings could not show given N=40.

## Part D — Loose ends carried over
- **POC join exit (user decision pending):** (a) leave; (b) revert to 20pt/60-min exit + fix the arming-bar booking (priceAtRes) [recommended]; (c) SHADOW/size down. Evidence: wide stop raises win rate not dollars; momentum join vs fade both ~zero; the live-construction edge is ~+0.8/trade, CI includes zero. Decisions: `poc_rotation_join_exit_decision_after_fill_artifact_20261020`, `poc_join_edge_unproven_live_construction_20261020`. Needs a restart when flat.
- ML: pre-registered ranker test on/after 2026-10-27 (`ml_ranking_preregistered_test_20261027`; pass bar >=20 windows, +$5/window over random, >=60% windows); weekly scorecard runs automatically; `ml_trimmed_checkpoint_swap_decision_20261020` (recommended: let the weekly gate decide). Proposed, not approved: compute label/features for BACKFILL history to widen the training set (only ~80 live-detected days).
- Merged sweep detector (SHADOW, live since the 21:02 restart): collect forward rows; `stop_sweep_retire_after_merged_rows_20261021`, `stop_sweep_live_row_collection_recheck` (~100 rows per direction).
- Data hygiene flags: `post_close_rows_pollute_live_population_20261021` (add a `*_basis` flag to REAL_TRADE_FILTER), `active_setup_types_without_optimal_stop_row_20261021` (78 types), `reconciliation_refused_fill_log_noise_20261021`, `setup_family_sim_fill_drag_review_20261021`, `promote_all_mode_review_post_rotation_changes_20261012`.
- Confound boundary 2026-10-11/12 still applies: report POC_ROTATION_JOIN separately; do not judge PROMOTE_ALL_MODE with pre-10-11 data.
- DeepSeek review of the merged sweep setup was skipped (SHADOW-only); do it if it is ever promoted.

## Suggested order for the next session
1. Read `docs/OPEN_THREADS.md` and `node scripts/flag_decision.mjs --list`.
2. Get the user's answers on: family map (Part A tension 2), literal vs bad-sibling-excluded family rule (tension 1), POC join exit.
3. DeepSeek design critique of Part A (before code). Then build the family roll-up in the calibration script, dry-run, report which types change, get a go, restart when flat.
4. Write the Part B pre-registration and commit it; run on explore split only first.
5. Analyze the user's ratings when they are in.
