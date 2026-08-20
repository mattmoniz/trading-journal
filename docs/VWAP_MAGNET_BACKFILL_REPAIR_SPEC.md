# VWAP_MAGNET BACKFILL Entry-Price/Trade-Date Repair Spec

**Status: 2026-08-20, spec only, not yet built.** Written to be self-contained across a
context clear — read this doc plus `CLAUDE.md` and you should not need the prior
conversation. Resolves `OPEN_DECISION vwap_magnet_backfill_entry_price_trade_date_mismatch`
(HIGH). Read this before touching `active_setups` for any of the 4 setup_types below, or
before touching `scripts/update_optimal_stops.mjs`'s STOP-side calibration for them.

## The problem, and why it matters now

`active_setups.entry_zone_low` (and by extension `stop_level`/`t1_level`, computed
relative to it) does not correspond to real NQ market price at the row's own stored
`fired_at` timestamp on its own stored `trade_date`, for the **majority** of the
`resolution_method='BACKFILL'` population of all 4 VWAP_MAGNET-family setup_types:

| setup_type | checked | mismatched (>100pt from real price) | pct |
|---|---|---|---|
| `VWAP_MAGNET_LONG` | 1,149 | 972 | 84.6% |
| `VWAP_MAGNET_SHORT` | 575 | 416 | 72.3% |
| `GLOBEX_VWAP_MAGNET_LONG` | 2,000 (query-capped) | 1,584 | 79.2% |
| `GLOBEX_VWAP_MAGNET_SHORT` | 1,481 | 1,005 | 67.9% |

**Concrete example** (id=73950, `VWAP_MAGNET_LONG`, `trade_date=2026-06-17`,
`fired_at=11:43:00`): stored `entry_zone_low=29971.75`. Real NQ `close` prices at
11:40-11:50 ET that same date were 30409-30445 — checked bar-by-bar around the exact
`fired_at` minute, not a day-average artifact (a day-average lookup coincidentally landed
near the stored entry because NQ's full-day range that date was ~655pt wide, spanning
both zones at different times — a red herring, ruled out explicitly). The row's stored
`resolution='STOP_HIT'`/`actual_pnl=-$61` **is** internally consistent with its own
stored entry/stop ($2/pt × 30pt + $1 commission = $61) — meaning whatever process
originally computed this row used the same wrong entry/stop/target throughout, not just
a display artifact on top of otherwise-correct data.

**Why this is urgent, not just a historical curiosity**: these are the **4 highest-volume
LIVE setup_types today**. CLAUDE.md's "CURRENT STATE" note (under Optimal
stops/targets) already documents their stops are built on 93-97% synthetic BACKFILL
data, tracked by the still-open `optimal_stop_100pct_unguarded_fallback_needs_new_formula`
(HIGH). This finding sharpens that concern from "thin/unvalidated" to "actively
price-inconsistent with real market history" — meaning today's live `OPTIMAL_STOP`
calibration for all 4 types is very likely computing MAE/MFE/stop-sweep statistics
against corrupted price distances, not just a small/synthetic sample.

**Blast radius, scoped honestly**: `origin_status='BACKFILL'` rows are synthetic by
construction and never counted as realized/historical performance (CLAUDE.md's standing
`active_setups` caveat) — no real-money P&L reporting is corrupted by this. The actual
live consequence is narrower but still real: `sweepOptimalStopAndTarget()`
(`scripts/update_optimal_stops.mjs`) has never been `origin_status`-filtered (the exact
gap `optimal_stop_100pct_unguarded_fallback_needs_new_formula` already names), so this
corrupted population directly feeds the STOP distance chosen for live trades on these 4
setup_types right now.

## Phase 1 — root cause (do this first, don't repair blind)

**Goal**: identify which script originally generated these rows, and whether the bug is
systematic (fixable by understanding the mechanism) or scattered (needs a different
strategy).

1. `git log --all -S"VWAP_MAGNET" --oneline -- 'scripts/**'` and check `scripts/archive/`
   specifically — per the DB_MIGRATION_PROTOCOL.md convention, understand why the current
   data is the way it is before changing it. `backfill_level_fades.js` (the script behind
   the already-investigated `resolution_bar_time` bug) is a *different* setup family;
   confirm whether VWAP_MAGNET has its own dedicated backfill script or shares one.
2. Once found, read it for how it joins `entry_zone_low` to `trade_date`/`fired_at`. Given
   the prevalence is high (68-85%) and remarkably consistent across all 4 related
   setup_types, this reads as a systematic bug (e.g., a stale/cached price series, an
   off-by-N-days join, a symbol or table mixup), not random corruption — confirm this
   hypothesis before assuming a per-row root cause.
3. **Specific hypotheses to check, in order of plausibility**:
   - A `trade_date` computed from a *different* timestamp than `fired_at` (e.g., a batch
     `INSERT` that stamped all rows in a run with one shared/wrong date while `fired_at`
     varied correctly) — check whether mismatched rows cluster by `created_at`/insertion
     batch rather than being spread evenly across `trade_date`.
   - A price series join keyed on the wrong table/symbol/offset (similar in *shape* to
     the already-fixed ES-symbol-contamination bug, though that bug's specific 2023-11-15
     to 2023-12-15 window doesn't overlap these dates — check whether this is the *same
     bug class* recurring via a different code path, not the same historical incident).
   - A VWAP *computation* bug (the level itself computed from the wrong window/date),
     downstream of which entry/stop/target got derived correctly relative to a wrong
     VWAP value — distinguishable from the above by checking whether the mismatch
     magnitude correlates with how far real intraday VWAP moved that day.
