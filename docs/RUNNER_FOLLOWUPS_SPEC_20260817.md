# Runner-mechanism follow-up batch — spec (2026-08-17)

Five items, scoped together because they surfaced from the same investigation thread (the
wider-target/"trailing mechanism" build, 2026-08-17) and are going through the same
design-critique → implement → review cycle in one session. Each item is independently
buildable and independently reversible — none blocks another except where noted.

## Item 0 — Daily cadence for `audit_wider_target_live.mjs` until real armed N≥20

**User request (verbatim intent)**: run the wider-target closed-loop auditor daily instead
of weekly while real data is thin, self-throttling back to weekly once N clears 20 — no
manual cron revert needed later.

**Current state**: `scripts/audit_wider_target_live.mjs` runs only via
`run_weekly_backtests.sh` (Sunday 10:30 PM ET). Not in `run_daily_calibration.sh` (Mon-Fri
8:20 PM ET). Real armed N is currently 0.

**Design**:
1. Add to `run_daily_calibration.sh`: `node scripts/audit_wider_target_live.mjs --daily-check`
2. `run_weekly_backtests.sh`'s existing unflagged invocation is untouched — it always does a
   full run regardless of N, matching every other weekly-scheduled script's standing cadence.
3. Inside the script: move the existing `priorRes`/`prior`/`nAtLastCheck` query (currently
   built late, right before the `notes` object) up to immediately after `armedN` is computed.
   Reuse the same query result for both the throttle decision and the existing
   `deltaSinceLastCheck` field — no duplicate DB round-trip.
4. Throttle check: `const dailyCheckMode = process.argv.includes('--daily-check');` — if
   `dailyCheckMode && nAtLastCheck >= MIN_N`, log a one-line "throttled — N already cleared
   the floor as of the last check, deferring to weekly cadence" message and `return` before
   the `performance_audit` INSERT / `flagDecision` calls. Otherwise run the full path as today.
