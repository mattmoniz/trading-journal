# VWAP_MAGNET BACKFILL `fired_at`/`resolved_at` Timezone Repair Spec

**Status: RESOLVED 2026-08-20, no live-risk action needed, timestamp repair remains
optional/not built.** `OPEN_DECISION vwap_magnet_backfill_entry_price_trade_date_mismatch`
closed the same day it was flagged, on its 3rd pass, after discovering the presumed
live-risk mitigation (`origin_status` filtering on the STOP-side population) was already
shipped 2026-08-09/10 — 10 days before this bug was even found. `rawByTypeReal`
(`origin_status IN ('ACTIVE','SHADOW')`) already feeds `computeStopTargetForType()` for
all 4 setup_types below; verified live via `notes.method` (`EV-sweep-real`/
`p75mae-real-fallback`, not a synthetic-derived method). **Neither the STOP nor TARGET
live calibration path reads BACKFILL-origin data for these types at all** — the
`fired_at`/`resolved_at` defect this doc describes has zero current live consequence.
This document is kept for whoever eventually wants to repair the historical BACKFILL
timestamps for analysis purposes (the mechanism below is still correct), but do not treat
it as urgent, and do not assume `CLAUDE.md`'s prior "CURRENT STATE" framing of this area
was accurate — it was stale by 10 days and has been corrected in the same session this
spec was resolved.

---

*Below is the mechanism writeup from the spec's corrected (2nd) version — still accurate
for the timestamp bug itself, just no longer describing an urgent problem.*

**This spec's first version (same date) mischaracterized the defect** — it framed this as
"`entry_zone_low` doesn't match real market price" and proposed a 2-phase
archaeology-then-choose-a-strategy plan. A DeepSeek Phase-0 review found the actual root
cause already diagnosed elsewhere in this codebase's own git history, and every load-bearing
claim below was independently re-verified against live data (not accepted on DeepSeek's
word) before rewriting this doc. See "What changed from the first version" at the bottom
if you're comparing against an earlier read of this file.

## The actual defect

`active_setups.fired_at` (and `resolved_at`) is stored **4 hours early (EDT
months)/5 hours early (EST months)** for the BACKFILL-origin population of all 4
VWAP_MAGNET-family setup_types — a naive ET-as-UTC timestamp round-trip bug, **not** a
corrupted entry price. `entry_zone_low`/`stop_level`/`t1_level`/`resolution`/`actual_pnl`
are all correct — computed from the true triggering bar — only the two timestamp columns
carry the wrong clock time.

**Mechanism** (confirmed via `server/db.js`): `price_bars_primary.ts` and
`active_setups.fired_at` are both naive `TIMESTAMP WITHOUT TIME ZONE` columns storing ET
wall-clock digits. `db.js`'s `setTypeParser(1114, val => new Date(val + 'Z'))` relabels
those ET digits as UTC on read (a deliberate "digit-preservation trick" per the file's own
header) — but node-postgres's default local-time serializer writes a JS `Date` back out
using the **process's own timezone** (`America/New_York`), which reapplies the ET offset
a second time. Net effect on a value that round-trips through a JS `Date` object: shifted
by the ET/UTC offset, 4h in EDT months, 5h in EST months.

