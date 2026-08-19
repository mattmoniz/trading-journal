# IB 30-min → 60-min window recalibration — spec (v2, post-DeepSeek critique)

Resolves `OPEN_DECISION ib_bullbear_window_fix_recalibration_needed`. v1 written 2026-08-19,
sent to DeepSeek for a Phase 0 design critique before any diagnostic script was built. This
v2 incorporates every substantive finding from that review — see
`scratch/deepseek_response.md` (2026-08-19 dispatch) for the full critique this revision is
based on. Four real issues were found and are fixed below: an undercounted population, a
lookahead risk for a real subset of historical fires, a diluted STOP_SWEEP signal, and a
deferred threshold that should have been pre-registered.

## Background

2026-08-12 (`acd.js`'s `ibBarsRow` query, ~line 4106): `ibBars` was widened from
`BETWEEN 570 AND 599` (30 min) to `BETWEEN 570 AND 629` (the real 60-min Initial Balance).
Motivated by `RESEARCH_CLAIM ib_bullbear_30min_vs_60min_window_test` (day-level: 51%
disagreement, 12% outright flip) — **note: that claim's source script
(`scratch/backtest_ib_window_30v60.mjs`) no longer exists** (overwritten by a later scratch
dispatch, expected/documented behavior for `scratch/`), so the 51%/12% figures can't be
independently re-derived right now. The diagnostic below re-derives a day-level anchor as
part of its own output, not just the trade-level numbers, so this decision has a live
reference again.

The fix is real and already live. Unresolved: `IB_BULLISH`/`IB_BEARISH`'s
`SETUP_STATUS`/`OPTIMAL_STOP` rows, and `STOP_SWEEP_LONG`/`SHORT`'s (which use `ibHigh`/
`ibLow` as candidate price levels in `sweepLevels` — a selection question, not a calibration
question, see below), are still built almost entirely from real trades fired under the OLD
30-min classification.

## Confirmed current scope (DeepSeek independently re-derived every cell 2026-08-19 — all
## matched exactly; corrections below are precision fixes DeepSeek flagged, not scope changes)

`ibBars` (60-min, corrected) feeds:
1. `ibHigh`/`ibLow`/`ibMid` computed **inline** at `acd.js:4277-4278`
   (`Math.max/min(...ibBars.map(b=>b.high/low))`) — NOT inside `computeIbBullBear()`, which is
   called separately at ~4719 and only returns `{ibMid, ibClose, totalAsk, totalBid, ibBullish,
   ibBearish}`. Both consume the same `ibBars`, so the numbers agree, but the code location
   matters for anyone reading the diagnostic against the live source.
2. `sweepLevels`' `IB_HIGH`/`IB_LOW` candidates for `STOP_SWEEP_LONG`/`SHORT`
   (`acd.js:7530-7537`, gated by a 30pt confluence check + sweep-trigger test at ~7567-7625)
3. `firstHourDir` (session-bias check, ~4676) — now genuinely reflects a full hour
4. `aUpTestedInIB`/`aDownTestedInIB` conflicting-signal check (~4724-4725)

`computeIbBullBear()` (`server/services/caseEngine.js:152`) needs only `high, low, close,
ask_vol, bid_vol` (not `open`/`volume`). **Implementation trap**: `ask_vol`/`bid_vol` are
produced by the *query's* `COALESCE(ask_volume,0)`/`COALESCE(bid_volume,0)`, not the function
— the diagnostic's reconstruction query must replicate that COALESCE or a null-volume bar
silently zeroes one side and flips `totalAsk > totalBid`.

Live state as of 2026-08-19:

| Type | SETUP_STATUS rec. | Real N (`REAL_TRADE_FILTER`, all-time) | N since 08-12 fix | OPTIMAL_STOP method | Live capital exposure right now |
|---|---|---|---|---|---|
| IB_BULLISH | DAY_TYPE_MANAGED | **69** (68 TARGET/STOP_HIT + 1 non-MTM TIME_EXPIRED) | 8 | `chronological-sweep-real`, real N=68, `clustered=true` top5=97.1% (blended `sample_size` column=171, NOT the real sample — don't cite 171 as "N") | Fires as **SHADOW** (still accumulating real N, not stopped) via `CAPITAL_EXPOSURE_OVERRIDE` (STOP_DAY_CLUSTERED, unrelated reason, added 2026-08-19) |
| IB_BEARISH | DAY_TYPE_MANAGED | 148 (all non-MTM TIME_EXPIRED already excluded) | 7 | `EV-sweep-real`, real N=148, `clustered=true` top5=81.8% (blended `sample_size`=244 — same caveat) | Real — DAY_TYPE_MANAGED fires ACTIVE when its day-type bucket clears the real-N floor |
| STOP_SWEEP_LONG | ACTIVE | 34 | 3 | `p75mae-real-fallback` (placeholder, never swept) | Real — currently ACTIVE, blended `ev_per_trade`≈$1.05 (thin, near-breakeven; cite this field, not a separately-scoped `real_ev` guess) |
| STOP_SWEEP_SHORT | THIN_N | 14 | 0 | none | None — THIN_N routes to SHADOW |

Real capital exposure to a potentially-stale basis is concentrated in **IB_BEARISH** and
**STOP_SWEEP_LONG**. Adjacent, out-of-scope-for-this-thread observation: IB_BEARISH's own
`OPTIMAL_STOP` is also day-clustered (81.8% top5, 11 distinct days) — below IB_BULLISH's
97.1% and deliberately not added to `CAPITAL_EXPOSURE_OVERRIDE` in this pass, but flagged in
`docs/OPEN_THREADS.md` as the next name that would clear the same bar if that framing is
revisited.

## Population predicate (FIXED — was too narrow in v1)

v1 scoped the diagnostic to `origin_status IN ('ACTIVE','SHADOW') AND resolution IN
('TARGET_HIT','STOP_HIT')` — mismatched `backtest_setup_status.mjs`'s own `REAL_TRADE_FILTER`
(now exported from that file, imported here rather than hand-copied) by excluding non-MTM
`TIME_EXPIRED` rows, and — the larger issue — **silently dropped the entire reconstructable
`origin_status='UNKNOWN'` population** (pre-2026-07-09 real fires, no SETUP_STATUS snapshot
survives, but every row has a `trade_date` and is fully reconstructable from
`price_bars_primary`). These are the OLDEST trades, 100% fired under the old 30-min window —
exactly the population most likely to flip — so excluding them **understates** the flip
fraction and biases toward "Option 1: it's fine" by construction. IB_BULLISH has 106 UNKNOWN
vs 68 in-scope; IB_BEARISH has 100 vs 148.

Fixed: the diagnostic reports **two** flip fractions per type:
- **(i) Calibration-relevant**: `REAL_TRADE_FILTER` population (`origin_status IN
  ('ACTIVE','SHADOW')`, resolution `TARGET_HIT`/`STOP_HIT`/non-MTM-`TIME_EXPIRED`) — this is
  what Option 2's exclusion would actually operate on, so it's the number the decision rule
  below is evaluated against.
- **(ii) Better-powered sanity check**: (i) + `origin_status='UNKNOWN'` (same resolution
  filter, no `resolution_method` gate since UNKNOWN rows predate that column's reliable
  population) — reported alongside, not blended into (i), with the excluded/included counts
  printed as explicit line items so nothing is silently omitted either direction.

## Lookahead fix (FIXED — v1 asserted a gate invariant that doesn't hold for a real subset)

v1 claimed "IB fires are gated `etMin>=630`... both windows close by 10:29." True only since
the 2026-07-14 gate move, and never true for STOP_SWEEP (no 630 gate exists for it). Real
counts: IB_BULLISH 6/68 fired pre-10:30 (earliest 9:58), IB_BEARISH 9/148; STOP_SWEEP_LONG
3/34 pre-10:30 (5 more in the 10:30-11:00 partial-second-half window), STOP_SWEEP_SHORT 1/14.
For these fires, live code computed `ibBullish`/`ibBearish`/`ibHigh`/`ibLow` over whatever
partial window existed **at fire time**, not the full window the diagnostic would otherwise
reconstruct — comparing a full-window reconstruction against a partial-window live decision
is not a real 30-vs-60 comparison, it's an artifact.

Fixed (took DeepSeek's "simpler and more honest" option over full as-of-fire-time
reconstruction, to avoid introducing a second reconstruction-fidelity risk into an already
DB-heavy diagnostic): **exclude pre-10:30 fires from the flip-fraction denominator**, report
their count and outcome separately as "already stale for the unrelated gate-timing reason,"
and do not let them contribute to either flip fraction above.

## Reconstruction-failure vs. genuine flip (FIXED — v1 conflated these)

A trade that fired means live had ≥3 `ibBars` at fire time. If the diagnostic's
reconstruction query finds <3 bars for that `trade_date`/window (a data gap — missing bars,
not a real absence of trading), that's a **reconstruction failure**, reported as its own
bucket, not folded into "became ineligible (neither bull nor bear)." Conflating the two would
mislabel a data-quality artifact as a real classification flip and inflate the affected
fraction.

## STOP_SWEEP scoping (FIXED — v1's distance distribution would have been ~79% noise)

STOP_SWEEP fires against any of 6 `sweepLevels` (ONL/ONH/PDL/PDH/IB_LOW/IB_HIGH), recoverable
per-trade from `t1_label` (e.g. "IB_LOW sweep bounce"). Only **8/34** STOP_SWEEP_LONG and
**2/14** STOP_SWEEP_SHORT real fires actually swept an IB level — pooling all 34+14 into one
`|ΔibHigh|`/`|ΔibLow|` distribution would be ~79% trades whose IB levels never mattered to
their firing. Fixed: filter to IB-level sweeps via `t1_label` FIRST (report the filter count
explicitly), then compute the distance distribution only over that subset.

**Explicit limitation, not fixed (scope decision, not a bug)**: the distance distribution is
a **lower-bound proxy**, not the real answer to "would this trade have fired differently."
STOP_SWEEP's stop/target (`recentLow − 5` / `currentPrice + 30`) don't depend on `ibHigh`/
`ibLow` — a changed IB level changes *whether the sweep trigger condition* (`brokeBelow`/
`nowAbove` + confluence) would have fired at all, which only a full trigger re-simulation
against the corrected level can answer. This pass commits to the distance-distribution proxy
(cheap, read-only, answers "how different are the levels" even if not "would the trade still
exist") — a full re-simulation is explicitly out of scope for this pass; if the proxy shows
material distance differences, a follow-up decision (not this one) should consider whether
the re-simulation is worth building. Also worth stating plainly: STOP_SWEEP's exposure
mechanism is **selection** (which trades exist in the real-N pool), not **calibration**
(stop/target geometry) — different from the IB pair's mechanism, and the two shouldn't be
described with the same "stale strategy" framing.

## Pre-registered thresholds (FIXED — v1 deferred this; DeepSeek's case for not deferring is
## adopted: this is a binary decision, judged after the fact by the same party who shipped
## the underlying fix and would bear the cost of Option 2 — a textbook post-hoc-threshold
## incentive, and "large, matching 51%/12%" was an undefined anchor since that figure is
## day-level/all-days while this diagnostic's number is trade-level/real-fires-only)

Registered NOW, before the diagnostic is run, not editable after seeing the output except by
a reviewer who has not seen it:

- **IB_BULLISH/BEARISH → Option 2 if**: over the `REAL_TRADE_FILTER` population (metric (i)
  above, combined N=217, so 20%≈43 trades), **≥20% flip direction or become ineligible**
  under the 60-min window (excluding pre-10:30 and reconstruction-failure buckets from the
  denominator per the fixes above). **P&L-materiality override, checked regardless of the
  count**: if the flipping+ineligible subset's mean `actual_pnl` differs from the
  stable subset's mean by **≥$5/trade**, treat as material → Option 2 even if under 20% by
  count. (A headcount threshold is a proxy; whether the calibration *numbers* actually move
  is the real question — the diagnostic must report this P&L split, not just counts.)
- **STOP_SWEEP → Option 2 if**: among the IB-level-sweep subset only, **≥20% of trades**
  show `|ΔibHigh|` or `|ΔibLow| ≥5pt`  (the 5pt bar matches the `recentLow − 5` stop buffer
  and existing sweep tolerance already used live).

Below either bar: Option 1 (interim note + natural reaccumulation), now backed by an actual
measured number instead of an assumption.

## Proposed diagnostic (Phase 1 — build this, read-only, no writes to `active_setups`/
## `performance_audit`)

`scripts/backtest_ib_window_reclassification_impact.mjs`:
1. Import `REAL_TRADE_FILTER` from `scripts/backtest_setup_status.mjs` (now exported) rather
   than hand-copying it.
2. Query both the `REAL_TRADE_FILTER` population and the `UNKNOWN`-inclusive population,
   per the two-fraction design above, for all 4 setup_types.
3. Split out pre-10:30 fires (excluded from the flip denominator, reported separately).
4. For each remaining real trade, reconstruct `ibBars` from `price_bars_primary` for that
   `trade_date` under both `BETWEEN 570 AND 599` and `BETWEEN 570 AND 629`, replicating the
   live query's exact column shape and `COALESCE` handling.
5. IB_BULLISH/BEARISH: classify via `computeIbBullBear()` (imported, not reimplemented) under
   both windows; bucket same / flipped / became-ineligible / reconstruction-failure.
6. STOP_SWEEP_LONG/SHORT: filter to IB-level sweeps via `t1_label`; compute
   `ibHigh`/`ibLow` under both windows (same reconstruction); report the distance distribution
   and the ≥5pt-affected count/fraction over the filtered subset.
7. Day-level sanity anchor: re-derive the original 51%/12%-style day-level 30-vs-60
   disagreement rate independently (a fresh, simple query — not a re-run of the lost script)
   so this decision has a live reference number again.
8. Apply the pre-registered thresholds above and print the Option 1/2 verdict per type —
   but do not act on it automatically; this is a report, not a migration.

## Decision rule execution + guardrails (Phase 2)

1. Run the diagnostic. Independently re-derive its key counts via a **second party writing
   its own SQL** (Gemini or DeepSeek — matching this codebase's recent
   `CAPITAL_EXPOSURE_OVERRIDE` precedent, where a second party's independent re-query, not
   just a review of Claude's output, is what actually caught the wrong blast-radius number)
   before trusting the verdict.
2. If Option 1 for a type: add an interim-state note in **both** places a consumer would see
   it — a `performance_audit`-readable note (script/consumer-facing) **and**
   `SETUP_DISPLAY_LABELS`/Setup Reference page (human-facing). Both, not either — v1 said
   "or," which would leave one audience blind.
3. If Option 2 for a type: build the exclusion backfill per `docs/DB_MIGRATION_PROTOCOL.md`
   (dry-run first, backup table, independent re-verification of dry-run counts). Tag affected
   rows via a `notes`-style JSONB marker (one-time analytical flag, not a new typed column).
   **Hold the re-run in SHADOW/diff-only** — re-run `backtest_setup_status.mjs`/
   `update_optimal_stops.mjs` for the affected types against the corrected population, diff
   the before/after stop/target/EV, and **confirm the diff is fully attributable to the
   exclusion** (the delta should match what removing exactly the tagged rows predicts) —
   before writing anything to live `performance_audit`. A diff that's larger or smaller than
   predicted is a bug signal, not something to write through.
4. After any Option 2 exclusion is applied, re-run the diagnostic once more to confirm the
   tagged rows are exactly the intended subset (no over-tag, no under-tag) before considering
   the decision resolved.
5. Resolve `OPEN_DECISION ib_bullbear_window_fix_recalibration_needed` with the real numbers
   from steps 1-4, not a restatement of this plan.

## Explicitly out of scope for this pass

- Re-litigating whether the 60-min window is correct (already settled).
- `IB_BULLISH`'s `CAPITAL_EXPOSURE_OVERRIDE` entry (unrelated day-clustering reason) — not
  touched by this work either direction.
- A full STOP_SWEEP trigger re-simulation (see the explicit-limitation note above) — a
  possible follow-up decision, not this one.
- Building a live day-type signal for `value_fade_daytype_positive_signal_needs_live_gate_research`
  — separate thread.
