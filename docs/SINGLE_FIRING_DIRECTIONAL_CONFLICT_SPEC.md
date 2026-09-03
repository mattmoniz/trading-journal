# Single-Firing / Directional-Conflict Spec

Status: **built and wired to ALL 4 real (ACTIVE-capable) insert sites (2026-09-03), added and
tested one at a time per explicit user request.** `isOppositeDirectionOpen()`
(`server/routes/acd.js`) forces SHADOW when a new real candidate's direction conflicts with a
currently-open real (`origin_status='ACTIVE'`) position. Live on: (1) the RTH main active-slot
path, (2) the Globex path (`detectGlobexSetup()`'s PD-level candidates array), (3)
`STACK_VOL_BREAK_LIVE`, (4) the `shadowCandidates` loop (this loop is where most level-fade
candidates that don't win the single `active` slot actually fire `ACTIVE` from, per its own
existing comments — the highest-volume of the 4 in practice).

**Checked all 7 raw `INSERT INTO active_setups` sites in `acd.js` before finalizing scope**: the
other 3 (a `CASCADE_BREAKER` audit-only insert using `status='EXPIRED'`, a "suppressed audit"
insert hardcoded to `'SHADOW','SHADOW'`, and an "early-touch backfill" insert also hardcoded to
`'SHADOW','SHADOW'`) can structurally never produce a real `ACTIVE` row, so a directional-conflict
gate there would be a correct no-op — confirmed this matches where the cross-direction and
sibling-reversal gates are ALSO not wired, i.e. this is the established pattern, not an oversight.
Written after a same-session research thread (same-setup-type refire gate investigation led into
this). No prior spec existed before this document — checked memory, `docs/OPEN_THREADS.md`, and
every flagged `OPEN_DECISION` first.

## The rule under test

Not "the account can only ever hold one position, period." The user's actual design intent,
confirmed directly: **multiple concurrent positions in the SAME direction are fine** (they just
add up, same as today) — the rule is specifically **never open a NEW position in the OPPOSITE
direction of anything currently open**, because in a real single account a long and a short on
the same instrument (MNQ) would net against each other rather than exist as two independent bets.

Non-directional setup_types (no `_LONG`/`_SHORT` suffix, e.g. `IB_BULLISH`) have no direction to
conflict with anything and are always let through — same convention the live sibling-reversal
gate (`isPostWinOppositeFamilyBlocked()`) already uses.

## What was tested and found (2026-09-03)

### 1. Per-case decision: if a conflict happens, hold or switch?

Question: when a trade is open and a new opposite-direction signal (different setup_type) fires,
is it better to (A) ignore the new signal and let the open trade ride to its real resolution, or
(B) exit the open trade now (banked at its real mark-to-market price) and take the new signal
instead?

**First pass had a real bug**: naively joining every open trade against every opposite-direction
trade that fired during its lifetime double/triple/85-counted long-lived positions (one trade,
`id=79618`, was counted 85 times because 85 different short-lived setups happened to fire during
its long open window). That inflated N to 4,161 and showed switching winning by a huge margin
(+$13.64/pair) — an artifact, not a real effect.

**Corrected version** (one observation per open trade — only the FIRST opposite-direction signal
during its life counts as the decision point): N=1,316 real cases, 43 distinct days, 40.2% of N
from the top-5 busiest days (under this codebase's 50% day-clustering threshold).

| Strategy | Avg per case |
|---|---|
| Hold — ignore the new signal, let the open trade finish | **+$6.80** |
| Switch — bank the open trade now, take the new signal | **+$3.71** |

**Verdict: hold beats switch by ~$3.09/case.** Spot-checked the largest individual values
(`C_PAIRED_LONG`, $1,958, a real >24hr wide-stop TIME_EXPIRED trade) directly against
`active_setups` to confirm the bug fix didn't introduce a new one — checked out.

### 2. Account-level impact: does blocking opposite-direction overlaps actually change total real P&L?

A materially different question from #1 — #1 asks "if forced to choose, which is better"; this
asks "how often does this situation even arise for REAL capital, and does removing those trades
change the account's real total?"

Simulated on real `origin_status='ACTIVE'` trades only (N=475, the account's actual real-money
history), walking chronologically and blocking any new fire while an opposite-direction position
was open (same-direction stacking allowed freely):

| | N | Total P&L | Avg/trade |
|---|---|---|---|
| Actual (what really happened) | 475 | $1,546.61 | $3.26 |
| Simulated (opposite-direction blocked) | 455 taken (20 skipped) | $1,505.48 | $3.31 |

**Verdict: real opposite-direction conflicts are rare (20/475 = ~4.2% of real trades) and the
P&L impact of blocking them is negligible (-$41.13 total, on N=20 — well below this codebase's
own N≥20 decisiveness floor).** This is NOT a return-improving mechanism — the honest framing is
"cheap risk-discipline insurance with no measurable cost," not "this makes the account better."
Don't oversell it as a P&L improvement when proposing this to build or review it.

## What was tested and found NEGATIVE (same-setup-type refire, related but separate thread)

Not part of this spec's core question, but discovered in the same session and directly relevant
context for anyone extending this work: a same-EXACT-setup_type refire gate (blocked until a
DIFFERENT setup fires, mirroring the sibling-reversal gate's own event-based reset) was built,
calibrated across the full roster, and found NOT yet ready for live use — a genuine walk-forward
split (train on the first half of each setup's history, test on the second half) showed ZERO of
27 setup/session groups had even enough data to pick a mechanism on the train half alone, let
alone validate it held up on test. See `RESEARCH_CLAIM same_type_refire_gate_calibration_20260903`
and `docs/OPEN_THREADS.md`'s 2026-09-03 entries for the full writeup — that thread is calibration-
only (`scripts/backtest_same_setup_refire_gate.mjs`, running nightly) and not live-wired.

## What's built (2026-09-03)

`isOppositeDirectionOpen(direction)` in `server/routes/acd.js` — queries currently-unresolved
real (`origin_status='ACTIVE'`) rows, resolves each one's direction via the canonical
`resolveDirection()` (price-derived, handles name-directionless types correctly), returns true if
any open row is the opposite direction of the candidate. Wired into the RTH main active-slot
insert path only, short-circuited behind the cross-direction and sibling-reversal gates (same
"only check if nothing already forced SHADOW" pattern those two use), forcing SHADOW with reason
`OPPOSITE_DIRECTION_OPEN` when triggered.

**Tested before shipping** (no live-DB writes used for testing — synthetic in-memory rows only):
1. Smoke-tested the real function against the live DB (`scratch/test_opposite_direction_gate_live.mjs`)
   — ran without error, correctly returned `false` for both directions when nothing was open.
2. Unit-tested the exact classification logic (`scratch/test_opposite_direction_gate_logic.mjs`)
   against 8 synthetic cases — same-direction (no conflict), opposite-direction (conflict), no
   position open, a null-direction candidate, and a name-directionless open position whose
   direction only resolves correctly via price levels. All 8 passed.
3. `node --check`, `eslint`, and a full `test_invariants.mjs` run — same 15 pre-existing
   failures/78 warnings as before this change, nothing new introduced.

## Remaining work (tracked via `OPEN_DECISION single_firing_directional_conflict_gate_not_built`)

All 4 real insert sites are wired as of 2026-09-03. What's left:

1. **Frame it correctly when reviewing**: this is risk-discipline (never let opposite directions
   net against each other in a single real account), not a backtested EV improvement — the
   account-level simulation found the P&L delta indistinguishable from noise (N=20).
2. Per this codebase's higher-stakes-work rule (gates real trade eligibility), the full rollout
   should still get a design critique + code review pass before being considered fully shipped,
   even though every site went through direct testing (live smoke test + logic unit test +
   `test_invariants.mjs`, all clean) as it was added.
3. Watch real `OPPOSITE_DIRECTION_OPEN` fires as they accumulate (`suppression_reason` on
   `active_setups`, or the loose `st` boolean on the `shadowCandidates` site which doesn't
   currently persist a per-reason string) to confirm live behavior matches the backtested
   expectation.
4. Note the `shadowCandidates` site (site 4) doesn't populate `suppression_reason` in its INSERT
   at all — none of that loop's gates (cross-direction, sibling-reversal, or this one) currently
   distinguish WHY a candidate went SHADOW there, only THAT it did (the `st` boolean). Worth a
   follow-up if per-reason visibility on that specific site ever matters for debugging or
   promotion-pipeline work.

## Source scripts (scratch, not productionized)

- `scratch/test_opposite_direction_overlap_strategy.mjs` — per-case hold-vs-switch test (§1)
- `scratch/test_true_single_firing_account_sim.mjs` — account-level simulation (§2)

These are exploratory, not scheduled/productionized scripts — if this gate gets built, its
calibration/monitoring should get a real `scripts/` name and (if it needs recurring recompute) a
cron entry, per this codebase's own convention.
