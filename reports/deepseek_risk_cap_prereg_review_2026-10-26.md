# Design review — one-contract risk-cap prereg

1. **"Risk" is not a fire-time quantity (lookahead; invalidates the lever).** Risk = |entry_zone_low − OPTIMAL_STOP|. OPTIMAL_STOP is a hindsight-optimized stop, so a trade's "risk" is known only after the stop is chosen with future knowledge — the trader has no such lever at fire time. The percentile/median are also built on a population already filtered on post-hoc outcomes (actual_pnl not null, not NOT_FILLED). Fix: use the stop present at signal/fire time; compute thresholds over ALL fired candidates regardless of fill/pnl; if OPTIMAL_STOP is the only stop, re-state the claim as descriptive, not causal.

2. **S2's random-skip placebo is the wrong control (geometry confound).** Wide stop ⇒ wide target ⇒ larger |$| P&L. Removing the biggest-|P&L| trades lowers worst-day/drawdown versus *random* removal automatically, without evidence the trades are bad. Fix: placebo that skips the same number of trades with the largest |actual_pnl| (or same risk mass), and require the R-multiple result to pass too.

3. **S1's within-type contrast doesn't test the cap.** The cap is the global 90th pct (~65 pts), which ≈ "drop the 2–3 widest setup types." S1 instead median-splits *within* each type — a different, lower threshold that discards magnitude — and the >=40 gate is chosen on the full sample (mild lookahead), so it can collapse to one type. Fix: pre-register the type gate on prior data only; add an explicit "drop whole widest-types" arm; test the actual 90th-pct threshold.

4. **R-multiple is only descriptive, but it is the fair metric.** Dollar sums/means/worst-day are inflated for wide trades; skipping them changes risk-reward exposure, not just risk. Fix: make pnl/risk co-primary for S1 (mean R KEPT vs SKIPPED) and S2 (R-based account curve, worst R-day, R-drawdown).

5. **Account series from SHADOW rows breaks one-contract reality.** Summing all detected SHADOW events per day overstates daily variance, worst day, and drawdown — a one-contract account cannot be in simultaneous trades. Fix: one-contract execution simulator (time-ordered, single position).

6. **Power is very low.** ~50 evaluated days, halved to ~30/~20; worst-day is one observation and max drawdown one path statistic; a 97.5th-pct placebo with tiny N gives huge CIs, so NOT SHOWN ≠ no effect and SHOWN risks a tail artifact. Fix: pre-register halves as exploratory, report minimum detectable effect, lower the placebo threshold.

7. **Multiple comparisons / attribution.** q=90, q=95, structural cap, two S1 contrasts, S2 stats × pooled/halves — no correction; the binary can be gamed, and the structural cap (a clean no-lookahead rule) is mixed with the percentile cap. Fix: one primary threshold/outcome pair, correct elsewhere, report the structural cap as a separate claim.
