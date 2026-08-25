# Touch-Quality Signal Ideas — DeepSeek Brainstorm (2026-08-25)

**Status: NOT YET BUILT, NOT YET TESTED.** This document records 6 candidate research ideas
proposed by DeepSeek in response to a direct design-brainstorm request, plus the full
context that produced the request. Nothing here has been run against real data. Per this
codebase's standing rule ("no dead ends" — CLAUDE.md), this doc is the persisted,
discoverable record of the idea until someone picks one up and tests it; see
`docs/OPEN_THREADS.md`'s 2026-08-25 entry and `OPEN_DECISION touch_quality_ideas_pending_test`
for the live pointer back to this file.

---

## 1. Context — why this was asked

This came at the end of a very long 2026-08-25 session that started from one user
complaint: **"we're picking good spots but keep getting stopped out."** Over the course of
the day, several concrete hypotheses were tested with real rigor (independent re-runs,
bug-hunting, retraction where warranted):

1. **PD_VAH/PD_VAL value-area session-window definition** (RTH-only vs. Sierra Chart's
   full-24hr-session definition) — tested, real negative, no edge either way.
2. **OR-family pooled stop-widening** — tested, real negative. A wider, pooled-calibrated
   stop recovered zero of 17 real historical stopped-out trades into winners.
3. **`keepLevelsAll` had zero overnight coverage for 25 levels** (a real structural bug,
   not a calibration issue) — found and FIXED. 29 weekly/monthly/quarterly/yearly levels
   now get real overnight touch detection via `detectGlobexSetup()`.
4. **The same detector's dedup fired at most once per level per night, no re-arm** — found
   and FIXED (re-arm now allowed once the prior row resolves AND took long enough to be a
   real trade, not chop).
5. **Next-bar directional confirmation before entering a fade** — built and tested properly
   (a 3-arm design isolating "is the confirmed subset just better trades" from "does
   waiting cost you"). Real result: the SIGNAL was genuine and substantial (+$21.83 to
   +$41.35/trade selection value, positive in every one of 5 structural level-groups), but
   the cost of waiting one bar to observe it was always larger (-$32.93 to -$56.96/trade).
   Net effect negative everywhere. **Not implemented** — `RESEARCH_CLAIM
   globex_level_confirm_entry_signal_real_delay_too_costly`.
6. **Decisive-breakout-then-fade-the-reversal** ("sweep reversal") — initially found a
   striking positive (N=1089, +$41,022 total, a clean dose-response by breakout size), shipped
   live as a SHADOW-only mechanism plus a Home Assistant watch card. **Retracted the same
   session**: the underlying price history had a real data bug (56,566 timestamps in raw
   `price_bars` where two different futures contracts both have a row — a naive dedup
   picked an arbitrary one, manufacturing fake ~800pt price jumps). Re-run against the
   correct, already-existing `price_bars_primary` view: the finding completely reverses to
   a net loss (-$7,672, N=911). `RESEARCH_CLAIM globex_sweep_reversal_retraction_data_bug`.
   The live SHADOW code was fixed to use the correct data source and left running (zero
   capital risk), but the premise it was built on does not hold.

**The common thread across every one of these**, positive and negative: *don't just react
to "price touched a known level" — find a quality signal that separates the touches about
to work from the touches that aren't, using only information available at or before the
moment of decision.* Idea #5 (confirmation) and idea #6 (breakout decisiveness) were both
attempts at this filter; #5 failed because the observation cost exceeded the signal's
value, #6 failed for an unrelated data-integrity reason (the underlying signal was never
cleanly tested against real data).

The user then asked, explicitly: **"run the idea off of DeepSeek and see if it can come up
[with a] similar adjacent idea that comes from the same frame of mind."** This document is
the direct output of that request.

---

## 2. The exact request sent to DeepSeek

Dispatched via `scripts/invoke_deepseek.sh` (design-critique/brainstorm channel, no DB
access) with the following framing — reproduced here in full since the user asked for
"intent as stated":

