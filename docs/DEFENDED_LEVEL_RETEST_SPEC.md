# Defended-Level Retest Spec (2026-08-12, scoped and design-critiqued — ready to mine)

## Origin

User observation from real chart-reading, grounded against real bar data (not
assumed): comparing a losing `OR5_LOW_FADE_SHORT` (09:45) against a winning one
(10:59) on the same day. Both are retests of a level from the broken side — the
mechanical direction logic already correctly identifies which side of a level
constitutes a valid retest (`isLong = approachDir === 'FROM_ABOVE'`, symmetric:
a stall above/around a level on first test is a `LONG` fade, a stall below on a
retest after a break is a `SHORT` fade — same underlying rule, not two rules).

**The current gap:** the system fires the instant a retest *touches* the level,
regardless of whether that retest shows any sign of holding. The 09:45 loser was
a retest that touched and got run over. The 10:59 winner was a retest that
*stalled* — a sequence of failed bounce attempts before the final rollover:

```
10:50-51  first drop            delta -180, -79
10:52-53  bounce attempt 1      delta +118, +43   (tries to counter)
10:54     hits a wall           closes back down, delta -127  (attempt 1 fails)
10:55     drops further         new low 29848.50
10:56-57  bounce attempt 2      delta +126, +118
10:58     hits a wall again     tiny range, delta -31  (attempt 2 fails)
10:59     rolls over            entry
```

## Known traps this design must avoid (both real, both found by re-checking the
## design against the exact numbers above, not assumed)

1. **`intrabar_cvd_divergence_no_edge_confounded`** (2026-07-21) — a
   similarly-shaped idea (price making a new adverse extreme while delta already
   favorable) found the "divergence" condition added almost nothing once
   properly controlled, because "made a new extreme" and "divergence present"
   are structurally correlated by construction. A naive "N failed attempts"
   predicate has the same shape: "price kept trying and couldn't" is *definitionally*
   close to "the level held" — the outcome being predicted, not a separate signal.
   Multiplying the attempt count from 1 to N does not escape this; it just
   restates it more times. **Fix**: define "failure" as absorption (an attempt
   makes a new HIGH, i.e. moves *against* the eventual fade direction, and then
   loses it) rather than "makes a new low" (which is a momentum restatement of
   the outcome). Absorption is anti-correlated with the down-prediction, not
   entailed by it.
