# Cluster Touch Credit — Phased Build Spec

**Status as of 2026-09-04: Phase 0/1 shipped 2026-08-25. Phase 3's live-forward core (the actual
sibling-row insert) SHIPPED 2026-09-04, DeepSeek-reviewed same day (2 real bugs found and fixed).
A simplified Phase 2 (distinct-day promotion floor, general — not sibling-specific) also SHIPPED
2026-09-04. Phase 3b (the historical backfill, RTH-only) also SHIPPED 2026-09-04 — see the "Phase
3b — shipped" section below for the full outcome (1,279 rows inserted, 27 SETUP_STATUS changes
including 3 real ACTIVE→SUPPRESS demotions). Globex-origin siblings remain unbackfilled — a
second pass, not yet scoped.** Read `docs/OPEN_THREADS.md`'s 2026-08-25 AND 2026-09-04 "Cluster
touch credit" entries for the full narrative before touching anything here — this doc is the
buildable plan, those entries are the reasoning trail.

## What's actually live right now (2026-09-04) — read this before assuming Phase 2/3 below is still all-future

**Phase 3 core, shipped:** `server/routes/acd.js`, inside the `sortedCandidates` loop that picks
a cluster's winner (search `CLUSTER_SIBLING_TOUCH_CREDIT`). Every candidate the loop skips on the
way to picking a winner now ALSO gets its own real, resolvable `active_setups` SHADOW row (own
level as entry, own calibrated stop/target via `liveStats._opt`), gated on the same 15-min
`candRecentlyFired` cooldown the winner path already uses. Two real bugs DeepSeek's review found
and that got fixed the same day:
1. `_TRAIL` variant siblings (7 types: `FLOOR_R1_FADE_SHORT`, `PW_HIGH_FADE_LONG`,
   `PD_POC_FADE_LONG`, `FLOOR_S1_FADE_LONG`, `DAILY_OPEN_FADE_LONG`, `CAM_S2_FADE_LONG`,
   `PD_POC_FADE_SHORT`) are now **explicitly skipped**, not credited — crediting them without
   `runner_trail_width` silently corrupted them into fixed-target trades under the `_TRAIL`
   label (the exact bug this codebase already fixed once on a different insert path). This
   matters for the backfill below too — same exclusion applies.
2. Sibling entry/stop/target are anchored at `cand.level` (its own level), not the winner's
   touch price.

Also fixed same day: the `gated_candidates`/`active_setups` double-audit-trail this doc's own
"Known adjacent findings" section (below) already flagged — a skipped candidate now logs to
`gated_candidates` ONLY when it does NOT also get a real touch-credit row.

**Simplified Phase 2, shipped:** rather than the full `cluster_touch_id`/`is_cluster_primary`/
`POOLED_TRADE_FILTER` schema build originally scoped below, a cheaper equivalent went live
instead — `scripts/backtest_setup_status.mjs` now blocks any **NEW** promotion (THIN_N/SUPPRESS
→ ACTIVE/PROMOTE, never demotes an already-live type) when the real trade population behind it
is `computeRigor().clustered` (top5DayPct>50%), reusing the exact clustering definition already
proven on the `SETUP_STATUS_DOW` gate rather than building new schema. Deliberately general —
protects every setup_type's promotion, not just sibling-touch-credit-sourced ones, since the
underlying gap (real_n with no distinct-day floor) already existed for other data sources too
(confirmed live: `GLOBEX_VWAP_MAGNET_LONG`, real_n=98 across only 4 distinct days, zero sibling
involvement). This is NOT the same as the original Phase 2 plan (no `is_cluster_primary` column,
no `POOLED_TRADE_FILTER`, the 3 named pooled consumers — `bet_class` override,
`monitor_bet_correlation.mjs`, `backtest_bet_class_status.mjs` — are still NOT cluster-aware) —
re-evaluate whether that fuller Phase 2 is still worth building once real sibling volume
accumulates and those 3 consumers' pooled numbers are checked for contamination.

**Not built: the historical backfill.** Everything below this point (Phase 3b) is the scope for
that, unstarted.

## Phase 0 results (2026-08-25, read-only verification, real numbers)

1. **Sibling-count distribution, RTH real touches** — `confluence_levels_at_detection` has been
   populated on every real (`origin_status IN ('ACTIVE','SHADOW')`) INSERT since 2026-07-23
   (917 rows so far). Of those, 562/917 (61%) have 2+ levels within the 15pt cluster radius —
   confirms the core premise directly: co-location is the common case, not an edge case.
