# acd.js file-size reduction — scoping spec (2026-09-16)

**Status: Phase A DONE (2026-09-20). Phase B not started.** Written after a user question
("how many lines is acd.js" → "what would shrink it") turned into a real measurement pass.

## Phase A — executed 2026-09-20, corrected the spec's own premise along the way

The spec's original claim ("already decoupled enough to physically move with no logic changes")
turned out to be wrong for real, exactly the failure mode the spec's own verification section
warned about ("Do not assume the ctx pattern alone proves it"). The exhaustive grep the spec
demands found `buildAllCandidates()`/`computeLevelFadeFactors()` also depend on a handful of
MODULE-LEVEL helpers that live outside their `ctx` (not the `runSetupDetection`-local closures
Phase C is deferred over — those are a structurally different, still-unmoved problem):
`logGatedCandidate()` (also called ~8 more times directly inside `runSetupDetection`'s own
remaining body — re-imported back into acd.js, not just moved), `t1Guard()`/`t1GuardLabeled()`
(confirmed used only inside `buildAllCandidates`, nowhere else in the file), and
`_pdpMissingLogged` (a console.error dedup Set, used only inside `computeLevelFadeFactors`).
Several other early grep "hits" (`REFIRE_COOLDOWN_MINUTES`, `isInRefireCooldown`,
`recentlyShadowedSameType`, `tagDirectionGateShadow`, `getMomentumAgainstFade*`) turned out to be
comment-only mentions inside the two functions' own prose, not real code references — verified
line-by-line before concluding either way, since a bare grep hit doesn't distinguish a comment
from a call site.

All 5 moved to `server/services/acdCandidateBuilder.js` (buildAllCandidates,
computeLevelFadeFactors, logGatedCandidate, t1Guard, t1GuardLabeled, plus the _pdpMissingLogged
Set) — no circular import results, since acd.js only ever imports FROM the new file. Real
reduction: **12,286 → 10,658 lines (-1,628, ~13%)**, close to the original ~1,657-line estimate
despite the extraction unit being different from what the spec described. Verified: ESLint's
no-undef caught 9 genuinely missing imports on the new file before they could have become a
live bug (matchPermissionSlips, computeIbBullBear, classifyACDOpeningCall, getOrVolBaseline20d,
computeLiveVolatilityRegime, resampleBars, computeRSI14) — fixed, then 0 errors/0 warnings on
both files. `node scripts/test_invariants.mjs` byte-identical to baseline (25 FAIL/90 WARN),
`npm run lint` + `npm run build` clean, `./restart.sh` + live PID/uptime check confirmed the
running process postdates the edit, `GET /api/acd/setup-detection` returns clean JSON, zero new
`scratch/server_errors.jsonl` entries.

## `/acd/live` — deleted outright, not extracted (2026-09-20)