5. Gating on `nAtLastCheck` (the PRIOR stored row's N), not the just-computed `armedN`, is
   deliberate: the daily run that FIRST discovers `armedN≥20` should still write (so the
   verdict transition + `flagDecision` fires promptly, not delayed to Sunday) — only
   subsequent daily runs after that point throttle.

**Risk**: negligible. Monitoring/write-cadence only, zero live-trading impact, reuses
already-tested logic paths unchanged (the full computation still runs every day even when
throttled — only the persist step is skipped — so there's no new code path for the "N is
thin" case, which is the one that matters most).

**Open question for DeepSeek**: is gating on `nAtLastCheck` vs. a fresh `armedN` the right
call, or is there an edge case (e.g. N flickers around 20 due to a same-day exclusion) worth
guarding differently?

---

## Item 1 — Fix `isLongSetup()`'s direction-inference bug (`islongsetup_gap_variant_direction_bug`)

**Scope correction found this session**: the original `OPEN_DECISION` described this as
scoped to `resolveSetupsByPrice()`. Research today found **4 real call sites across 3
functions**, not 2 across 1:
- `server/routes/acd.js:506, 548` — inside `resolveSetupsByPrice()` (plain TARGET_HIT/STOP_HIT,
  extendTarget, trailWidth, wider-target branch, running MAE/MFE).
- `server/routes/acd.js:1464` — inside `expireStaleSetups()` (TIME_EXPIRED mark-to-market P&L).
- `server/routes/acd.js:1554` — inside `structurallyInvalidateSetups()` (POST_ENTRY
  invalidation mark-to-market P&L).

**Historical blast radius, measured directly (not assumed)**:
- `_GAP_UP`/`_GAP_DOWN` conditional-variant rows in `active_setups`: **1 total**
  (`WPP_FADE_SHORT_GAP_UP`, already resolved). Not a backfill-campaign-scale problem — a
  single-row check-and-correct is sufficient once the fix ships, not a dedicated backfill
  script.
- A **second, related, previously-undiscussed bug in the same function** surfaced while
  checking this: `active_setups` has **no `direction` column at all** (confirmed via
  `information_schema.columns`). `isLongSetup('ZONE_EDGE_FADE')` — a `CONTEXTUAL_DIRECTION_TYPES`
  member whose real direction is decided at fire time based on zone position (ceiling vs.
  floor), never encoded in the type name — returns `false` unconditionally (no `LONG`/
  `BULLISH`/`_UP` substring), so **every ZONE_EDGE_FADE row is silently treated as SHORT**
  regardless of its true fire-time direction. Confirmed 19 resolved ZONE_EDGE_FADE rows exist
  (`resolution_method` breakdown: 11 `SAME_BAR_STOP_FIRST`, 5 `MARK_TO_MARKET`, 3
  `PRICE_CLEAN` — i.e. via all 3 of the buggy functions above, not just one). `inferDirection()`
  ALSO returns `null` for `ZONE_EDGE_FADE` (no direction in the name, correctly) — so swapping
  `isLongSetup()` for `inferDirection()` alone does not fix this population, it would just
  make it explicitly "unknown" (skip) instead of silently wrong (guessed SHORT), which is
  strictly better but still leaves 19 historical + all future ZONE_EDGE_FADE rows
  unresolvable by name alone.

**Design recommendation — hybrid, price-derived fallback (not previously considered in the
original OPEN_DECISION)**: at the point `zoneEdgeFade` candidates are built (`acd.js` ~7708),
direction is computed (`isLong = nearBot`) and used to set `stop`/`target` — `stop_level` is
below entry and `t1_level` above it for a LONG, and the reverse for a SHORT. This sign
relationship is a **general, always-available, setup-type-agnostic signal present on every
resolved row in the table**, not just `ZONE_EDGE_FADE`. Confirmed `stop_level` is never
mutated post-insert anywhere in `acd.js` (`grep` for `UPDATE active_setups ... SET stop_level`
returns zero hits) — so the sign is stable for a row's entire lifecycle, including
breakeven-trail and wider-target extensions (which by design keep the original stop/target
levels fixed).

Proposed fix, all 4 call sites:
```js
function resolveDirection(row) {
  const named = inferDirection(row.setup_type);           // primary: name-based, this
                                                            // codebase's established source
  const priceLong = row.t1_level > row.stop_level;         // fallback/cross-check: price-derived
  const priceDerived = priceLong ? 'LONG' : 'SHORT';
  if (named !== null && named !== priceDerived) {
    // disagreement between the two signals -- log and treat as unresolvable, same
    // "exclude, don't guess" posture audit_wider_target_live.mjs already established
    // for exactly this bug.
    return null;
  }
  return named ?? priceDerived; // named wins when both agree or named is unavailable
}
```
Then `const long = resolveDirection(row) === 'LONG'` replaces `const long = isLongSetup(row.setup_type)`
at all 4 sites, with each site's existing null-handling convention decided per call site (most
likely: skip/continue with a logged reason, matching `PRE_ENTRY`/`NO_PRICE_DATA`-style
deliberate-null conventions already established elsewhere in this file — needs a specific
per-site decision, not a blanket one, since e.g. `expireStaleSetups()`'s loop structure differs
from `resolveSetupsByPrice()`'s).

**Alternative considered and NOT recommended**: `inferDirection()` alone with null→skip. Safer
in the sense of reusing an already-established function verbatim, but leaves the ZONE_EDGE_FADE
population (and any future `CONTEXTUAL_DIRECTION_TYPES` member) permanently unresolvable by
these paths, a real and currently-live gap the hybrid design closes for free.

**Explicitly asking DeepSeek to verify**: (a) is the `t1_level`/`stop_level` sign invariant
actually safe across every current setup_type and mechanism (wider-target, breakeven-trail,
STACK_VOL_BREAK_LIVE's extendTarget) — anything that could invert it transiently that a static
grep for `SET stop_level` wouldn't catch (e.g. a JS-side variable named differently that still
writes the column)? (b) is a name/price disagreement the right thing to treat as "exclude,"
or should one signal outrank the other in a disagreement instead of nulling out? (c) the
19 ZONE_EDGE_FADE historical rows — backfill (recompute `actual_pnl`/`mae_points`/`mfe_points`
via the same price-derived direction) or leave as a known, small, already-resolved
imperfection? `active_setups`'s `origin_status` for these — need to check `SHADOW` vs `ACTIVE`
split before deciding backfill stakes (not yet queried).

**Build order**: (1) implement `resolveDirection()` per DeepSeek's critique, (2) swap all 4
call sites, (3) remove the now-dead `isLongSetup()` function, (4) query `origin_status` split
for the 19 ZONE_EDGE_FADE + 1 GAP-variant rows, decide backfill scope, (5) execute backfill if
warranted (`docs/DB_MIGRATION_PROTOCOL.md`: backup table first), (6) `test_invariants.mjs` +
lint + direct spot-check of a few affected rows' recomputed values, (7) server restart +
health check, (8) separate DeepSeek code-review pass on the actual diff.

**Blast radius**: HIGH relative to the other items — touches live P&L computation across 3
functions, all setup types, not just the `_GAP_*`/`ZONE_EDGE_FADE` populations (every row goes
through the same `long` variable). Per CLAUDE.md's 3-phase rule for live-wiring changes, this
design-critique dispatch IS phase 0; phase 2 (review-only, after code) is a separate step, not
skipped.

---

## Item 2 — `runner_bounded_live_gate_passed_needs_build_and_process` (3 sub-items)

### 2a. Visibility tile extension (small, build this session)

**Current state, checked directly**: `RunnerWiderTargetPanel` (`AlphaEngineOverview.jsx`
~629-730) and its backing `GET /acd/runner-wider-target-status` (`acd.js` ~9963) already
exist and already show: headline delta, verdict badge, real armed N/flagged/excluded,
target/stop/timeout breakdown, mean/median delta, win-rate-vs-fixed, delta-since-last-check.
**Genuinely missing** vs. DeepSeek's original ask (day-sign status, dominant-family guard
status, an N-of-20 progress indicator):
- `day_sign_majority` and `survives_largest_day_exclusion` — already computed and stored in
  `WIDER_TARGET_LIVE_STATUS.notes` by `audit_wider_target_live.mjs`, just never read into the
  endpoint's `liveMechanism` object or rendered.
- `top_setup_type` / `top_setup_type_share` — same: computed and stored, not surfaced.
- An explicit progress indicator for `nArmed` toward the audit script's own `MIN_N=20` floor —
  distinct from the existing "full-live promotion" bar (`nActiveCurrent`/`nActiveFloor`, a
  different population/purpose: real ACTIVE-origin trades toward the separate full-live
  standard). The armed-N-toward-20 number is the one that actually drives the verdict
  computation Item 0 is about — currently invisible in the UI.

**Design**: add 4 fields to the endpoint's `liveMechanism` object
(`daySignMajority`, `survivesLargestDayExclusion`, `topSetupType`, `topSetupTypeShare`,
read from `lmNotes` exactly like the existing fields are), and extend the existing "Live
mechanism results" card with a small "guard status" line + a slim progress bar for
`nArmed`/20. Read-only display addition, no logic change — reuses the exact existing data
shape and component conventions. Low risk.

### 2b. Negative-trace process rule (non-code, doc-only, build this session)

**Design**: add one new bullet to CLAUDE.md's Conventions section, immediately after the
existing "Confound checklist for comparison-style backtests" bullet (same neighborhood —
both are about avoiding false conclusions on a specific finding class), full detail
deferred to `docs/CONVENTIONS_DETAIL.md` per the file's established two-tier pattern. Content:
for runner/winner-extension-class findings specifically, a negative verdict must cite a
SPECIFIC TESTED mechanism failure with a number — "negative by analogy/inference to a
different pipeline's result" is not a valid closure (the exact mistake that produced this
thread's own false wider-target closure earlier the same session it was later corrected).
Introduce `CLOSED_INFERRED` vs. `CLOSED_TESTED` as a marker for future claim text in this
class. Make the adversarial stress-test battery (exclude dominant family → exclude top day →
exclude cluster → verify P&L → check for bugs) the DEFAULT gate before recording any positive
runner finding, not something requested only after the fact. Zero code risk.

### 2c. The bounded-live T1-floor mechanism itself — SCOPE ONLY, not built this session

**Explicitly deferred, not silently dropped.** This is the actual mechanism that would let
the wider-target finding touch real capital (a capped ~25%-of-eligible-positions rollout,
T1 banked as a guaranteed floor reusing the breakeven-trail machinery's T1-floor pattern,
conditioned on `bars_to_resolution≤4` at T1 touch). Reasons for deferring out of this batch:
- Touches the live resolution engine for real ACTIVE-origin positions — a fundamentally
  higher blast radius than every other item here.
- Triggers this codebase's full new-setup-type checklist (dedicated backtest script,
  `SETUP_STATUS`/`OPTIMAL_STOP` rows, `CONDITIONAL_VARIANTS` entry, insert-time forced-SHADOW
  gate, dashboard visibility, `test_invariants.mjs` pass).
