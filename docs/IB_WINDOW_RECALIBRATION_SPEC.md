# IB 30-min → 60-min window recalibration — spec

Resolves `OPEN_DECISION ib_bullbear_window_fix_recalibration_needed`. Written 2026-08-19,
before writing the diagnostic script, per this codebase's standing 3-phase workflow for
work that could affect live calibration data — this doc is Phase 0 (design critique before
code), sent to DeepSeek for review before the script below is built.

## Background

2026-08-12 (commit-documented at `acd.js`'s `ibBarsRow` query, ~line 4106): `ibBars` was
widened from `BETWEEN 570 AND 599` (30 min, mislabeled "OR period" in a stale comment) to
`BETWEEN 570 AND 629` (the real 60-min Initial Balance, matching `ibHighToday`/`ibLowToday`
elsewhere in the file). Motivated by `RESEARCH_CLAIM ib_bullbear_30min_vs_60min_window_test`:
a direct test found the two windows disagree on bullish/bearish/neither classification 51% of
the time, with a 12% outright direction flip, and the 60-min window shows better raw EV.

The fix is real and already live. What's unresolved: `IB_BULLISH`/`IB_BEARISH`'s
`SETUP_STATUS`/`OPTIMAL_STOP` rows, and `STOP_SWEEP_LONG`/`SHORT`'s (which use `ibHigh`/`ibLow`
as candidate price levels in `sweepLevels`, a different mechanism than the bull/bear call),
are still built almost entirely from real trades fired under the OLD 30-min classification —
re-running `backtest_setup_status.mjs`/`update_optimal_stops.mjs` right now would not fix
this, since those scripts read existing `active_setups` history, which doesn't change.

## Confirmed current scope (re-verified against live code 2026-08-19, not assumed from the
## original decision text)