> This is a trading journal for MNQ futures ($2/pt, $2 RT commission). Today's whole
> session started from one complaint: "we're picking good spots but keep getting stopped
> out." Every real idea tested today was actually the same underlying move, applied a few
> different ways: **don't just react to "price touched a known level" — find a QUALITY
> SIGNAL that separates the touches that are about to work from the touches that aren't,
> using only information available at or before the moment of decision.**
>
> [... the same 3 numbered summaries as items 5-6 above plus the entry-proximity idea,
> abbreviated here — full original text in the session transcript / this file's git
> history if needed ...]
>
> **What I want from you:** Not a review of the above — brainstorm GENUINELY NEW, ADJACENT
> ideas that come from this same frame of mind but that weren't tried today. Think about
> what OTHER kinds of "is this touch real or noise" signals might exist that: (a) don't
> require waiting for a future bar to reveal themselves, (b) are derivable from real,
> already-available data in a trading journal like this one — volume/order-flow at the
> touch bar itself, how the level was approached, time-of-night/session context, recent
> volatility regime, whether multiple levels are clustering at the same price
> (confluence), the shape of the immediately PRIOR bars, etc., (c) are things a
> discretionary trader might intuitively "feel" looking at a chart, turned into something
> measurable without lookahead. Give me 4-6 concrete, testable ideas, each with: what it
> is, why it fits this exact frame, and what a first cheap sanity-check would look like.

---

## 3. What DeepSeek actually did before answering (real codebase exploration, not guessing)

DeepSeek's own working trace (preserved in full at
`/tmp/deepseek_clean.txt` as of this write — copy into `scratch/` if that path is gone by
the time this is read) shows genuine exploration, not a cold guess:

- Read the real schema (`CREATE TABLE`, `price_bars_primary`, `level_prices`).
- Grepped for prior art on delta-intensity, confluence, volatility regime, touch-freshness,
  approach-shape, and absorption-vs-initiative BEFORE proposing anything, specifically to
  avoid re-treading already-tested ground.
- Read `docs/OPEN_THREADS.md`, `docs/CANDLE_ORDERFLOW_RESEARCH_SPEC.md`,
  `docs/Strategy_Playbook_Ideas.md`, and `server/services/touchQuality.js` directly.
- Explicitly ruled out ideas that overlap with already-failed research (candle-shape
  variants — 6 failed; delta-sign variants — 5-for-5 failed; raw touch-bar volume
  magnitude — confirmed no signal; cross-instrument confirmation — checked, no second
  usable instrument exists in `price_bars_primary`, only the documented ES-contamination
  window).
- Found and correctly cited a REAL, already-live, already-validated sizing factor
  (`server/routes/acd.js` lines 7674-7675: "Revisit latency: untouched liquidity on first
  visit; picked-off zone on 3hr+ return" — 78% WR +$71 EV z=+2.74 N=283 for first visit,
  60% WR -$35 EV z=-2.74 N=129 for 3hr+ stale) — **Claude independently verified this exact
  text and these exact numbers exist verbatim in the live file before trusting anything
  else in the response.**

This is why the 6 ideas below are trusted enough to record formally rather than discarded
as unverified model output — the load-bearing factual claims were spot-checked and
confirmed real, matching this codebase's standing "audit all model output" discipline.

---

## 4. The 6 ideas, in full (DeepSeek's own text, lightly reformatted for this doc)

**Ground rule DeepSeek held every idea to**: the feature must be computable from bars
strictly ≤ the touch bar, because this codebase's entry convention is the touch bar's own
close (`entryPrice = b.close`, confirmed in `acd.js`). Anything needing bar t+1 is exactly
the failure mode that killed idea #5 above.

### Idea 1 — Volatility-normalized proximity (re-test of today's failed idea, in the right units)

**What it is.** Today's entry-distance test bucketed distance-to-level in raw points
(0.75pt vs 15.0pt) and found no clean separation. But the touch window is a hardcoded 15pt
constant while the night's median bar range varies 2-3x across regimes — "12pt away" is
~1.5 bar-ranges on a fast night and ~5 bar-ranges on a quiet night, two different trades
pooled into the same bucket. Re-express as `d_norm = |entry − level| / trailingMedianBarRange`
(trailing 30 bars, strictly before the touch), or divide by the GARCH forecast vol this
codebase already has and has validated on stop width.

**Why it fits the frame.** Same information already available at decision time, zero
waiting — just a re-parameterization. Captures what a discretionary trader means by
"basically at the level" vs. "a mile away," a judgment made relative to current bar size,
never in absolute points.

**Why it's plausibly the reason idea failed today.** With N=10-14/bucket, mixing a 3x
denominator swing into the numerator is more than enough to wash out a real monotone
effect. Cheapest possible explanation of a null result, testable without new data.