- CLAUDE.md's 3-phase rule requires a SEPARATE design-critique-before-code pass specifically
  for this piece — folding it into this batch's shared critique would shortcut that.
- **Real dependency on Item 1**: this mechanism would extend the exact same
  `resolveSetupsByPrice()` direction logic Item 1 is fixing. Building it before Item 1 lands
  and is verified would mean building on top of a known-buggy foundation. Sequence strictly
  after Item 1, not concurrently.

Recorded here so a future session picks this up as an explicit, scoped-but-not-built
follow-on, not something that has to be rediscovered.

---

## Item 3 — `computerigor_stable_clustered_independence_gap`: `boundaryStraddle` detection

**Design**: in `computeRigor()` (`server/services/rigorDiagnostics.js`), after computing
`third`/`stable` (only when `third≥5`, matching `stable`'s own existing gate — so
`boundaryStraddle` is `null` exactly when `stable` is `null`), detect whether the dominant
`dateField` entity's events span more than one of the 3 chronological thirds:

```js
let boundaryStraddle = null;
if (third >= 5) {
  const idxByDate = new Map();
  events.forEach((e, i) => {
    const d = e[dateField];
    if (!idxByDate.has(d)) idxByDate.set(d, []);
    idxByDate.get(d).push(i);
  });
  let dominant = null, dominantCount = 0;
  for (const [d, idxs] of idxByDate) if (idxs.length > dominantCount) { dominant = idxs; dominantCount = idxs.length; }
  const bucketsTouched = new Set(dominant.map(i => i < third ? 0 : i < 2 * third ? 1 : 2));
  boundaryStraddle = bucketsTouched.size > 1;
}
```

