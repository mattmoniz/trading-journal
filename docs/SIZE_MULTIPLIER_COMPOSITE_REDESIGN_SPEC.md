# sizeMultiplier composite redesign — scoping spec (2026-08-30)

**Status: design-only, nothing built or wired.** Triggered by a user question during a
Vol+/Vol++ walkthrough: "is sizeMultiplier's dynamic use rigid, or intuitive like the
volume-building work?" Answer, verified directly against the live code: **rigid.** This doc
scopes what a redesign toward the volume-building work's style (continuous, distribution-
derived, self-recalibrating) would actually require.

## 1. Current mechanism (as-is, verified 2026-08-30)

`server/routes/acd.js` ~7824-7930, an IIFE inside `levelScalpSetup`'s construction (RTH
level-fade engine only — see §4 for Globex). Confirmed by direct read, not memory:

- `mult` starts at `1.0`.
- ~25 independent `if`/`else if` conditions each apply a flat step (`+0.10`, `+0.15`,
  `+0.20`, `+0.25`, `+0.50`, or a hard reset like `mult = 0.10`), each with its own
  `Math.min`/`Math.max` floor/ceiling clamp (floors of `0.10`/`0.25`, ceiling `1.5`).
- Applied in a **fixed written order** — order matters, because later clamps can partially
  override earlier bumps (e.g. the loss-streak cap at the very end is a hard ceiling nothing
  above it can escape).
- **Two of the ~25 factors already self-recalibrate** from live data: the day-type bump
  reads `dtaRow.sizeDelta` from `DAY_TYPE_ALPHA` (scaled by that row's own z-score), and the
  entry-pressure short boost reads a weekly-recalibrated bump from `performance_audit`. The
  other ~23 are literal constants frozen at whatever the backtest said when each factor was
  added — they don't move unless someone edits the code.
- Most conditions are **binary threshold-crossers**, not continuous functions of signal
  strength — e.g. "consecutive wins ≥3 → flat +0.50," not "+0.50 scaled by how far past 3."
- A separate downstream step (~9058-9060, the post-construction "Death Sequence" block)
  applies `Math.min(active.sizeMultiplier ?? 1.0, 0.5)` as an additional cap when
  `hasLossToday` — **caps, never overwrites**, per this codebase's own standing
  `active.sizeMultiplier` overwrite-footgun rule. Any redesign must preserve this
  cap-not-overwrite contract exactly.

This is, in effect, a hand-tuned linear model with hand-picked coefficients and no
correlation control between features — several factors plausibly measure overlapping things
(`dtClass==='TREND'`, the NL30 bucket conditions, `smallGapDay`, `_lfDeltaNeutral` all touch
"how directional/volatile is today" from different angles) and nothing currently checks
whether stacking all of them double-counts the same underlying effect.

## 2. What "intuitive, like volume-building" means concretely

The volume-building work (`docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`) is continuous by
construction: dose-response across percentile deciles, rolling p60/median cutoffs derived
from a live distribution, self-recalibrating weekly, no hand-picked step size anywhere. The
redesign goal is to move sizeMultiplier's *combination mechanism* toward that shape — the
research behind each of the ~25 existing factors stays valid (each already cleared real
N≥20 backtested EV/WR splits); what changes is how they're combined into one number.

## 3. Proposed approach — composite continuous score

1. **Per-factor continuous transform.** Replace each binary condition with a z-score or
   percentile rank of the underlying measure against its own rolling historical
   distribution (matches the standing "no static thresholds" rule directly — most of these
   factors currently violate it in step-size, if not in cutoff). E.g. "loss streak" becomes
   a continuous function of streak length against its own historical distribution, not a
   3-tier ladder.
2. **Weights derived, not hand-picked.** Each factor's contribution should be sized by its
   own measured effect (EV-per-sigma, or a coefficient from a real regression against
   outcome), recalibrated on the same weekly cadence as `SETUP_STATUS`/`OPTIMAL_STOP` —
   not a constant someone typed in the day the factor was added.
3. **Correlation/multicollinearity check before combining.** Before trusting a composite
   score, check pairwise correlation between the ~25 factor z-scores on real trade history.
   Collapse or orthogonalize any pair that's substantially redundant (a real risk here, per
   §1) rather than letting the composite silently double-weight one underlying effect.
4. **Combination + calibration.** Weighted sum of factor z-scores → a single composite
   score → mapped to a multiplier via a monotonic calibration curve fit against real
   outcome (not another hand-picked linear scale), recalibrated weekly.
5. **Persistence.** A new `performance_audit` row, e.g. `signal_type='SIZE_MULTIPLIER_MODEL'`,
   storing the current per-factor weights + calibration curve, written by a new
   `scripts/backtest_size_multiplier_model.mjs` on the same weekly cron as everything else
   in `run_weekly_backtests.sh`. This satisfies the four-part no-dead-ends checklist
   (persisted, recheck path, wired consumer, discoverable) from the start.
