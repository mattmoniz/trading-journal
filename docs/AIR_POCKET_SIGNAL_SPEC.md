# Air-Pocket Signal Spec (2026-08-12, RESOLVED — closed without mining, see Status)

## Origin

Follow-up to a direct question about market mechanics: price moves either by
aggressive orders consuming resting liquidity, or by resting orders being
withdrawn (cancelled, not filled) — thinning the book so a comparatively small
push moves price further than it "should." This codebase can't see either
mechanism directly (no order-book depth, no cancellation data — only
aggregated 1-min trade volume), but it can *infer* the difference: a big price
move on heavy volume is consistent with real consumption; a big price move on
*light* volume is consistent with a thin/withdrawn book.

This codebase already has the mirror-image signal live: `hivolLopace`
(`server/routes/acd.js` ~6836-6874, `RESEARCH_CLAIM
hivol_lopace_precursor_confirmed_negative`, CONFIRMED 2026-07-29) — heavy
volume WITHOUT correspondingly large price movement in the trailing 5 bars
before a touch, predicting a WORSE fade outcome (the opposite of the
"absorption defends the level" story that motivated testing it; it reads as a
headwind instead). This spec set out to test what looked like the untested
mirror: **low volume WITH correspondingly LARGE price movement** — the
air-pocket signature — as a predictor of fade quality.

**This premise turned out to be false — see Status below.** The mirror
quadrant was already computed in the same 2026-07-29 run (the source data
behind `hivol_lopace_precursor_confirmed_negative`) and already failed its
stability check. Left the rest of this doc unedited below as a record of the
original (mistaken) reasoning; do not build against it without rereading
Status first.

## Reuses existing, already-validated infrastructure (not a new algorithm)

Unlike `docs/DEFENDED_LEVEL_RETEST_SPEC.md` (which needed a new multi-bar
pattern-detection algorithm), this signal is a direct structural mirror of
`hivolLopace`'s own exact, already-shipped methodology:

