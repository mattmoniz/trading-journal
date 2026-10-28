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
