# Unified live-gate checkpoint — scope (2026-09-02)

**Status: scoped, zero code changed.** Follow-up to the sibling-reversal gate
(`isPostWinOppositeFamilyBlocked()`) shipped the same session — DeepSeek's code review of that
gate found it was wired into only 2 of `active_setups`'s 7 real INSERT sites, and the user asked
directly: "shouldn't there be one insert site?" This doc scopes the real fix. **User explicitly
prioritized this spec above `docs/ROSTER_WIDE_INVALIDATION_BOUNDARY_WHITELIST_SPEC.md`** — do
this one first next session.

## The problem, restated precisely

`server/routes/acd.js` has **7 places** that `INSERT INTO active_setups`:

| line (as of commit ab81fce) | what it inserts | can produce `status='ACTIVE'`? |
|---|---|---|
| 2269 | Globex candidates (`detectGlobexSetup`) | yes |
| 4917 | `STACK_VOL_BREAK_LIVE_LONG/SHORT` | yes |
| 7873 | cascade-breaker audit rows | no — always `status='EXPIRED'` |
| 8610 | suppressed-audit SHADOW rows | no — always `status='SHADOW'` (hardcoded literal) |
| 9691 | early-touch backfill SHADOW rows | no — always `status='SHADOW'` (hardcoded literal) |
| 10092 | RTH `active` slot (the main level-fade candidates array) | yes |
| 10310 | RTH `shadowCandidates` loop — the ACTUAL fire path for `STOP_SWEEP`, `VWAP_MAGNET` (RTH-side), `VWAP_RECLAIM`, `C_PAIRED`, `C_REVERSAL`, `TRT`, `BRACKET_BREAKOUT` | yes |

**4 of the 7 sites can produce a real `ACTIVE` row** (2269, 4917, 10092, 10310) — those are the
only ones any live-gating mechanism actually needs to reach. Each of those 4 currently
hand-assembles its own `forceShadow`-equivalent boolean from a different subset of checks,
independently. There is no single place a new gate can be added once and guaranteed to apply
everywhere it should.

**This is not a one-off mistake — it's a recurring pattern.** The sibling-reversal gate shipped
this session needed a follow-up fix (commit `ab81fce`) to reach 2 sites it missed on the first
pass. Before that, the cross-direction-fast-flip gate (`isCrossDirectionFastFlip`, the mechanism
this session's new gate is modeled on) was originally built for Globex only and needed a
*separate*, later commit to add RTH coverage — RTH's own candidates don't all flow through one
insert site either. Two different gates have now independently hit the same structural gap.

## Why this is NOT simply "merge the 7 INSERTs into 1"

The 4 live-capable sites have genuinely different shapes, not just historical accident:
- **Different available context.** The Globex site has `c` (a Globex candidate object with its
  own field names); the RTH `active` slot has `active`; the `shadowCandidates` loop has `shadow`;
  `STACK_VOL_BREAK_LIVE` has its own locally-scoped `svEntry`/`svStop`/etc. Merging the INSERT
  statements themselves would mean unifying these shapes first — a much bigger, riskier
  refactor than this problem calls for.
- **Different columns.** `STACK_VOL_BREAK_LIVE`'s INSERT carries `extend_target_level`; the
  `shadowCandidates` loop's INSERT has no `suppression_reason` column at all (a separate,
  pre-existing gap, not addressed by this spec — noted for awareness, not in scope).
- **Not every check applies everywhere.** Confirmed directly (`grep`): `isTrailMechanism` is
  computed once, scoped only to the RTH `active` slot (line ~10000) — it has no meaning for
  `STACK_VOL_BREAK_LIVE` or the Globex path, which aren't trail-mechanism candidates. A blind
  "run every check at every site" consolidation would be **wrong**, not just redundant — it
  would apply checks to sites they were never designed for.

