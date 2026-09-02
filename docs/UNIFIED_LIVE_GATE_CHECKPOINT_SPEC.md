# Unified live-gate checkpoint — scope (2026-09-02, DeepSeek-corrected same day)

**Status: scoped, zero code changed.** Follow-up to the sibling-reversal gate
(`isPostWinOppositeFamilyBlocked()`) shipped the same session — DeepSeek's code review of that
gate found it was wired into only 2 of `active_setups`'s 7 real INSERT sites, and the user asked
directly: "shouldn't there be one insert site?" This doc originally scoped a shared-function
refactor confined to `server/routes/acd.js`. **DeepSeek's design critique of that first version
(full text: `scratch/deepseek_response.md` as of 2026-09-02) found the scope itself was wrong in
the same way the original bug was — its "4 live-capable sites" census undercounted reality by 3
sites outside `acd.js`.** This version replaces the original scope with DeepSeek's corrected
census, corrected function shape, and corrected sequencing. **User explicitly prioritized this
spec above `docs/ROSTER_WIDE_INVALIDATION_BOUNDARY_WHITELIST_SPEC.md`** — do this one first.

## Verdict (DeepSeek, verbatim framing)

> The spec's *direction* is right (centralize the gate-*decision*, not the INSERT), but its
> *scope* is wrong in a way that reproduces — one level up — the exact failure it exists to
> prevent. Its "4 live-capable sites" census is a strict subset of reality; it misses 3
> live-capable INSERT sites outside `acd.js`. Its proposed `{ forceShadow, reason }` shape cannot
> express the `skip`-vs-`force-SHADOW` distinction that already exists across the 4 sites it
> *does* count.

**Recommendation: do NOT build the runtime `evaluateLiveGates` refactor next.** Do three things
in order instead (full reasoning in "Corrected sequencing" below):
1. Ship a cheap `test_invariants.mjs` structural check now — zero live risk, directly answers
   "shouldn't there be one insert site?" by making a missed site impossible to forget rather than
   by actually building one site.
2. Fix the base-eligibility divergence (`getCanonicalLiveStatus` vs `isLiveEligible` vs the RTH
   slot's fail-**open** `_suppressedSetups.has()`) as its own, separate, higher-risk change — this
   is a real fail-open bug, more dangerous than any of the force-shadow gates this spec was
   originally about.
3. Only then build the force-shadow consolidation, using the corrected shape below, one site at a
   time under a dual-run assertion (not byte-diff-by-eye).

## The problem, corrected census

`active_setups` has **10 total INSERT sites** across the codebase, not 7, and **7 are
live-capable** (can produce a real `status='ACTIVE'` row), not 4:

| file:line | what it inserts | can produce `ACTIVE`? | gates reached today |
|---|---|---|---|
| `acd.js:2269` | Globex candidates (`detectGlobexSetup`) | yes | refire(skip), crossDirectionFlip, postWinOpposite |
| `acd.js:4917` | `STACK_VOL_BREAK_LIVE_LONG/SHORT` | yes | postWinOpposite only — **missing** deadzone, refire, crossDirectionFlip |
| `acd.js:7873` | cascade-breaker audit rows | no — always `status='EXPIRED'` | n/a |
| `acd.js:8610` | suppressed-audit SHADOW rows | no — always `status='SHADOW'` (hardcoded) | n/a |
| `acd.js:9691` | early-touch backfill SHADOW rows | no — always `status='SHADOW'` (hardcoded) | n/a |
| `acd.js:10092` | RTH `active` slot (main level-fade candidates array) | yes | trailMechanism, suppressed(fail-**open**), deadzone, refire, exposureOverride, crossDirectionFlip, postWinOpposite — the only site with full coverage |
| `acd.js:10316` | RTH `shadowCandidates` loop — fire path for `STOP_SWEEP`/`VWAP_MAGNET`(RTH)/`VWAP_RECLAIM`/`C_PAIRED`/`C_REVERSAL`/`TRT`/`BRACKET_BREAKOUT` | yes | refire(skip), postWinOpposite — **missing** deadzone, crossDirectionFlip |
| `server/services/minuteBarSignalDetector.js:181` | `MOMENTUM_60m_60m_TREND` | **yes** — hand-rolled `getLiveStatus()` (N≥20 && ev≥−5) | **none of the 7 checks** |
| `server/services/rthFlushDetector.js:180` | `RTH_FLUSH_LONG/SHORT` | **yes** — same hand-rolled pattern | **none of the 7 checks** |
| `server/services/globexFlushDetector.js:228` | `GLOBEX_FLUSH_*` | **yes** — same hand-rolled pattern | **none of the 7 checks** |
| `server/services/pocRotationJoinDetector.js:140` | `POC_ROTATION_JOIN_*` | no — hardcoded `status='SHADOW'` | correctly out of scope |

The 3 service-site pollers are wired into `server/index.js`'s 60s `setInterval` (lines
1530–1539) and each does its own N≥20/ev≥−5 `getLiveStatus()` check with **zero** exposure to
`CAPITAL_EXPOSURE_OVERRIDE`, refire-cooldown, cross-direction, or sibling-reversal protection.
This is not hypothetical — the moment any of these 3 setup_types accumulates N≥20 with ev≥−5, it
fires `ACTIVE` completely unprotected by every gate this spec is about. The original version of
this spec grep'd only `acd.js` and never surfaced this.