Phase B originally named `/performance-audit/unified` (899 lines) and `/acd/live` (548 lines) as
extraction candidates. `/acd/live` turned out not to need extraction — it's dead code. Tracing
consumers of `GET /api/acd/setup-detection` (for an unrelated investigation, see
docs/OPEN_THREADS.md's 2026-09-20 entry) led to checking `/acd/live` too: its only frontend hook,
`useAcdLive()`, was imported in `App.jsx`/`ACDView.jsx` but never actually called — the one
component that called it, `ACDSessionTimeline`, was deleted as dead code 2026-07-16 (commit
`9fb677b`), and the hook file plus the 548-line backend handler were never cleaned up in the same
pass. Confirmed read-only (no INSERT/UPDATE/io.emit/setCached) before deleting the whole handler,
`src/utils/useAcdLive.js`, and both dead imports. Phase B's remaining scope is just
`/performance-audit/unified` now.

**Same pass also found 17 dead imports at the top of acd.js** — 4 caused by Phase A itself
(the relocated functions' old imports were never removed, since this file's `npm run lint` has
no `no-unused-vars` rule configured to catch it), 13 pre-existing (likely superseded by the
`complete*Shadows()` wrapper pattern without their raw imports ever being cleaned up). All
grep-confirmed individually before removal, not assumed from a pattern.

**Cumulative acd.js reduction, 2026-09-20: 12,286 → 10,091 lines (~18%)**, combining Phase A
(1,628 lines), the `/acd/live` deletion (~537 lines), the `description`/`confluenceNote` removal,
and the dead-import sweep.

The rest of this document (Phase B's remaining `/performance-audit/unified` extraction, the
"not in scope" section, and the general verification checklist) is the original 2026-09-16 text,
unexecuted.

## Current state (measured directly, not from an old comment)

`server/routes/acd.js` is **12,897 lines**. `export default function createACDRouter(io) { ... }`
(line 3682 to end-of-file) is a single ~9,215-line function containing every route registration —
71% of the entire file lives inside one function body.

| Chunk | Lines | Location |
|---|---|---|
| `runSetupDetection()` | 4,049 | inside `createACDRouter`, lines 6045–10093 |
| `buildAllCandidates()` | 1,265 | top-level, lines 2025–3290 (outside the router closure) |
| `/performance-audit/unified` route handler | 899 | inside `createACDRouter`, lines 11695–12594 |
| `/acd/live` route handler | 548 | inside `createACDRouter`, lines 5094–5642 |
| `computeLevelFadeFactors()` | 392 | top-level, lines 3290–3682 (outside the router closure) |
| `/market/pulse` route handler | 226 | inside `createACDRouter`, lines 12594–12820 |
| `/acd/correlation` route handler | 174 | inside `createACDRouter`, lines 4529–4703 |

`runSetupDetection` + its own two already-extracted helpers (`buildAllCandidates`,
`computeLevelFadeFactors`) together account for **5,706 lines — 44% of the whole file** — this is
really one detection pipeline, not a naturally file-shaped unit.

## Prior history — `runSetupDetection` was already worked on once, and stopped

A prior session ran a real, multi-pass decomposition specifically to shrink this function:
`fetchDetectionInputs()` (Pass 1), `buildAllCandidates()` (Pass 2), `computeLevelFadeFactors()`
(Pass 3) were all pulled out of `runSetupDetection`'s own body as named, `ctx`-parameterized
functions for exactly this reason. A 4th pass was attempted and explicitly closed — CLAUDE.md's
own "`acd.js` block-scoping footgun" entry documents why: `liveStats` is declared with `let`
inside a nested `if` block partway through the function, and a large amount of downstream code
(the candidates loop, `shadowCandidates`, every real INSERT) reads it directly. There is no clean
seam left in the remaining ~4,049 lines without first resolving that scoping problem — **this
spec does not propose reopening Pass 4.** Any future attempt at `runSetupDetection` itself needs
to start by lifting `liveStats` out of its `let`-inside-if declaration into something explicitly
threaded through (the same pattern `buildAllCandidates`/`computeLevelFadeFactors` already use via
their own `ctx` parameter), not by trying to slice the function differently.

## What this spec actually proposes: two safer, real reductions

### Phase A — relocate the two already-extracted helpers (lowest risk, do first)

`buildAllCandidates()` and `computeLevelFadeFactors()` already take their state via an explicit
`ctx` parameter (destructured at the top of each function) rather than reading `runSetupDetection`'s
closures directly — that was the whole point of Pass 2/3. This means they're plausibly *already*
decoupled enough to physically move to `server/services/` with no logic changes, just a relocation
+ import.

**Before moving either one**, per this codebase's own standing rule ("free-variable/return-
completeness must be checked by exhaustively grepping every candidate name against the ENTIRE
downstream body — never by eyeballing a read-through, even a careful one" — CLAUDE.md's
Conventions section, which documents two prior near-misses on this exact file): grep every
identifier referenced inside each function against (a) its own `ctx` destructuring, (b) module-
level imports/constants, and (c) anything else in scope — confirm there is no remaining implicit
closure reference to `runSetupDetection`'s own local variables. Do not assume the `ctx` pattern
alone proves it; that's the same trap the `etMin` and `_lfOvOpen`/`_pulseVolSigma` near-misses
came from.

New home: `server/services/acdCandidateBuilder.js` (or similar — matches this codebase's own
"default new acd.js logic to server/services/" convention). Expected reduction: **~1,657 lines
(13% of the file)**, zero behavior change.

### Phase B — extract the two largest standalone route handlers' bodies

`/performance-audit/unified` (899 lines) and `/acd/live` (548 lines) are each a single
`router.get(...)` handler — self-contained by construction (only `req`/`res` plus whatever they
import), not entangled in `runSetupDetection`'s shared state. Per this codebase's own rule, the
route *registration* stays in acd.js (that's the one explicit exception to "move new logic to
services"), but each handler's internal logic can move into a plain service function the thin
route handler then calls — matching the existing precedent (`detectGlobexSetup`,
`computeStackVolSignal`, etc. are already structured this way elsewhere in this same file).

Expected reduction if both are fully extracted: **~1,447 lines (11%)** — likely partial in
practice, since some of that logic may reasonably want to stay inline (check as you go, don't
force a split that hurts readability just to hit a number).

### Not in scope for this spec

- `runSetupDetection`'s own remaining 4,049-line body (Phase C, deliberately deferred — see
  "Prior history" above). Revisit only as its own, separately-scoped effort that starts by
  addressing the `liveStats` block-scoping problem, not by attempting another line-count pass.
- The smaller route handlers (`/market/pulse` 226 lines, `/acd/correlation` 174 lines, etc.) —
  real but much smaller wins; worth doing opportunistically if touching those handlers anyway,
  not worth a dedicated pass on their own.

## Verification requirements (same discipline every extraction in this file already documents)

1. Exhaustive free-variable grep (see Phase A above) before finalizing any extraction boundary.
2. Byte-diff old vs. new output over real data for whatever endpoint/function moved.
3. `node scripts/test_invariants.mjs` against the current baseline — no new failures.
4. `npm run lint` / `npm run build` clean.
5. Live server restart, confirm process postdates the edit, health-check the affected
   endpoint(s).
6. No behavior change is the goal at every phase — this is a maintainability investment, not a
   feature or a bug fix. If any phase changes a real number/response shape, that's a bug in the
   extraction, not an acceptable side effect.

## Priority

**MEDIUM** — real value (a 12,897-line file is a genuine cost to every future session working in
it), no urgency (nothing here is a correctness bug or a live-trading risk). Should not preempt
higher-priority live-correctness work; a reasonable candidate for a quiet session with no other
pressing user requests.