4. Compute the mismatch's own distribution once the row-selection mechanism is
   understood: is it consistently "N days/weeks off" (pointing at a date-arithmetic bug)
   or unstructured (pointing at a join/contamination bug)? This determines whether Phase
   2's repair path is "shift and re-verify" or "re-derive from scratch."

## Phase 2 — decide the fix: repair vs. quarantine vs. re-derive

Do not pick a path before Phase 1 is done — the right choice depends on what's actually
wrong. Options, cheapest to most expensive:

**(a) Repair — shift/correct the stored fields once the mechanism is understood.** Only
viable if Phase 1 finds a clean, structured error (e.g., a fixed date offset) that can be
inverted with confidence. Follow `docs/DB_MIGRATION_PROTOCOL.md` exactly: dry-run first,
backup before any write, cross-check the corrected entry/stop/target against real bars at
the corrected timestamp before trusting it (same discipline as
`repair_resolved_at_timezone_bug_20260727.mjs` and this session's `resolution_bar_time`
fixes — verify a fresh re-walk against real bars produces the SAME resolution/pnl already
stored, don't just shift blindly).

**(b) Quarantine — exclude from calibration without deleting.** If Phase 1 finds
unstructured/unrecoverable corruption (or if repair confidence is low), add a way to mark
affected rows so `sweepOptimalStopAndTarget()` and any other consumer can filter them out
— check first whether an existing column already does this (per CLAUDE.md's "share
modules instead of reimplementing" convention: `origin_status` already covers a similar
case elsewhere) before adding a new one. A `resolution_method`-based flag or a new boolean
(e.g. `entry_price_verified`) are both plausible — decide based on whether other
setup_types could ever have the same defect and need the same flag.

**(c) Re-derive from real price history.** If neither (a) nor (b) is satisfying (e.g., the
*real* resolution/outcome for these touches is unknown and worth recovering, not just
excluding) — re-walk real `price_bars_primary` bars from a corrected `fired_at`/entry
point, matching the pattern `scripts/repair_dead_end_shadow_rows_20260727.mjs` used for a
different historical-casualty population. Most expensive; only worth it if the affected
population is too large a fraction of real signal to simply exclude (given these are
majority-BACKFILL/synthetic already, this is the least likely path — lean toward (a) or
(b) unless Phase 1 reveals something that changes this assessment).

## Interaction with `optimal_stop_100pct_unguarded_fallback_needs_new_formula`

That decision already calls for adding `origin_status` filtering to
`sweepOptimalStopAndTarget()` — a **separate, structural** fix (scoping to real trades,
independent of whether any individual BACKFILL row's price data is correct). This spec's
fix is **data-level** (are the BACKFILL rows themselves trustworthy). Do not conflate
them, but sequence deliberately:

- If the `origin_status` filter lands first and is aggressive enough to exclude BACKFILL
  entirely from these 4 setup_types' calibration, this spec's urgency drops (the
  corrupted data would no longer feed anything live) — check this before starting Phase 1
  in a future session, in case the other decision already resolved in the meantime.
- If this spec's fix lands first, `sweepOptimalStopAndTarget()`'s current unguarded
  behavior means a repair here immediately changes live stop distances for these 4
  types — treat that as a real, deliberate one-time re-baseline (matching the
  `bypassed_for_rebaseline_20260809` precedent already in the circuit-breaker's history),
  not a quiet routine update. Expect the circuit breaker to trip and require an explicit
  bypass, similar to prior corrections of this scale.

## Verification plan (required before closing this decision)

1. Dry-run count matches this spec's own numbers (984/416/1584/1005-ish, allowing for
   real new BACKFILL rows accumulating since 2026-08-20) before any write.
2. Post-fix, re-run this session's own prevalence check (>100pt from real price at
   `fired_at`) — expect it to drop to ~0% for whichever rows were repaired, or to
   correctly disappear from the live-eligible population if quarantined.
3. Re-run `scripts/update_optimal_stops.mjs` for these 4 setup_types specifically and
   diff the resulting stop/target against today's live values — expect the circuit
   breaker to trip (per the interaction note above); do not silently bypass it without
   reviewing the diff first.
4. Re-run `scripts/pilot_overshoot_control_check.mjs` (or any other script pooling across
   these 4 setup_types) and confirm the pooled EV magnitude is plausible (roughly -$100 to
   +$50/trade range, matching every other setup_type in this codebase) — this was the
   original symptom that surfaced the bug, and is the cheapest sanity check that the fix
   actually worked.
5. `node scripts/test_invariants.mjs` clean (no new FAILs beyond the existing baseline).

## What NOT to do

- Do not silently repair the entry price without root-causing Phase 1 first — an
  unstructured fix risks introducing a *second*, differently-wrong price, indistinguishable
  from the current bug without the same kind of audit that found this one.
- Do not re-run any pooled backtest/pilot script across these 4 setup_types and trust its
  output until this is resolved — flagged explicitly in the parent `OPEN_DECISION`.
- Do not treat this as urgent enough to bypass the circuit breaker casually once a fix
  lands — the breaker exists specifically to prevent exactly this class of "stop/target
  lurches on a data correction" from silently changing live risk.
