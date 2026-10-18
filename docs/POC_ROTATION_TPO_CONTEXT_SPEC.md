# POC rotation as a "which playbook" selector, inside a TPO / auction context -- scoping spec for external review

Status: DRAFT scoping, 2026-10-18. Nothing here is built. Research only, no live wiring. Written to be read standalone by a reviewer with read access to this repo (`/home/mmoniz/trading-journal`) and, for Gemini, read-only DB access.

## 1. The problem in one paragraph

`POC_ROTATION_JOIN_LONG/SHORT` (live since 2026-09, SHADOW then promoted) trades WITH the direction of a 65pt rotation leg that has just converged back to the running 24h median-volume "fair value". It works in some conditions and fails in others. On Friday 2026-10-16 several upward rotations fired while the market kept grinding lower (NQ ended ~-700pt); the user's read: "poc rotations work well but in certain context -- sometimes the market is just building to go lower even though the rotation moves above and looks like a rotation long". The question is NOT "is the signal good" but **"which auction context is the market in, and does that tell us whether to join the rotation, fade it, or stand aside?"** (balance vs trend vs outside-acceptance/rejection; where the high/low levels to trade from are).

## 2. What already exists in the codebase (do not rebuild; reuse)

| Capability | Where |
|---|---|
| 65pt leg / convergence events (the rotation events themselves) | `server/services/pocRotationService.js` `detectSignalEvents(65,'standard',theta,sessions,'fixed')` (theta = median 1-min bar range) |
| Live detector + its exit mechanism (100pt stop, breakeven after 60min, exit at next event or 24h) | `server/services/pocRotationJoinDetector.js`, `pocBreakevenHoldWalker.js` |
| Current rotation direction used as an entry gate | `rotation65ptGateShadow.js` `getCurrentRotationDirection()`, `acdRiskGates.js` `isRotationDirectionConflict()` (currently live-blocking DISABLED) |
| Volume profile POC/VAH/VAL, correct (volume spread across each bar's H-L) | `server/services/developingValueService.js` `computeProfile()`, `computeVolumeProfileForRange()` -- the ONLY sanctioned implementation |
| Prior-day / weekly / monthly levels, VA overlap, day type | `level_prices`, `developing_value_log`, `acd_daily_log` (day_type BALANCE/TREND/TURBULENT), `value_area_overlap` style features in the ML dataset |
| Multi-day regime labels, GARCH vol scale | `setup_outcome_backtest.regime_label_*`, `performance_audit` `GARCH_VOL_SCALE` |
| Bars | `price_bars_primary` (NQ 1-min, `bid_volume`/`ask_volume`; a VIEW -- always bound both ends of `ts`) |
| Statistical tooling | `server/services/rigorDiagnostics.js` `dayBlockedBootstrapCI()`, `computeRigor()`, `computeReplication()` |

**NOT in the codebase today:** any TPO construct -- 30-minute letter brackets, tails/excess, single prints, poor highs/lows, double distributions, HVN/LVN detection, an auction-state machine, a composite multi-day POC hierarchy. These would be new.

## 3. The ideas being scoped (user-supplied, three sources)

A. **Playbook-selector framing.** POC rotation is a value-migration/trend signature, so it is a *playbook selector* (fade vs follow), not a trigger. Test it split by: setup family (fade vs continuation), direction x rotation cell (up+long, up+short, down+long, down+short, flat), inside vs outside value, volume (above-average = real migration, thin = head-fake), time of day (early expansion more persistent).

B. **Quantitative layer.** Make the signal continuous: `extension = (POC - VAH)/VA_width` (long) or `(POC - VAL)/VA_width` (short), z-scored vs its own trailing 20-day distribution; build a conditional EV table (family x direction x extension_bucket x volume_bucket) with a **day-blocked bootstrap CI**, trade only cells whose CI lower bound > 0 with >= 20 distinct days; walk-forward everywhere; optionally a tiny (3-5 coefficient) logistic / depth<=2 tree used only to RANK inside already-positive cells.

C. **TPO / auction state machine** (a long external spec): states BALANCED / OUTSIDE_REJECTION / OUTSIDE_ACCEPTANCE / TREND_UP / TREND_DOWN, driven by developing-vs-prior POC/VA, a POC location score `L=(POC-VAL)/(VAH-VAL)`, a POC migration score, time/volume outside value, tails, single prints, poor highs/lows, double distributions; signals = fade (outside rejection), breakout retest (acceptance/trend), POC rotation inside balance. Its own thresholds (30 min outside, 2 closes, 1.5x volume, 5 TPOs, migration 0.7/0.3) are **static numbers**.

## 4. Hard constraints from this codebase (a review must respect these)

1. **No static thresholds** -- every cutoff derived from a rolling distribution. C's constants above must be re-derived or dropped.
2. **No lookahead** -- every feature as-of the event bar; a *developing* profile at time t only uses bars <= t. A fractal pivot/leg end is only known after its confirmation lag.
3. **RTH and Globex both** (9:30-16:00 ET vs 18:00-08:30 ET) evaluated separately; these sessions have reversed directional-pressure signals before. Pooled-only results are not acceptable.
4. **Split-comparison rule:** when comparing two arms of a SPLIT (different events in each arm), report plain sum(pnl)/N per arm; use the day-blocked bootstrap only for the CI on the DELTA. Day-weighted means flipped a result's sign once here.
5. **Placebo for any asymmetric stop/target** (gambler's-ruin baseline `stop/(stop+target)`), and a same-selection-minus-the-signal control bucket.
6. **Confound boundary:** three mechanisms changed on 2026-10-11/12 (`PROMOTE_ALL_MODE` stat gate, a 65pt rotation entry gate, and a brand-new POC_ROTATION_JOIN exit). Design/fit only on events through 2026-10-10; post-10-11 is a forward check, never mixed in.
7. **Data window:** NQ 1-min history is dense only from 2025-11-20 forward (earlier is placeholder daily rows, per `docs/KNOWN_ISSUES.md` #16/#17); roll weeks excluded via `acdShared.js` helpers.
8. **Effective N:** ~1,600 events over ~12 months but heavily day-clustered and overlapping legs; decisions need >= 20 DISTINCT DAYS per cell, not >= 20 events.
9. Anything that could later gate/size a live trade needs the 3-phase review (design critique -> mine-and-run -> code review). This document is phase 0.

## 5. Proposed Phase-0 plan (my draft -- attack it)

**Step 1 -- raw forward-return screen, no trade machinery.** For every `detectSignalEvents(65)` event (RTH and Globex separately), measure the forward price change at several bar horizons in the JOIN direction, conditional on context bucket vs the UNCONDITIONAL mean over the same horizon.

**Step 2 -- context features, all as-of-event, all bucketed from rolling distributions:**
- (a) developing-session POC location score `L` and its slope over the last k bars (volume-spread profile via `computeProfile`);
- (b) developing POC / price relative to the PRIOR day's value area (inside / above / below) and minutes spent outside it so far;
- (c) 3-5 day composite POC position and prior-days' value-area migration (up / down / overlapping);
- (d) volume z-score vs the time-of-day baseline (`touchQuality.js getVolumeBaseline`), and cumulative-delta alignment z-scored per minute-of-day;
- (e) **TPO-derived features built from 30-minute brackets of the 1-min bars (NEW, needs definition):** single-print gaps, tail/excess at the session extreme, poor high/low (>=3 TPOs at an extreme, no tail), and whether the developing profile is single-distribution or double-distribution;
- (f) day-type-so-far, rotation count and size so far, time of day.

**Step 3 -- trade-level confirmation** only for cells that survive Step 1: run the real exit mechanism (`pocBreakevenHoldWalker`, imported, never reimplemented) on the same events; compare against the identical events simulated with a plain fixed stop/target to isolate exit effect.

**Step 4 -- statistics:** pre-registered cell list; per-trade means per arm; day-blocked bootstrap CI on deltas; chronological thirds; day-exclusion (top-5 days) stress; same-selection placebo; walk-forward re-fit for any continuous score; report coverage (tested / excluded / pooled) not just the winner.

**Success / kill criteria (to be agreed in review):** a context bucket "counts" only if the delta CI excludes zero in BOTH sessions or the effect is explicitly session-specific and replicated forward, >= 20 distinct days, survives top-5-day exclusion, beats the placebo. Otherwise the honest answer is "no usable context split", which is a complete deliverable.

## 6. Questions for the reviewers

1. **Verdict and holes.** Is this the right shape of experiment? What are the biggest methodological holes, ranked? What would make you say "do not build"?
2. **Minimum first experiment.** What is the smallest slice that would tell us whether context matters for POC rotation (cut everything else)?
3. **TPO from 1-min bars.** Is it legitimate to build 30-minute TPO brackets from 1-min OHLC bars (no tick data)? Give exact, lookahead-free definitions of single prints, tails, poor highs/lows and distribution count from bars, and say which are too noisy to use.
4. **Which of idea C's states are testable now** with what exists, and which depend on features that do not exist and must be built first? Which static thresholds in C must be replaced, and by what rolling-distribution rule?
5. **Overfitting budget.** With ~1,600 clustered events, how many contexts x buckets can be tested before the multiple-comparisons surface makes a "winner" meaningless? Propose a concrete pre-registered cell list and correction.
6. **Lookahead traps** specific to leg/rotation events and developing profiles in this codebase (the leg end is only known after confirmation lag; the 65pt event's `entry_idx` semantics -- read `pocRotationService.js`).
7. **Interaction with the existing rotation direction gate** and with the 2026-10-11/12 changes: what must be controlled so we do not attribute an effect of the new exit to context?
8. **Alternative explanation to rule out** for the Friday observation (up-rotations in a down-trending day): is it context, or is it simply that JOIN-long has negative drift in a down day regardless of any state classifier -- how do we separate them?

## 7. Output format requested

Write the answer to the response file named in the request. Sections: (0) one-paragraph verdict, (1) ranked list of holes with the concrete failure each causes, (2) your recommended minimal experiment as a numbered protocol, (3) answers to questions 3-8 above, (4) what you checked in the repo vs assumed. Concrete and short beats long; mark speculation as speculation.
