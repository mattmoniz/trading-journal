# Pre-registration: regime gauge and the $2,000 trailing-floor risk test (step 3 of the user's ML plan; written 2026-11-02 BEFORE any bucket label is joined to a minute bar and before any outcome is computed; user go: "Sure do it")
Shadow and descriptive. It places no order, changes no switch, needs no server restart, and makes NO profit claim. It asks what the gauge (docs/REGIME_GAUGE_20261102.md) is worth for the one thing it is meant for: protecting the cushion of a prospective prop evaluation (rules per memory `reference-prop-account-rules-20261102`: $2,000 end-of-day trailing loss, any intraday dip below the floor is a breach, $3,000 target, no daily limit, no overnight hold, 1 MNQ).

## 0. What is already known, so this is not repeated (hr-052)
- Controls cannot create edge. At zero edge a trailing floor passes with probability about exp(-T/D) = 22 percent whatever stop or stand-down rule is used; a rule moves outcomes from "breach" to "frozen", not to "pass" (risk-design agent, scratch/agent_reports_20261102/risk_design.md; its simulator is NOT reused, a new one is written here and must reproduce its baseline first, section 4).
- On the live roster generator (mean-reverting fades with large adverse excursions) the cushion-relative stop and the day budget turned NEGATIVE; on the bar generator they were neutral to positive. Anything that looks good on bars here is therefore NOT validated for the roster. The agent's forward replay on live fills (at least 60 live days, paired) remains the only validation and is not run now.
- The gauge says how big, never which way (claim `regime_gauge_day_model_walkforward_20261102`: BUSY/QUIET realized-range ratio 1.49, OOS Spearman +0.42, overnight range alone +0.41).

## 1. Data (explore only; the hold-out is not touched)
Explore minute bars `scratch/range_budget_bars_20261102.json` (463 dates 2023-03-31 .. 2025-04-02, 390 RTH one-minute bars 09:30-15:59, built by `scripts/build_range_budget_bars_20261102.mjs`). Labels from `scripts/regime/regime_lib.py`: the walk-forward day model's out-of-sample prediction for the date (refit every 10 days on strictly earlier days, the first 120 valid days only train) and the bucket from expanding terciles of the strictly earlier OOS predictions (window 250, the first 60 OOS days skipped), exactly as `regime_report.py` labels. Evaluated days = explore dates with a label (about 280). The labels use no information after 09:25 of their own day.

