# Unified live-gate checkpoint — sequencing items 1+2 SHIPPED, item 3 PAUSED (2026-09-02)

**Status: items 1 and 2 of the 3-step sequencing below are done and live. Item 3 (the full shared
`runLiveGates` runtime refactor) is deliberately PAUSED, not forgotten — see "Item 3: why paused"
near the end of this doc before ever picking it back up.** Follow-up to the sibling-reversal gate
(`isPostWinOppositeFamilyBlocked()`) shipped the same session — DeepSeek's code review of that
gate found it was wired into only 2 of `active_setups`'s real INSERT sites, and the user asked
directly: "shouldn't there be one insert site?" This doc originally scoped a shared-function
refactor confined to `server/routes/acd.js`. **DeepSeek's design critique of that first version
(full text: `scratch/deepseek_response.md` as of 2026-09-02) found the scope itself was wrong in
the same way the original bug was — its "4 live-capable sites" census undercounted reality by 3
sites outside `acd.js`.** This version replaces the original scope with DeepSeek's corrected
census, corrected function shape, and corrected sequencing.

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

`active_setups` had **10 total INSERT sites** across the codebase, not 7, and **7 were
live-capable** (can produce a real `status='ACTIVE'` row), not 4. **UPDATED 2026-09-03**: the
cascade-breaker audit-row site was deleted entirely (never live-capable, always
`status='EXPIRED'` — see `OPEN_DECISION cascade_breaker_query_missing_origin_status_filter`,
resolved), so this is now **9 total INSERT sites, 6 live-capable, 4 in acd.js**. A 5th gate,
`oppositeDirectionOpen` (`isOppositeDirectionOpen()`, `docs/SINGLE_FIRING_DIRECTIONAL_CONFLICT_SPEC.md`),
was also added to all 4 acd.js sites the same session — unlike the other 4 gates, it shipped with
full coverage from day one, not incrementally:

| file:line | what it inserts | can produce `ACTIVE`? | gates reached today |
|---|---|---|---|
| `acd.js:2360` | Globex candidates (`detectGlobexSetup`) | yes | refire(skip), crossDirectionFlip, postWinOpposite, **oppositeDirectionOpen** |
| `acd.js:5024` | `STACK_VOL_BREAK_LIVE_LONG/SHORT` | yes | postWinOpposite, **oppositeDirectionOpen** — **missing** deadzone, refire, crossDirectionFlip |
| `acd.js:8648` | suppressed-audit SHADOW rows | no — always `status='SHADOW'` (hardcoded) | n/a |
| `acd.js:9723` | early-touch backfill SHADOW rows | no — always `status='SHADOW'` (hardcoded) | n/a |
| `acd.js:10150` | RTH `active` slot (main level-fade candidates array) | yes | trailMechanism, suppressed(fail-**open**), deadzone, refire, exposureOverride, crossDirectionFlip, postWinOpposite, **oppositeDirectionOpen** — the only site with full coverage of the original 4 gates |
| `acd.js:10388` | RTH `shadowCandidates` loop — fire path for `STOP_SWEEP`/`VWAP_MAGNET`(RTH)/`VWAP_RECLAIM`/`C_PAIRED`/`C_REVERSAL`/`TRT`/`BRACKET_BREAKOUT` | yes | refire(skip), postWinOpposite, **oppositeDirectionOpen** — **missing** deadzone, crossDirectionFlip |
| `server/services/minuteBarSignalDetector.js:181` | `MOMENTUM_60m_60m_TREND` | **yes** — hand-rolled `getLiveStatus()` (N≥20 && ev≥−5) | **none of the 8 checks** |
| `server/services/rthFlushDetector.js:180` | `RTH_FLUSH_LONG/SHORT` | **yes** — same hand-rolled pattern | **none of the 8 checks** |
| `server/services/globexFlushDetector.js:228` | `GLOBEX_FLUSH_*` | **yes** — same hand-rolled pattern | **none of the 8 checks** |
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

## Corrected sequencing — STATUS as of 2026-09-02 end of session

DeepSeek's ordering, adopted as-is. **Items 1 and 2 are DONE. Item 3 is PAUSED by explicit user
decision** (see "Item 3: why paused, and when to revisit" below) — do not resume it without
re-reading that section first.

1. **✅ SHIPPED.** `test_invariants.mjs` check `[24]` (Live-gate coverage census). Enumerates the
   live-capable INSERT sites and asserts, per gate, that the set of sites it's wired into equals
   the set it's supposed to reach — FAILs on regression, WARNs on every still-known gap. Verified
   0 new failures via git-stash A/B. This is the actual answer to "shouldn't there be one insert
   site?" — not building one site, but making it impossible to silently miss one.
2. **✅ SHIPPED** (base-eligibility reconciliation). The RTH `active` slot — this codebase's single
   highest-volume live INSERT site — used to read `_suppressedSetups?.has(active.type)` directly:
   **fail-open** on an unknown setup_type (absent from the set == "not suppressed" == eligible for
   real capital), the only one of 3 competing eligibility checks with that posture (both
   `getCanonicalLiveStatus` and `isLiveEligible()` are fail-closed). Fixed by swapping in
   `isLiveEligible()` — the same canonical function `shadowCandidates` already used — bringing this
   site to parity and, as a side effect, applying DOW suppression there for the first time (it
   never consulted `_dowSuppressToday` before). DeepSeek-reviewed before shipping (see
   `scratch/deepseek_response.md` as of this fix's own dispatch, or re-run the review if that file
   has since been overwritten by a later request).
   Server restarted after deploy so the in-memory 12h calibration/eligibility cache picked up the
   fix immediately rather than waiting for its own TTL.