**Cheap sanity check.** On existing resolved fades, compute `d_norm`, bucket by quartiles
(not fine thresholds — this codebase's own data-resolution rule), compare EV. Then the
decisive diagnostic: cross-tab raw-point bucket × volatility tercile. If the raw-point
effect is present *within* vol terciles but absent pooled, that confirms the confound. Kill
criterion: no monotone ordering across `d_norm` quartiles AND no interaction in the
cross-tab.

**Trap to avoid.** Median range must come from bars strictly before the touch (rolling),
never from the whole night — the night's full range includes the outcome.

### Idea 2 — Level liquidity depletion (the mechanism behind the already-confirmed revisit-latency effect)

**What it is.** Revisit latency is one of this system's strongest confirmed pre-decision
effects (first visit +$71 EV z=+2.74 N=283; 3hr+ stale return −$35 EV z=−2.74 N=129,
verified real, `acd.js` ~line 7674). But time is a proxy — the causal story in the code
comment is "untouched liquidity vs. picked-off zone." Measure the actual thing: volume
already transacted within ±X points of the level, from session start to the bar before the
touch, normalized by session-volume-to-date. Secondary feature: count of prior bars that
closed inside that band.

**Why it fits the frame.** Pure history at decision time, no waiting. Distinguishes "one
quick 2-minute poke" from "40 minutes of grinding acceptance," which the time metric alone
scores identically.

**Honest overlap disclosure (DeepSeek's own).** `docs/CANDLE_ORDERFLOW_RESEARCH_SPEC.md`'s
pending item (`level_agnostic_absorption_multisession_research`-adjacent) proposes
level-anchored volume-node-vs-gap via `developingValueService.computeProfile()`. This is
NOT that — node-vs-gap is a static structural classification of the price; this is a
depletion counter over the session (the same level scores differently at 9pm vs. 2am).
Worth building on the same `computeProfile()` machinery though, which makes it cheap.

**Cheap sanity check.** Bucket touches by normalized-depleted-volume quartile → EV. Then
the decisive test: 2×2 cross-tab against revisit latency (first-visit/stale ×
low/high-depletion) plus a plain correlation between the two features. If `|r| > 0.8` with
revisit latency and it adds nothing in the cross-tab, it's the same signal wearing a
different hat — kill it, keep the cheaper existing feature.

### Idea 3 — Signed structural runway (what's behind your stop vs. in front of your target)

**What it is.** Two features, both derived purely from `level_prices` + the setup's own
`OPTIMAL_STOP` distance, no bar data at all: `adverseRunway` = distance from entry to the
nearest opposing level in the stop direction; `favorableRunway` = distance to the first
level in the target direction — both in median-bar-range units. Hypothesis: a stop parked
just past a level-cluster is a magnet (ordinary sweeps reach it); a target with a level a
few points in front of it structurally can't be reached.

**Why it fits the frame.** Known before the touch even happens — levels are precomputed
the night before by `compute_levels.js`. This is the discretionary trader's "there's
nothing in the way" / "my stop is right under that pivot, they'll run it."

**Why this dodges the confound that killed a past, similar idea.**
`docs/STOP_PLACEMENT_LEVEL_CLUSTERING_SPEC.md` was deprioritized 2026-08-20 because its
Phase 1 had to *swap* to a "clear runway" candidate, which is by construction a lower-EV
level — leaving irreducible ambiguity between "stop placement matters" and "the lower-EV
pick got lucky." This framing never changes selection: identical fired population, purely
a tag on it, EV compared within-`setup_type`. No alternative candidate, no ambiguity.
That's the whole reason DeepSeek thinks this is worth reviving.

**Cheap sanity check.** Tag existing resolved fades; compare EV for high vs. low
`adverseRunway`, and target-blocked vs. target-clear. Then permutation-test it (5,000
draws, shuffled level sets) — this codebase's own standing rule from
`globex_large_moves_start_near_pit_safe_levels` (a real, already-confirmed `RESEARCH_CLAIM`
in this codebase, verified) is that any "near a level" claim needs a permutation test, not
a single placebo draw, because level density alone manufactures apparent effects. Bar to
clear: the spec's own deprioritization logic says a marginal effect (~one commission-and-
slippage round-trip, i.e. ≲$4-5/trade) isn't worth shipping.

### Idea 4 — Approach path geometry (drive vs. rotation, volume- and volatility-free)

**What it is.** Over the k bars strictly before the touch (k ≈ 5, 10, 20):
`efficiency = |close_touch − close_{t−k}| / Σ|close-to-close moves|` (net displacement ÷
path length), plus overlap ratio (mean range overlap of consecutive bars) and direction
changes. High efficiency + low overlap = a one-way drive arriving with momentum → the
level likely breaks. Low efficiency + high overlap = rotation/balance → the fade holds.

**Why it fits the frame.** Bars before the touch only. Expresses "steady drift vs. sudden
spike into it" as a dimensionless shape ratio — different from everything already tried:
`paceZ` measures magnitude of net movement, `approachDelta` measures sign of order flow
(the already-failed 5-for-5 delta-sign family), candle patterns measure single-bar shape
(6 already-failed variants). Path efficiency is scale-free, volume-free, and vol-free — a
chop-heavy 30pt approach and a clean 30pt approach score identically on `paceZ` and
oppositely here.

**Cheap sanity check.** Efficiency quartiles → EV, pooled across level families first
(never all ~60 setup_types at once — the multiple-comparisons surface this codebase's own
classifier-validation rule warns about). Then the redundancy check, in the style of
`scripts/pretest_wider_target_speed_and_participation.mjs` (a real, existing script):
correlate efficiency against `paceZ` and against `barsToT1`. Kill if `|r| > 0.7` with
`paceZ` (it's just pace again) or if quartile EV ordering is flat.

### Idea 5 — Tonight's fade-friendliness, measured from ALL touches, not just fired trades

**What it is.** The existing streak factor (`lfConsecWins`/`lfConsecLosses`, confirmed real
in `acd.js` ~line 6027-6033) uses only fired setups' win/loss — thin, and selection-biased
toward whatever the engine chose to fire. Instead, at the moment of the touch, compute the
hold rate of every level touch that already occurred this session — mechanically from bars
+ `level_prices`, whether or not anything fired: for each earlier touch, did price revert
k×medianRange before continuing X×medianRange through? Typically 5-15 observations per
night, all strictly prior, answering "is tonight a rotation night or a trend night" using
the market's own behavior at levels, not a regime label.

**Why it fits the frame.** Strictly backward-looking, and the single most common
discretionary read there is: "levels are holding beautifully tonight" vs. "everything's
getting run — stand down." Notably the one idea here that could explain CLUSTERS of
stop-outs rather than individual ones — closest fit to the session's original complaint.

**Cheap sanity check.** Bucket the current touch's EV by prior-hold-rate tercile (N≥20/
bucket). Two mandatory controls: (a) cross-tab against `day_type` and NL30 bucket — if
it's just re-encoding "TREND day," it adds nothing over features already live; (b) because
this is a newly-invented classifier, this codebase's own hard rule applies —
sensitivity-test the k/X/revert-window cutoffs and show independent predictive power
before trusting any EV split it produces (the rule exists because 3 EV splits passed rigor
once and all 3 classifiers behind them later failed independent validation).

### Idea 6 — Touch-in-expansion vs. touch-in-rotation (new-session-extreme context)

**What it is.** At touch time, two cheap facts: is the touch bar printing a new session
extreme (or within k bars of one), and what fraction of the session's range so far was
made in the last 30 minutes? Fading a level while the market is making new session
extremes is fading an expansion; fading the same level inside an established range is
fading a rotation.

**Why it fits the frame.** Session high/low to date is pure history. The "is the market in
balance or going somewhere" glance that precedes every discretionary fade decision.

**The crux control, where this idea lives or dies.** Several level families are
definitionally at extremes (`OR_HIGH`, `ONH`, `PD_HIGH`, `PM_HIGH`, etc.), so a naive test
would just rediscover "level type" as "new extreme." The test must either compare within
`setup_type` or restrict to levels that aren't structurally extremes (`*_POC`, `*_MID`,
VWAP family, floor pivots, camarilla interior). Cheap check: within-setup_type EV for
extreme-coincident vs. range-interior touches, then the range-velocity feature as a
continuous quartile split. Kill if the effect vanishes once conditioned on `setup_type`.