## 2. Trade model (the same shape as the risk-design agent, so the baseline can be checked)
Each day, four sequential trades of equal length (window = 390 // 4 = 97 bars, the last takes the remainder), entry at the open of the window's first bar, direction random per trade (so the day carries NO directional edge unless an edge scenario is stated), exit at the window's last close. Dollar P&L = 2 x points - 2.50 per trade. An edge scenario E (net dollars per day, spread over the four trades) shifts every bar by a favourable linear drift of g = (E / 4 + 2.50) / 2 points per trade, so E = 0 means the cost is exactly recovered. A stop of S points fills 1 point through (loss = S + 1 points); a trade is stopped if its worst adverse excursion reaches S. Stop distance is checked against the window's maximum adverse excursion only (no re-entry inside a window). Account: balance starts 0, floor starts at -2,000, EOD best balance moves the floor up (floor = best EOD balance - 2,000), a breach is any trade whose intraday low (start balance - 2 x worst adverse points, or the stop loss when stopped) is below the floor, pass = EOD balance >= +3,000, horizon 250 trading days. A path that neither passes nor breaches in 250 days, or can no longer trade under its rule, is OPEN/FROZEN.
Day sampling: days drawn iid with replacement from the evaluated pool (primary) and in 5-day blocks (uncounted check); 40 independent pools of 500 paths each; every arm sees the SAME drawn days and the SAME random directions (paired).

## 3. Arms (the agent's formulas, fixed now: f = 0.15, g = 0.2, Smin = 9.25 points = the agent's trailing median 1-minute range; none of them is tuned here)
- C0: no control.
- C1 cushion stop: c = balance - floor; each trade's stop S = f x c / 2 points; if S < Smin stand down for the rest of the day (and permanently when f x c0 / 2 < Smin at a day start, since the cushion cannot rise without trading).
- C2 day budget: S = min(f x c / 2, (g x c0 + dayPnl) / 2) with c0 = the day-start cushion; stand down as in C1.
- C3 regime stand-down: no trades on days whose gauge bucket is BUSY (no stop).
- C4: C2 and C3 together.

## 4. Gate before any arm is read
At E = 0 the C0 pass share must be 22.3 percent +/- 4 (theory exp(-3000/2000) = 22.3 percent; the agent's bar simulation gave 23.3 +/- 3.8); if not, the simulator is wrong and stops there. Unit tests of the account logic (a path that dips to -2,001 breaches; EOD best raises the floor; pass at +3,000; a stopped trade fills 1 point through; paired arms share directions) are in `scripts/regime/test_risk_test.py` and must pass.

## 5. Counted tests (family `regime_risk_test_20261102`, ledger tests = 6; BH q = 0.10)
- T1 (market fact): ratio BUSY / QUIET of the mean maximum adverse excursion of a random-direction window trade (mean over the four windows and both directions, no drift). Hypothesis: > 1. Day-blocked bootstrap CI (3000, seed 20261102), circular-shift placebo on the bucket labels (1000), same sign of (ratio - 1) in both chronological halves.
- T2 (market fact): ratio BUSY / QUIET of the daily random-direction P&L SD, sqrt(mean over days of the sum over the four windows of the squared window move). Same statistics.
- T3-T6: paired change at E = 0 of C1, C2, C3, C4 against C0 in pass share, and in breach share; verdict labels: HELPS = pass-change CI above zero; PRESERVES = pass-change CI above -2 points and including zero, AND breach-change CI below zero (protects the account at no measurable cost to the pass odds); HURTS = pass-change CI below zero; otherwise NOT SHOWN. A positive label is only about this bar model; see section 0.
- A control scenario at E in {10, 25} dollars per day is printed, uncounted, labelled hypothetical (no edge exists); the E = 25 table answers "would the gauge help if an edge of that size existed", nothing else.
- The condition under which stand-down on BUSY could help a pass is stated now: only if the per-trade EDGE does not scale with the volatility (a fixed-dollar edge), because then quiet days give more edge per unit of variance; if the edge scales with volatility, gating cannot change the pass odds. The edge is unknown, so the E-scenario arms use a fixed-dollar edge and are an upper bound for the gauge.

## 6. Resolution, stated now
About 280 days, roughly 90 per extreme bucket: the BUSY/QUIET ratios of T1 and T2 resolve to about +/- 12 to 15 percent; the paired pass-share change resolves to about +/- 1.5 to 2.5 points per arm (40 pools of 500 paths). An effect smaller than that is invisible; NOT SHOWN means exactly that, never "no effect".

## 7. Uncounted diagnostics, all printed
Baseline gauge: the same ratios with buckets from the overnight range alone (expanding terciles), to see whether the model adds anything over the plain overnight range; ratios by calendar year (era flips are real here, cv-033); the C0 median days to pass and breach; the 5-day-block check of T3-T6; the share of paths FROZEN per arm.

## 8. Reading rules
- T1 and T2 both pass: the gauge tells a real swing-size difference, as built for; useful for standing down, sizing a cushion plan and expectations; nothing about direction.
- Any control PRESERVES or HELPS on bars: a lead for the forward counterfactual on live fills (the agent's pre-registered test, at least 60 live days, paired, criteria in risk_design.md), never a wired rule; the roster sign reversal means a bar-model positive is not evidence for the roster.
- Everything NOT SHOWN: the gauge does not change the pass odds at the resolution above (as the theory says for a driftless account); it stays an expectation-setting display.
- Nothing is wired, no order or switch changes, under any outcome.

## Amendment 1 (2026-11-02, written AFTER run 1's output was read; disclosed)
Run 1 drew each path's days straight from the evaluated set, so its paired CIs measured only Monte Carlo noise, not the uncertainty of having only ~267 days (the risk-design agent resampled a bootstrap day pool inside each of the 40 pools; section 2 meant "pool-bootstrapped" and I did not implement it). The fix (a bootstrap day pool per pool, the arms still paired) only WIDENS intervals and applies to every arm alike; labels are re-derived from the corrected CIs, and run 1's output is kept as `scripts/regime/run_risk_test_output_run1_mc_only_ci.txt` for the record. T1 and T2 were already day-blocked and are unchanged. The point estimates of run 1 were read before this amendment, so the amendment cannot be claimed as pre-outcome; only the label rule (fixed in section 5) and the arms were fixed before.
