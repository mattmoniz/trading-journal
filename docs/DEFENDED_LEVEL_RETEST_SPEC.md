# Defended-Level Retest Spec (2026-08-12, scoping — not yet built)

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
*stalled* — specifically, a sequence of failed bounce attempts, each one sold
back down, before the final rollover:

```
10:50-51  first drop            delta -180, -79
10:52-53  bounce attempt        delta +118, +43   (tries to counter)
10:54     hits a wall           NEW LOW (29856 < 29863), delta -127  (counter fails)
10:55     drops further         new low 29848.50, third leg down
10:56-57  another bounce        delta +126, +118
10:58     stalls                tiny range, delta flips to -31  (bounce loses conviction)
10:59     rolls over            entry
```

**The actual signature is not "N quiet bars."** It's a sequence of failed
reclaim/bounce attempts against the level, where each subsequent push shows less
conviction than the last, until the bounces themselves stop and price reverses.
User explicitly declined to pin a fixed bar count ("not a hard number... really
about getting a solid feel for that moment a possible pivot") — the window
should be swept, not guessed.

## Known trap this design must avoid

`intrabar_cvd_divergence_no_edge_confounded` (2026-07-21, this codebase) tested a
similar-shaped idea — price making a new adverse extreme while delta is already
favorable — and found the "divergence" condition added almost nothing once
properly controlled: `CVD_DIVERGENCE` (N=2294, EV=-$32.20) vs
`EXTREME_NO_FAV_VOL` (N=2418, EV=-$23.93) — only -$8.27/trade of real marginal
contribution, because "price already made a new extreme" and "divergence
present" are structurally correlated by construction, not independent signals.

This spec's version must isolate "the pushes are getting weaker" from "price
is still moving toward extremes" as two *separate* measured quantities, not
conflate them the way the 2026-07-21 first-pass version did.

## Definition (first cut, to be refined in DeepSeek design critique)

At a level retest (touch on the direction-correct side, per existing logic):

1. Look back over a swept window (candidates: 4/6/8/10 bars — user's own guess
   was "6-7", treat as a hypothesis to check, not the answer) ending at the
   current bar.
2. Within that window, identify each local counter-move ("bounce attempt" for a
   short setup, "dip attempt" for a long one) — a run of bars moving away from
   the adverse extreme before reversing again toward it.
3. For each attempt, measure: (a) whether it made a new adverse extreme
   afterward (failed to hold), (b) the delta/volume magnitude of that attempt
   vs. the previous one (weakening or not).
4. The "defended" signal = multiple failed attempts (>=2, swept) with
   monotonically weakening counter-push delta, culminating in the most recent
   attempt failing to even reach the prior attempt's magnitude.
5. Symmetric for the opposite direction (long setups: failed sell-off attempts
   into support, weakening downside delta each time).

Bid/ask size (not just net delta) as a secondary check on the same attempts —
does resting size at the level visibly build as each attempt fails, distinct
from just the delta sign.

## No-lookahead

The signal at each candidate bar may only use bars strictly at-or-before that
bar. The window/attempt-detection logic walks forward through history exactly
as the live poller would see it, never referencing a future bar to decide
whether the current bar "was" a failed attempt.

## Step 0 — cheapest screen first (per CLAUDE.md's standing pretest rule)

No stops, no targets, no trade machinery. At every real level-retest touch in
`price_bars_primary` (using the actual live touch-detection logic, not a
reimplementation — the existing candidate-detection function, not a
new copy), measure raw forward price movement at several horizons (1/3/5/10/20
bars), conditional on the defended-signature being present vs. absent vs. the
unconditional mean over the same horizon. Both RTH and Globex, not RTH-only.

## Step 1 — full simulation, if Step 0 shows something

Three arms (reusing the `pilot_cvd_divergence.mjs` 3-way template, the
established pattern for this exact class of selection-bias problem):

- `NEVER_WAITED` — blind immediate entry on touch, today's baseline, resimulated
  fresh (not read from a stored column).
- `DEFENDED_CONFIRMED` — waited up to the window's end; entered only if the
  failed-attempt/weakening-delta signature completed.
- `WAITED_NO_SIGNATURE` — same touches, waited the same window, entered at
  window's end regardless of whether the signature appeared. This is
  simultaneously the blind-delay control (isolates whether the pattern itself
  matters vs. just entering late) and the same-selection control (isolates the
  pattern's real marginal contribution from which touches happened to survive
  to be eligible at all) — the two confounds this codebase has already been
  burned by once each (`engagement_confirmation_entry_timing`'s blind-delay
  trap, the overshoot-entry algebraic-advantage trap), controlled in one arm.

## Required reporting shape (per direct user instruction — not aggregate EV alone)

1. **Coverage cost**: of all `NEVER_WAITED`-eligible touches, what fraction does
   `DEFENDED_CONFIRMED` filter out entirely (signature never completes within
   the window)? Of *that filtered-out population specifically*, what would its
   win rate/EV have been under blind immediate entry? This is the real price of
   the filter — a number, not an afterthought.
2. **Precision gain**: `DEFENDED_CONFIRMED`'s WR/EV vs. `WAITED_NO_SIGNATURE`'s
   WR/EV (same selection, only the signature differs) — the honest measure of
   whether the pattern adds anything, isolated from delay/selection.
3. Distribution, not just mean, per this codebase's standing asymmetric-payoff
   convention — tail shape matters as much as the average.
4. If multiple window lengths are swept (item 1 of the definition), the
   selected window needs `computeReplication()` before being trusted — this is
   a K-way sweep by construction.

## Second-phase application (not part of this test — flag only)

If validated, this same "is this level actually being defended" signal is a
natural input to the level-cluster candidate-selection fix shipped 2026-08-12
(`nearLevels` fallback loop, `server/routes/acd.js`) — prefer a candidate
showing real defense over one just ranked by historical EV when multiple levels
are clustered. Deliberately out of scope for the first test — validating one
new signal and its live-selection application in the same pass would make a
negative result ambiguous (is the signal wrong, or the selection-integration
wrong). Revisit once Step 1 has a real, controlled result on its own.

## Status

Scoped, not built. Next: send this spec (not code) to DeepSeek for a design
critique before any mining begins, per this session's established workflow.