## Corrected per-check matrix (DeepSeek, verified directly against code)

Legend: **shadow** = insert as `SHADOW` with a reason; **skip** = no row at all; **—** = check
absent at that site (a real gap, not a deliberate no-op unless noted otherwise).

| check | A: Globex (2269) | B: STACK_VOL (4917) | C: RTH active (10092) | D: shadowCandidates (10316) | E/F/G: service pollers |
|---|---|---|---|---|---|
| `isTrailMechanism` | — (Globex has its own, deliberately different, trail resolution — see below) | — | **shadow** `UNCALIBRATED_TRAIL_VARIANT` | — (folds into base-eligibility fail-closed instead) | — |
| base eligibility (suppressed/THIN_N) | via `getCanonicalLiveStatus` (fail-**closed**) | via `getCanonicalLiveStatus` (fail-**closed**) | `_suppressedSetups?.has()` (fail-**open**, no DOW) | via `isLiveEligible` (fail-**closed** + DOW + knownTypes) | hand-rolled N/EV only, no relation to any of these 3 |
| `inNewEntryDeadZone` (4–6pm) | — (structurally N/A) | **GAP** — can fire ACTIVE 4–5pm | **shadow** `POST_RTH_DEAD_ZONE` | **GAP** — can fire ACTIVE 4–5pm | — (own eval windows) |
| `isInRefireCooldown` | **skip** | **GAP** | **shadow** + conditional skip | **skip** (different reason string) | — |
| `CAPITAL_EXPOSURE_OVERRIDE` | via `getCanonicalLiveStatus` | via `getCanonicalLiveStatus` | direct `.get()` | via `isLiveEligible` (reason discarded — no column) | — |
| `isCrossDirectionFastFlip` | **shadow** | **GAP** | **shadow** | **GAP** | — |
| `isPostWinOppositeFamilyBlocked` | **shadow** | **shadow** | **shadow** | **shadow** (reason discarded — no column) | **GAP** |

**Three findings the original matrix got wrong, not just incomplete:**

1. **`isTrailMechanism`'s "opt-in because meaningless elsewhere" rationale is wrong.** Globex has
   its own trail resolution (`globexResolvedType`/`globexTrailVariant`, acd.js 2253–2266) that
   *deliberately does not force-shadow* — a Globex trail fire stores under the base name and its
   ACTIVE/SHADOW status is decided by the base name's normal eligibility. RTH and Globex have
   **intentionally divergent** trail semantics, not "RTH has it, Globex doesn't need it." A
   shared function defaulting `isTrailMechanism=false` is still fine — but the justifying
   comment must say "deliberately divergent semantics," not "meaningless outside RTH."
2. **`inNewEntryDeadZone` is under-scoped, not just RTH-active-scoped.** It's computed once
   (acd.js:4965) and consumed only at the RTH `active` slot (line 10055). `shadowCandidates` and
   `STACK_VOL_BREAK_LIVE` both run during RTH 4–5pm and do **not** consult it — meaning
   `docs/CONVENTIONS_DETAIL.md`'s "force-SHADOWs everything in that window" claim is contradicted
   by the code (a real, pre-existing coverage gap; confirmed by static read, not yet verified
   empirically against live rows).
