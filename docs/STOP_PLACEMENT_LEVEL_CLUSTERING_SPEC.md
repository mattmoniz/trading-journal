# Stop Placement vs. Nearby Structural Levels — Spec

**Status: 2026-08-20, spec only, not yet built.** Written to be self-contained across a
context clear — read this doc plus `CLAUDE.md` and you should not need the prior
conversation. Resolves `OPEN_DECISION stop_placement_ignores_nearby_structural_levels`
(MEDIUM, flagged 2026-08-12). Sent to DeepSeek for Phase-0 design critique before any
code — see `scratch/deepseek_stop_placement_spec_review.md` once it lands.

## The hypothesis

When multiple level-fade candidates cluster close together in price, the live selection
picks whichever has the best historical EV as primary — confirmed in code,
`server/routes/acd.js:6966-6967`:
```js
const pooledPrimary = nearLevels.reduce((best, lv) =>
  (lv.ev ?? -999) > (best.ev ?? -999) ? lv : best, nearLevels[0]);
```
The resulting stop is then a **fixed point-distance for that setup_type**, read from
`OPTIMAL_STOP` calibration with zero awareness of where any other nearby level sits —
confirmed in code, `server/routes/acd.js:7113-7114`:
```js
const optStop = liveStats._opt?.[type];
const stopPts = optStop?.stop ?? Math.round(lv.mae_p75 ?? STOP);
```
Neither the selection (`pooledPrimary`) nor the stop distance (`stopPts`) consults
`nearLevels`' other members' prices at all. If two levels are 5-10pt apart, the stop from
fading the closer one could land right on top of the other level's liquidity pocket —
more exposed to an ordinary sweep/noise move than if the model had picked a level with a
genuinely clear runway to the same fixed stop distance.

**This is a real hypothesis worth testing carefully — not a bug.** The EV-based selection
has its own real backing (per-level historical performance); this spec does not propose
replacing it, only asking whether stop *placement* awareness of level clustering would
improve outcomes on top of it, or whether it would need to override selection entirely.

## Distinct from a related, already-flagged idea

`wait_for_held_ground_confirmation_before_fade_entry` is about entry **timing**/
confirmation — this is about entry **selection** among clustered candidates and stop
**placement** relative to known structure. Different questions; don't conflate.

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
5. **Specifically check the STOP_HIT sub-population for a liquidity-sweep signature**: of
   trades that hit their stop, does `STOP_NEAR_OTHER_LEVEL` show a higher rate of price
   reversing back through the stop level within N bars afterward (a "the market just
   swept the pocket and reversed" pattern) compared to `STOP_CLEAR_RUNWAY`'s stop-outs?
   This is the mechanistic signature the hypothesis actually predicts, not just a WR/EV
   gap — worth checking even if the top-line WR/EV difference is modest, since it's more
   diagnostic of *why* a gap exists if one is found.

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

## Open questions for DeepSeek's review

1. Is `TOUCH=15` the right clustering threshold to reuse, or does treating "clustered for
   confluence purposes" and "clustered for stop-placement risk purposes" as the same
   distance conflate two different physical questions (confluence is about the ENTRY
   level; this is about where the STOP lands, potentially a different, setup_type-specific
   distance)?
2. Is the Phase 0 → Phase 1 staging the right sequencing, or is there a cheaper way to get
   at the counterfactual question directly without a full resimulation?
3. Anything about the liquidity-sweep-signature check (Phase 0 step 5) that's
   underspecified or likely to be noisy/hard to define cleanly with 1-minute bar data
   (given this codebase's own established ceiling on tick-level order-flow questions,
   `table_preentry_inflection_detection_pending_orderflow_data` — is this check asking
   for more precision than 1-min bars can support)?
4. Any structural/algebraic confound in the Phase 0 comparison itself (per the
   confluence-checklist's item 1) that isn't just the day-type/volatility one already
   named?