2. **Early-touch-backfill 1PM-expiry bug, real impact before the fix** — identified backfill rows
   via their unconditional `expires_at`=13:00:00 ET marker (`resolution_method` mutates away from
   `'EARLY_TOUCH_BACKFILL'` once a row resolves, so that string can't be used post-resolution;
   `expires_at` is never rewritten after insert, so it's a durable identifier). 77 real
   (`origin_status='SHADOW'`) backfill rows all-time; only 2 of those actually fired after 1PM ET,
   and both still resolved `PRICE_CLEAN` despite the stale expiry — `resolveSetupsByPrice()` walks
   bars from `fired_at` forward regardless of `expires_at`, so the theorized "instant
   MARK_TO_MARKET" failure mode didn't materialize in practice. Real bug (fixed anyway, see
   Phase 1 below), but low realized damage prior to the fix.
3. **The natural experiment (`detectGlobexSetup()`, no cluster dedup)** — exact-same-minute
   cross-type grouping badly undercounted real clustering (only 6 pairs found); widening to
   near-simultaneous (≤10min apart, ≤15pt entry distance, both sides real `ACTIVE`/`SHADOW`
   origin) found 127 cross-type pairs all-time. Resolution mix: ~67% `PRICE_CLEAN`, ~26%
   `MARK_TO_MARKET`, remainder `RETROACTIVE_REPAIR`/`WIDER_TARGET_HIT`/`NO_PRICE_DATA`/null.
   **Inter-sibling P&L correlation: r=-0.14 (n=123)** — near-zero/slightly negative, not the
   redundant-same-bet correlation Phase 2's independence-floor concern worries about. Directly
   useful input for `monitor_bet_correlation.mjs`'s r<0.6 gate once Phase 2 wires pooled
   consumers.

## Phase 1 shipped (2026-08-25)

All 3 items from the Phase 1 section below were implemented in `server/routes/acd.js`:
1. Early-touch backfill's `sessionEndStr` expiry (was hardcoded `13:00:00`) now computes a real,
   rollover-safe RTH close (4PM ET, next day if already past) — mirrors the suppressed-audit
   insert's existing `auditSessionEnd` pattern.
2. Early-touch backfill's `if (Math.abs(currentPrice - lv.level) <= 15) continue` skip (the false
   "live path already covers this" assumption) removed entirely — the per-type-per-day dedup
   check a few lines below already makes this idempotent.
3. `cluster_attributed_setups` now also gets written onto the WINNER'S OWN row for same-poll,
   same-cluster candidates the `sortedCandidates` fallback loop skipped on the way to picking it
   (the literal `FLOOR_R2`-loses-to-`WEEKLY_OPEN` case) — previously only written onto a
   *different* poll's already-open `clusterAlreadyFired` anchor.

Verified: `node --check` clean, `npm run lint` clean, server restarted onto the new code with
zero new `scratch/server_errors.jsonl` entries, `/api/acd/setup-detection` returns 200 with a
well-formed body, `test_invariants.mjs`'s 4 FAILUREs are pre-existing OPTIMAL_STOP
circuit-breaker trips (`OR5_LOW_FADE_SHORT`/`OR5_MID_FADE_LONG`/`GLOBEX_VWAP_FADE_SHORT`/
`IB_BULLISH`) fully unrelated to this change.

**Phase 2 (schema + gating safety net) and Phase 3 (the actual sibling-row insert) remain NOT
built.** Both are live-wiring changes to production gating/suppression logic — CLAUDE.md's
higher-stakes-work rule requires the 3-phase Gemini workflow (design critique on the approach →
mine-and-run analysis → review-only pass on the code) before either ships, not just a design
critique of the plan (which both models already gave 2026-08-25, before Phase 0's real numbers
existed to critique against).

## The problem, one sentence

When several distinct named levels sit within `nearLevels`' 15pt cluster radius of each other
(e.g. `FLOOR_R2`=29392.50 and `WEEKLY_OPEN`=29392.25, 0.25pt apart), the live level-fade engine
(`server/routes/acd.js`, the winner-selection loop ~line 7316-7358) fires exactly ONE real
`active_setups` row per touch — picked by directional EV, `break` at the first candidate that
clears every gate — and every other level in that same real touch gets nothing. Confirmed live:
`FLOOR_R2_FADE_SHORT`/`LONG` real N has been stuck at 3/1 for months as a direct structural
consequence, not because the level is rarely touched.

