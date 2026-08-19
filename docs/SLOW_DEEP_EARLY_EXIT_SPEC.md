# Slow+Deep Adverse-Grind Early-Exit Spec

**Status: PROVISIONAL, 2026-08-18. Real, tautology-free, N-backed finding — not yet ready for live/SHADOW
wiring. `RESEARCH_CLAIM slow_deep_adverse_grind_early_exit` and `OPEN_DECISION` (same slug) carry the
full text and the concrete next-build-steps; this doc is the narrative + the design record, read this
first if picking the thread back up.**

## The user's original idea and how it evolved

Started from a simple observation: some trades never once move favorably before stopping out — "zero
MFE" losers, visible daily on the quick-check dashboard. The original idea (move the stop up 25-50%,
leaving wiggle room, once a trade shows zero MFE) went through four real methodology corrections before
landing on something trustworthy:

1. **Fixed-bar-count checkpoint (N=1/2/3/4/6/10), zero-MFE + MAE-magnitude split.** Looked strong at
   first (+$17-66/trade for the "big early drop" bucket) — then DeepSeek found the population included
   trades that had **already resolved before the checkpoint bar**, which isn't a real, executable
   intervention. Fixing that (still-open-at-N filter) collapsed the effect to noise/reversed sign.
2. **Dynamic checkpoint** (per-trade timing: check when a trade reaches X% of ITS OWN stop distance,
   not a shared bar count) — the user's own refinement, since trades move at different speeds. Fixed a
   real bug in the walker (checkpoint-bar breach test used `close` where every other bar used
   `low`/`high`). Then found a **structural tautology**: sweeping tighten levels expressed as a fraction
   of the SAME distance used to select the population meant, past a threshold, the "new" stop was
   already behind price by construction — not a real forward test at all. `AlreadyBreachedPct` hits
   exactly 100% at `moveUp = 100% - triggerFraction%`, confirmed empirically, both trigger levels.
3. **Velocity contingency (no simulation at all)** — DeepSeek's recommendation once the tautology was
   understood: forget stop placement, just check bars-to-depth vs real recorded outcome. Found the
   **opposite of "falling knife"** — fast-to-get-deep trades recover more, slow-to-get-deep trades stop
   out more (83.7% vs 60.7% at the 75%-depth trigger). DeepSeek's own first read of this ("depth barely
   discriminates, median bar-to-trigger=0") was itself later corrected — that "0" was from the tiny
   zero-MFE-required population, not the real one (median is 2-3 bars in the real population).
4. **Market-exit-at-confirmation (the trustworthy test)** — exit at the confirmation bar's close instead
   of placing a stop, sidestepping every prior issue (no stop level, no tautology, no `moveUp` sweep).
   This is the current, load-bearing result (see below).

Every step was DeepSeek-reviewed (4 separate dispatches across the night — script review, script review
again after a fix, results interpretation, and this Phase-0 scoping pass), and every single pass caught
something real, matching this project's standing note about the value of independent review.

## Current finding (Part 4 of `scripts/pilot_zero_mfe_early_stop.mjs`)

A trade that reaches **75%** of its own original stop distance **slowly** (2+ bars, not 0-1) stops out
83.7% of the time (vs 60.7% for fast) and averages **-$82.84** real P&L (vs -$17.05 for fast). Exiting
such a trade at market on the confirmation bar's close, instead of holding:

| trigger | arm | n | delta vs holding | excl. top date (08-03) |
|---|---|---|---|---|
| 50% | SLOW (≥2 bars) | 385 | -$0.23 | -$0.86 (n=341) |
| 75% | SLOW (≥2 bars) | 327 | **+$2.32** | **+$1.51 (n=296)** |
| 75% | FAST (≤1 bar) | 194 | -$12.29 | — |
| 75% | BLIND (all deep) | 521 | -$3.12 | — |

The effect is specific to the depth+speed **combination** — blindly exiting anything 75%-deep loses
money, and exiting fast-to-get-deep trades specifically loses a lot (they're the ones that often
recover). 50%-depth shows nothing. Falling-knife framing (fast = dangerous) is **refuted** — slow is the
dangerous shape here, not fast.

## Why this isn't confirmed yet (3 reasons, none is raw N — 327 clears the N≥20 floor)

1. **No held-out/chronological check** — `computeReplication()` has not been run.
2. **No `computeRigor()`** on the per-trade `(exitPnl - realPnl)` delta.
3. **Not yet split by `bet_class`** — pooled across ~90 distinct `setup_type`s. A diversity check
   (top-5 contributing types = only 34.8% of the SLOW bucket, and span **3 different bet_classes** —
   `IB_BEARISH`/`IB_BULLISH`→`CONTINUATION_LEGACY`, `GLOBEX_VWAP_MAGNET_SHORT`/`GLOBEX_VWAP_FADE_SHORT`
   →`GLOBEX_LEVEL`, `FAILED_AUCTION_LONG`→`VALUE_FADE`, independently verified via `getBetClass()`) is
   encouraging but **not sufficient** — a family-conditioned effect could still be real and masked by
   pooling even without one family dominating the raw count.

## DeepSeek's Phase-0 scoping plan (numbered build order, none started except step 0)

