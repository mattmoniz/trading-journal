# Prereg retrospective, 2026-10-27

Separate from `prereg.lock` (hash `becad7fc...`, CONFIG unchanged). This is a finding about the preregistration, not about the data.
It does not invalidate the run. It invalidates one interpretation of it: "PROCEED means both regimes are viable."

## The run, as the prereg asked it
- Window 2023-03-06 to 2026-10-26 (pinned), 934 sessions loaded, 928 clean, 556 train / 372 hold-out. Hold-out frequency table withheld.
- Train classified N=516: D 227 (43.99%), A 189 (36.63%), C 90 (17.44%), B 10 (1.94%).
- Pooled B+C = 100/516 = **19.38%**. Verdict as pre-committed: **PROCEED WITH UNDERPOWERED CAVEAT, DESCRIPTIVE_ONLY_NOT_CONFIRMATORY**. Regime A 36.6% is under the 40% floor (report only).
- Log: `run_20261027_201521.log` (first run), `run_20261027_202135.log` (identical numbers, adds the decomposition block). Deterministic on the pinned window.

## What the gate evaluated vs what it should have evaluated
- Evaluated: pooled B+C rate against 20% / 12% bands.
- Should have evaluated: per-regime viability. The pooled gate assumed B and C were interchangeable for the proceed decision.
- Consequence: B passed on C's sample. 90 of the 100 pooled fires are Regime C. The pool provides no evidence about B, so the pass is a **false positive for B**.

## Why B was structurally under-armed (measured on classified train, N=516)
| B condition | share of train sessions meeting it |
|---|---|
| ib_vol_ratio >= 1.5 | 4.3% (the 1.5 floor is above the train p90 of 1.261) |
| ib_range >= rolling p65 | 42.2% |
| open_location != 0 | 64.0% |
| independence product | 1.15% (observed 1.94%, so the conditions are mildly positively correlated) |
Among the 218 sessions with ib_range >= p65, only 7.3% reach vol >= 1.5.
Expected B sessions in the hold-out is about 7 (1.94% x 372), a projection from the train rate; the hold-out regime table was not read.

Two corrections to the first-pass arithmetic (the conclusion is unchanged, the inputs were off in offsetting directions):
the vol condition passes 4.3% of sessions, not "at most 10%"; and open_location != 0 passes 64%, not 35-45%.
"Mathematically incapable of a testable sample" is slightly too strong as wording: B is not impossible, it is a ~1-2% event, which on this history yields about 10 train and about 7 hold-out sessions. That is not a test.

## What a correct gate looks like (v2 will use one of these)
1. Conjunctive: B >= min_n AND C >= min_n. On this run it would have returned NEGATIVE for B.
2. Per-regime: two gates, two verdicts, two Phase 3 scopes.
3. Pooled with a floor: B+C >= 12% AND min(B, C) >= X% of classified sessions.
Recommendation for v2: option 2 (per-regime gates), because Phase 3 scope follows the verdict.

## What PROCEED authorizes
The prereg gates the decision to start Phase 3. It is silent on scope. Phase 3 proceeds on **Regime C only** (90 train sessions, about 65 projected hold-out: 17.44% x 372; descriptive, as pre-committed).