6. **`standDown` stays a hard gate, not a composite input.** The existing boolean stand-down
   logic (loss streak ≥2, or TREND+loss) should remain a categorical filter applied
   *outside* the continuous score, not folded in as another weighted factor — this
   preserves the existing "filter out, don't just size down" design intent for clearly -EV
   conditions.

## 4. RTH vs Globex (hard rule: both windows, not RTH-only)

The Globex sizeMultiplier (acd.js ~1846-1853) is currently a one-line stub:
`confluencePairPartner ? 1.15 : 1.0`. There is no equivalent ~25-factor stack on the Globex
side at all — a much bigger asymmetry than "the RTH version needs modernizing." Two
sub-decisions, not one:
- **(a)** Does the new composite mechanism get built for RTH first and Globex second, or
  designed once and instantiated for both from day one? Given Globex's setup roster and
  data volume are both thinner, a shared composite *framework* (per-factor z-score →
  weighted sum → calibrated multiplier) populated with whichever factors have enough real
  Globex N, rather than porting all 25 RTH factors wholesale, is the more honest starting
  point.
- **(b)** If Globex genuinely doesn't have enough real N yet to support more than the
  existing single confluence factor, that's a valid "doesn't apply yet" outcome per the
  RTH/Globex hard rule — but it must be an explicit, tested, recorded conclusion (a
  `RESEARCH_CLAIM`), not a silent RTH-only ship.

## 5. Validation requirements (per this codebase's own standing rules)

- **Classifier validation, not just split validation** (`docs/HARD_RULES_DETAIL.md`'s
  classifier-vs-split rule): the composite score IS a newly-built classifier. Window
  lengths, z-score lookback periods, and the weighting scheme all need their own robustness
  checks — sensitivity to reasonable parameter changes, and independent predictive power —
  before trusting the composite's ranking of "high confidence" vs "low confidence" fires.
- **Held-out validation, not in-sample refit.** Every one of the ~25 existing factors was
  originally validated against `active_setups` history that a naive composite-model fit
  would refit on again — genuine walk-forward (`computeRigor()`'s chronological-stability
  check) and `computeReplication()` (`server/services/rigorDiagnostics.js`) are required
  before promoting the composite over the current hand-stack, not just a single in-sample
  backtest number.
- **Day-clustering + confound checklist** (per the standing comparison-backtest checklist in
  CLAUDE.md Conventions): the composite-vs-hand-stack comparison is exactly a two-arm
  comparison backtest — apply all 4 checklist items, especially "is this the largest of K
  effects" given ~25 candidate features are being combined at once.
- **Real N only** (`REAL_TRADE_FILTER`, `origin_status IN ('ACTIVE','SHADOW')`) — never
  fit or validate against `BACKFILL` rows.

## 6. Rollout plan

- **Phase 0 — design critique.** This document, dispatched to DeepSeek (design
  critique/code review owner per this repo's Gemini/DeepSeek division of labor) *before*
  any code is written. Deliberately not Gemini for this phase — Gemini's lane is DB
  mining/backtests, not design critique.
- **Phase 1 — mine-and-run comparison.** Dispatch to Gemini: simulate both the existing
  hand-stack and a first-draft composite model against real (`REAL_TRADE_FILTER`) historical
  `active_setups` fires, compare realized WR/EV, and explicitly check for the
  double-counting/correlation risk flagged in §1 and §3.
- **Phase 2 — code review.** A separate, review-only DeepSeek pass on the resulting
  implementation before any live wiring, per the standing 3-phase higher-stakes workflow.
- **Phase 3 — shadow-parallel logging.** Compute and persist the new composite multiplier
  alongside the existing one on every real fire, informational-only (no behavior change),
  for a real accumulation period — mirrors how the volume-building signal itself was
  introduced.
- **Phase 4 — promote.** Only after the composite clears the same bar as any other live
  change: real N, clean replication, chronological stability — not a single backtest number.

## 7. Open risks / questions (not yet resolved)

- **Circularity risk.** Every existing factor's weight was itself derived by testing against
  the same `active_setups` history a composite refit would use — a real risk of just
  re-deriving the current hand-picked weights with extra steps unless the validation in §5
  is taken seriously (genuine out-of-sample split, not just a cleaner in-sample fit).
- **Thin per-bet-class N.** A single global composite risks being dominated by whichever
  bet_class/setup_type has the most real fires; a per-bet-class composite risks each one
  being too thin to fit reliably. Needs a concrete decision once Phase 1's real N counts are
  in hand — not decidable from design alone.
- **Whether this is worth the build cost at all.** The user's original framing was "not sure
  if sizeMultiplier is needed" — Phase 1's comparison (old hand-stack vs new composite,
  real EV/WR) is what actually answers that, not this design doc. If Phase 1 shows no
  material EV difference, the honest conclusion may be "keep the hand-stack, it's not
  costing anything" rather than shipping a more complex mechanism for its own sake.

## Next step

Dispatch this document (not code) to DeepSeek for phase-0 critique. Tracked as
`OPEN_DECISION sizemultiplier_composite_redesign_scoped_pending_review`.
