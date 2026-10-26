# Pre-reg critique: FLOOR_HOLD_TO_POC (2026-10-26)

1. **Survivorship contaminates the primary K3P−K1 contrast (most serious).** K3P conditions on the level having survived ≥3 tests without a decisive break, so it selects "sticky" floors; K1 pools every first test including levels that never re-test or soon break. A floor that held three times is more likely to hold a fourth by selection alone, so the headline difference is biased toward SHOWN. **Fix:** make the contrast within-sequence — compare the 3rd test's hit rate to the 1st test's among sequences that reach k≥3 (causal, no lookahead, same levels, same survival).

2. **The mirrored placebo guards the wrong quantity.** Control #2 mirrors K3P absolute hit rate (good — it preserves survivorship), but the pass bar's headline is K3P−K1, which the placebo never touches. A survivorship-inflated difference can pass while the placebo shows the absolute level is unremarkable. **Fix:** placebo the difference too, or treat the within-sequence contrast in #1 as the survivorship control.

3. **97.5th percentile from 10 random-direction trials is not estimable.** Ten draws cannot locate a 97.5th percentile (≈ the max); the threshold will be noisy and easy to clear by chance. **Fix:** use the analytic driftless baseline stop/(stop+target) or thousands of permutations, not a 10-trial empirical quantile.

4. **Far target vs 1·A15 stop makes hit rate a near-meaningless readout.** With target "several to tens of A15," driftless P(reach)=stop/(stop+target) is tiny, yet the pass bar is hit-rate-only, so a high-hit-rate, negative-expectancy result could be "SHOWN." Target gap-through fills at the limit (favorable) while stop gap-through fills at the open (unfavorable) — asymmetric and inflates the long. **Fix:** require positive mean points per trade as a co-condition for SHOWN; mirror gap conventions exactly in the short.

5. **Multiplicity + non-independent cells.** Secondary cells (5 per-family, 4 sensitivity, 2 session, mirror, H2) overlap the same trades; BH assumes independence. "Same sign at all five" is an informal, uncorrected gate. **Fix:** treat sensitivity as robustness (report, don't gate); pre-register BH only on non-overlapping families; split-sample or Bonferroni for the primary.

6. **Bootstrap blocks by day but sequences span weeks and are autocorrelated.** Day-resampling understates variance → inflated CIs → false SHOWN. **Fix:** block-bootstrap by sequence (or level), not trade date.

7. **ES canary (H2).** The now/prev windows are causal (no lookahead), but D>0 on a thin K2+K3P subset with a low base hit rate is underpowered; canary-positive−negative is a tiny split. **Fix:** pre-specify a minimum N below which H2 is descriptive-only, and print raw counts.

8. **Level mismatch is unresolved.** Stored PW_VAL (29280) ≠ user's chart (29065), yet the run tests stored levels. A SHOWN/NOT SHOWN on the stored level may not describe what the user trades. **Fix:** resolve before running, or dual-report both level sets under the same pass bar.

9. **Episode asymmetry / event thinning.** Episodes start at VAL+p but end only at low>VAL+2p; "one event per (F, sequence, arm)" can drop informative tests and hide within-sequence clustering. **Fix:** make start/end symmetric and report dropped counts.

Otherwise lookahead is clean: entry at next bar's open, A15 from strictly prior days, k from earlier episodes only.