## Regime B: deferred to v2
- Do not build B against about 7 hold-out sessions: it cannot produce a result, only a number that gets misquoted later.
- Do not re-tune the vol floor (1.2, 1.15, ...) and re-run on this window. The train window is also burned for B (n=10 was untestable there too), so any floor change is a new design choice that needs its own evaluation window.
- **A fresh hold-out for B does not exist in this database.** History before 2023-03-03 is daily placeholder rows only (KNOWN_ISSUES #17; no NQH3 tick file exists to rebuild 2022-12 to 2023-02), so extending backward is closed. Forward accumulation is about 21 sessions a month; at B's observed rate that is well under one B session a month, so waiting does not solve it either.
- So B v2 needs a **redesigned classifier** (a floor derived from the distribution, e.g. an in-prereg percentile of the trailing vol-ratio window rather than a literal 1.5) with its own prereg, evaluated by walk-forward on the data we have, or accepted as descriptive-only. That is a different methodology and needs its own prereg. Not started.

## One-line verdict note
PROCEED (underpowered). Post-verdict structural finding: Regime B was structurally under-armed by construction (vol floor above the p90 of the distribution; 1.5 vs 1.261); pooled gate produced a false positive for B. Proceeding on Regime C only (about 65 projected hold-out, descriptive). Regime B deferred to a v2 prereg with a fresh evaluation window; no re-tune on this window.

---

# Addendum: Regime C Phase 3 closed (2026-10-27)

## Headline
**Trigger: no edge shown and train-significantly negative. Classifier: not refuted, with a separation observed for this trigger, but not independently validated. "Trapped auction reversal" as specified is not a viable response to Regime C.** Phase 3 for Regime C is closed. Regime B is deferred to v2. Nothing is live.

## What was run
Pre-registered (`PHASE3_C_PREREG.md`, committed `b76e96d` before any C trade), one look at each split, frozen config (`phase3_c.lock`, hash `aa8425d0854f`), engine verified on synthetic sessions and by an independent recomputation of real trades.

| | Sessions | Trades | Win rate | Mean $/trade | 95% CI (day-blocked) | Exits | Real vs random-direction placebo |
|---|---|---|---|---|---|---|---|
| Train | 90 | 53 | 9.4% | -46.42 | [-71.54, -17.58] | 87% stop, 0% target, 13% flatten | worse than 98.5% of trials |
| Hold-out | 50 | 28 | 14.3% | -31.91 | [-89.25, 44.55] | 82% stop, 4% target, 14% flatten | worse than 84% of trials |

Break-even win rate is about 13-14% (median stop 29.75 pt vs median target 178.75 pt, median R:R 6.5). Train is below it; hold-out sits at about it with a CI that cannot separate it from either side.

## What was shown, and what was not
- Shown: on train, the trigger loses (CI excludes zero) and does worse than random direction on the same geometry. On hold-out the point estimate points the same way, but the CI crosses zero and the placebo comparison (84%) is not strong. Read together: consistent direction, one split significant, the other not.
- Not shown: that the trigger has no edge of any size on future data (hold-out CI width is about $134), and that it is biased against by a mechanism. "Worse than 98.5% of placebo trials" is a train-only statement; it says the real direction underperformed random direction on those 53 trades, not why.
- The pre-registered reading was "no demonstrated edge". The stronger wording used in discussion ("refuted") is defensible for train, not for hold-out. The closure does not depend on the stronger wording.

## The classifier: what this does and does not establish
- Observed: with the same engine, A and D are about break-even (A mean R -0.104 train / +0.073 hold-out, D -0.014 / +0.096) and C is worse (-0.611 / -0.339). C minus non-C is -$42.78 on train (CI [-70.10, -13.07]) and -$32.51 on hold-out (CI [-94.77, 50.38], crosses zero).
- So closing C closes the **trigger**, not the classifier thesis. The classifier is not refuted by this result.
- But "classifier validated as discriminating" overstates it, for three recorded reasons: (1) the hold-out separation is not significant; (2) C is defined by a large IB range (> rolling p75), which by itself changes the stop/target geometry and break-even of any IB-anchored trigger, and no range-only control was run, so this cannot separate "the regime matters" from "wide-IB days are worse for this trigger"; (3) a trigger's P&L by regime is not a test of whether the regime predicts anything about the auction itself (subsequent range, trend, rotation). The completed sub-result is: the classifier's states produce groups that behave differently under this one trigger. Whether they discriminate anything independently is untested and would need its own prereg with a range-only control.

## Spec-level corrections (recorded here, not just as implementation details)
1. **Lookahead in the handoff spec:** "entry on the reclaim bar open" uses information that exists only at that bar's close. Corrected to the next bar's open. Any future spec derived from this one inherits the correction.
2. **Commission:** the handoff's $4.00 conflicts with this journal's ground truth (MNQ, $2 per round trip, `server/config/instruments.js`). Headline at $2.00, $4.00 run as a pre-registered sensitivity; it moves the means by about $2 and changes nothing.
3. **The R:R >= 1.0 filter is non-binding by construction** for this geometry (median R:R 6.5): it adds no selectivity, and the real constraint is the low break-even win rate that the far target implies.
4. First-pass ceiling arithmetic for B (see above) used 10% and 35-45% where the measured values were 4.3% and 64%; the conclusion survived the correction.

## Why C is not reopened by flipping or swapping the trigger
- **Continuation is not a mirror.** The 13-14% break-even comes from a 30/179 stop/target built on the sweep extreme and the opposite IB edge. A continuation trade has no symmetric reference points; it would need its own geometry and its own break-even.
- **The windows are used.** Both train and hold-out have been observed for Regime C. Any new trigger on the same classifier states re-uses days already conditioned on, which is contamination in the strict sense.
- **The only valid path for anything new** (a flipped hypothesis, a new trigger, B v2, a classifier redesign) is a walk-forward project with its own prereg: rolling train -> test -> roll, window lengths and step fixed in advance, ONE pre-specified aggregation across folds. Its own failure modes must be written into that prereg up front: many folds invite selection of the favorable ones, parameters drift across folds, and fold results are serially correlated, so the effective sample is smaller than the fold count suggests. It is not a free lunch and is not started.

## Status
- Phase 3, Regime C: **closed**. `macro_regime_C_after_null_what_next_20261027` resolved as (a).
- Regime B: deferred to v2 (`macro_regime_B_v2_needs_redesign_no_fresh_window`, walk-forward is the framework).
- Classifier: sub-result recorded above; independent validation is open only as a new prereg, not as a continuation of this one.
- Frozen configs (`prereg.lock`, `phase3_c.lock`) stay as the record. Do not edit `PHASE3_CONFIG` or the classifier CONFIG to chase this data.