3. **`isInRefireCooldown` is one function with three different *dispositions*, not a uniform
   check**: RTH-active force-shadows (and conditionally also skips via
   `skipRedundantShadowInsert`); `shadowCandidates` and Globex both *skip* (no row at all) on the
   same predicate, with different reason strings; `STACK_VOL_BREAK_LIVE` doesn't check it at all.
   A `{ forceShadow, reason }` return value literally cannot express "skip" — this alone
   invalidates the original proposed shape (see below).

**The base-eligibility check (row 2 of the matrix above) is not one check, and it's the
dangerous part, not the force-shadow gates:**

| | `getCanonicalLiveStatus` (A, B) | `_suppressedSetups?.has()` (C) | `isLiveEligible()` (D) |
|---|---|---|---|
| suppresses on | SETUP_STATUS `SUPPRESS`/`THIN_N`/non-live | `SUPPRESS`/`THIN_N` only | knownTypes + `SUPPRESS`/`THIN_N` + DOW + override |
| unknown type | fail-**closed** → SHADOW | fail-**open** → eligible | fail-**closed** → ineligible |
| DOW suppression | no | no | **yes** |
| real-forward clearance | yes (`hasRealForwardClearance`) | no | no |
| `CAPITAL_EXPOSURE_OVERRIDE` | yes | no (checked separately) | yes |

The RTH `active` slot — the single highest-volume live site — is the **only one that fails
open** on an unknown setup_type. This is a genuine correctness bug independent of anything to do
with force-shadow gates, and DeepSeek ranks fixing it above building the shared checkpoint.

## Why this is NOT simply "merge the 7 (now known: 10) INSERTs into 1"

