# Stop Placement vs. Nearby Structural Levels — Spec

**Status: DEPRIORITIZED 2026-08-20, not built, not an active thread.** Reviewed by
DeepSeek (`scratch/deepseek_stop_placement_spec_review.md`, verdict: proceed, 3
amendments, all applied below) and fully scoped — but on reviewing the plan against the
closest real analog, the decision was made not to schedule effort here. Two reasons: (1)
the closest comparable prior test (see "Related prior work" below) showed only a marginal
effect even at its best — roughly one commission-and-slippage round-trip; (2) Phase 1, the
only phase that could test this spec's actual entry-selection hypothesis, has a structural
confound that's hard to escape — the "clear runway" alternative candidate is by
construction a *lower-EV* level than whatever the current selection already picked, so
even a clean Phase 1 result would leave real ambiguity between "stop placement matters"
and "the lower-EV pick got lucky." Phase 0 alone (correlation only) can't resolve that
ambiguity. Kept for reference, not deleted — revisit only if real trade volume grows
substantially or someone has a sharper way to isolate stop placement from level quality in
Phase 1. `OPEN_DECISION stop_placement_ignores_nearby_structural_levels` resolved with this
reasoning.

---

*Below is the spec as scoped and DeepSeek-reviewed, preserved as-is for reference.*

## The hypothesis