---

## 5. Cross-cutting notes (DeepSeek's own, verbatim in substance)

- **Build one feature-extraction pass, not six scripts.** Every idea above is a scalar
  computed at the same instant on the same population. One pass over the corrected fade
  population that emits all ~10 features per touch to a single table/CSV drops the
  marginal cost of testing idea #7 through #15 to nearly zero, and lets redundancy between
  candidates be checked directly. DeepSeek's stated prior: #1 and #4 partly overlap, #2
  overlaps revisit latency, #5 overlaps `day_type`. That correlation matrix is arguably the
  single highest-value artifact from doing this work at all.
- **Pre-register, because the comparison surface is enormous.** 10 features × 5
  level-groups × 2 directions is ~100 cells — something will look great by luck. Pool
  first, split only after a pooled effect appears, and run `computeReplication()` on
  anything selected as "best of K."
- **The bar to clear is $4-5/trade, not $0.** $2/pt with $2 RT commission plus slippage
  means a $3/trade "edge" is noise you pay for. This matches the reasoning that already
  deprioritized the stop-placement-clustering spec once.
- **Population hygiene** (this exact question has been bitten by this twice already):
  `origin_status IN ('ACTIVE','SHADOW')`, dynamic-exit columns NULL, and be aware
  `VWAP_MAGNET`/`GLOBEX_VWAP_MAGNET` BACKFILL rows carry a real, already-documented 4-5h
  `fired_at` corruption (confirmed in `docs/VWAP_MAGNET_BACKFILL_REPAIR_SPEC.md` per
  CLAUDE.md's own "Where to look" section) — report population size honestly rather than
  reaching for BACKFILL N to pad it.

**Ideas DeepSeek deliberately did NOT propose, and why**: anything needing bar t+1 (today's
own lesson from idea #5 above); delta-sign variants (5-for-5 already failed in this
codebase); candle/single-bar shape (6 already failed); raw volume magnitude at the touch
bar (already confirmed no signal); cross-instrument confirmation (checked directly — the
only non-NQ data in `price_bars_primary` is the documented ES-contamination window,
2023-11-16 to 2023-12-14, not a usable second series).

---

## 6. Claude's audit of this response before recording it

Per this codebase's standing "audit all model output before acting on it" rule (applies to
DeepSeek exactly as it does to Gemini), the following specific, checkable claims were
independently verified directly against the live codebase before this document was
written:

| Claim | Verified? |
|---|---|
| `lfConsecWins`/`lfConsecLosses` exist in `acd.js`, as described | ✅ confirmed, exact match (~line 6027-6033) |
| Revisit-latency numbers ("+$71 EV z=+2.74 N=283", "-$35 EV z=-2.74 N=129") | ✅ confirmed VERBATIM in `acd.js` line 7674-7675 |
| `docs/STOP_PLACEMENT_LEVEL_CLUSTERING_SPEC.md` exists | ✅ confirmed |
| `scripts/pretest_wider_target_speed_and_participation.mjs` exists | ✅ confirmed |
| `patch.cjs` (cited as the source for the touch-bar-close entry convention) | ✅ confirmed exists at repo root |
| `globex_large_moves_start_near_pit_safe_levels` is a real, confirmed `RESEARCH_CLAIM` | ✅ confirmed, matches this codebase's own documented finding |

No fabricated claims found. This is a well-grounded response, not a plausible-sounding
guess — DeepSeek did real exploration of the actual codebase before answering (visible in
its own working trace) rather than inventing context.

---

## 7. Next steps — RESOLVED 2026-08-25 for ideas 1/2/3/4/6, idea 5 deferred

Built the shared feature-extraction pass (`scripts/pilot_touch_quality_features_deepseek.mjs`,
real N=959) via the standard Gemini design-critique-then-mine workflow. Full writeup, the two
real bugs caught along the way (a lookahead bug in idea 6 caught pre-run by the critique pass;
a verdict-function bug that ignored its own monotonicity check, caught post-run by auditing
Gemini's output directly), and the final numbers are in `docs/OPEN_THREADS.md`'s 2026-08-25
resolution entry under this same heading — read that before repeating this work.

**Outcome**: ideas 1, 2, 3, 4, and idea 6's `rangeVelocity` — 7 numeric features total — are
CONFIRMED negative (zero monotone quartile trends on N=840-960 each; `RESEARCH_CLAIM
touch_quality_ideas_1_2_3_4_negative`). Idea 6's boolean (`isNewSessionExtreme`) is PROVISIONAL,
not dead — a real residual effect survives conditioning on level-family but is too thin (N=20)
to call (`RESEARCH_CLAIM touch_quality_idea6_expansion_touch_provisional`, self-rechecks once
real N roughly doubles). Idea 5 was never built — still a legitimate next step for anyone
picking this thread back up, now tracked as its own decision:
`OPEN_DECISION touch_quality_idea5_fade_friendliness_deferred`.