## Why this isn't a quick patch

`levelScalpSetup` is a single-slot object feeding a single `active` slot, a single trade brief,
a single `existingSetup` check, and a single INSERT (`acd.js` ~7540-9027). There's no loop to
"just don't break" — DeepSeek's review found this structural fact after Gemini's first-pass
critique missed it. The actually-correct implementation reuses a row shape that **already
exists**: the suppressed-audit insert (`acd.js:7845-7878`) already writes real, resolvable
`SHADOW` rows with full entry/stop/target from that type's own calibration, and those rows
already count toward `real_n` (`REAL_TRADE_FILTER` includes `SHADOW`). It just needs to fire for
every eligible cluster candidate, not only the one case it currently handles.

Two more things make this bigger than it looks:
1. **The N≥20 promotion gate has zero independence/distinct-day protection** — verified directly
   in `backtest_setup_status.mjs` (~line 277: rigor diagnostics are "informational only — does
   NOT feed into SUPPRESS/PROMOTE logic"). Cluster siblings inflate `real_n` without growing
   distinct days, so a level could go THIN_N→ACTIVE (live, real capital) on real trades spanning
   only 6-9 distinct calendar days. This is the exact bug class the `origin_status` hard rule
   was built to catch (previously BACKFILL; this would reintroduce it via same-instant siblings).
   Gemini's critique said this needed no change — verified that claim directly against the code
   and it's wrong. This must be fixed BEFORE siblings can safely feed per-type gating N.
2. **Three live pooled consumers exist today**, not future work: the `bet_class` SUPPRESS
   override inside `backtest_setup_status.mjs` itself (pools ~166 setup_types, can suppress the
   entire `VALUE_FADE`/level-fade family at once), `monitor_bet_correlation.mjs` (the
   roadmap's diversification guardrail, r<0.6 gate before any bet_class goes live at real
   capital), and `backtest_bet_class_status.mjs`. All three need cluster-awareness before the
   first sibling row is ever written, or they silently corrupt.

## Phase 0 — Verify before building anything (read-only, no code changes)

Run these first; they turn several "the plan assumes X" points into real numbers:
1. Sibling-count distribution per touch, from `confluence_levels_at_detection` (already
   persisted on every live INSERT) — how many levels typically cluster together in practice?
2. Count of early-touch-backfill rows with `resolution_method='MARK_TO_MARKET'` fired after
   13:00 ET — quantifies a separate, already-existing bug found along the way (below).
3. **The natural experiment**: `detectGlobexSetup()` (`acd.js` ~8433) already fires "every
   qualifier gets its own row regardless of ACTIVE/SHADOW status," no cluster dedup at all
   (deliberately not ported to RTH — see `OPEN_THREADS.md`'s prior entry on this). It already
   covers 29 levels including `WEEKLY_OPEN` as of 2026-08-25. Measure real sibling counts per
   touch, non-MTM resolution rate, and inter-sibling P&L correlation from this population
   directly — this replaces guessing at every one of these numbers for the RTH design.

## Phase 1 — Cheap, independent fixes (no schema change, ship immediately)

1. **Fix the early-touch backfill's stale 1PM ET expiry** (`acd.js:8845`,
   `` const sessionEndStr = `${todayET} 13:00:00` ``) — the exact hardcoded-timestamp bug class
   already fixed elsewhere per `CONVENTIONS_DETAIL.md:107`, just not here. Any early-touch
   backfill detected after 1PM gets an already-past `expires_at` → instant `TIME_EXPIRED`/
   `MARK_TO_MARKET` → excluded from `real_n`. May already be quietly starving the same levels
   this whole effort is trying to fix — independent bug, fix regardless of everything else.
2. **Fix the early-touch backfill's skip condition** (`acd.js:7955`,
   `if (Math.abs(currentPrice - lv.level) <= 15) continue`) — wrong assumption ("live path
   already covers this") that's false for every cluster loser. Change to skip only if that
   `setup_type` already has a row today (its own dedupe check already does this at ~8850-8854).
   Cheap partial fix, reuses an already-tested insert path.
3. **Make `cluster_attributed_setups` symmetric** — today only written when `clusterAlreadyFired`
   (`7885-7891`), never for the within-poll losers (exactly the `FLOOR_R2` case). One-line
   change; gives real measurement of how often/which types this happens to, before committing to
   the bigger build.

## Phase 2 — Schema + gating safety net (land BEFORE any sibling row is ever written)

1. Add `cluster_touch_id uuid` (nullable) **and** `is_cluster_primary boolean` to `active_setups`.
   Backfill ALL existing rows to `is_cluster_primary = true` — this is what keeps every existing
   pooled number continuous across the cutover (DeepSeek's point: a boolean flag beats
   query-time `DISTINCT ON` dedupe, which has no deterministic tie-break and can't promise
   continuity).
2. **Add the independence floor to the main gate** (`backtest_setup_status.mjs` ~line 399-419).
   Minimum viable: alongside `realN >= 20`, require a distinct-day (or distinct-`cluster_touch_id`
   -day) floor before promotion out of THIN_N — i.e. promote `rigor` from informational to
   gating, specifically for the N-floor decision. This is the prerequisite that makes it safe to
   ever let sibling rows count toward per-type gating N.
3. **Add `POOLED_TRADE_FILTER`** (`= REAL_TRADE_FILTER AND is_cluster_primary`), exported
   alongside `REAL_TRADE_FILTER` from the same module. Wire into all 3 live pooled consumers
   (`bet_class` override, `monitor_bet_correlation.mjs`, `backtest_bet_class_status.mjs`). Add a
   `test_invariants.mjs` check enforcing every pooled consumer imports the pooled filter, not the
   per-type one — this codebase already learned this exact lesson once (a drifted, un-synced
   filter string was the mechanism behind a prior DOW-pass bug).
4. **Make the same-day counters touch-aware, not row-aware:**
   - Stacking count (`acd.js:5957-5962`, feeds the live `>=7 → 0.10x` sizing cap) →
     `COUNT(DISTINCT COALESCE(cluster_touch_id, id))` instead of `COUNT(*)`.
   - Cascade breaker (`acd.js:6250-6256`) → distinct touch, not distinct `setup_type`.
   - Win/loss streak (`acd.js:5951`) → confirmed unaffected, it's `origin_status='ACTIVE'`-scoped
     only — this is the reason siblings MUST be `SHADOW`-origin, never `ACTIVE`.

## Phase 3 — The actual sibling-row insert

1. Extract the existing suppressed-audit insert (`acd.js:7845-7878`) into a shared helper.
2. Call it, after the winner is chosen, for every side-OK cluster candidate that independently
   clears its own full gate set — `suppression_reason='CLUSTER_SIBLING'`, `origin_status='SHADOW'`,
   `status='SHADOW'`, tagged with the touch's `cluster_touch_id` and `is_cluster_primary=false`.
   Winner keeps `is_cluster_primary=true`. Zero change to the winner loop, `active` slot, trade
   brief, banner, or socket emit — alerting is untouched.
3. Add a **sibling proximity gate** tighter than the 15pt cluster radius — every candidate's
   `entry` is `currentPrice` (`acd.js:7543`), so a loser 14pt from its own level would otherwise
   get a row implying a touch that didn't really happen at that price. This codebase already has
   a precedent constant (`MAX_SANE_ENTRY_DIST=20` in `backtest_entry_proximity_resimulation.mjs`)
   — derive or explicitly document the sibling threshold from it.
4. `RETURNING id` on every sibling insert, count and log — bare `ON CONFLICT DO NOTHING` (this
   codebase's standing convention) silently swallows a collision; without this, "did the fix
   actually produce rows" is unanswerable.
5. **Ship with siblings EXCLUDED from per-type gating N too** (route them through
   `POOLED_TRADE_FILTER`-equivalent logic everywhere, including the promotion floor, not just
   cross-type pooling) for 2-4 weeks. Real data over that window (sibling count per touch,
   non-MTM resolution rate, real inter-sibling correlation via `monitor_bet_correlation.mjs`)
   replaces every assumption this plan is currently making. This mirrors the shadow-then-promote
   discipline this codebase already applies to every new setup type — the same discipline
   applies to a new *row population*, not just a new setup name.
6. Add a **dated cutover marker** — pre-change real_n rows are winner-biased (only counted when
   that level won its cluster's EV sort); post-change rows include losers too. These two
   populations aren't exchangeable, and `computeRigor`'s chronological stability check will
   (correctly) start flagging affected types as unstable across the cutover. Write down which
   types are expected to flag, so it isn't misdiagnosed later as a new problem.
7. **Frontend: ship the second number with the change, not as a fast-follow.** Setup Reference /
   Alpha Engine Overview / Unified Signal Table (already surfacing real-N-vs-blended-N as of
   today) should show real N **and** independent N (`COUNT(*) FILTER (WHERE is_cluster_primary)`)
   side by side — a prose caveat is the wrong artifact once `real_n` is about to jump 2-3x for
   affected types.

## Phase 4 — After 2-4 weeks of real data (Phase 3 in production, siblings SHADOW + pooled-excluded)

Review real sibling-count/correlation/resolution data, then decide whether to flip siblings into
per-type gating N (now that the independence floor from Phase 2 exists to guard it). This is the
step that actually resolves `FLOOR_R2`'s starvation for real — everything before this point fixes
the surrounding safety mechanisms first.

## Phase 3b — shipped 2026-09-04 (RTH-only; Globex deferred)

**Outcome:** `scripts/backfill_cluster_touch_credit_20260904.mjs` ran for real 2026-09-04,
inserting 1,279 real, resolved `active_setups` SHADOW rows (1,299 candidates identified, 20 hit
`ON CONFLICT DO NOTHING` against real-time activity), `suppression_reason=
'CLUSTER_SIBLING_TOUCH_CREDIT_BACKFILL'`. Getting there took 3 Gemini dry-run rounds (the first
had a real bug — no normalization of 3+ historical naming conventions in
`confluence_levels_at_detection`, canonical/`_FADE`-suffixed/human-readable-display-string
variants mixed across time), then a Claude direct rewrite once the naming table was fully
verified, then 3 DeepSeek code-review rounds that found and fixed 3 more real bugs before
anything was written for real: wrong `resolution` schema vocabulary (would have silently
excluded or miscounted rows from every real-N/WR/EV query), a flat multi-day bar-walk cap that
contradicted the live session-end-expiry convention and inflated WR/EV, ~93 spurious raw sibling
instances from `STACK_VOL_BREAK_LIVE_*` winners (a structurally different engine wrongly treated
as a fade-cluster winner), and — found only on DeepSeek's 2nd confirmation pass, after the 1st
fix attempt reused the wrong row's `expires_at` — a per-setup_type expiry window bug (8 fade
types expire in 30 minutes, not the 16:00 ET session-end default most others use). Every dry-run
count was independently cross-checked against separately-written SQL before trusting it, not
just re-running the dispatched script.

Post-write: re-ran `update_optimal_stops.mjs` + `backtest_setup_status.mjs`. **27 SETUP_STATUS
changes**, all reviewed: 24 `THIN_N`→`SUPPRESS` (real N newly cleared 20, real EV negative — an
honest resolution of previously-thin data, not a demotion of anything live) and **3 real
`ACTIVE`→`SUPPRESS` demotions** — `ONL_FADE_LONG` (N=254, EV=-$8.04), `OR5_HIGH_FADE_LONG`
(N=67, EV=-$0.30), `OR5_LOW_FADE_SHORT` (real_n=59, real_ev=-$4.64, DEGRADING trend — its blended
EV of +$1.55 was propped up by non-real data, exactly the survivorship-bias risk this whole
project was built to catch). These 3 had been trading live capital on a winner-only-biased
sample; the previously-invisible losing sibling touches this backfill added flipped their true
EV negative. Tracked via `OPEN_DECISION cluster_touch_credit_phase3b_historical_backfill_scoped`
(RESOLVED).

**Not done: Globex-origin siblings.** The Globex engine (`detectGlobexSetup()`) uses a
structurally different naming convention (`levelBase`, `_OVERNIGHT`-suffixed types, 4 types that
share bare names with RTH siblings — see CLAUDE.md's "setup_type name-only classification is
structurally ambiguous" entry) and was deliberately out of scope for this pass, same as the
original plan's deferral of the 2 gap-conditioned RTH types (still also deferred). A second pass
would need its own naming-reconstruction table built the same rigorous way this one was — not
yet scoped.

The original goal and scoping notes below are kept as the historical record of what was planned
and executed, not a still-open TODO.

**Goal:** every historical touch where a level lost a confluence pick (2026-07-23 onward, when
`confluence_levels_at_detection` started being populated) gets the same real, resolvable
`active_setups` SHADOW row the live-forward fix now writes going forward — closing the ~3x
undercount confirmed directly from real data (1,863 real trades with confluence data recorded,
average 2.99 levels present per touch, only 1 ever got a row).

### Step 0 — prerequisite, do this regardless of whether the backfill ships

**Export `resolveSetupType()` as a real, standalone function.** It's currently a local closure in
`server/routes/acd.js` (search `const resolveSetupType = (rawType, lv) =>`, ~line 8342+), closing
over `allRthBarsRow` and `lp.PD_CLOSE` — not reusable by a standalone script. Move it to
`server/config/setupTypes.js` (already home to `inferDirection`, `resolveDirection`,
`getBetClass`, `CONDITIONAL_VARIANTS` as real exports) as a pure function taking
`(rawType, { level, sessionOpenBar, prevRthClose })` instead of reading from closure variables.
Update the live call site in `acd.js` to pass those two values explicitly (both already computed
nearby — `allRthBarsRow.rows.find(b => b.et_min === 570)` for the open bar, `lp.PD_CLOSE` for the
prior close). This satisfies the codebase's own "export the real function, never reimplement"
rule and is required for Step 2 below to be correct rather than a second, drifting copy.

### Step 1 — define the eligible population (the "safe subset")

`resolveSetupType()` applies conditional overrides for exactly 9 raw types — reconstructing the
real historical `setup_type` for any OTHER canonical level name is unambiguous regardless of
date. **Exclude these 9, backfill everything else:**

- 2 gap-conditioned (need that day's own 9:30 open bar / prior RTH close, real but not cheap):
  `WPP_FADE_SHORT` (→`_GAP_UP` variant), `OR5_LOW_FADE_LONG` (→`_GAP_DOWN` variant)
- 7 unconditional `_TRAIL` diversions, each with a real `addedDate` in `CONDITIONAL_VARIANTS`
  (touches before that date map to the BASE type, not `_TRAIL` — "unconditional" describes
  today's code, not the code live at each historical touch): `FLOOR_R1_FADE_SHORT` (2026-07-19),
  `PW_HIGH_FADE_LONG`/`PD_POC_FADE_LONG`/`FLOOR_S1_FADE_LONG`/`DAILY_OPEN_FADE_LONG`/
  `CAM_S2_FADE_LONG` (all 2026-07-21), `PD_POC_FADE_SHORT` (2026-08-26)

For the eligible (non-override) population, direction is NOT ambiguous: `dir` is cluster-global
(computed once per touch in the live code), so a sibling's direction = the winner's own
direction, recoverable from the winner's own `setup_type` suffix (`_LONG`/`_SHORT`) on the
already-stored row.

### Step 2 — reverse `canonicalConfluenceLevelName()`

`confluence_levels_at_detection` stores names through this exact stripping function
(`acd.js` ~line 83):

```js
function canonicalConfluenceLevelName(name) {
  const stripped = (name || '').replace(/_FADE$/, '');
  return stripped === 'RTH_VWAP' ? 'VWAP' : stripped;
}
```

Reverse it: `canonical === 'VWAP' ? 'RTH_VWAP_FADE' : `${canonical}_FADE``, then apply the
direction suffix and (for the eligible/non-override subset only) the now-exported
`resolveSetupType()` — which for this subset just returns the raw string unchanged, so this step
is mostly a formality confirming no override applies.

### Step 3 — for each eligible historical sibling, reconstruct and resolve as a real trade

For every real (`origin_status IN ('ACTIVE','SHADOW')`) winner row with `confluence_levels_at_detection`
containing 2+ canonical names, for each OTHER name in that array (not the winner's own type):

1. Reconstruct `candType` (Steps 1-2).
2. **Dedup check**: skip if `candType` already has ANY row within, say, ±20 minutes of the
   winner's `fired_at` on the same `trade_date` (avoid crediting a touch that's already covered
   by a real winner-fire, an early-touch-backfill row, or a prior backfill run of this same
   script) — reuse the exact style of dedup check the live suppressed-audit insert already does,
   don't invent a new one.
3. **Entry**: the sibling's own level (`cand.level` — the winner row doesn't store this directly
   for its siblings, so this needs the historical LEVEL PRICE at that moment, which for most
   level types is derivable the same way `keepLevelsAll` derives it live — check whether this is
   cheaply reconstructable per historical date via `developing_value_log`/`price_bars_primary`
   for each level family, or whether some level types' historical price simply isn't
   reconstructable from stored data and must be skipped. **This is the one open sub-question the
   live-forward fix didn't have to solve** (it has `cand.level` live, for free) — resolve it
   before writing the real backfill script, don't guess.
4. **Stop/target**: current `OPTIMAL_STOP` calibration for `candType` (same `liveStats._opt`-style
   lookup, applied retroactively — matches how every other historical-reconstruction insert in
   this codebase already works, e.g. the suppressed-audit insert, early-touch-backfill).
5. **Resolve as a REAL bar-by-bar walk**: fetch `price_bars_primary` from that historical
   `fired_at` moment forward, walk for stop-hit vs target-hit vs session-end mark-to-market —
   same logic `resolveSetupsByPrice()` runs live, don't reimplement a simplified version.
6. **Insert** with `suppression_reason='CLUSTER_SIBLING_TOUCH_CREDIT_BACKFILL'` (distinct from the
   live-forward `'CLUSTER_SIBLING_TOUCH_CREDIT'` — makes the backfilled population identifiable/
   removable on its own if something's wrong with it later), `origin_status='SHADOW'`,
   `status='RESOLVED'` (already resolved, unlike the live-forward version which inserts open).

### Step 4 — migration protocol (non-negotiable given the stakes)

Per `docs/DB_MIGRATION_PROTOCOL.md`, this is a bulk reconstruction touching potentially thousands
of rows across the live SUPPRESS/PROMOTE gate:
1. **Dry run first, in its own pass** — report counts per `setup_type` (how many backfilled rows
   each would get, and by how much real_n would move), zero writes. Show this to the user before
   anything executes.
2. **Gemini builds the dry-run script** (this is real DB-mining/reconstruction work, matches
   CLAUDE.md's Gemini-for-mining convention exactly) — Claude independently re-verifies the
   dry-run numbers via a separately-written query before trusting them (never just re-run
   Gemini's own script and call that verification).
3. **Claude — never Gemini — executes the actual write**, only after the dry-run numbers have
   been reviewed and the user has said go.
4. **DeepSeek code-reviews the backfill script before it runs for real** — same discipline as the
   live-forward fix, which caught 2 real bugs. Given the backfill's blast radius (potentially
   thousands of rows, many setup_types at once) is bigger than the live-forward fix's (one row at
   a time, growing slowly), this review matters more here, not less.
5. **After the real write**: re-run `scripts/update_optimal_stops.mjs` then
   `scripts/backtest_setup_status.mjs` (the same two-script daily-calibration cron) to refresh
   SETUP_STATUS off the new N. The distinct-day floor (shipped today, see above) will
   automatically protect any resulting promotion attempts — watch its log output
   (`DAY_CLUSTERED` lines) as much as the `PROMOTE`/`ACTIVE` lines. **Report every status change
   explicitly** (the user asked for this specifically) — diff `SETUP_STATUS` recommendations
   before vs. after using the DB's own history (see the query pattern used earlier the same
   session — rank by `run_date DESC`, compare `rn=1` vs `rn=2` per `signal_name`), not a
   snapshot file (one was tried same-session and silently wrote empty due to a `require()`-in-ESM
   bug — query the DB directly instead).

## Known adjacent findings (fix opportunistically, not blocking)

- `ARCHITECTURE.md:82` documents that the 6 level-fade gates deliberately don't write to
  `gated_candidates` (they already have an `active_setups` trail). If cluster losers get both a
  `LEVEL_FADE_CLUSTER_FALLBACK_SKIP` gated-candidate row AND a real `active_setups` row, that
  decision is violated — pick one when building Phase 3.
- `clusterAlreadyFired`'s 15-minute cluster lockout (`acd.js:7260-7269`) currently re-arms once
  the single open row resolves. With k open sibling rows, it would only re-arm once the LAST one
  resolves — a silent regression of the 2026-08-03 fix (`OPEN_DECISION
  cluster_dedup_blocks_reentry_after_first_fade_stopped`). Since siblings are SHADOW (not
  blocking `ACTIVE`/ open in the sense that check cares about — confirm the exact `status IN
  (...)` predicate against SHADOW rows before shipping Phase 3, this may already be fine).
