# Rotation VBP → 24hr POC convergence — scope for a future session

**Status**: scoped, not built. Written 2026-08-23 at the end of the POC-migration thread (see
`docs/OPEN_THREADS.md`'s 2026-08-23 entries for the full arc this follows on from). Do not
re-derive the reversal algorithm below from scratch — it was already fully designed in
`scratch/deepseek_poc_realtick_convergence_design_review.md` §6, just gated behind the volume-bar
pilot at the time. This doc adapts that design to run on the 1-min-bar approximation first
(consistent with how the directional-rule question was resolved without needing real ticks —
see that thread's §5 reasoning), not the still-environment-blocked real-tick pipeline.

## What this is, and how it differs from what's already been tested

The user's real chart (a "Pinch Avg Rotation" indicator) builds a volume profile over the
**current rotation leg** only — not the whole session. A rotation resets every time price moves
`R≈60-65 index points` against the leg's running extreme; the new leg's start is retroactively
the prior extreme. This is a fixed-magnitude ZigZag/swing segmentation, fundamentally different
from the **whole-session-developing** profile already tested and rejected in the 2026-08-23
"directional setup" thread — that used bars from 9:30am onward, growing monotonically; this uses
only bars since the last swing pivot, resetting repeatedly through the day. **Neither this doc's
construction nor its outcome is answered by that prior negative result.**

The trigger, per the user's screenshot and description: the rotation leg's own volume profile POC
converges with the (separately computed, non-rotation) 24hr-inclusive profile → trade.

## Reuse verbatim — the reversal algorithm (already fully specified)

From `scratch/deepseek_poc_realtick_convergence_design_review.md` §6.1 — the direction-explicit
fixed-magnitude ZigZag, backward-looking/non-repainting when used correctly:

```
R = 65.0            # index points; user confirmed "60-65", use 65 as primary, 60 as sensitivity
anchor = None       # last CONFIRMED pivot (start of the current leg)
pivot_is_low = None # True -> anchor is a swing LOW, current leg is UP
                     # False -> anchor is a swing HIGH, current leg is DOWN
running_high = None
running_low  = None

for each price print (ts, price):      # chronological
    if anchor is None:
        anchor = running_high = running_low = price
        continue
    running_high = max(running_high, price)
    running_low  = min(running_low, price)

    if pivot_is_low is None:                       # bootstrap: first R move wins
        if (running_high - price) >= R:
            finalize_rotation(start=anchor, end=running_high)   # up-leg
            anchor = running_high; running_high = running_low = price
            pivot_is_low = False
        elif (price - running_low) >= R:
            finalize_rotation(start=anchor, end=running_low)    # down-leg
            anchor = running_low; running_high = running_low = price
            pivot_is_low = True
    elif pivot_is_low:                             # UP leg: only a high confirms
        if (running_high - price) >= R:
            finalize_rotation(start=anchor, end=running_high)
            anchor = running_high; running_high = running_low = price
            pivot_is_low = False
    else:                                          # DOWN leg: only a low confirms
        if (price - running_low) >= R:
            finalize_rotation(start=anchor, end=running_low)
            anchor = running_low; running_high = running_low = price
            pivot_is_low = True
```

**Critical repainting-safety rule** (§7.2 of the same review, non-negotiable): the *developing*
rotation profile used as the live trigger is `[anchor → now]`, using the current price as the
provisional endpoint — never the eventual confirmed `extreme`. The *completed* leg profile
(`[anchor → extreme]`) is hindsight-only, for description, never as a trigger. Two forbidden leaks
carried over from that review: don't use a completed leg's POC as a trigger before it confirmed;
don't backdate `anchor` to before the confirming print.

## Adaptation needed for the 1-min-bar approximation (not real ticks)

- Feed the reversal detector 1-min bar **highs and lows directly** (not synthetic sub-points) for
  the swing-pivot detection itself — swing/ZigZag detection is conventionally done on OHLC extremes,
  and this avoids the interpolation-artifact class of bug this thread already hit twice. The
  *volume profile within* each leg still needs the existing sub-point interpolation
  (`subPoints()` from `backtest_poc_volume_bar_convergence_pilot.mjs`) to build `entries` for
  `computeProfile`/`med50`.
- Use `med50` as the convergence statistic (never raw POC/argmax) — same fix as everywhere else in
  this thread, for the same reason (argmax teleport risk).
- Confirm with the user (open question, not yet answered): is the 24hr profile on their chart
  itself rotation-based, or the standard continuously-accumulating profile? User's own answer when
  asked was "probably tick data" — doesn't resolve whether it's rotation-segmented. Default
  assumption per the design review: **standard (non-rotation) 24hr-inclusive profile**, same
  construction already built and tested. Confirm before building — a rotation-based 24hr leg would
  be a materially different (and thinner-data) construction.

## Open design question this doc deliberately does NOT resolve

**What determines direction for a rotation-leg trigger?** The already-tested "both series migrating
the same way into a price-coincident meeting" rule doesn't obviously transfer — a rotation leg
already *has* an inherent direction (up-leg or down-leg) by construction, so the natural candidate
is simpler: down-leg converging → long (support), up-leg converging → short (resistance). But this
needs its own confound pass (is this just "which way is the leg going," a tautology given the leg's
own definition?) before building. **Run this through a fresh DeepSeek design-critique pass before
writing code** — do not assume the prior directional design transfers unchanged.

## Kill criteria, population, cost — not yet specified

Not scoped in this doc. The prior real-tick review (§6.4) flagged three reasons this is harder than
the volume-bar construction: (a) the repainting proof needs independent audit, (b) `R=65` is a free
parameter requiring pre-registration, (c) the 24hr-profile-construction ambiguity above. A proper
DeepSeek design pass (mirroring the two already done for this thread's other constructions) should
produce these before any Gemini dispatch — this doc is a scope, not a finished spec.

**Add explicit bars-to-resolution / time-to-target as a first-class reported stat, not an
afterthought.** The prior directional-setup test never measured this directly, but its indirect
evidence pointed the same way — the derived target landed at the widest candidate in the sweep grid
(`T=150`, `TARGET_SWEEP` max), and the structural stop's 2-consecutive-close requirement is itself
deliberately slow. Combined with the user's own observation that convergence "takes longer on some
days but still happens," any move this construction finds is unlikely to resolve quickly. A 65-point
rotation leg is a larger, slower structure by definition than a single-session convergence — track
and report the median/distribution of bars-to-target and bars-to-stop explicitly, and consider
whether the exit mechanism needs a minimum holding-time floor rather than treating every bar as
equally likely to resolve the trade.

## Where to pick this up

Next session: dispatch a Phase-0 design critique to DeepSeek covering (1) the direction-mapping
confound above, (2) kill criteria, (3) population/cost on the 1-min approximation, (4) explicit
confirmation of the 24hr-profile-construction assumption with the user first if not already
clarified. Then synthesize into a spec, get it reviewed, then dispatch to Gemini — same pattern
used successfully (after early mistakes) for every other construction in this thread.
