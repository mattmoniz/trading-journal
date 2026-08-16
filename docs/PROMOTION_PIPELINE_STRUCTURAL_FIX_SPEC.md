# Promotion Pipeline Structural Fix — Build Spec (2026-08-16)

**Status: SPEC ONLY, NOT BUILT.** Written so a fresh session (after `/clear`) can implement
this without re-deriving the diagnosis. Read this file top to bottom before writing any code
— it supersedes re-reading the full diagnosis docs, though they're linked below if you want
the "why" in more depth than this file repeats.

**Resolves**: `OPEN_DECISION promotion_pipeline_structural_fix_2026_08_16` (HIGH) and
`shadowcandidates_hardcoded_no_promotion_path` (F3, HIGH). Also closes the still-open half of
`time_expired_exclusion_pattern_broader_audit` (HIGH) that lives inside 3 live promotion gates.

**Background, read if you need the "why"**: `docs/PROMOTION_PIPELINE_STRUCTURAL_AUDIT_20260816.md`
(DeepSeek's design critique, every checkable claim independently verified by Claude) and
`docs/LIVE_FIRING_AUDIT_20260814.md` section F3 (the original bug find + a draft diff this
spec builds on, not replaces). User's own framing, verbatim, is the reason this exists:
*"I dont want to keep having an issue where setups arent getting promoted. Its fundamental
here."*

**One-paragraph diagnosis** (full version in the audit doc): the codebase has 5 places that
each independently decide whether a setup_type is allowed to fire `origin_status='ACTIVE'`.
Only 2 read the canonical `SETUP_STATUS` table (`performance_audit`, written weekly by
`backtest_setup_status.mjs`). The other 3 hand-roll their own eligibility check and have each
drifted: `shadowCandidates`'s INSERT never checks anything at all (hardcoded `'SHADOW'`
literal); the 3 standalone-poller promotion gates (`minuteBarSignalDetector.getLiveStatus()`,
`acd.js`'s `getOvernightLevelLiveStatus()` and `getStackVolBreakLiveStatus()`) each reimplement
an `N>=20, EV>=-$5` check directly against `active_setups`, and that reimplementation still
excludes `TIME_EXPIRED`-resolved trades (a bug fixed in `backtest_setup_status.mjs` itself back
on 2026-08-03, never propagated to these 3 copies).

## Build order (do not reorder — each layer's verification depends on the previous one)

1. **Layer 2: reachability invariant** — cheapest, zero blast radius, no DB writes, ships
   first because it mechanically produces the per-type "should this actually go live" review
   that Layer 1/F3 needs before it ships.
2. **Layer 1 + F3, scoped**: the canonical gate function, wired into `shadowCandidates` only
   (not the 3 pollers yet) — this is the direct fix for the user's most acute complaint (~20
   event setup types that can never reach `ACTIVE` no matter what). Explicitly excludes
   `STOP_SWEEP_LONG`/`STOP_SWEEP_SHORT`.
3. **Layer 3**: migrate the 3 standalone pollers onto the same canonical gate, retiring their
   own hand-rolled `N/EV` reimplementation entirely (not just patching `TIME_EXPIRED` into
   their existing query).

---

## Layer 2 — Reachability invariant (`scripts/test_invariants.mjs`)

**What it checks**: for every `setup_type` whose latest `SETUP_STATUS` recommendation is
`ACTIVE` or `PROMOTE`, has it *ever* had a real `origin_status='ACTIVE'` row in `active_setups`
— full history, not scoped to a window? A `SETUP_STATUS`-eligible type with **zero** `ACTIVE`
rows ever is exactly the evidence pattern that proved `STOP_SWEEP_LONG` was structurally stuck
(N well past 20, rated `ACTIVE`, 0 real `ACTIVE` fires ever — `docs/LIVE_FIRING_AUDIT_20260814.md`
F3 table). This check turns that one-off manual discovery into a standing, self-running one.