Add `boundaryStraddle` to `computeRigor()`'s return object and to `rigorContext()`.
**Explicitly NOT changing `clean`'s semantics this pass** (`clean = stable === true &&
!clustered` stays as-is) — additive/informational only, matching the decision's own "not
urgent... build defensively before it migrates into a live gate" framing. Retroactively
tightening `clean` would ripple into every current consumer, including the `SETUP_STATUS_DOW`
gate fixed earlier today, and deserves its own dedicated audit before being wired into any
gate.

**Scope expansion worth flagging for DeepSeek**: `rigorContext()` itself is barely used
(1 caller, `scripts/calibrate_touch_quality.mjs`) — the two consumers that actually matter
(`backtest_setup_status.mjs`'s main gate and its `SETUP_STATUS_DOW` sub-pass) build their own
inline `rigor: {...}` object literals rather than calling `rigorContext()`, so the new field
would be invisible where it matters most unless also added to those two inline objects
(informational only — does not touch the SUPPRESS/THIN_N/ACTIVE decision itself). Asking
DeepSeek: is this expanded scope (computeRigor + rigorContext + the 2 inline notes objects)
right, or should it stay minimal (computeRigor/rigorContext only) for now, with the
DOW-gate/main-gate notes wiring deferred to whenever `clean`'s semantics actually get
revisited?

---

## Build order for this session

0 (daily-audit throttle) → 3 (boundaryStraddle, informational) → 2a (visibility tile) →
2b (process-rule doc) → 1 (isLongSetup fix, most complex, most blast radius — done last so
patterns/critique from the earlier items inform it, and so if time runs out this is the one
still cleanly scoped-but-deferred rather than half-built). 2c stays scope-only regardless.

Each item gets a DeepSeek review pass immediately after its own implementation, before moving
to the next — not one review at the very end.