Unchanged from the original scoping — still correct, DeepSeek confirmed:
- **Different available context** per site (`c` vs `active` vs `shadow` vs local `svEntry`/
  `svStop`, vs the service pollers' own candidate shapes).
- **Different columns** (`extend_target_level` only on STACK_VOL; `shadowCandidates`'s INSERT has
  no `suppression_reason` column at all — this is not a cosmetic gap, see "Migration risk"
  below).
- **Not every check applies everywhere**, and not always for the reason originally assumed (see
  `isTrailMechanism` above).

Full INSERT consolidation remains the wrong answer — a high-risk refactor for no behavioral
benefit, since the sites' actual shapes genuinely differ.

## Corrected proposed shape (replaces the original `evaluateLiveGates` sketch)

The named-boolean-parameters shape is rejected — it can't express skip-vs-shadow, it assumes one
canonical priority order that's only true at the RTH `active` slot, and it can't carry per-site
reason/gate-name strings. Corrected shape (DeepSeek, concrete enough to implement from):

```javascript
// server/services/liveGates.js — exported so the 3 service pollers can reach it too.
// Each gate is self-contained; disposition is 'skip' (no row) or 'shadow' (insert as SHADOW).
const GATES = {
  trailMechanism:     { order: 10, action: 'shadow', reason: () => 'UNCALIBRATED_TRAIL_VARIANT',
                         when: (ctx) => ctx.isTrailMechanism === true },
  suppressed:         { order: 20, action: 'shadow', reason: () => 'PERFORMANCE_BELOW_THRESHOLD',
                         when: (ctx) => ctx.baseStatus === 'SHADOW' }, // base eligibility folded in
  newEntryDeadZone:   { order: 30, action: 'shadow', reason: () => 'POST_RTH_DEAD_ZONE',
                         when: (ctx) => ctx.inNewEntryDeadZone === true },
  refireCooldown:     { order: 40, action: 'shadow', reason: () => 'REFIRE_COOLDOWN',
                         when: (ctx) => ctx.inRefireCooldown === true },
  exposureOverride:   { order: 50, action: 'shadow', reason: (ctx) => ctx.exposureOverride?.reason ?? 'EXPOSURE_OVERRIDE',
                         when: (ctx) => ctx.exposureOverride != null },
  crossDirectionFlip: { order: 60, action: 'shadow', reason: (ctx) => `CROSS_DIRECTION_FAST_FLIP_${ctx.crossDirectionCooldownMin}min`,
                         when: (ctx) => ctx.crossDirectionCooldownMin != null },
  postWinOpposite:    { order: 70, action: 'shadow', reason: () => 'POST_WIN_OPP_FAMILY_REV',
                         when: (ctx) => ctx.postWinOppBlocked === true },
};

// Each SITE declares its own ordered gate list and per-gate action override (e.g. Globex
// overrides refireCooldown to action:'skip'). Base eligibility (ctx.baseStatus) is computed by
// a SEPARATE, genuinely shared reconciliation function (see "base-eligibility" work item below)
// -- not by this function.
async function runLiveGates(ctx, orderedGateIds) {
  for (const id of orderedGateIds) {
    const g = GATES[id];
    if (await g.when(ctx)) return { disposition: g.action, reason: g.reason(ctx), gateName: id };
  }
  return { disposition: ctx.baseStatus, reason: ctx.baseReason ?? null, gateName: null };
}
```

The key structural change from the original sketch: **each site supplies its own ordered gate-id
list and can override a gate's disposition** (skip vs shadow) — there is no single canonical
order or disposition shared across all sites, and pretending there is would be a silent behavior
change at 3 of the 4 `acd.js` sites (Globex, `shadowCandidates`, and `STACK_VOL` all have
different real orders/dispositions today, verified directly against code — see matrix above).

## Corrected sequencing (replaces "Required before implementation")

DeepSeek's ordering, adopted as-is:

1. **Ship a `test_invariants.mjs` structural check now.** Enumerate the 7 live-capable INSERT
   sites (this doc's corrected table) and assert, per gate, that the set of sites it's wired into
   equals the set of sites it's supposed to reach. Zero live risk, would have caught the original
   `ab81fce` gap, the `isCrossDirectionFastFlip` RTH gap, the dead-zone gaps, and all 3 service
   sites in one shot. This is the actual answer to "shouldn't there be one insert site?" — not
   building one site, but making it impossible to silently miss one.
2. **Write and ship a base-eligibility reconciliation** — `getCanonicalLiveStatus` vs
   `isLiveEligible` vs the RTH slot's fail-open `_suppressedSetups.has()` — as its own change,
   before touching force-shadow consolidation. This is the one place with a genuine
   correctness/fail-open bug, independent of everything else in this spec.
3. **Only then** build `runLiveGates` per the corrected shape above, migrating one site at a time
   under a **dual-run assertion**, not byte-diff-by-eye: since every gate here is a pure
   read-only predicate, run both the old inline chain and the new shared function on the same
   candidate for N days and log any disagreement (reuse `cascadeDiagLog`/`gated_candidates`,
   already used for the RTH-active forceShadow inputs — add `assertGateAgreement({site,
   setupType, oldDecision, newDecision})` writing a CRITICAL line or a `gated_candidates` row on
   mismatch). This is cheaper and safer than trying to replay an ephemeral candidate stream by
   eye.
4. **Resolve the `shadowCandidates` missing-`suppression_reason`-column gap before migrating site
   D**, not after — if the whole point of this refactor is "one place that knows why something is
   SHADOW," a site that structurally can't store the why is a hole in the center. Either add the
   column or explicitly accept reason-loss for that site; don't leave it implicit.
5. **A code-review pass on the actual diff** before it ships, same as every other live-risk
   change this session.

## What this spec does NOT cover (explicitly out of scope)

- The 3 always-non-ACTIVE `acd.js` insert sites (7873, 8610, 9691) and the 1 hardcoded-SHADOW
  service site (`pocRotationJoinDetector.js`) — correctly out of scope, no live-gating mechanism
  can ever have anything to prevent there.
- `docs/ROSTER_WIDE_INVALIDATION_BOUNDARY_WHITELIST_SPEC.md` (the `structurallyInvalidateSetups()`
  extension) — a related but independent piece of work, second priority, not blocked by this one
  or vice versa.
- Full INSERT-statement consolidation — rejected in both the original and corrected version, for
  the same reasons (genuinely different context/columns per site).

## Suggested entry point for whoever picks this up

1. `grep -rn "INSERT INTO active_setups" server/ scripts/` and classify every hit by
   ACTIVE-capability, confirming this doc's corrected 10-total/7-live-capable count still holds
   (line numbers drift; DeepSeek already found several stale references in the first version of
   this doc).
2. Build and ship the `test_invariants.mjs` gate-coverage check (sequencing item 1).
3. Scope and ship the base-eligibility reconciliation (sequencing item 2) as its own
   spec/PR — this is higher-risk than anything else in this doc and deserves its own design
   critique.
4. Only then build `runLiveGates` and migrate sites one at a time under dual-run assertion
   (sequencing item 3).