**Origin**: `scripts/backtest_vwap_magnet.mjs` (RTH `VWAP_MAGNET_LONG/SHORT`) and
`scripts/backtest_globex_vwap_magnet.mjs` (`GLOBEX_VWAP_MAGNET_LONG/SHORT`), both built
2026-07-28. Both scripts set `entry = bars[i].close` and `fired_at = bars[i].ts` from the
*same* bar index — correct and self-consistent at the script level — but `bars[i].ts`
picks up the round-trip shift on the way into the DB. **This is not a new bug** — it is
the same defect commit `5da594c` (2026-08-02, "Fix target-calibration bug: BACKFILL
fired_at corruption inflated live targets 10-15x") already diagnosed and partially fixed,
for a *different* consequence (target-calibration lookahead via
`computeCorrectedTarget()`'s `expandedTrades` population). That fix added an
`origin_status IN ('ACTIVE','SHADOW')` filter to the *target-calibration* read path — it
did not correct the stored `fired_at`/`resolved_at` values themselves, and did not touch
`sweepOptimalStopAndTarget()` (the STOP side), which remains unfiltered — see
"Interaction" below.

### Verification (exact match, not approximate)

For id=73950 (`VWAP_MAGNET_LONG`, stored `fired_at`="2026-06-17 11:43:00", stored
`entry_zone_low`=29971.75): real NQ `close` at `fired_at + 4 hours` ("2026-06-17
15:43:00") is **29971.75 — an exact match, diff=0.00**. `resolved_at` ("2026-06-17
11:44:00", one minute after `fired_at`, consistent with a fast stop-hit in the original
simulation) shows the same pattern shifted by +4h. The true firing time for this row was
15:43 ET, not the stored 11:43 ET.

**The first version's ">100pt from real price" prevalence check (84.6%/72.3%/79.2%/67.9%
across the 4 setup_types) was measuring something real but mislabeled** — it was
detecting "NQ moved >100pt over the true 4-5h shift window," not "entry is corrupted."
The ~15-32% of rows that looked "clean" under that check are simply the rows where NQ
happened to move <100pt during their true 4-5h window — not a structurally different,
uncorrupted sub-population. **Re-verify this reframing with one query before building
anything** (per DeepSeek's flagged gap): confirm `entry_zone_low ≈ close_at(fired_at +
4h)` for Apr-Oct rows and `+5h` for Nov-Mar rows, at the *exact* `fired_at` instant (not a
day-average), across a real sample — the single-row check above supports this but a
population-level confirmation is still worth the one query before treating this as fully
closed.

## Is this population still growing?

Both scripts read "Built 2026-07-28" with no visible cron/scheduler wiring found — check
`crontab -l` and `run_weekly_backtests.sh`/`run_daily_calibration.sh` for either script
name before assuming the population is frozen. If neither runs on a schedule, this is a
**one-shot historical population** (fixed row count as of 2026-07-28), which simplifies
scoping — the fix targets a known, finite set, not an ongoing stream.

## Why this still matters live

These are the **4 highest-volume LIVE setup_types today**. Per CLAUDE.md's "CURRENT
STATE" note and the still-open `optimal_stop_100pct_unguarded_fallback_needs_new_formula`
(HIGH), their stops are built on 93-97% synthetic BACKFILL data, and
`sweepOptimalStopAndTarget()` has never been `origin_status`-filtered. Unlike the
already-fixed target-calibration path, this means **today's live STOP calibration for all
4 types is reading a population where `fired_at`/`resolved_at` (and therefore any
duration/bars-to-resolution derived from them) are wrong**, even though the underlying
entry/stop/target/outcome data is fine. The severity is about *timing-derived* statistics
(bars-to-resolution, any time-of-day conditioning), not price-derived ones (MAE/MFE/stop
distance itself, which use the correct entry/exit prices directly).

## The fix — quarantine first, repair as an optional, decoupled follow-up

The first version of this spec ordered repair before quarantine ("cheapest first"). That
was backwards for this specific bug, per DeepSeek's review:

1. **The live-risk fix and the data fix are different operations.** Adding
   `origin_status` filtering to `sweepOptimalStopAndTarget()` (exactly what
   `optimal_stop_100pct_unguarded_fallback_needs_new_formula` already calls for)
   neutralizes the live-calibration risk completely, independent of whether any BACKFILL
   row's timestamp is ever corrected. **Do this first, unconditionally, and do not wait
   on this spec to do it** — it's the same fix regardless of root cause.
2. **Timestamp repair is optional and lower-priority.** Since `entry_zone_low`/
   `stop_level`/`t1_level`/`resolution`/`actual_pnl` are already correct, the ONLY reason
   to repair `fired_at`/`resolved_at` is if some consumer needs correct timing-derived
   stats from this population (e.g. a bars-to-resolution or time-of-day analysis that
   pools BACKFILL rows) — check whether one exists before spending effort here.
3. **If repair is pursued**, it is a straightforward **signed shift**, not the archaeology
   or re-derivation the first version proposed: `fired_at = fired_at + (is_dst(trade_date)
   ? interval '4 hours' : interval '5 hours')`, same for `resolved_at`. Follow
   `docs/DB_MIGRATION_PROTOCOL.md`: dry-run first, backup before write, and verify the
   shifted timestamp actually lands on a real bar whose `close` matches the stored
   `entry_zone_low` (per row, not just in aggregate) before trusting the shift direction
   and magnitude — this is the same discipline this session already applied successfully
   to the 3 ES-era rows and the 12,641-row `resolution_bar_time` repair (both found via
   `docs/DB_BACKUP_CATALOG.md`'s 2026-08-20 entries).

## Interaction with `optimal_stop_100pct_unguarded_fallback_needs_new_formula`

**Decoupled, not sequenced** — the first version's "check whether the other decision
resolved first" framing risked both HIGH decisions waiting on each other indefinitely
(flagged by DeepSeek as a real deadlock risk, and confirmed still `PENDING` as of this
rewrite). Correct framing:

- The `origin_status` filter that decision calls for should land **regardless of this
  spec** — it's a structural fix, valid whether or not any BACKFILL timestamp is ever
  corrected.
- Once it lands, `sweepOptimalStopAndTarget()`'s current unguarded behavior means the
  filter itself immediately changes live stop distances for these 4 types — treat that as
  a deliberate one-time re-baseline (matching the `bypassed_for_rebaseline_20260809`
  precedent), not a quiet routine update. Expect the circuit breaker to trip.
- This spec's own scope (timestamp repair) can proceed independently, whenever picked up,
  without waiting on the other decision landing first.

## Verification plan

1. **Before any write**: confirm the 4h/5h shift prediction holds across a real sample
   (not just id=73950) — `entry_zone_low ≈ close_at(fired_at + 4or5h)` for a random
   sample of ~20 rows per setup_type, checking the exact `fired_at` instant.
2. **If repairing timestamps**: after the shift, re-verify per row that the shifted
   `fired_at`'s bar matches `entry_zone_low` and the shifted `resolved_at`'s bar is
   consistent with the stored `resolution` (STOP_HIT/TARGET_HIT) — the re-walk-consistency
   check, not just "does the aggregate mismatch rate drop to zero" (which a *wrong* fix,
   e.g. rewriting `entry_zone_low` instead of `fired_at`, could also satisfy while leaving
   the row's story internally inconsistent).
3. **If adding the `origin_status` filter to `sweepOptimalStopAndTarget()`**: diff the
   resulting stop/target against today's live values for all 4 setup_types before
   trusting it; expect and review a circuit-breaker trip rather than bypassing blind.
4. `node scripts/test_invariants.mjs` clean (no new FAILs beyond the existing baseline).

## What NOT to do

- Do not repair `entry_zone_low` to match a still-wrong `fired_at` — this "fixes" the
  symptom (the >100pt mismatch check) while leaving the row's actual defect (wrong
  timestamp) in place and now ALSO breaking the previously-correct entry/stop/target
  consistency. This is the exact trap the first version's own verification plan would not
  have caught.
- Do not apply a single fixed offset (e.g. always +4h) across the whole population —
  DST-dependent, will be wrong for Nov-Mar rows.
- Do not treat the `origin_status` filter as blocked on this spec, or this spec as blocked
  on that filter landing — they're decoupled fixes for the same underlying population.

## What changed from the first version (2026-08-20, same day)

- Root cause: was "unknown, needs archaeology in `scripts/archive/`" → now "known,
  diagnosed in commit `5da594c` (2026-08-02), the exact originating scripts identified
  (`scripts/backtest_vwap_magnet.mjs`/`backtest_globex_vwap_magnet.mjs`, both live in
  `scripts/`, not archived)."
- Defective field: was "`entry_zone_low`" → now "`fired_at`/`resolved_at`"; entry/stop/
  target/resolution/pnl are all correct.
- Fix order: was "repair (cheapest) → quarantine → re-derive" → now "quarantine
  (`origin_status` filter, decoupled and immediate) first; timestamp repair optional and
  separate."
- Sequencing with the sibling HIGH decision: was "wait and check if it resolved first" →
  now "decoupled, no dependency either direction."
- Verification: added the re-walk-consistency requirement (was implicit/buried, now
  promoted to the actual verification plan) to prevent a "passes the aggregate check but
  is still wrong" repair.
