# OPUS STRATEGIC AUDIT (AUDIT #14): how should this codebase use ML, and is the current direction right?

> **Numbering note:** requested as "Audit #13", but `docs/OPUS_AUDIT_PROMPT_13.md` /
> `scratch/opus_audit_13_results.md` already exist (the 2026-09-15 contract-calendar data-model
> audit). Filed as **#14** so the two don't get confused. Results:
> `scratch/opus_audit_14_ml_strategy_results.md`.

You are Claude Opus, running at high reasoning effort. This is a strategy review, not a bug hunt.
Give real verdicts, not both-sides-ism. You may conclude the current direction is wrong and a
wholesale redirect is the right call. Do not write feature code or touch the live app; the output
is a research/strategy document.

## Read these first (the real code, not summaries)

1. `CLAUDE.md` in full, especially the hard rules (no static thresholds, no lookahead, N>=20,
   day-blocked/embargoed validation, permutation nulls, the 4-part "no dead ends" checklist, the
   roster-churn confound, the pooled-verdict rule) and the "Where to look" index. Many ideas in
   this space were already tested and killed. Don't re-propose them.
2. `ARCHITECTURE.md`.
3. **Track A, live-silo:** `scripts/ml_meta_labeling/` (LightGBM TAKE/VETO on every real fire,
   fully isolated, never gates a live trade). Walk-forward day-blocked CI still crosses zero.
4. **Track B, built 2026-09-23:** `scripts/tick_microstructure/`,
   `docs/TICK_MICROSTRUCTURE_PILOT_SPEC.md`. The first survival target was a clean negative
   (AUC 0.4563). It was then reframed to a trade-level fade STOP_HIT vs TARGET_HIT classifier:
   AUC 0.5368, permutation p=0.10, 77.6% of test trades on 5 of 10 days. It is PROVISIONAL and
   rechecked daily.
5. **Track C, paused/broken:** `scripts/depth_absorption/`,
   `docs/DEPTH_ABSORPTION_PILOT_SPEC.md`. Order-book reconstruction fails validation (15.85%
   mismatch against a <1% bar), and the root cause hasn't been isolated.
6. **External input** (a separate DeepSeek conversation the user had, not this repo's own
   dispatch history). Evaluate it independently; don't defer to it:
   - Predict the forward path (MAE/MFE in R, time-to-MAE/MFE, P(hit 1R/2R/3R/5R before stop))
     instead of a binary win/lose label.
   - Two models: "Adverse Continuation" P(MAE>1R before MFE>0.5R), and "Runner Probability"
     P(MFE>2R/3R/5R before stop).
   - A counterfactual exit model: simulate every exit for every trade, label the best one, and
     learn the optimal exit policy per entry. Relate this to the stalled runner mechanisms
     (`stepTrailWalker.js`, `pitchCatchWalker.js`, breakeven-trail).
   - Trade-type classification (with-grain vs countertrend), compared against Track B's
     efficiency ratio.
   - Level-specific features (approach speed, absorption, prior tests, time at level), which
     overlap Track C and `touchQuality.js`.
   - Unsupervised outcome archetypes (UMAP+HDBSCAN).
   - Online/adaptive learning with recency weighting instead of full periodic retrain.
   - Its own closing self-critique: compute forward paths first, run univariate checks, and use
     the simplest model (logistic regression) first. Should this codebase follow that
     minimalism, or can it skip ahead given its existing LightGBM/purged-CV/labeled-trade
     infrastructure?

## Questions to answer

1. Is the current shape (A live meta-labeling + B trend/path features + C blocked depth) right,
   or should ML be re-approached across the app?
2. Evaluate the MAE/MFE path-prediction reframing concretely against what's built, including
   real `mae_points`/`mfe_points` coverage and what an upgrade to Track B's target would require.
3. Is the counterfactual exit-policy idea a real bridge to the stalled runner mechanisms? If so,
   what's the concrete next build step?
4. With Track C blocked, is depth worth chasing, or should the absorption goal go another way
   (e.g. the tick bid/ask split with no book reconstruction)?
5. Rank order what should happen next, and why. This is a short sequence, not a wish list.
6. Follow this codebase's own rules throughout: no lookahead, real N floors, day-blocked or
   embargoed validation, no fabricated stats, and audit any external-model claim before
   trusting it.

Deliverable: full results document plus a few-hundred-word summary.
