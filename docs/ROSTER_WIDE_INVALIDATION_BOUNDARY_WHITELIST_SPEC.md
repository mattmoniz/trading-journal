# Roster-wide invalidation-boundary whitelist extension — scope (2026-09-02)

**Status: scoped, zero code changed for this specific extension.** Follow-up to the same-day
IB_HIGH/IB_LOW invalidation-boundary fix (`docs/OPEN_THREADS.md`'s 2026-09-02 entry) and the
DeepSeek roster-wide audit that found the same bug shape extends well beyond the 8 already-fixed
IB types. Read this doc fresh before touching `structurallyInvalidateSetups()` again.

## The bug, restated precisely (already fixed for 8 types, NOT yet fixed for the rest)

`structurallyInvalidateSetups()` (`server/routes/acd.js` ~2364) kills a SHORT setup the instant
price closes above the day's **Opening Range High**, and a LONG setup below **Opening Range
Low** — correct only for setup types whose faded level is naturally near/inside the OR. Already
fixed for `IB_HIGH_FADE_*`/`IB_LOW_FADE_*`/`PD_IB_HIGH_FADE_*`/`PD_IB_LOW_FADE_*` (8 types),
which now resolve their own real level (today's IB or prior-day IB via `level_prices`) instead
of the OR, per-level not per-direction, with 2 real bugs found and corrected by a DeepSeek
review before shipping (see that entry for the full story).

**The same bug shape exists for every other fade family whose level sits structurally outside
the Opening Range.** Confirmed via direct DeepSeek roster audit + Claude verification.

## Full affected-family list, ranked by real N × born-past rate

| rank | family | combined real N | combined born-past | level source | live callers include |
|---|---|---|---|---|---|
| 1 | `PD_VAH`/`PD_VAL`/`PD_POC` | 238 | 91 | `lp.PD_VAH`/`lp.PD_VAL`/`lp.PD_POC` (`level_prices`) | `PD_VAH_FADE_SHORT` (SETUP_STATUS ACTIVE), `PD_VAL_FADE_LONG`, `PD_POC_FADE_SHORT/LONG` |
| 2 | `PW_VAL`/`PW_VAH`/`PW_POC` | ~30 (thinner) | 13+ | `lp.PW_VAL`/`lp.PW_VAH`/`lp.PW_POC` | `PW_VAL_FADE_LONG`, etc. |
| 3 | `IB_MID_SCALP` | 63 | 13 | `(ibHigh + ibLow) / 2` (today's IB midpoint, already computed in scope for the IB branch) | `IB_MID_SCALP_FADE_LONG/SHORT` |
| 4 | `FLOOR_R1` | 21 | 10 | `lp.FLOOR_R1 ?? floorR1` | `FLOOR_R1_FADE_LONG` |
| 5 | `CAM_S2` | 40 | 12 | `lp.CAM_S2` | `CAM_S2_FADE_SHORT`, `CAM_S2_FADE_LONG_TRAIL` |
| 6 | `ONL`/`ONH` | 44 | 11 | `lp.ONL`/`lp.ONH` | `ONL_FADE_LONG/SHORT` |
| 7 | `PD_IB_MID` | 63 | 15 | `lp.PD_IB_MID ?? pdIbMid` | `PD_IB_MID_FADE_LONG/SHORT` |

All 7 resolve from `level_prices` by name (or, for `IB_MID_SCALP`, from values already fetched
in scope for the existing IB branch) — the exact same shape as the already-shipped
`PD_IB_HIGH`/`PD_IB_LOW` fix. No new query pattern needed, just extending the existing one.

**Not in scope for this whitelist extension (need the separate universal fix instead):**
- `RTH_VWAP_FADE` (level = `earlyVwap`) and `GLOBEX_VWAP_FADE`/`GLOBEX_VWAP_MAGNET` (level =
  `vwap24`) — both are live-computed rolling values, not static named lookups in `level_prices`.
  Can't be resolved by name at invalidation-check time the way the others can.
- `3M_VAL`/`PY_*`/other year-scale levels — low real touch frequency (`ARCHITECTURE.md` notes
  `PY_VAL` has 0 touches over ~2.3 years), immaterial in practice even though structurally the
  same bug.
- `GLOBEX_VWAP_FADE` specifically was also found to be currently **unguarded**, not mis-bounded,
  during Globex hours (the function bails entirely when `acd_daily_log.or_high`/`or_low` don't
  exist yet, which is most of an overnight trade's life) — a different, lower-urgency gap.

## Confirmed NOT part of this bug (checked directly, don't re-investigate)

- **`OR5_HIGH_FADE`/`OR5_LOW_FADE`/`OR5_MID_FADE`** — level literally IS the OR (`orH`/`orL`/
  `orMid` read from the same `acd_daily_log.or_high`/`or_low` column the invalidation check
  itself uses). The apparent anomaly (`OR5_HIGH_FADE_SHORT` showing 9 real invalidations) was
  traced to early-touch-backfill entries whose recorded `price_at_detection` overshoot the OR by
  a small amount (0.5–14.5pt, confirmed directly against the DB) — a measurement artifact, not a
  boundary mismatch. **No fix needed for the OR5 family.**

## Proposed implementation (mirrors the shipped IB fix's shape exactly)

Extend the existing `Promise.all` fetch block in `structurallyInvalidateSetups()` with one more
query for the 7 additional named levels, then resolve the correct level by setup_type name
(independent of direction, same lesson as the IB fix — a level can be approached from either
side), falling back to OR only if the specific level truly isn't available:

```javascript
// Added to the existing Promise.all alongside the IB/PD_IB queries:
query(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND level_name IN
       ('PD_VAH','PD_VAL','PD_POC','PW_VAH','PW_VAL','PW_POC','FLOOR_R1','CAM_S2','ONH','ONL','PD_IB_MID')`,
      [todayET]),

// Resolver (mirrors resolveFadeLevel sketch from the roster audit, DeepSeek-reviewed shape):
function resolveExtendedFadeLevel(setupType, lp, ibHigh, ibLow) {
  // Strip _TRAIL/_GAP_UP/_GAP_DOWN before matching -- CAM_S2_FADE_LONG_TRAIL is the same level
  // as CAM_S2_FADE_LONG. Missing this silently leaves the TRAIL variants unfixed (this exact
  // mistake was made and caught in the sibling-reversal gate shipped the same session --
  // see docs/OPEN_THREADS.md's 2026-09-02 "sibling reversal" entry for the concrete bug shape).
  const t = setupType.replace(/_(TRAIL|GAP_UP|GAP_DOWN)$/, '');
  if (t.startsWith('PD_VAH_FADE'))      return lp.PD_VAH ?? null;
  if (t.startsWith('PD_VAL_FADE'))      return lp.PD_VAL ?? null;
  if (t.startsWith('PD_POC_FADE'))      return lp.PD_POC ?? null;
  if (t.startsWith('PW_VAH_FADE'))      return lp.PW_VAH ?? null;
  if (t.startsWith('PW_VAL_FADE'))      return lp.PW_VAL ?? null;
  if (t.startsWith('PW_POC_FADE'))      return lp.PW_POC ?? null;
  if (t.startsWith('IB_MID_SCALP_FADE')) return (ibHigh != null && ibLow != null) ? (ibHigh + ibLow) / 2 : null;
  if (t.startsWith('FLOOR_R1_FADE'))    return lp.FLOOR_R1 ?? null;
  if (t.startsWith('CAM_S2_FADE'))      return lp.CAM_S2  ?? null;
  if (t.startsWith('ONH_FADE'))         return lp.ONH ?? null;
  if (t.startsWith('ONL_FADE'))         return lp.ONL ?? null;
  if (t.startsWith('PD_IB_MID_FADE'))   return lp.PD_IB_MID ?? null;
  return null; // not one of these 7 families -- caller falls through to existing OR-based logic
}
```

Wired into the existing `else` branch (the one currently doing blanket OR-based invalidation for
everything that isn't a bracket or an IB type): if `resolveExtendedFadeLevel()` returns non-null,
use `direction === 'SHORT' ? currentPrice > level : currentPrice < level` (the same universal
rule the IB fix uses); otherwise fall through to the existing OR-based check unchanged, so this
extension is purely additive — every setup type NOT in these 7 families behaves exactly as
before.

## Open questions to resolve before/during implementation (explicitly NOT decided yet)

1. **Fallback semantics when the named level is missing** (e.g. `level_prices` row not yet
   computed for today). The shipped IB fix falls back to OR (`pdIbHigh ?? orHigh`). Should this
   extension do the same (`resolveExtendedFadeLevel() ?? orHigh/orLow` per direction), or fall
   back to "no invalidation check at all" (skip)? Flagged as a genuine fork in the original
   roster audit — needs a deliberate call, not a default.
2. **`ONH`/`ONL` naming** — confirmed both level names exist in `level_prices`
   (`SELECT DISTINCT level_name ...` returned both), but no `ONH_FADE_*` real trades were found
   in the current dataset (only `ONL_FADE_*`). Include `ONH` in the resolver anyway for
   forward-completeness (matches the "applies to all setups, not a hardcoded subset that goes
   stale" convention this codebase already insists on elsewhere) — confirm this reasoning still
   holds before shipping.
3. **Should `PD_IB_MID` really be batched with this group, or with the already-shipped IB
   fix?** It's a prior-day level like `PD_IB_HIGH`/`PD_IB_LOW`, but wasn't part of the original
   IB fix's scope (that fix only covered HIGH/LOW, not MID). Confirm it belongs here, not as a
   3rd correction to the already-shipped IB fix.

## Required before shipping (per this project's standing rule for live-risk code)

1. **Backtest first, mirroring `scripts/backtest_ib_high_low_invalidation_boundary_fix.mjs`'s
   exact methodology** (clean bar-by-bar re-walk of both OLD-boundary and NEW-boundary scenarios
   for every real historical trade of these 7 families, not a replay of what the live poller
   happened to catch) — get a real $ delta and rigor check before touching live code, the same
   process the IB fix went through (twice, after DeepSeek caught 2 real bugs in the first
   version).
2. **A phase-0 design critique of the exact resolver + fallback-semantics decision** before
   writing the live code (this doc is that critique's input, not a substitute for it — the 3
   open questions above need real answers, not defaults).
3. **A code review pass on the actual diff** before it ships, same as both prior fixes this
   session.
4. **Verify the change doesn't regress** the already-shipped IB fix or the OR5 family — these 7
   new families are a disjoint set from both, but confirm the branch ordering in
   `structurallyInvalidateSetups()` doesn't accidentally short-circuit incorrectly once this
   extension is added (IB branch first, then this extension, then generic OR fallback last).

## Suggested entry point for whoever picks this up

1. Build and run the walk-forward backtest first (item 1 above) — this is the same kind of task
   Claude built directly for the IB fix (not dispatched to Gemini, since the exact methodology
   already exists as a template to adapt, same precedent).
2. Send the backtest script + real results + the 3 open questions above to DeepSeek for design
   critique, same shape as every other higher-stakes change this session.
3. Only then write the actual `structurallyInvalidateSetups()` diff, and send THAT for a
   separate code-review pass before shipping.