3. **⏸ PAUSED, not started.** Building `runLiveGates` (the shared checkpoint function) and
   migrating all 4 live-capable `acd.js` sites onto it one at a time under a dual-run assertion.
   See below for why, and what would need to be true to pick this back up.

## Item 3: why paused, and when to revisit

User asked directly: "is this worth building?" The honest answer given and accepted: **no, not
now** — not because it's too risky to ever do, but because **item 1 already captured most of the
practical benefit for a fraction of the cost.** The whole reason item 3 was proposed was "so a
future gate can never silently miss a site again" — but the `test_invariants.mjs` census (item 1,
already shipped) does that same job: any future gate that misses a site fails the test suite
loudly, at zero live risk. Item 3 on top of that would mostly buy architectural tidiness (one
canonical function instead of 4 independently hand-rolled `forceShadow` chains), not close a risk
that isn't already covered — while carrying a materially larger blast radius (a single shared
function touching decision logic at every live-capable site simultaneously, vs. today's 4
independent chains where a bug in one doesn't touch the other 3).

**Revisit only if:** a third or later gate gets added to this codebase and the per-site
hand-duplication of its wiring becomes genuinely painful to maintain (not just "would be nicer"),
or the 4 sites' independent `forceShadow` chains visibly drift out of sync again despite the
check-[24] safety net. Do not resume this preemptively. If picked back up, follow DeepSeek's
original migration plan below (dual-run assertion, one site at a time) rather than a big-bang
switch — the run**LiveGates** shape itself (corrected version above) is still the right shape,
it's the *timing* that was deferred, not the design.

## Full site census (re-verified 2026-09-02, line numbers current as of this session's last edit)

**11 total `active_setups` INSERT sites; 7 live-capable.**

| file:line | site | live-capable? |
|---|---|---|
| `acd.js:2295` | Globex candidates (`detectGlobexSetup`) | yes |
| `acd.js:4953` | `STACK_VOL_BREAK_LIVE_LONG/SHORT` | yes |
| `acd.js:7909` | cascade-breaker audit rows | no — always `status='EXPIRED'` |
| `acd.js:8646` | suppressed-audit SHADOW rows | no — always `status='SHADOW'` (hardcoded) |
| `acd.js:9727` | early-touch backfill SHADOW rows | no — always `status='SHADOW'` (hardcoded) |
| `acd.js:10147` | RTH `active` slot (main level-fade candidates array) | yes — item 2 fix applied here |
| `acd.js:10377` | RTH `shadowCandidates` loop | yes |
| `server/services/minuteBarSignalDetector.js:181` | `MOMENTUM_60m_60m_TREND` | yes — own hand-rolled `getLiveStatus()`, zero exposure to any of the 4 gates |
| `server/services/rthFlushDetector.js:180` | `RTH_FLUSH_LONG/SHORT` | yes — same hand-rolled pattern, same zero exposure |
| `server/services/globexFlushDetector.js:228` | `GLOBEX_FLUSH_*` | yes — same hand-rolled pattern, same zero exposure |
| `server/services/pocRotationJoinDetector.js:140` | `POC_ROTATION_JOIN_*` | no — hardcoded `status='SHADOW'` |

**Line numbers WILL drift again on the next edit to any of these files** — re-verify with
`grep -n "INSERT INTO active_setups" server/routes/acd.js server/services/*.js` before trusting
this table, don't just cite it from memory.

The 3 service-poller sites (`minuteBarSignalDetector`/`rthFlushDetector`/`globexFlushDetector`)
remain the single biggest un-closed gap from this whole thread — they have **zero** exposure to
`isInRefireCooldown`/`isCrossDirectionFastFlip`/`isPostWinOppositeFamilyBlocked`/
`CAPITAL_EXPOSURE_OVERRIDE`, protected only by their own hand-rolled N≥20/ev≥-$5 `getLiveStatus()`.
`test_invariants.mjs` check `[24]` WARNs on this every run so it stays visible — closing it would
mean either wiring those 3 gates into each service file directly, or (more in the spirit of item
3, were it ever resumed) routing them through a shared checkpoint too. Out of scope for today.

## What this spec does NOT cover (explicitly out of scope)

- The 3 always-non-ACTIVE `acd.js` insert sites (7909, 8646, 9727) and the 1 hardcoded-SHADOW
  service site (`pocRotationJoinDetector.js`) — correctly out of scope, no live-gating mechanism
  can ever have anything to prevent there.
- `docs/ROSTER_WIDE_INVALIDATION_BOUNDARY_WHITELIST_SPEC.md` (the `structurallyInvalidateSetups()`
  extension) — RESOLVED NEGATIVE the same session, unrelated outcome, not blocked by this spec or
  vice versa.
- Full INSERT-statement consolidation — rejected in both the original and corrected version, for
  the same reasons (genuinely different context/columns per site).
- The 3 service pollers' complete lack of gate coverage (see above) — flagged, not fixed, here.