When multiple level-fade candidates cluster close together in price, the live selection
has two paths. **The real primary path** (`server/routes/acd.js:7058-7083`, added
2026-08-12) filters candidates to the approach-consistent side, sorts by **directional**
EV (`liveStats[base][dirKey].ev`, not pooled EV), and walks in order, skipping
recently-fired/suppressed/DOW-suppressed/S2-double/trend-counter candidates, picking the
first that clears. **The fallback path** (`acd.js:7096-7100`, only reached when no
candidate clears) is the pooled-EV pick:
```js
const pooledPrimary = nearLevels.reduce((best, lv) =>
  (lv.ev ?? -999) > (best.ev ?? -999) ? lv : best, nearLevels[0]);
```
The resulting stop is then a **fixed point-distance for that setup_type** (per-setup_type
`OPTIMAL_STOP`, falling back to that level's own `mae_p75`, then a constant) — read with
zero awareness of where any other nearby level sits, in either path — confirmed in code,
`acd.js:7113-7114`:
```js
const optStop = liveStats._opt?.[type];
const stopPts = optStop?.stop ?? Math.round(lv.mae_p75 ?? STOP);
```
**The hypothesis survives the correction**: neither the primary (directional-EV) path nor
the fallback (pooled-EV) path consults `nearLevels`' other members' prices when computing
the stop. If two levels are 5-10pt apart, the stop from fading the closer one could land
right on top of the other level's liquidity pocket — more exposed to an ordinary
sweep/noise move than if the model had picked a level with a genuinely clear runway to the
same fixed stop distance.

**This is a real hypothesis worth testing carefully — not a bug.** The EV-based selection
(either path) has its own real backing (per-level historical performance); this spec does
not propose replacing it, only asking whether stop *placement* awareness of level
clustering would improve outcomes on top of it, or whether it would need to override
selection entirely.

## Distinct from a related, already-flagged idea

`wait_for_held_ground_confirmation_before_fade_entry` is about entry **timing**/
confirmation — this is about entry **selection** among clustered candidates and stop
**placement** relative to known structure. Different questions; don't conflate.

## Related prior work — found mid-session, does NOT settle this hypothesis

`scratch/pilot_structural_stop_placement.mjs` (2026-07-27/29) tested a **related but
different** question: for **stack-break CONTINUATION** trades (same signal family as the
live `STACK_VOL_BREAK_LIVE`, not level-fade candidates), does anchoring the **stop
distance** to nearby structure (`LEVEL_IMMEDIATE`/`LEVEL_NEXT`/etc.) beat a fixed 40pt
stop, with **entry held fixed**? This spec's hypothesis holds **stop distance fixed**
(the setup_type's `OPTIMAL_STOP`) and varies **which entry candidate gets selected** —
an orthogonal knob. The mechanisms are different enough (reversal-vs-momentum,
entry-selection-vs-stop-distance) that the prior work's result does not transfer in either
direction — per this codebase's own hard rule, "a negative verdict … must cite a specific
TESTED mechanism failure with a number — negative by analogy to a different pipeline's
result is not a valid closure."

**That prior work's own "replication failed" conclusion turned out to be wrong anyway** —
DeepSeek's review found the `computeReplication()` call passed the 9-event held-out
complement as `units` instead of the full 491-event population, which structurally
guarantees `replicates: false` regardless of the data (the `selected` pool inside the
function is always empty since none of the 9 held-out ids can appear in `selectedIds`),
compounded by scoring those same 9 events with a null stop price (`nextLevelBeyond ===
null` coerces to a stop price of 0 in JS, producing garbage ~-$40k-per-trade PnL).
Independently re-verified against the actual code before trusting DeepSeek's claim — both
defects confirmed exactly as described. The prior pilot's one methodologically clean cell
(`LEVEL_NEXT @ 40pt` vs `FIXED_40 @ 40pt`, WR 48.3% vs 45.4%, EV $8.26 vs $6.82, N≈482) is
therefore a real-but-unreplicated small edge, not a confirmed positive OR negative finding
— recorded as `RESEARCH_CLAIM structural_stop_placement_level_next_vs_fixed40`
(PROVISIONAL) alongside a corrective `RESEARCH_CLAIM
pilot_structural_stop_placement_replication_check_broken` so the defect is durable,
documented knowledge rather than a scratch-file footnote nobody rediscovers.

**Practical takeaway for this spec's own build**: when this spec's Phase 1 eventually
calls `computeReplication()`, pass the **full** population as `units` (never the
complement), ensure `metricFn` is defined for every unit (return `null` — not a
nonsense-scored value — for a unit that can't be scored under the variant being tested,
per the function's own documented contract), and surface `distinctDates`/`top5DayPct`
alongside `clean` rather than letting them be computed-and-discarded like the prior pilot
did.

## Phase 0 — cheap correlational check first (no re-simulation)

Per this codebase's own "signal-level forward-return pre-test before building any trade
machinery" convention (`CLAUDE.md`'s new-setup-type checklist item 4a — the cheapest,
most decisive screen), characterize the **existing, already-fired** population before
building anything that resimulates alternative entries:

1. **Define "clustered" using an existing threshold, not a new hardcoded one** (per the
   no-static-thresholds hard rule). `TOUCH = 15` (`acd.js:1356`, and the equivalent inline
   `<= 15` at `acd.js:6898`) is already the proximity window this exact code uses to
   decide which levels count as "near" the touch price for confluence purposes — reuse it
   for "clustered" rather than inventing a second distance convention. A level is
   "clustering" with the primary if it's within `TOUCH` of the primary's own price.
2. For every real, resolved fade trade (`origin_status IN ('ACTIVE','SHADOW')`,
   `resolution IN ('STOP_HIT','TARGET_HIT')`), reconstruct what `nearLevels` looked like at
   fire time (the full set of `keepLevelsAll` candidates within `TOUCH` of the fired
   price on that date — reuse the real level-construction logic, don't reimplement it by
   hand, per the export-the-real-function rule).
3. For each trade, compute whether its **own fixed stop price** (`entry ± stopPts`, using
   the setup_type's `OPTIMAL_STOP` stop at the time, or today's for simplicity if
   historical values aren't easily reconstructed — note explicitly which you used) lands
   within `TOUCH` of any OTHER level in that trade's `nearLevels` set (excluding the
   primary level itself). Bucket: `STOP_NEAR_OTHER_LEVEL` vs. `STOP_CLEAR_RUNWAY`.
4. Compare real WR/EV between the two buckets, **within setup_type** (or at minimum
   stratified/controlled by setup_type — EV varies enormously by type, a naive pooled
   comparison would be dominated by composition, not the hypothesis). N≥20 floor per
   bucket per this codebase's standard.
5. **Specifically check the STOP_HIT sub-population for a liquidity-sweep signature** —
   DeepSeek review: define it mechanically and conservatively, not fuzzily, given 1-min
   bars can't see intrabar ordering (can't distinguish a true sweep-then-reverse from an
   ordinary stop-out-then-trade-back-through — the same ceiling
   `table_preentry_inflection_detection_pending_orderflow_data` already documents). Use: a
   `STOP_HIT` where a subsequent bar trades back through the stop by ≥X pt within N bars,
   AND the stop-out bar's own `close` does not itself close beyond the stop (a
   rejection-of-the-break signature). Derive `N`/`X` from the data (e.g. the rolling median
   bar range) rather than hand-picking them, per the no-static-thresholds rule. Treat this
   as **corroborating diagnostic evidence**, not a gate — the actual Phase 0 decision rests
   on the WR/EV gap and the base rate of `STOP_NEAR_OTHER_LEVEL`, with the sweep signature
   as supporting color for *why*, not the primary test.
