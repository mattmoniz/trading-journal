# acd.js file-size reduction — scoping spec (2026-09-16)

**Status: scoped, not started.** Written after a user question ("how many lines is acd.js" →
"what would shrink it") turned into a real measurement pass. Nothing in this spec has been
executed — it's the plan, verified against the file's real current structure, not a guess.

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