**So the fix is not merging the INSERT statements.** It's building **one shared gate-evaluation
function** that every live-capable insert site calls before deciding its `status`, where each
check inside that function is itself responsible for correctly no-op'ing when it doesn't apply
to the calling context (the same pattern `isPostWinOppositeFamilyBlocked` and
`isCrossDirectionFastFlip` already use — they return `false`/don't block when their own
preconditions aren't met, e.g. a null `dir`). The INSERT statements themselves stay separate;
only the "should this be forced to SHADOW, and why" decision gets centralized.

## Proposed shape (sketch, needs design critique before implementation)

```javascript
// One shared checkpoint, called by all 4 live-capable insert sites before choosing status.
// Returns { forceShadow: boolean, reason: string | null }. Each individual check function is
// responsible for its own no-op conditions (a null direction, a check that doesn't apply to
// this call site's family, etc) -- this function does not itself decide which checks are
// "relevant" to the caller; the caller passes only the context it actually has, and checks that
// need context the caller can't provide (e.g. isTrailMechanism, which is meaningless outside the
// RTH active-slot's trail-variant resolution) are opt-in via the `applicable` parameter, not
// silently run against a context they don't understand.
async function evaluateLiveGates(tradeDate, setupType, direction, {
  isTrailMechanism = false,       // only meaningful for the RTH active-slot call site
  suppressedSetupsCheck = true,   // liveStats._suppressedSetups?.has(setupType)
  newEntryDeadZoneCheck = true,
  refireCooldownCheck = true,
  exposureOverrideCheck = true,
  crossDirectionFlipCheck = true,
  postWinOppositeFamilyCheck = true,
} = {}) {
  // ... runs each applicable check in the SAME priority order the current forceShadowReason
  // chains already use (isTrailMechanism > suppressed > deadzone > refire > exposure >
  // crossDirectionFlip > postWinOpposite > PERFORMANCE_BELOW_THRESHOLD), first one that fires
  // wins, matching existing behavior exactly -- this is a refactor, not a behavior change.
}
```

## Required before implementation (per this project's standing rule for live-risk code)

1. **Build the definitive "which checks currently apply at which of the 4 sites" matrix first**,
   by reading each site's actual current logic (not assuming) — this doc's table above is a
   starting point, not the finished audit. Get this matrix design-critiqued before writing the
   shared function, since an incorrect matrix would silently change live behavior at a site
   (exactly the failure mode this refactor exists to prevent, ironically).
2. **Migrate one site at a time**, each with an explicit before/after check (same real
   candidates, same day, verify `forceShadow`/`status` output is byte-identical before and
   after the migration) — not a single big-bang replacement across all 4 sites at once.
3. **A phase-0 design critique of the matrix + shared-function shape** (this doc is the input to
   that critique, not a substitute for it) before any code is written.
4. **A code-review pass on the actual diff** before it ships, same as every other live-risk
   change this session.

## What this spec does NOT cover (explicitly out of scope)

- The 2 pre-existing gaps noted in the table (`shadowCandidates` loop missing
  `suppression_reason` entirely, `STACK_VOL_BREAK_LIVE`'s different column shape) — real, but
  separate from the gate-consolidation problem this spec addresses.
- The 3 always-non-ACTIVE insert sites (7873, 8610, 9691) — correctly out of scope, since no
  live-gating mechanism can ever have anything to prevent there.
- `docs/ROSTER_WIDE_INVALIDATION_BOUNDARY_WHITELIST_SPEC.md` (the `structurallyInvalidateSetups()`
  extension) — a related but independent piece of work, explicitly SECOND priority per user
  instruction, not blocked by this one or vice versa.

## Suggested entry point for whoever picks this up

1. Build the per-site check-applicability matrix (item 1 above) by reading the actual current
   code at all 4 live-capable insert sites — this is a research/audit task, not a build task.
2. Send that matrix + this spec to DeepSeek for a design critique before writing any shared
   function.
3. Only then implement, migrating one site at a time with the before/after verification in
   item 2 of "Required before implementation."