6. **Confounds to control for, beyond day-type/volatility** (DeepSeek review, in
   roughly decreasing importance):
   - **Stop-width**: `STOP_NEAR_OTHER_LEVEL` is mechanically more likely for setup_types
     with wider fixed stops (a wider stop sweeps more price territory) — the within-setup_type
     stratification in step 4 already controls for this; don't let cross-type pooling
     reintroduce it.
   - **Level-density**: "another level near the stop" partly proxies "a dense-level day" —
     control for `nearLevels.length` at entry, not just day-type, so the test isolates
     stop-adjacency from "this was just a busy day."
   - **Selection/survivorship**: Phase 0 only sees the exposure of the *currently-selected*
     (EV-best) candidates — never the alternative (clear-runway) candidates' exposure. It
     can show "the current selection is exposed and exposed trades do worse," but it
     *cannot* by itself show "the alternative would have done better" — that is exactly
     why Phase 1's paired counterfactual exists. State this limitation explicitly when
     reporting Phase 0 results so a correlational gap isn't over-read as already answering
     the causal question.

**Decision point**: if Phase 0 shows no real, controlled, rigor-clean gap, stop here —
this is the cheap screen this codebase's own conventions call for, and Phase 1's
resimulation cost isn't justified without a Phase 0 signal to explain.

## Phase 1 — counterfactual test (only if Phase 0 finds something)

Phase 0 characterizes the *existing* selection's exposure; it does not test whether the
*proposed fix* (prefer the level whose fixed stop clears the next-nearest other level by
a real margin) would actually help. If Phase 0 finds a real signal:

1. For clustered candidates where the alternative rule (max-clearance-to-next-level,
   among candidates within some EV floor of the pooled-best — not literally "worst EV
   wins" just because it's furthest from other levels) would have picked a **different**
   level than the current `pooledPrimary`, re-walk real bars from that alternative
   level's entry against its own fixed stop/target (same discipline as this session's
   other bar-walk repairs: no lookahead, direction-correct, real `price_bars_primary`
   data).
