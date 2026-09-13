# Climactic Acceleration Reversal — Spec (2026-09-10, Phase 1 only, NOT wired)

## Status at handoff
**Phase 1 (raw forward-return pre-test) complete and genuinely promising. Phase 2 (real stop/target simulation + placebo test) has NOT been built.** Nothing here is live, nothing is wired, no `server/services/` file exists for this yet. This is the single most promising unfinished thread from the 2026-09-10 session — read this whole doc before continuing it.

## How this thread started
After shipping two live SHADOW-only detectors this session (`MAJOR_PIVOT_DEFENDED_BREAK_LONG/SHORT` and `STALL_DEFENDED_LEVEL_LONG/SHORT` — see `CLAUDE.md`'s pivot-thread entry for their own full history), the user asked a direct, simple question: **"how many 300-400+ point moves were not caught by these 4 setups?"**

### The miss-rate measurement
Scanned the full dataset (2025-09-01 onward) for real point-magnitude ZigZag legs (fixed 300pt/400pt thresholds, NOT ATR-relative — a deliberate departure from every other threshold in this codebase, because the question was about a fixed move size, not a relative one), then cross-referenced each leg's start time/direction against every historical signal both detectors would have fired (majors: full `reports/major_pivot_defended_break_events_20260910.csv`, threshold=1.5x, streak>=1; stall: full `reports/stall_defended_level_phase1_events_20260910_rth.csv`, RTH-only, corrected quiet threshold).

**Critical methodology point**: an unbounded scan (no duration cap) is misleading — it counts multi-day/multi-week trend legs (e.g., a 1221pt move over 12 days) as the same kind of "move" as a fast, hours-long flush, which they clearly are not. Duration-bounded results are the ones that matter:

| Move size | Duration cap | N | Caught | Missed |
|---|---|---|---|---|
| ≥300pt | ≤8h | 111 | 12 (10.8%) | 99 (89.2%) |
| ≥400pt | ≤8h | 58 | 6 (10.3%) | 52 (89.7%) |
| ≥300pt | ≤24h | 190 | 24 (12.6%) | 166 (87.4%) |
| ≥400pt | ≤24h | 117 | 15 (12.8%) | 102 (87.2%) |

**Consistent ~87-90% miss rate across every cut.** Both shipped detectors are real, validated, positive-EV setups on their own narrow trigger populations — but that population is a small slice of market behavior (a defended pivot's break; a quiet RTH stall near a level), not a general "catch the big move" system.

## Digging into the missed population — two real methodology corrections happened here, both important to not repeat

### Correction 1: "continuation vs reversal" via the immediately-prior ZigZag leg is a TAUTOLOGY, not a finding
First attempt: for each missed move, checked whether its direction matched the immediately-preceding accepted ZigZag leg's direction ("continuation") or opposed it ("reversal"). Result: 98/99 (99%) "reversal." **This was reported to the user, verbally, as "99% continuation" — a direct misreading of the output, caught and corrected in the same conversation.** But the deeper problem is the check itself is broken: **consecutive accepted ZigZag legs ALWAYS alternate direction by construction** (a LOW pivot's leg necessarily goes up to the next HIGH, then down to the next LOW — that's what makes it a zigzag). So "does this leg match the immediately-prior leg's direction" is trivially going to say "no" (reversal) almost every time, regardless of any real market behavior. This is the exact same shape as the already-documented "target set to its own population's median" tautology (`CLAUDE.md`'s Conventions section) — a self-referential comparison that produces a numeric-looking result which measures nothing. **Standing lesson, now added to `CLAUDE.md` Conventions: never compare a ZigZag leg's direction against its own immediately-adjacent leg to ask "continuation or reversal" — compare against an independent measure of the prevailing trend instead (net price change over a real time window, a moving average, etc.).**

### Correction 2 (the real, valid check): compare against the net price change over the preceding 24 hours instead
Fixed version: for each missed move, compute the net price change from 24h before the move's start to the move's start (an independent, non-tautological measure of "what was the market already doing"). If the move's direction opposes that net 24h direction, it's a genuine reversal; if it agrees, genuine continuation.

**Result (N=166, the ≤24h/≥300pt missed population): continuation=17, reversal=146, flat/no-trend=3 → 89.6% of missed moves genuinely REVERSE the prevailing 24h trend.** This is real — it survived the correction.

### Does a stall (quiet pause) precede these reversals?
No. Checked whether the exact live stall condition (4 consecutive 5-min bars, tight range vs a representative ~0.06x ATR cutoff) fires anywhere in the 2 hours before each reversal's start. **Only 32/146 (21.9%) show one.** The vast majority of these reversals do NOT pause before turning — ruling out "reuse the stall trigger, just drop the prior-defense/confluence requirements" as a fix.

### Does the prior trend show gradual exhaustion (deceleration) before it turns?
No — the opposite. Compared the pace (points/hour) of the FINAL 4 hours of the prior trend leg against the pace of the whole leg. **127/136 (93.4%) show the final 4h moving FASTER than the leg's own average pace (median 3.41x, p75=6.07x).** This is a climactic acceleration/blow-off pattern, not gradual exhaustion — price capitulates hard in the ORIGINAL direction right before it snaps the other way.

**This independently confirms an already-separately-validated finding from earlier in the same session**: `docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md`'s "momentum feeds momentum beats the coiled-spring intuition." Two independent tests, on different populations, both point the same direction: acceleration (not stillness or gradual slowdown) precedes a big move.

## The trigger design (Phase 1, tested)

**Live-computable, no lookahead**: is the price move over the trailing `ACCEL_WINDOW_MIN` (240min = 48 5-min bars) unusually large as a fraction of that day's ATR20, RIGHT NOW? If so, bet on a REVERSAL of that direction (fade it).

**Threshold is data-derived, not guessed**: computed the real distribution of |trailing 240min move| / ATR20 across every bar in the full dataset — p50=0.190, p75=0.370, **p90=0.622** (used as the "climactic" cutoff), p95=0.832. Debounced at `ACCEL_BARS` (48 bars) so a single extended climactic leg doesn't fire repeatedly.

### Phase 1 results — pooled is misleading, RTH and Globex are OPPOSITE
Pooled (N=330, direction-adjusted fade return): mean at +240min = +0.63 but **median = -7.25** (a large mean/median divergence — the outlier-driven-mean red flag this codebase watches for) and pos%=47.9% (below coin-flip). **Fading blind, pooled, does not work.**

Split by session, it's not noise — it's a real, opposite-signed split:

| Horizon | RTH mean (fade) | Globex mean (fade) |
|---|---|---|
| +30min | -7.87 | +1.57 |
| +60min | -9.17 | +2.77 |
| +120min | -3.82 | +4.93 |
| +240min | -2.71 | **+5.90** |

**RTH: fading a climactic acceleration is actively bad at every horizon tested — do not build this for RTH.** **Globex: a real, monotonically growing edge (not flat, not noisy up-and-down) — the shape of a genuine effect, not noise.** Population overall is clean: 330 events, 200 distinct dates, top-5-day concentration only 5.8% (not clustering-driven).

### Globex-only follow-up (N=155)
- **Extended horizons**: +240min=$10.96, +480min=$26.86, **+720min=$6.68 (dips)**, +960min=$19.74. Noisier and non-monotonic past 240min — do NOT assume "longer is always better" here the way it was for the majors' RTH config; this needs Phase 2's own target/hold grid to find the real sweet spot, not an extrapolation from this raw-return check.
- **Chronological stability (fwd240)**: halves close and both positive (9.71 / 12.19) — genuinely stable at the 2-way level. Thirds show the familiar "weak early, strong late" shape already seen elsewhere this session (-0.93 / 4.30 / 29.28) — not a clean flat line, but no real negative dip (Third 1 is barely negative, not a red flag on its own).
- **Capture check — the headline number**: of real Globex moves ≥300pt completing within 24h (N=69), **this signal caught 37 (53.6%)** — a same-direction fade signal fired within 24h before, or up to 1h into, the move's start. Compare this to the ~10-13% catch rate of the two shipped detectors combined. **This is the most promising single number from the entire session** — it's the first idea that actually addresses "catch a meaningfully larger share of the big moves," not just another narrow, situational trigger.

## What's NOT done yet — this is the actual scope of Phase 2
1. **Real stop/target bar-by-bar simulation.** Everything above is raw forward point movement — no stop, no target, no realistic exit. This is exactly the same checklist gap every other idea this session had to clear before being trusted (`CLAUDE.md`'s "New setup type checklist," item 5).
2. **Placebo test.** This design is a directional bet (fade) on a selected sub-population — needs the same randomized-direction placebo control used for every other finding today, especially given the mean/median divergence already seen in the pooled (non-Globex-filtered) version. Do not skip this just because the Globex-only cut looks clean; the confound checklist (`CLAUDE.md` Conventions) still applies.
3. **A real target/hold grid**, since the raw-return check already showed non-monotonic behavior past 240min (the 720min dip) — needs the same kind of grid sweep used for the majors and the stall detector, not a single assumed hold time.
4. **Threshold sensitivity on the p90 cutoff itself** — only one percentile (p90) was tested. Given how well the majors' threshold-sensitivity check (5 points, all positive) strengthened confidence there, the same kind of sweep (p80/p85/p90/p92/p95) should be run here before trusting p90 specifically.
5. **Day-clustering re-check on the Globex-only N=155/N=69 populations specifically** (not just the pooled N=330) — not done yet.
6. Only after all of the above: the standard new-setup-type checklist (`CLAUDE.md`), N≥20 floor (already comfortably cleared, N=155), SHADOW-only wiring.

## DeepSeek design review, 2026-09-10 — substantially tempers the headline numbers above, read before touching this again

Requested review found the code itself sound (both live detectors: no lookahead, no unit mismatches, correct stop/target sign math, correct `ON CONFLICT`/`dropToTimeline` usage — separate from the real timezone bug it also caught, see `CLAUDE.md`'s naive-timestamp Convention entry). But the **design critique meaningfully downgrades confidence in this idea's headline results** — treat the "35/35 cells" and "53.6% catch rate" numbers above as evidence of a real *direction*, not as a validated, ready-to-wire finding:

1. **The chosen cell's EV is not target-driven.** At the "best practical" cell (1.0x ATR / 240min): target-hit = **3.0%**, stop = 72.7%, time-exit = 24.2%. The strategy is really "hold 240min behind a wide structural stop" — profit lives almost entirely in the time-exits, the least robust exit type and the most sensitive to the exact hold cutoff chosen.
2. **The hold-time surface is non-monotonic in a way that looks like overfitting, not signal.** At target=1.0x: $12.43 (120m) → $26.40 (240m) → $23.85 (360m) → $16.10 (480m) → **$8.46 (600m)** → $21.96 (720m) → $31.60 (960m). A genuine effect should not fall to a third of its value then nearly quadruple. The chosen cell sits in a jagged neighborhood, not a smooth plateau.
3. **Winner's curse.** The chosen cell is the max of a 7×5=35-cell grid (correlated estimates), no holdout, no multiple-comparison correction. Mean/median divergence and day-clustering were re-checked on the pooled Phase 1 population and on Phase 1's raw-return numbers — but **never on the exact N=132 Phase 2 stop/target-simulated population at the winning cell itself**, which is exactly where a heavy tail (89% stop rate + rare large time-exit winners) would show up.
4. **The 53.6% "catch rate" is very likely a matching artifact, not a tradeable capture rate — this is the single most important correction.** "Caught" was defined as "a same-direction signal fired anywhere in the 24h before, or up to 1h into, the move's start." But the base strategy stops out 67-89% of the time and resolves within 120-960min — so a signal can count as "catching" a move while the position it would have opened was **already stopped out hours before the move even began**. "53.6% caught" and "67-89% stopped out" are simultaneously true and were never reconciled. The real, tradeable question — "of the big moves, how many did a still-open, correctly-directioned position actually survive to capture" — was never asked. Until it is, do not repeat the 53.6% number as if it describes real capture.
5. **The placebo only proves "fade beats random direction," not "fade beats a simple momentum-follow rule."** Several placebo cell-averages are themselves positive ($14.10, $15.30, $17.32 at various cells) — the underlying population carries its own drift/geometry that the fade direction merely beats, which is a weaker claim than "this is a real, standalone edge."

**The single most important next step (not yet done)**: re-run the Phase 2 Globex grid — no new detector, no wiring — and report, for the existing N=132 population: (a) median trade P&L and the top-5-trade share of total EV (is this a few huge trades carrying the whole result?), (b) distinct-trading-day count plus a day-clustered/day-block bootstrap significance test, and (c) a chronological half-split specifically at the chosen cell (1.0x ATR/240min) — not just on the raw Phase 1 return. If 1.0x/240m still shows a positive median, both halves positive, and isn't dominated by a handful of trades/days, it's a genuine SHADOW candidate. Pair this with the p80/p85/p90/p92/p95 threshold-sensitivity sweep (already scoped below) since it's nearly free on the same data — build one script (`scratch/climactic_acceleration_reversal_phase2_robustness.mjs`) that does both, before any further work on this idea.

**Also flagged, cheap to fix**: (a) retire the RTH arm as a formally recorded negative (`RESEARCH_CLAIM` or `KNOWN_ISSUES`), not just a passive "do not build," so it doesn't get re-proposed; (b) the "adds" scope's own Phase 0 metric (see `docs/CLIMACTIC_ACCEL_REVERSAL_ADDS_SCOPE.md`) has a related, real flaw — see that doc's own update.

## Concrete next-session starting point
Reuse `scratch/climactic_acceleration_reversal_phase1.mjs` (the original scan + p90 derivation) and `scratch/` script pattern already established today (see `stall_defended_level_phase2.mjs` for the exact WITH_STOP/placebo/target-grid template to copy) — build the Globex-only Phase 2 grid (target ATR-multiples x hold times, real stop from a sensible structural reference — the trailing-window's own extreme is a reasonable starting candidate, matching how the stall detector's stop was defined), with a 10-trial placebo per cell, before doing anything else with this idea. Do NOT build the RTH version at all — that arm is confirmed negative.

## RESOLVED NEGATIVE, 2026-09-10 — the robustness check above was run and failed

`scratch/climactic_acceleration_reversal_phase2_robustness.mjs` ran the exact checks the review above asked for, at the chosen 1.0x ATR/240min Globex cell (N=132, same population as Phase 2):
- **Top-5-trade share confirmed the winner's-curse concern directly**: the top 5 trades sum to $3683.50 = **107.1% of total EV** — the other 127 trades net to a small aggregate loss. Median EV=$23.00 vs. mean $26.06 (close, so not a skew-of-the-median issue — the concentration is specifically in the extreme tail).
- **Day-blocked bootstrap 95% CI on the real mean: [-$27.88, $76.57] — does NOT exclude zero.** Fails the same strict standard (`CI excludes zero AND excludes the full placebo range`) that MAJOR_PIVOT_DEFENDED_BREAK's Globex regrid was held to (which also failed, 0/64 cells, and was ultimately abandoned per data-availability limits — see `CLAUDE.md`'s "Where to look" entry for that thread).
- Chronological half-split was fine (first half N=64 mean $29.69, second half N=68 mean $22.65, both positive) and the p80/p85/p90/p92/p95 threshold-sensitivity sweep beat a 30-trial placebo average at every percentile (deltas $27-$91) — but neither of these checks rescues a bootstrap CI that includes zero at N=132. "Beats a noisy placebo average" and "the real mean is statistically distinguishable from zero/noise" are different claims, and only the second one matters at this sample size.

**Combined with the already-confirmed RTH negative and the original review's "53.6% catch rate is likely a matching artifact" finding, this closes the climactic-acceleration-reversal idea as a full negative across both sessions.** `RESEARCH_CLAIM climactic_accel_reversal_globex_resolved_negative_20260910`, CONFIRMED. `OPEN_DECISION climactic_acceleration_reversal_phase2_needed_20260910` is RESOLVED. No detector was ever built or wired for this idea (backtest-only throughout) — nothing to pull or suppress. The "adds"/pyramiding scaling-in extension (`docs/CLIMACTIC_ACCEL_REVERSAL_ADDS_SCOPE.md`) is now moot given this result and should not be pursued.