**Deliberately empirical, not a static code-path trace.** Tracing "which insert path handles
this exact setup_type" statically would require a maintained map from setup_type to insert
path — exactly the kind of hand-maintained list this whole fix exists to eliminate. The
empirical signal (real `ACTIVE` rows exist or they don't) needs no maintenance and can't drift.

**One real false-positive risk, handle it explicitly**: a setup_type promoted to `ACTIVE` for
the very first time *today* will legitimately show zero `ACTIVE` rows yet — it hasn't had a
chance to fire. Do not flag it as broken. Guard: only evaluate a setup_type if its *earliest*
`SETUP_STATUS` row with recommendation `ACTIVE`/`PROMOTE` is at least 30 days in the past (this
codebase's own N≥20 promotion floor already implies real setups take weeks to prove themselves,
so 30 days is a fair, generous grace period, not an arbitrary shorter one that would false-fire
on a legitimately-new promotion).

**WARN, not FAIL** — matches this codebase's convention for findings that need a human read
before acting (see check `[6]`'s precedent). A rare-touch setup_type could plausibly go a while
without a real fire even when structurally capable of one; the check's job is to surface the
question, not auto-adjudicate it.

**Implementation** — add as check `[20]` (next available number; check current file for the
actual next number before hardcoding, in case something else was added meanwhile), placed near
check `[6]` (`UNCALIBRATED_SHADOW_TYPES`) since it's the closest sibling in spirit:

```js
// ── 20. Reachability: every ACTIVE/PROMOTE-rated setup_type must have fired ACTIVE at least
//    once, given a fair chance to do so. Empirical proxy for "is there a live insert path
//    that actually checks SETUP_STATUS for this type" -- avoids maintaining a hand-written
//    map from setup_type to insert path, which would itself be exactly the kind of
//    hand-maintained list this check exists to make unnecessary. See
//    docs/PROMOTION_PIPELINE_STRUCTURAL_FIX_SPEC.md for the full design rationale.
console.log('\n[20] Reachability: ACTIVE/PROMOTE-rated setup_types can actually fire ACTIVE');
{
  const { rows: firstPromoted } = await client.query(`
    SELECT signal_name, MIN(run_date) as first_active_date
    FROM performance_audit
    WHERE signal_type='SETUP_STATUS' AND recommendation IN ('ACTIVE','PROMOTE')
    GROUP BY signal_name
    HAVING MIN(run_date) <= CURRENT_DATE - 30
  `);
  const { rows: latestStatus } = await client.query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation
    FROM performance_audit WHERE signal_type='SETUP_STATUS'
    ORDER BY signal_name, run_date DESC
  `);
  const currentlyActive = new Map(latestStatus.map(r => [r.signal_name, r.recommendation]));
  const { rows: everFired } = await client.query(`
    SELECT DISTINCT setup_type FROM active_setups WHERE origin_status = 'ACTIVE'
  `);
  const everFiredSet = new Set(everFired.map(r => r.setup_type));
  const stuck = firstPromoted
    .filter(r => ['ACTIVE', 'PROMOTE'].includes(currentlyActive.get(r.signal_name)))
    .filter(r => !everFiredSet.has(r.signal_name));
  if (stuck.length === 0) {
    ok('every setup_type rated ACTIVE/PROMOTE for 30+ days has fired origin_status=ACTIVE at least once');
  } else {
    for (const r of stuck) {
      warn(`${r.signal_name}: rated ${currentlyActive.get(r.signal_name)} since ${r.first_active_date} (30+ days ago) but has ZERO real origin_status='ACTIVE' rows ever -- likely reachable only through a hardcoded-SHADOW insert path (see shadowCandidates in acd.js) or a poller gate that never checks SETUP_STATUS at all. Verify which insert path this setup_type actually goes through before assuming it's a bug -- a genuinely rare-touch level can also produce this pattern.`);
    }
  }
}
```

**Verify it works, before moving to Layer 1**:
1. Run `node scripts/test_invariants.mjs` and confirm check `[20]` appears and runs without a
   script error.
2. Confirm it WARNs on at least `STOP_SWEEP_LONG`/`STOP_SWEEP_SHORT` if their `SETUP_STATUS`
   history shows a `ACTIVE`/`PROMOTE` rating 30+ days back with zero real `ACTIVE` rows — this
   is the known, already-proven case from the F3 audit, so if the check misses it, the check
   itself is wrong, not the data. (Their *current* rating may have since flipped to `SUPPRESS`/
   `THIN_N` from the 2026-08-16 cascade-breaker re-baseline — if so, they'll correctly NOT
   appear, since the check only looks at *currently* `ACTIVE`/`PROMOTE`-rated types. Check a few
   other `shadowCandidates`-family types instead if these two no longer qualify — e.g.
   `VWAP_MAGNET_LONG`, `FAILED_AUCTION_LONG`, `C_PAIRED_SHORT` per the F3 audit table.)
3. This check's WARN list at this point **is** your build-ready input list for Layer 1/F3 —
   don't separately eyeball `shadowCandidates`' ~20 names by hand.

---

## Layer 1 + F3 (scoped) — canonical eligibility gate + `shadowCandidates` fix

**New shared function** — extract the existing inline SQL that builds `liveStats._suppressedSetups`
/`_dowSuppressToday` (currently duplicated nowhere yet, but about to be needed in a second
place) into an exported function. Suggested location: new file `server/services/setupEligibility.js`
(small, single-purpose, matches this codebase's existing `server/services/*.js` convention).

```js
// server/services/setupEligibility.js
import { query } from '../db.js';

// Canonical "is this setup_type currently allowed to fire ACTIVE" source. Every live insert
// path must call this instead of reimplementing its own N/EV threshold check -- see
// docs/PROMOTION_PIPELINE_STRUCTURAL_FIX_SPEC.md. Mirrors the exact SQL already used to
// build server/routes/acd.js's liveStats._suppressedSetups/_dowSuppressToday (extracted from
// there, not reinvented) -- SUPPRESS/THIN_N both cause SHADOW-only, ACTIVE/PROMOTE allow ACTIVE.
export async function computeSuppressionSets(todayDowInt) {
  const [setupStatusQ, dowStatusQ] = await Promise.all([
    query(`
      SELECT DISTINCT ON (signal_name) signal_name, recommendation
      FROM performance_audit WHERE signal_type = 'SETUP_STATUS'
      ORDER BY signal_name, run_date DESC
    `),
    query(`
      SELECT DISTINCT ON (signal_name) signal_name, recommendation
      FROM performance_audit WHERE signal_type = 'SETUP_STATUS_DOW' AND signal_name LIKE $1
      ORDER BY signal_name, run_date DESC
    `, [`%_DOW_${todayDowInt}`]),
  ]);
  const suppressedSetups = new Set();
  for (const r of setupStatusQ.rows) {
    if (r.recommendation === 'SUPPRESS' || r.recommendation === 'THIN_N') suppressedSetups.add(r.signal_name);
  }
  const dowSuppressToday = new Set();
  for (const r of dowStatusQ.rows) {
    if (r.recommendation === 'SUPPRESS') dowSuppressToday.add(r.signal_name.replace(/_DOW_\d+$/, ''));
  }
  return { suppressedSetups, dowSuppressToday };
}

export function isLiveEligible(setupType, { suppressedSetups, dowSuppressToday }) {
  return !suppressedSetups.has(setupType) && !dowSuppressToday.has(setupType);
}
```

**Wire into `acd.js`'s existing cache block** (the one building `liveStats._suppressedSetups`,
around line 6337-6367) — replace the inline `setupStatusQ`/`dowStatusQ` construction with a
call to `computeSuppressionSets(todayDowInt)`, assign the result into `liveStats._suppressedSetups`/
`_dowSuppressToday` as before. This is a refactor, not a behavior change, for the main
candidates path — verify with a diff that the resulting Sets are identical before/after.

**Wire into `shadowCandidates`'s INSERT** (currently ~line 8621-8645, `if (shadowCandidates.length > 0)`)
— this is F3's already-drafted fix (`docs/LIVE_FIRING_AUDIT_20260814.md` section F3, copy the
diff from there, it's ready to apply as-is) with **one required change**: exclude
`STOP_SWEEP_LONG`/`STOP_SWEEP_SHORT` explicitly, since they're separately paused
(`OPEN_DECISION stop_sweep_long_calibrated_target_pause_or_keep`, still unresolved as of
2026-08-16):

```js
const STOP_SWEEP_PAUSED = new Set(['STOP_SWEEP_LONG', 'STOP_SWEEP_SHORT']); // see
  // OPEN_DECISION stop_sweep_long_calibrated_target_pause_or_keep -- remove this exclusion
  // once that decision resolves, don't just delete it silently
...
const shadowIsLive = !STOP_SWEEP_PAUSED.has(shadow.type) && isLiveEligible(shadow.type, suppressionSets);
```

(`suppressionSets` = the same `{ suppressedSetups, dowSuppressToday }` object already available
as `liveStats._suppressedSetups`/`_dowSuppressToday` at that point in the request cycle — pass
it through, don't refetch.)

**Before shipping, per F3's own original caveat #1**: review Layer 2's WARN list (the actual
per-type names, not just the count) and confirm none of them are setup types you'd rather keep
`SHADOW`-only even once technically eligible (e.g. genuinely noisy/thin ones). This is a human
judgment call the spec deliberately doesn't make for you — Layer 2's check produces the list,
it doesn't auto-approve it.

**Verify it works**:
1. `node --check server/routes/acd.js` and `npm run lint` clean.
2. Restart the server, confirm `/api/acd/setup-detection` responds 200, no new
   `scratch/server_errors.jsonl` entries.
3. **The actual proof this works**: after the next live poll cycle fires a `shadowCandidates`
   setup that's eligible, query `active_setups` for a fresh row with `origin_status='ACTIVE'`
   for one of the previously-stuck types (from Layer 2's WARN list). If none has fired yet
   (event-triggered, not guaranteed same-day), at minimum confirm the code path is reachable by
   temporarily logging `shadowIsLive`'s computed value for a few poll cycles, or by checking
   `gated_candidates`/timeline for a dry-run-style trace — don't consider this "verified" purely
   from "no errors," per this codebase's own standing distinction between "doesn't crash" and
   "actually does the right thing."
4. Re-run `node scripts/test_invariants.mjs` check `[20]` after a few days — the previously-WARNed
   types should start dropping off the list as real `ACTIVE` rows accumulate. This is the
   concrete, ongoing confirmation the fix is working, not a one-time check.

---

## Layer 3 — canonical resolved-trade predicate, migrate the 3 pollers

**The 3 still-broken promotion gates**, current code (read exact current line numbers before
editing, these will have shifted after Layer 1's changes):

- `server/services/minuteBarSignalDetector.js`'s `getLiveStatus()` — queries
  `WHERE setup_type LIKE '${SETUP_FAMILY}_%' AND resolution IN ('TARGET_HIT','STOP_HIT')`.
- `server/routes/acd.js`'s `getOvernightLevelLiveStatus(type)` — queries
  `WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT')`.
- `server/routes/acd.js`'s `getStackVolBreakLiveStatus(setupType)` — same pattern, exact type.

All three reimplement the exact `N>=20, EV<-$5` threshold `backtest_setup_status.mjs` already
computes correctly (including `TIME_EXPIRED`, fixed there 2026-08-03) — and all three still
exclude `TIME_EXPIRED`, undercounting real N for any setup_type in these 3 families whose
trades often time out rather than hit a clean stop/target.

**Fix: stop reimplementing, read the canonical `SETUP_STATUS` row directly** — same principle
as Layer 1, applied to these 3 functions instead of patching `TIME_EXPIRED` into their existing
queries (a narrower fix that would still leave 3 independent copies of the same logic to drift
again later):

```js
// Replace getLiveStatus() / getOvernightLevelLiveStatus() / getStackVolBreakLiveStatus()'s
// bodies with a shared helper reading the canonical SETUP_STATUS row instead of reimplementing
// the N/EV threshold against active_setups directly.
export async function getCanonicalLiveStatus(setupType) {
  const { rows } = await query(`
    SELECT recommendation, sample_size, ev_per_trade::float as ev
    FROM performance_audit WHERE signal_type='SETUP_STATUS' AND signal_name=$1
    ORDER BY run_date DESC LIMIT 1
  `, [setupType]);
  const row = rows[0];
  if (!row) return { status: 'SHADOW', reason: 'NEW_SIGNAL_UNDER_LIVE_EVALUATION', liveN: 0, liveEv: null };
  const isLive = row.recommendation === 'ACTIVE' || row.recommendation === 'PROMOTE';
  return {
    status: isLive ? 'ACTIVE' : 'SHADOW',
    reason: isLive ? null : (row.recommendation === 'THIN_N' ? 'NEW_SIGNAL_UNDER_LIVE_EVALUATION' : 'PERFORMANCE_BELOW_THRESHOLD'),
    liveN: row.sample_size, liveEv: row.ev,
  };
}
```

**One real open design question this spec deliberately does NOT resolve for you** —
`minuteBarSignalDetector.js`'s `SETUP_FAMILY = 'MOMENTUM_60m_60m_TREND'` uses a `LIKE
'${SETUP_FAMILY}_%'` wildcard, meaning its current check pools across every setup_type sharing
that prefix (e.g. a hypothetical `_LONG`/`_SHORT` split), whereas `SETUP_STATUS` calibrates
**per exact setup_type**. Verified 2026-08-16: `active_setups` currently has **zero** rows for
this family at all (matches the already-known "orphaned/dead calibration row" finding), and
`SETUP_STATUS` has exactly one row named `MOMENTUM_60m_60m_TREND` (no suffix) — so this
pooling-vs-exact question is moot *right now*, but will matter the moment this family (or a
similarly-patterned one) starts firing multiple sub-types under one family prefix. Decide
before shipping: does `getCanonicalLiveStatus()` take an exact setup_type (matching
`getOvernightLevelLiveStatus`/`getStackVolBreakLiveStatus`'s existing convention), or does
`minuteBarSignalDetector.js` need its own family-pooling wrapper on top? Recommendation if you
don't have a strong reason otherwise: exact setup_type, matching the other two and matching
how `SETUP_STATUS` itself is calibrated — if `MOMENTUM_60m_60m_TREND` ever splits into
directional variants, each should get its own real calibration, not inherit a pooled one.

**Also decide**: migrating these 3 pollers onto `isLiveEligible()`/`computeSuppressionSets()`
adds day-of-week suppression to families that never had it before (they currently check
N/EV only). This is a real behavior change, not just a bug fix — flag it in the commit message,
don't let it slide in silently. If undesired for these specific families, use
`getCanonicalLiveStatus()` above (SETUP_STATUS only, no DOW) rather than the full
`isLiveEligible()` used by Layer 1.

**Verify it works**:
1. `node --check` + lint on all 3 touched files.
2. Direct query, before and after: for each of the 3 families, `SELECT COUNT(*) FROM
   active_setups WHERE setup_type=<X> AND origin_status='ACTIVE'` — confirm the count doesn't
   regress (a type correctly `ACTIVE` before this change must still be `ACTIVE` after).
3. Restart server, confirm no new `scratch/server_errors.jsonl` entries for at least one full
   poll cycle from each of the 3 pollers (they run on different schedules — check
   `server/index.js`'s scheduling for `detectMomentum60Trend`/overnight window/stackvol).
4. Re-run `test_invariants.mjs` check `[20]` — this is the definitive "did it work" signal for
   Layer 3 specifically: any setup_type in the `momentum60`/`*_OVERNIGHT`/`STACK_VOL_BREAK_LIVE_*`
   families that was previously stuck (real N undercounted by TIME_EXPIRED exclusion) should
   either already clear the WARN or visibly approach it faster than before, since real N is no
   longer being silently undercounted.

---

## Final end-to-end verification (do this after all 3 layers ship, not per-layer)

The user's ask was explicit: *"know we verified that the fix works"* — not just "no errors."
Concretely:

1. `node scripts/test_invariants.mjs` — check `[20]`'s WARN list should be visibly shorter than
   it was right after Layer 2 shipped (some types will have genuinely started firing `ACTIVE`).
   Any type still on the list after Layers 1-3 ship needs a specific, named explanation (paused,
   genuinely rare-touch, deliberately excluded) — not silently left as an open question.
2. Direct query: `SELECT setup_type, COUNT(*) FROM active_setups WHERE origin_status='ACTIVE'
   AND fired_at > <the day Layer 1 shipped> GROUP BY 1 ORDER BY 2 DESC` — confirm at least one
   setup_type from `shadowCandidates`'s family appears that had **zero** `ACTIVE` rows in its
   entire prior history. This is the concrete, checkable proof the fix changed real behavior,
   not just passed a static check.
3. Resolve the 3 `OPEN_DECISION`s this spec closes (`promotion_pipeline_structural_fix_2026_08_16`,
   `shadowcandidates_hardcoded_no_promotion_path`, and the poller-gate half of
   `time_expired_exclusion_pattern_broader_audit`) via `scripts/flag_decision.mjs --resolve`,
   citing the specific verification evidence from steps 1-2 — not just "shipped."
4. Update `docs/OPEN_THREADS.md` with the final result, same convention as every other entry in
   this file — what changed, what was verified, what (if anything) is still open.
