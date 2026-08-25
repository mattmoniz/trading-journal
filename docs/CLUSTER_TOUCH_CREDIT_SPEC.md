# Cluster Touch Credit — Phased Build Spec

**Status: NOT BUILT. Design-critiqued only (Gemini + DeepSeek, both independent, 2026-08-25).**
Nothing in this doc is live. Read `docs/OPEN_THREADS.md`'s 2026-08-25 "Cluster touch credit"
entry for the full narrative (how this was found, both critiques in full) before touching
anything here — this doc is the buildable plan, that entry is the reasoning trail.

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