2. Compare the alternative-selection population's real outcome against what actually
   happened (the current EV-based selection's real, already-known outcome) — a paired
   comparison on the *same underlying touch events*, not two independent samples.
3. **Confound check** (per `CLAUDE.md`'s confluence-checklist convention): does
   "clustered vs. not" correlate with volatility regime or day-type independently of the
   stop-placement mechanism (e.g., choppier/wider-range days naturally have more levels
   trigger simultaneously, and fades independently perform worse on those days for
   unrelated reasons)? Control for `dtClass`/day-type before attributing any Phase 1 gap
   to stop placement specifically.
4. **EV-floor confound** (DeepSeek review): the alternative "max-clearance" candidate is,
   by construction, a *different* level with lower/different EV than the current
   selection (that's why it didn't win in the first place) — any Phase 1 comparison is
   therefore implicitly "EV-best-but-exposed vs. EV-worse-but-clear," which conflates
   level quality with stop placement unless bounded. Restricting the alternative to
   candidates "within some EV floor of the pooled-best" (Phase 1 step 1) is the right
   guard, but that floor itself needs deriving from the data (e.g. a rolling-distribution
   percentile of EV spread within historical clusters), not a guessed number.
5. **`computeReplication()` usage, if invoked here**: pass the full population as `units`
   (never the held-out complement — see "Related prior work" above for the exact bug this
   guards against), ensure `metricFn` returns `null` for any unit that can't be scored
   under the variant being tested (never a nonsense-scored value), and surface
   `distinctDates`/`top5DayPct` alongside `clean` rather than computing and discarding them.

## What NOT to do

- Do not skip Phase 0 and build the Phase 1 resimulation directly — it's the more
  expensive path and this codebase's own convention is to screen cheaply first.
- Do not let "clustered" be a new hand-tuned threshold — reuse `TOUCH=15` unless Phase 0
  data specifically shows that boundary is wrong for this purpose (and if so, derive the
  replacement from the data, not a guess).
- Do not conflate this with `wait_for_held_ground_confirmation_before_fade_entry` (entry
  timing) — this is selection-among-candidates and stop placement, a different mechanism.
- Do not treat a Phase 0 correlational gap as sufficient to wire anything live — Phase 1's
  counterfactual test (or at minimum a held-out replication check,
  `computeReplication()`) is required before any live change, per this codebase's
  standing confound-checklist discipline for comparison-style backtests.

## DeepSeek review — answers (2026-08-20)

Full review: `scratch/deepseek_stop_placement_spec_review.md`. Independently re-verified
before trusting (the two `pilot_structural_stop_placement.mjs` code claims and the
stale-selection-path claim above were all checked directly against the actual code).

1. **Is `TOUCH=15` the right clustering threshold?** Partially — it conflates two
   different physical questions if used carelessly. Confluence's `TOUCH=15` is about
   levels near the *entry* price; this spec's real question is whether the *stop* price
   (`entry ± stopPts`, which varies widely by setup_type, roughly 52-82pt in this
   codebase) lands near another level. Phase 0 step 3 already gets this right (`TOUCH` as
   the *proximity tolerance* for "stop near a level," not "clustered at entry") — keep
   that framing, don't let prose conflate the two uses.
2. **Is the Phase 0 → Phase 1 staging right?** Yes — confirmed no cheaper path exists to
   the counterfactual than resimulating from an alternative entry; Phase 0's sweep-signature
   check (step 5) is the highest-value cheap addition and correctly belongs there, not in
   Phase 1.
3. **Is the sweep-signature check asking for more precision than 1-min bars support?**
   Yes, partly — 1-min OHLC can't distinguish a true sweep-then-reverse from an ordinary
   stop-out-then-trade-back-through (the same ceiling
   `table_preentry_inflection_detection_pending_orderflow_data` already documents).
   Addressed above: define it mechanically (a rejection-of-the-break signature, not fuzzy
   "swept"), and treat it as corroborating diagnostic evidence, not the primary gate.
4. **Structural/algebraic confounds beyond day-type/volatility?** Yes, 4 more identified
   and folded into Phase 0/1 above: stop-width, level-density, selection/survivorship
   (Phase 0 can show exposure-correlates-with-worse-outcomes but not that the alternative
   would do better — that's what Phase 1 is for), and an EV-floor confound in Phase 1's
   alternative-candidate selection.

**Verdict: proceed with Phase 0 as scoped**, with the amendments above applied. Not
deprioritized by the prior work (see "Related prior work" — mechanisms differ, and that
prior work's own negative turned out to be a broken check, not real evidence either way).