2. **Summed attempt delta does not show "weakening" on the real example** —
   checked directly: attempt 1 (10:52-53) delta = +118+43 = +161; attempt 2
   (10:56-57) = +126+118 = **+244, stronger, not weaker**. Only the specific
   bar where each attempt fails shows a clean decline: -127 (attempt 1's
   failure) vs -31 (attempt 2's failure). Two genuinely different, non-tautological
   candidate metrics survive this reconciliation (both below) — testing both in
   parallel rather than picking one on a guess.
3. **Entry-timing structural advantage** (the overshoot-entry incident) — if the
   confirmed-signal arm enters at a variable bar (whenever the pattern completes)
   while its control enters at a fixed bar, early-completing signatures get a
   systematically cheaper entry against the same stop/target, independent of
   whether the pattern means anything. Needs a timing-matched control arm, not
   just a same-selection one.

## Definition — attempt detection (fixed, not swept)

At a level retest (touch on the direction-correct side — every touch, not
first-touch-only; the retest concept structurally excludes most events if
deduped to first-touch, per the live dedup convention used for
`active_setups`, which does NOT apply here):

1. Classify each bar UP or DOWN by close-vs-prior-close (SHORT fade: UP =
   reclaim/adverse, DOWN = rejection/favorable; mirror for LONG).
2. An **attempt** = a maximal run of >=1 consecutive UP bars.
3. An attempt **fails** at the first DOWN bar afterward that closes back below
   the level (or the attempt's own midpoint) — confirmed at that bar's close,
   not before. (Absorption reading — see trap #1 above.)
4. The **completion bar** — the anchor for everything downstream (entry,
   forward-return measurement) — is the bar where **both** conditions are true:
   (a) >=2 attempts have each had their failure confirmed within the lookback
   window, AND (b) the chosen weakening metric (below) shows the most recent
   attempt weaker than the prior one.

## Definition — weakening metric (TWO candidates, tested in parallel, not chosen by guess)

- **Variant 1 (bounce-progress weakening, price only):** `m_i` = price extent of
  attempt `i` (high − low over the attempt's UP-bar run). Weakening = `m_last <
  m_(last-1)`. Tests whether the bounces themselves are making less structural
  progress each time — no order-flow data needed.
- **Variant 2 (rejection-force weakening, order flow):** `m_i` = |delta on the
  bar where attempt `i` fails|. Weakening = `|m_last| < |m_(last-1)|`. Tests
  whether each rejection needs less active selling to turn the bounce back —
  the level increasingly defending itself with less force each time. This is
  the metric that actually holds cleanly on the real example (127 -> 31).

Run both as separate candidate definitions against the same attempt-detection
logic — not a combinatorial cross-product, two parallel single-metric tests.
Bid/ask resting size (distinct from net delta) is explicitly DROPPED from this
first pass — it has no measurement/threshold defined yet and would be a third
unaccounted free parameter; revisit as a follow-up only if Variant 2 shows real
signal.

## Window (the one deliberately swept parameter)

Lookback window candidates: 4/6/8/10 bars (user's own estimate was "6-7",
treated as a hypothesis to check, not the answer — "not a hard number... really
about getting a solid feel for that moment a possible pivot"). This is the only
swept surface; attempt-detection and the weakening-metric choice are both fixed
a priori (above), so `computeReplication()` only needs to key on (window,
variant) pairs, not a larger free-parameter space.

## No-lookahead

Every classification (UP/DOWN, attempt, failure, completion) walks forward
using only bars at-or-before the bar in question. The completion bar is the
earliest point the signal is legitimately known — never referenced before it
completes.

## Cheap gate before any real mining (run this first, always)

One `COUNT(*)` census: across the full history, how many touches actually reach
a completed defended-signature (>=2 failed attempts + weakening, either
variant) within the swept window range? If this is a low-single-digit percent
of touches, every downstream arm is N-starved from the start and the whole
design needs rethinking before spending real compute. Report this number before
anything else.

## Step 0 — cheapest screen first (per CLAUDE.md's standing pretest rule)

No stops, no targets, no trade machinery. At every real level-retest touch in
`price_bars_primary` (using the actual live touch-detection logic — the
existing candidate-detection function, not a reimplementation; every
direction-correct touch, not first-touch-only), measure raw forward price
movement at several horizons (1/3/5/10/20 bars from the **completion bar**, NOT
the touch bar — anchoring at the touch bar would put the signal's own
formation window inside the measured horizons, i.e. lookahead). Compare
conditional (signature present) vs. unconditional mean, session-matched: RTH
touches compared against an RTH-only baseline, Globex touches against a
Globex-only baseline — never a mixed baseline, since forward drift and
liquidity differ by session. Apply day-clustering/overlap rigor
(`computeRigor` with the touch date as `dateField`) at this bar-level stage,
not deferred to Step 1 — overlapping forward-return windows and same-day
repeat touches of the same level are correlated, and Step 0's N is inflated
without this.

## Step 1 — full simulation, if Step 0 shows something

Five populations, four marginal-comparison pairs (not the original three-arm
design — that version left the entry-timing confound and the delta-isolation
question both uncontrolled):

| Population | What it is |
|---|---|
| `NEVER_WAITED` | Immediate entry at first touch — today's baseline, resimulated fresh via `replayBars`/`directionFromType` (`maeMfeReplay.js`) against the real MNQ $2/pt + $2 round-trip commission (`server/config/instruments.js`) — not read from a stored column |
| `WAITED_NO_SIGNATURE` | Same touches, waited the full window, entered at window's end regardless of signature |
| `WAITED_SIGNATURE_TIMING` | Same touches, entered at `min(signature_completion_bar, window_end)` **regardless of whether the signature was actually real** — timing-matched to `DEFENDED_CONFIRMED`'s variable entry bar |
| `FAILED_ATTEMPTS_NO_WEAKENING` | >=2 failed attempts present, but the weakening metric (Variant 1 or 2) does NOT hold |
| `DEFENDED_CONFIRMED` | >=2 failed attempts AND weakening (Variant 1 or 2) |

Comparison pairs:

| Pair | Isolates |
|---|---|
| `NEVER_WAITED` vs `WAITED_NO_SIGNATURE` | pure delay effect |
| `WAITED_NO_SIGNATURE` vs `WAITED_SIGNATURE_TIMING` | entry-timing structural advantage |
| `WAITED_SIGNATURE_TIMING` vs `DEFENDED_CONFIRMED` | the whole signature, timing-matched |
| `FAILED_ATTEMPTS_NO_WEAKENING` vs `DEFENDED_CONFIRMED` | the weakening metric specifically |

Run this full 5-population design separately for Variant 1 and Variant 2.

## Required reporting shape (per direct user instruction — not aggregate EV alone)

1. **Coverage cost**: fraction of `NEVER_WAITED`-eligible touches that
   `DEFENDED_CONFIRMED` filters out entirely, and that filtered-out
   population's own EV under blind immediate entry — reported **relative to
   `NEVER_WAITED`'s own EV sign** (filtering out a trade only "costs" something
   if the blind baseline is itself positive-EV) — with its own N printed
   next to it, since it's the thinnest sub-population in the whole report and
   its WR alone is not trustworthy below the standing N>=20 floor. Also report
   the all-in blended EV (weighted mix of confirmed + filtered-blind) vs.
   `NEVER_WAITED` as a cross-check — components AND the aggregate, not
   components instead of it.
2. **Precision gain**: `DEFENDED_CONFIRMED` vs `WAITED_SIGNATURE_TIMING` (the
   timing-matched comparison, not `WAITED_NO_SIGNATURE` — using the fixed-window
   control here would still carry the entry-timing confound into this number).
3. Distribution, not just mean, per this codebase's standing asymmetric-payoff
   convention.
4. `computeReplication()` on the selected (window, variant) pair before trusting
   any headline number — this is a real K-way sweep even with the attempt-logic
   fixed a priori.

## Second-phase application (not part of this test — flag only)

If validated, this same "is this level actually being defended" signal is a
natural input to the level-cluster candidate-selection fix shipped 2026-08-12
(`nearLevels` fallback loop, `server/routes/acd.js`) — prefer a candidate
showing real defense over one just ranked by historical EV when multiple levels
are clustered. Deliberately out of scope for the first test — validating one
new signal and its live-selection application in the same pass would make a
negative result ambiguous. Revisit once Step 1 has a real, controlled result.

## Status — RESOLVED NEGATIVE (2026-08-12)

Full 8-way sweep (window 4/6/8/10 × variant 1/2) run against real history
(N=3657 RTH level-fade touches, 2023-11 to 2026-08) via
`scripts/backtest_defended_level_retest.mjs`. `computeReplication()` run for
real (not a placeholder call — the first Gemini pass got this wrong, see
below).

**Result: `DEFENDED_CONFIRMED` is negative EV in all 8 combinations** (range
-$0.23 to -$8.97/trade) and never beats blind immediate entry (`NEVER_WAITED`,
-$1.92/trade) in any of them. `heldOutFavorableFrac=0/7` on the replication
check. Against the timing-matched control (`WAITED_SIGNATURE_TIMING`,
isolating the pattern from the entry-delay confound) the result is genuinely
mixed — 4 of 8 combos better, 4 worse — no robust precision gain once delay is
controlled for. The dominant effect across the whole exercise: **waiting AT
ALL underperforms blind entry**, matching `engagement_confirmation_entry_timing`
(2026-07-23)'s prior finding on a related idea almost exactly. An early
single-point run (W=6/V=2 only) showed `FAILED_ATTEMPTS_NO_WEAKENING` at a
modestly positive +$1.64/trade and was flagged as a possible secondary
finding — this does **not** replicate across the full sweep (ranges -$9.35 to
+$2.70, sign-flips freely) — confirmed noise, exactly the largest-of-K-effects
trap this spec's own confound checklist exists to catch.

Full writeup: `RESEARCH_CLAIM defended_level_retest_confirmation_entry_negative`.
Resolves `OPEN_DECISION wait_for_held_ground_confirmation_before_fade_entry`.

**Process note, since two real mining-run bugs were caught by direct code
audit, not by trusting the prose summary:** (1) Gemini's first pass falsely
claimed the touch-detection logic wasn't cleanly importable (it already was,
in `scripts/backtest_unified.js`) and halted. (2) Gemini's second pass had a
hardcoded-Monday-stop/target bug and never actually computed the
required coverage-cost metric despite claiming to. (3) After the corrected
Step-1 run looked done, a follow-up audit found `computeReplication()` was
called with a broken/incomplete args object (missing `selectedIds`, and
against the wrong population shape) — it was never actually testing the
required window/variant sweep for selection bias, just returning degenerate
zeros. Built and ran the real 8-way sweep directly instead of a third Gemini
round, reusing the already-verified-correct simulation engine. Along the way,
consolidating the mining script into `scripts/backtest_defended_level_retest.mjs`
(imports the real `detectLevelFades`/`resolve`/`aggregate` from
`backtest_unified.js` rather than duplicating them) surfaced one more bug: the
import initially dropped Gemini's legitimate `stopPts`/`targetPts` fields,
silently zeroing out 4 of 5 populations' P&L. Fixed by adding those fields to
the canonical exported function itself (purely additive, verified
non-breaking for `backtest_unified.js`'s own use), then re-verified the sweep
reproduces byte-identical numbers to the pre-refactor run.