**0. DONE, this session.** `recordClaim()` persisted PROVISIONAL (`slow_deep_adverse_grind_early_exit`)
   so the finding survives a context clear — this was about to happen (user's own next step), and a
   claim that only lives in scratch/conversation is exactly the "evaporates across a session" failure
   mode this mechanism exists to prevent.

**1. Finer depth-trigger sweep.** `triggerFraction` 0.40 → 0.85 in 0.05 steps (+ an optional 0.90
   degenerate probe, read as a diagnostic only — as trigger% → 100% the population converges toward
   "already at the stop," which stops being an early-warning signal). Reuse Part 4's `summarizeExit()`
   verbatim (no rewrite needed), same FAST(≤1)/SLOW(≥2 bar) cut for comparability across cells. Trust
   only SLOW cells with n≥20 (expect n to shrink monotonically as depth rises — the sweep itself will
   show where the trusted range ends). **Read the shape, not the max**: a monotonic plateau from
   ~55-60% upward means 75% sits inside a robust operating point; a single spike at one depth means
   likely noise from an 11-way multiple-comparisons search — do not just pick the best cell.

**2. `bet_class` split (hard prerequisite, not optional).** Per-`setup_type` N is hopeless (327/90 ≈ 3.6
   trades/type — guaranteed to reproduce the sign-reversal-on-thin-slice problem already found in
   `trade_management_continuous_score_needs_more_data`). `getBetClass()` is this codebase's own pooling
   unit for exactly this. Split the 75%-trigger SLOW bucket by family, require **same-sign positive in
   every family with n≥20**, surviving exclusion of the largest family + largest single type
   (`IB_BEARISH`) + largest day. If all clear → pooling is defensible as a real generalizable finding.
   If only some families clear → **rescope to a family-gated rule**, never ship pooled — pooling would
   be actively wrong for the families where the delta is flat/negative. **This step gates everything
   after it.**

**3. Consolidate + promote to a real scheduled script.** `scripts/backtest_slow_deep_early_exit.mjs`
   (not the pilot) — sweep (step 1) + family split (step 2) + `computeRigor()` (needs n≥15 per
   chronological third; 327 is fine) + `computeReplication()` (bet_class granularity, or a chronological
   train-first-2/3 / test-last-1/3 split) + a `recordClaim()` write/upgrade (same slug, `ON CONFLICT DO
   UPDATE`, PROVISIONAL → CONFIRMED only once family-same-sign + rigor-clean + held-out-same-sign all
   pass). Wire into `run_weekly_backtests.sh` so it self-rechecks as real N grows — this is not
   premature; a real-N-growing question is exactly the case this project already schedules
   provisional/negative findings for (matching the ATR-compression/bollinger-squeeze pattern).

**4. Parallel, cheap, independent — the already-live wider-target runner has the identical class of
   gap.** `WIDER_TARGET_MULT = 1.5` (`server/services/widerTargetWalker.js`) is a single pooled constant
   across all setup_types too. **Different urgency, not a different fix**: wider-target is upside-only
   (the original stop never moves — worst case is giving back a paper gain down to the original stop,
   no capital at risk beyond it) and already has a closed-loop monitor
   (`scripts/audit_wider_target_live.mjs`). Early-exit is downside-realizing (a wrong rule converts
   would-be recoveries into locked-in real losses) — it does **not** get the clustering waiver the
   momentum-runner findings received (`computerigor_stable_clustered_independence_gap`); an early-exit
   rule that's really just tracking a few clustered bad days is the exact dangerous failure mode Part 3
   itself demonstrated (the FAST/"safe" half of that finding turned out to be 2 days' artifact).
   **User explicitly deprioritized splitting 1.5 by setup type until real extra-MFE benefit from the
   runner is confirmed first** — so the concrete near-term action here is just: add
   `topBetClass`/`topBetClassShare`/`byBetClass` to `audit_wider_target_live.mjs`'s notes (currently only
   tracks `topSetupType`/`topSetupTypeShare`) so if 1.5 starts hurting a specific family as live N grows,
   the monitor surfaces it before any promotion — not a full recalibration now.

**5. Deferred, months out.** True per-`setup_type` calibration of either mechanism — gated on the
   `unblockCondition` (`min_real_n_per_type`, `minN: 20`) already attached to the RESEARCH_CLAIM.
   `test_invariants.mjs` check `[11]` fires automatically the moment this becomes feasible; no manual
   revisit needed.

## What NOT to do

- Do not ship any live/SHADOW early-exit rule from the pooled 75%/SLOW number alone — step 2 (family
  split) is a hard prerequisite.
- Do not pick "the best depth" from a sweep without reading the shape first (multiple-comparisons risk).
- Do not extend this into a placed-stop mechanism (`moveUp` sweep) without first fixing the
  checkpoint-relative-to-current-price design flaw AND resolving the still-open `moveUp=0` sanity-check
  discrepancy (a "no tightening" test should show ~$0 delta vs reality and instead showed -$3 to -$7 —
  root cause not found; candidates are same-bar stop/target tie-breaking assumptions or the
  `entry_zone_high ?? entry_zone_low` vs `computeMaeMfe()`'s midpoint entry-convention mismatch already
  known elsewhere in this codebase). The market-exit test (Part 4, the one actually trusted) does not
  depend on any of this and is unaffected.
- Do not build the cumulative-delta/order-flow velocity refinement yet — the plain bars-to-depth measure
  already found a real signal with zero extra machinery; layering in delta data before the cheap version
  is validated would be getting ahead of the evidence, and this codebase has 2 prior similar order-flow
  ideas that came back negative/mixed.

## Source

`scripts/pilot_zero_mfe_early_stop.mjs` (all 4 parts, real, runnable, read-only) — rerun directly rather
than rebuilding when picking this thread back up.