- `volZ` = max z-score of total volume (bid+ask) over the trailing 5 bars
  ending at the entry/touch bar, vs. a per-minute-of-day baseline
  (`getTouchQualityBaseline()`/`touchQuality.js`'s `getVolumeBaseline()`).
- `paceZ` = z-score of net price movement magnitude (`|close_now -
  close_5_bars_ago|`) over the same window, vs. a per-minute-of-day baseline
  (`getPaceBaseline()`, `server/routes/acd.js` ~306).
- `hivolLopace` (existing, live) = `volZ >= 0.5 AND paceZ < 1.0`.
- **This spec (new)** = the mirror condition: low `volZ` AND high `paceZ`.

## Cutoffs — data-derived, not a mirrored guess

`hivolLopace`'s own 0.5/1.0 cutoffs were reused from a *different* signal
(`STACK_VOL_BREAK_LIVE`'s entry trigger), not independently re-derived for
`hivolLopace` itself — and there's no reason a volume distribution's lower
tail and a pace distribution's upper tail are symmetric around the same
absolute z-score magnitudes as the original signal's cutoffs. Derive both
cutoffs fresh from the pooled real distribution of `volZ`/`paceZ` at touch
events (e.g. bottom-quartile `volZ`, top-quartile `paceZ` — exact percentile
swept, not assumed) rather than reusing `-0.5`/`1.0` by symmetry.

## Framing — two candidate uses, test the cheaper one first

1. **Fade-suppression flag (primary, lower risk)**: does an air-pocket
   approach into a level predict the EXISTING fade setups at that level will
   fail (level gets blown through, no real liquidity to defend it)? Directly
   analogous to `hivolLopace`'s own role — informational/suppression on the
   *existing* setup population, not a new setup family. This is the cheaper,
   more directly comparable test and should run first.
2. **Standalone continuation/momentum signal (second phase, flag only)**: if
   the fade-suppression framing shows real signal, the natural follow-up is
   testing whether the SAME air-pocket condition predicts continuation in its
   own direction — i.e., a signal for the roster-rebuild's momentum/breakout
   setup family (Setup B/D), not a fade at all. Deliberately out of scope for
   the first test, same reasoning as the defended-level-retest spec's
   second-phase note — validating a new signal and a new application in the
   same pass makes a negative result ambiguous.

## Confound check (per this codebase's standing checklist)

1. **Structural/tautology risk**: does "price moved fast at low volume" just
   restate "the level was approached," which is definitionally true of every
   touch? Mitigated the same way `hivolLopace` itself is: the window is
   measured strictly BEFORE the touch/entry bar, and the claim being tested is
   about the FORWARD outcome after entry, not the touch itself — pre-touch
   condition predicting post-entry result, not a restatement of either.
2. **Baseline**: per-minute-of-day baselines already exist and are reused
   (`getTouchQualityBaseline`/`getPaceBaseline`) — not a flat/mixed-session
   baseline.
3. **Sub-population selection**: this selects a subset of existing touches
   (fast-on-thin-volume ones) — needs a same-selection-minus-signal control,
   not just signal-vs-unconditional-baseline (matching the pilot_cvd_divergence
   3-way template convention, reused elsewhere this session).
4. **Largest-of-K**: cutoffs are swept (percentile choice) — `computeReplication()`
   required before trusting the selected cutoff, same discipline as the
   defended-level-retest sweep.

## No-lookahead

Same structure as the live `hivolLopace` computation — window strictly before
the touch/entry bar, outcome measured strictly after.

## Step 0 — cheapest screen first

Unlike the defended-level-retest idea (a multi-bar *completing sequence*,
which needed the signal anchored at its own completion bar), this is a
single-bar-window snapshot classification exactly like `hivolLopace` and the
already-tested `intrabar_cvd_divergence`/exhaustion signals — a direct
bar-level forward-return pretest is the right first step, anchored at the
touch bar itself (no completion-bar ambiguity here, unlike the last spec).
Both RTH and Globex, session-matched baselines, per the standing rule.

## Status — RESOLVED, closed without mining (2026-08-12)

DeepSeek's design critique (`scratch/deepseek_response.md`) caught a factual
error in this spec's central premise before any Gemini dispatch, and every
load-bearing claim in the critique was independently verified against the
actual files/code (not just trusted):

- **The "untested mirror" claim is false.** `scratch/gemini_velocity_round3_results.md`
  (2026-07-29, the same run that produced `hivolLopace`) already contains a
  full 2×2 cross-tab of `volZ` × `paceZ`. The air-pocket quadrant — `LO-VOL +
  HI-PACE ("Vacuum")` — is right there: N=519, WR=64.2%, EV=+5.36, but
  `clean=false, stable=false`. It was correctly excluded from that run's
  train/test replication step; only the `clean=true, stable=true` `HI-VOL +
  LO-PACE` cell (`hivolLopace` itself) was carried forward. Verified by
  reading the file directly — the table matches DeepSeek's transcription
  exactly.
- **The window is not strictly pre-touch**, contra this spec's confound #1.
  `acd.js` ~6858-6872 sets `_hlEntryBar` to the *last* row of the bars used
  for `_hlVolBars`/`_hlNetPace` — the touch/entry bar is inside the
  measurement window, not excluded from it. Verified by reading the code
  directly.
- **volZ/paceZ are positively correlated** (r=+0.341, N=5240, computed by
  DeepSeek from `scratch/velocity_round3_touches.json`) — so the Vacuum
  quadrant is a genuinely distinct, rarer-than-independence cell, not just
  `hivolLopace`'s logical negation. But both marginals (paceZ alone, volZ
  alone) are smooth and monotonically favorable in the same direction the
  Vacuum cell points, with no sign of a real interaction — the +5.36 reads as
  two favorable marginals coinciding, not a distinct thin-book-liquidity
  effect.

Re-deriving fresh percentile cutoffs for this quadrant (as originally
proposed above) would not have made it a new test — it would have been
another resweep of a cell that already failed `computeRigor()` once, the same
largest-of-K-effects trap this session's confound checklist exists to catch.
No Gemini mining was dispatched. The finding is folded into the existing
`hivol_lopace_precursor_confirmed_negative` `RESEARCH_CLAIM` (updated
2026-08-12 with a "MIRROR-CELL CHECK" section) rather than filed as a
separate claim, since it adds no new data — it's a closer reading of data
that already existed.

If this thread is picked up again, the only framing the existing data
supports is **reversion/exhaustion** ("fast approach into a level → the fade
does *better*, not worse") — the opposite of both framings this spec
originally proposed (fade-suppression predicted the level would fail; the
deferred continuation framing predicted price would blow through — both
wrong-signed against the observed +5.36 fade EV). A real next step, if
pursued, would test the two marginals directly or a pre-registered tercile
design with the `HI-PACE+HI-VOL` arm as a pace-matched thinness control
(isolating volume's effect while holding pace constant) — not another cut of
this one cell.