`ibBars` (60-min, corrected) currently feeds, directly or via `computeIbBullBear()`
(`server/services/caseEngine.js`, window-agnostic, just computes stats over whatever bars
it's given):
1. `ibHigh`/`ibLow`/`ibMid`, `IB_BULLISH`/`IB_BEARISH` classification (`acd.js` ~4715)
2. `sweepLevels`' `IB_HIGH`/`IB_LOW` candidates for `STOP_SWEEP_LONG`/`SHORT` (~7530)
3. `firstHourDir` (session-bias check, ~4676) — now genuinely reflects a full hour
4. `aUpTestedInIB`/`aDownTestedInIB` conflicting-signal check (~4724)

Live state as of 2026-08-19 (query results, not the decision's original numbers, which were
7 days stale):

| Type | SETUP_STATUS rec. | Real N (all-time) | Real N (fired since 08-12 fix) | OPTIMAL_STOP method | Live capital exposure right now |
|---|---|---|---|---|---|
| IB_BULLISH | DAY_TYPE_MANAGED | 68 | 8 | chronological-sweep-real (N=171 sample) | **None** — already SHADOW via `CAPITAL_EXPOSURE_OVERRIDE` (STOP_DAY_CLUSTERED, added 2026-08-19, unrelated reason) |
| IB_BEARISH | DAY_TYPE_MANAGED | 148 | 7 | EV-sweep-real (N=244 sample) | Real — DAY_TYPE_MANAGED types fire ACTIVE when their day-type bucket clears the real-N floor |
| STOP_SWEEP_LONG | ACTIVE | 34 | 3 | p75mae-real-fallback (a placeholder-tier method, not swept) | Real — currently ACTIVE, real_ev≈$0.74 (thin, near-breakeven) |
| STOP_SWEEP_SHORT | THIN_N | 14 | 0 | none | None — THIN_N routes to SHADOW |

So real capital exposure to a potentially-stale basis is concentrated in **IB_BEARISH** and
**STOP_SWEEP_LONG** right now, not all 4 types symmetrically. Natural reaccumulation pace
(7-8 real fires/week for IB_BULLISH/BEARISH, 3/week for STOP_SWEEP_LONG, 0 for SHORT) means
Option 1 (let it reaccumulate, do nothing) would take ~3 weeks to reach even N=20 combined old+new
for IB_BEARISH, and far longer for STOP_SWEEP_LONG — too slow to just wait silently given
real trades are firing against the old-basis calibration meanwhile.

## Proposed diagnostic (Phase 1 — build this, read-only, no writes)

`scripts/backtest_ib_window_reclassification_impact.mjs`: for every historical REAL
(`origin_status IN ('ACTIVE','SHADOW')`, resolved `TARGET_HIT`/`STOP_HIT`) fire of
`IB_BULLISH`/`IB_BEARISH`/`STOP_SWEEP_LONG`/`STOP_SWEEP_SHORT`, reconstruct `ibBars` from
`price_bars_primary` for that `trade_date` under BOTH the OLD window (570-599) and the NEW
window (570-629) — same column shape `computeIbBullBear()` expects (`high, low, close,
ask_vol, bid_vol` — reuse the real function, don't reimplement its math) — and report, split
by setup_type:

- For `IB_BULLISH`/`IB_BEARISH`: how many real trades keep the same bull/bear classification
  under both windows vs flip direction vs become ineligible (neither) under the corrected
  window. A trade that becomes ineligible under the 60-min window fired on a classification
  the live code can no longer produce — its outcome describes a strategy the system doesn't
  run anymore.
- For `STOP_SWEEP_LONG`/`SHORT`: since these use `ibHigh`/`ibLow` as PRICE LEVELS (not a
  bull/bear call), report the distribution of `|ibHigh_60min - ibHigh_30min|` and
  `|ibLow_60min - ibLow_30min|` in points, and how many real fires actually TOUCHED a
  materially different level under the corrected window (i.e. would the sweep-trigger
  distance itself have differed enough to matter) — this is a different question from
  IB_BULLISH/BEARISH's classification-flip question and must be reported separately, not
  pooled into one combined "% affected" number.

No lookahead: every reconstruction uses only that trade_date's own historical bar data
(both windows are within the same trading day, well before the fire time in every real case
— IB fires are gated `etMin>=630`, both windows close by 10:29 at the latest).

## Decision rule (Phase 2 — act on the diagnostic's real output, not a guess made now)

- If the fraction of real historical trades that flip classification/eligibility is SMALL
  (a threshold TBD by the actual distribution — this spec deliberately does not pre-commit to
  a number before seeing real data, matching this codebase's standing rule against picking
  backtest cutoffs before looking at the results): document the interim state
  (`SETUP_DISPLAY_LABELS`/Setup Reference page note, or a `performance_audit` note field) and
  let natural reaccumulation continue — Option 1, now with actual evidence behind "it's
  probably fine" instead of an assumption.
- If the fraction is large (matching the previously-found 51%/12% signal-level disagreement):
  build the exclusion/backfill — tag historical `active_setups` rows whose classification
  flips under the corrected window with a new marker (exact column/JSONB-field TBD after
  seeing the row-level shape; likely `notes`-style, not a new typed column, given this is a
  one-time analytical flag not a going-forward field) so `backtest_setup_status.mjs`'s real_n
  scoping can exclude them going forward, then re-run the calibration pipeline for these 4
  types and diff the before/after stop/target/EV.

## What "done" looks like for this decision

1. Diagnostic script built, run, results reviewed (by Claude, then DeepSeek).
2. Decision rule applied based on real output — not decided in advance in this doc.
3. If Option 1: an interim-state note added somewhere a consumer of these 4 types' numbers
   would see it (this spec's original ask).
4. If Option 2: exclusion backfill built per `docs/DB_MIGRATION_PROTOCOL.md` (dry-run first,
   backup table, independent re-verification of the dry-run counts) and executed.
5. `OPEN_DECISION ib_bullbear_window_fix_recalibration_needed` resolved with the real numbers,
   not a restatement of this plan.

## Explicitly out of scope for this pass

- Re-litigating whether the 60-min window is correct (already settled,
  `RESEARCH_CLAIM ib_bullbear_30min_vs_60min_window_test`).
- `IB_BULLISH`'s separate `CAPITAL_EXPOSURE_OVERRIDE` entry (day-clustering, added 2026-08-19,
  unrelated to the window question) — not touched by this work either direction.
- Building a live day-type signal to unlock `value_fade_daytype_positive_signal_needs_live_gate_research`'s
  BALANCE-day edge — separate decision, separate thread.
