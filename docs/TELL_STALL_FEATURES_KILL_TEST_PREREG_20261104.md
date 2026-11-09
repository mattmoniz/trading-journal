# Pre-registration (explore): do NOW-versus-LATELY tape readings at a stall separate continuation from reversal? (step 0 of `docs/TRADE_WATCHER_MARKS_AND_LABELS_SCOPE_20261104.md`; written 2026-11-04 BEFORE any outcome was read)

STATUS: FROZEN. Ledger family `tell_stall_features_20261104`, 5 counted tests, hold-out UNSPENT and sealed (explore only). Origin: DeepSeek round T criticism 2 (spend the free test before the user's time) and the user's principle 'now versus lately' (memory `feedback-watcher-now-vs-lately-20261104`). Register row 13.

## 1. Population
The 1,760 explore tell entries (`scratch/tell_context_20261103/tell_hold_value_trail_rows.csv`; ONLY the columns date, dir and ehr are read, none of the V1 result columns). Entry minute em = floor((ehr - 55800) / 60) (ehr is seconds since the 18:00 Globex start) of the RTH session; entry price = the open of minute em. 1-minute NQ RTH bars with bid and ask volume from `scratch/watcher_marks_20261104/rth_1m_flow.json` (`export_flow_1m_20261104.mjs`; coverage checked: 523 dates, no null bid or ask, bid plus ask equals volume within 2 percent on every date, hr-070).

## 2. The stall minute (fixed causal rule, no outcome)
Walk the minutes after em in the trade's direction; a NEW EXTREME is a minute whose high (long) or low (short) beats the running best since entry. L = the 75th percentile of the gaps (in minutes) between successive new extremes, pooled over all entries' first 120 minutes (data-derived, printed; recalibrate when the entry set changes). The STALL MINUTE t* is the first minute at which no new extreme has been made for L minutes. Entries with no stall within 120 minutes, or with fewer than 60 minutes left before 15:55 after t*, are excluded and counted.

## 3. Features (all causal at t*, bars up to and including t*; NOW = the last 5 minutes, LATELY = the 20 minutes before that; W = 20 is the grid choice, W = 10 and 30 are reported as sensitivity, uncounted)
1. VOL: mean volume NOW / mean volume LATELY (log).
2. ADV_SHARE: the adverse side's volume share NOW minus LATELY (long: bid share; short: ask share), in share points.
3. RPC: range per contract = sum(high-low) / sum(volume), NOW / LATELY (log).
4. EFFORT: volume per point of net move = sum(volume) / (|close change| + s) over the window, NOW / LATELY (log); s = median 1-minute range of the session up to t* (causal).
5. PULLBACK: (best favourable price since entry - close at t*) / s.
Delta is NOT used (the user has not said how they read it). Rotation state was tested earlier (`tell_rotation_vwap_not_shown_20261104`) and is not repeated.

## 4. Outcome (continuous, scale-free, no trade rule)
y = (maximum favourable excursion - maximum adverse excursion) / s over the 60 minutes after t*, both measured from the close at t* in the trade's direction (favourable = further in the direction). Positive y = the move continues, negative = it reverses.

## 5. The five counted tests and the verdict
For each feature: Spearman rho(feature, y) with a day-block bootstrap CI (4,000 draws, seed 20261104) at 99 percent (Bonferroni 0.05 / 5). PLACEBO: the same feature taken at the same minute-of-session from a randomly drawn OTHER date (seeded), rho against the same y; the real rho must exceed the placebo rho in absolute size with the same sign. A feature is a LEAD only if the real CI excludes 0, the sign is the same in both chronological halves, and the real |rho| exceeds the placebo |rho| (and the placebo CI includes 0); else NOT SHOWN. The detectable rho (2.8 x the day-block SE) is printed BEFORE the verdicts. Reported, not counted: rho by entry hour (10:00-10:59 vs later), W = 10 and 30, quintile means of y by feature, the share of entries excluded.

## 6. What a result means
A LEAD is a candidate reading to put on the labelling charts and, later, a forward shadow display; never a gate or an exit. No lead: 'features alone do not carry the stall read'; the user decides whether to label anyway; the scope's retire rule applies (scope section 7, item 6). Explore only; Globex untested (hr-002 gap recorded); signed y has day-correlated structure, hence day-block CIs.

## 7. After the run
Claim via `recordClaim()` (hr-024), result appended here, register row 13 updated, `docs/RESEARCH_INDEX.md` rebuilt, OPEN_THREADS entry, `check_research_organized.mjs` all clear.

## 8. RESULT of the first run (2026-11-04 13:50 ET; ledger look 162; script `scripts/tell_context/research_20261103/tell_stall_features.py`; output `scratch/tell_stall_features_20261104_output.txt`)
Gaps between successive new extremes: median 1 minute, p75 3, p90 11, so the registered rule gave L = 3 minutes and all 1,760 entries had a stall (0 excluded). Detectable |rho| about 0.07 for every feature. All five NOT SHOWN: VOL +0.056 [-0.015, +0.126], ADV_SHARE -0.001, RPC -0.028, EFFORT +0.048 [-0.021, +0.115], PULLBACK +0.004; placebo rhos of the same size (-0.03 to +0.04); W = 10 and 30 the same. LIMITATION stated: a 3-minute pause is not the visible stall the user reads, so this tests 'any short pause' and a null is weak evidence about real stalls.

### A1. Amendment (written after reading section 8, BEFORE the second run; disclosed as a forking path)
Second look, ledger look 163, same five features, same outcome, same placebo: the stall rule uses the p90 of the gaps (L = 11 minutes) instead of p75. Entries with no stall within 120 minutes or too close to 15:55 are excluded and counted. Because this is a second set of five tests on the same entries, the verdict CI is Bonferroni over ALL ten tests (99.5 percent two-sided, quantiles 0.25 and 99.75); the p75 result above stays in the claim. This is the last stall-length variant under this prereg: a null here ends step 0 (the cheaper hold-out is not touched).

## 9. RESULT of the amended run (2026-11-04 13:55 ET; ledger look 163; output `scratch/tell_stall_features_20261104_output_p90.txt`; claim `tell_stall_features_not_shown_20261104`)
L = 11 minutes (p90): 1,752 of 1,760 entries have a stall with a full 60-minute horizon; stall minute median 118 after the open. All five NOT SHOWN: VOL +0.014 [-0.061, +0.087], ADV_SHARE -0.020, RPC -0.012, EFFORT +0.008, PULLBACK -0.003 (CI Bonferroni over 10 tests); placebos -0.03..+0.04; both chronological halves disagree in sign for four of five; W = 10 and 30 the same; detectable |rho| 0.066-0.076. STEP 0 VERDICT: NOT SHOWN at both stall lengths. What this does NOT say: that the user's stall read is wrong. It says five relative tape readings, alone, at a stall, on the tell's entries, carry no resolvable signal about the next hour (effects under about 0.07 in rank correlation are unresolvable here). Untested: delta (waits for an up/down-tick definition that reproduces the user's Sierra pane), the picture the user reads (levels, nodes, the shape of the approach), and the first-hour entries separately by label. Per scope section 7 item 6 the watcher stays a display unless the user chooses to label: decision `watcher_labels_after_null_features_20261104`.
