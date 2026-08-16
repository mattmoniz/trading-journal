# Promotion pipeline structural audit (2026-08-16)

**Context**: same-day follow-up to the cascade-breaker contamination repair
(`docs/OPEN_THREADS.md`'s 2026-08-16 entry, `scripts/repair_cascade_breaker_contamination_20260816.mjs`).
User's direct, verbatim worry after seeing that repair's blast radius (20 setup_types
changed recommendation): "I dont want to keep having an issue where setups arent getting
promoted. Its fundamental here." Dispatched to DeepSeek for design critique (per this
codebase's standing Claude-implements/DeepSeek-reviews division of labor), full request in
the git history of `scratch/claude_request_deepseek.md` as of this commit if needed again.

**Claude's independent verification, done before trusting any of this** (per the standing
"audit all DeepSeek/Gemini output" rule): every checkable factual claim below was re-verified
directly against the live code/schema, not just relayed —
- The 3 FK constraints on `active_setups(id)` (schema.sql:12096/12104/12112,
  `setup_outcome_backtest` ON DELETE CASCADE / `trade_feedback` restrict / `trade_timeline_events`
  restrict) — confirmed exact via direct grep.
- Whether the `setup_outcome_backtest` gap actually lost data — confirmed **zero rows lost**:
  `setup_outcome_backtest.MAX(trade_date)` is 2026-06-19, over a month before the earliest
  deleted CASCADE_BREAKER row (2026-07-27); its one live writer never ran in that window.
  Real gap in the repair script's methodology, empirically harmless this one time.
- The `shadowCandidates` hardcoded `'SHADOW','SHADOW'` insert — confirmed exact code match.
- All 3 "still excludes TIME_EXPIRED" poller promotion-gate claims
  (`minuteBarSignalDetector.js`, `acd.js` `getOvernightLevelLiveStatus()`/
  `getStackVolBreakLiveStatus()`) — confirmed exact via direct read.
- The `backtest_setup_status.mjs` "already fixed, 6 sites include TIME_EXPIRED" claim —
  confirmed exact via direct grep (lines 169/192/212/249/267/551/564).

Recorded as `OPEN_DECISION`s (see `node scripts/flag_decision.mjs --list`):
`promotion_pipeline_structural_fix_2026_08_16` (HIGH, new), `time_expired_exclusion_pattern_broader_audit`
(elevated MEDIUM→HIGH with the verified specifics below), `shadowcandidates_hardcoded_no_promotion_path`
(F3, updated with the sequencing recommendation below). None of the proposed fix layers are
built yet — this is a design decision awaiting explicit sign-off before implementation starts,
per this codebase's standing high-stakes-work protocol (gates live setup-firing eligibility
system-wide).

---

## DeepSeek's full response (verbatim, verified accurate per above)

# DeepSeek review — cascade-breaker cleanup QA + "setups never get promoted" structural analysis

Role note: this is the DeepSeek review/critique half of the Claude-implements / DeepSeek-reviews
split. No Postgres access used here; everything below is read from the code/docs listed in the
request plus grep over `server/` and `scripts/`. Flagging where I could NOT verify a claim for
lack of DB access rather than papering over it.

---

# Part 1 — QA of the cascade-breaker cleanup

## 1.1 Deletion vs. migrate-in-place — deletion is right; your rationale holds

I agree with deletion. The migrate-in-place alternative would have converted 1,072 rows into
the new terminal-marker shape (`status='EXPIRED'`, `resolution='NO_EXPIRY_SET'`, nulled
levels). That preserves the rows but produces 1,072 dead tombstones in `active_setups` that
serve no purpose — the new marker exists only so a *future* cascade window can log a touch
once per (trade_date, setup_type); it has zero value for the *past*. Your two-part rationale
(rows were never a fire decision; they contribute nothing but contamination) is exactly the
`OPEN_DECISION cascade_breaker_historical_rows_need_repair` framing, and it's sound.

One point of pushback on framing, not on the decision: you wrote "full provenance is preserved
via the backup tables either way." That claim is only true for the tables you actually backed
up — see 1.2, where it is not true.

## 1.2 Other FK references — YES, you missed two; one of them is a silent-data-loss risk

You asked me to grep `server/schema.sql` for `REFERENCES active_setups` and tell you if there's
a referencing table you missed. Answer: **there are three FK constraints on
`active_setups(id)`, not one**, and you only handled one of them:

| line | constraint | on delete | did the repair script handle it? |
|---|---|---|---|
| `server/schema.sql:12096` | `setup_outcome_backtest.setup_id → active_setups(id)` | **`ON DELETE CASCADE`** | **NO — silent, un-backed-up deletion risk** |
| `server/schema.sql:12104` | `trade_feedback.setup_id → active_setups(id)` | (restrict) | NO — would have blocked the delete |
| `server/schema.sql:12112` | `trade_timeline_events.setup_id → active_setups(id)` | (restrict) | YES — backed up then deleted |

This matters for two concrete reasons:

1. **`setup_outcome_backtest` is `ON DELETE CASCADE`.** `scripts/repair_cascade_breaker_contamination_20260816.mjs`
   only backs up `active_setups` (line 60) and `trade_timeline_events` (line 76). It never
   checks `setup_outcome_backtest`. If any of the 1,072 deleted ids had a matching
   `setup_outcome_backtest` row, the `DELETE FROM active_setups ...` at line 89 would have
   **silently cascade-deleted it with no backup and no count check**. You would not even have
   seen an error (unlike `trade_timeline_events`, which surfaced because its FK is RESTRICT).
   So the statement "full provenance is preserved" is unverified for this table. The correct
   pre-delete check was:

   ```sql
   SELECT COUNT(*) FROM setup_outcome_backtest s
   WHERE s.setup_id IN (SELECT id FROM active_setups WHERE suppression_reason='CASCADE_BREAKER');
   ```

   I cannot run this (no DB access per the task). You should verify it — and if the count is
   non-zero, those rows are already gone and need to be reconciled from
   `active_setups_cascade_breaker_repair_backup_20260816` (which retains the original ids) if
   they matter. `setup_outcome_backtest` is a per-fire backtest-outcome cache (hit_t1 /
   hit_stop / mfe / mae / computed_pnl_1contract), so losing rows for 1,072 phantom cascade
   fires is almost certainly *harmless in practice* — but it should be a known-harmless fact
   you confirmed, not an unknown.

2. **`trade_feedback` is RESTRICT (no cascade).** If any of the 1,072 ids had a `trade_feedback`
   row, line 89 would have thrown a *second* FK violation after the `trade_timeline_events`
   delete, and the script would have exited non-zero with `active_setups` still fully intact
   but the timeline rows already deleted. You reported a clean run (1,072 deleted from
   `active_setups`), which *implies* `trade_feedback` had zero matching rows — but that's an
   inference from the successful exit, not a check. Worth adding both tables to the script's
   verification for future repair scripts of this shape.

Minor secondary note on the backup method: `CREATE TABLE ... AS SELECT *` copies data but not
constraints/indexes/sequences. Fine for a forensic backup; just don't treat it as a
restore-ready table (a restore would need `INSERT INTO active_setups SELECT * FROM <backup>`
after re-verifying ids don't collide — the sequence was never touched, so it wouldn't).

## 1.3 Does re-baseline + restart complete the live-effect chain? — Yes, for the firing layer

I traced the consumers. Verdict: **restart + `backtest_setup_status.mjs` re-run is sufficient;
there is no other cache to nudge.**

- **Firing layer (the thing that actually flips a fire from ACTIVE to SHADOW):** `liveStats._suppressedSetups`
  / `_dowSuppressToday` / `_setupStats` are built once per day and cached via
  `getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)` with `DAY_CACHE_TTL = 12h`
  (`server/routes/acd.js:94`, `:7678`). The main candidates path reads it at
  `acd.js:8494` (`forceShadow = ... || _suppressedSetups.has(active.type) || ...`). This is the
  in-memory cache you correctly identified, and a process restart clears it. Good.

- **Display layer (`/api/setups/history`):** `getShadowSetupTypes()` (`acd.js:9113-9120`) runs a
  **fresh** `SELECT ... FROM performance_audit WHERE signal_type='SETUP_STATUS'` on every call —
  it is NOT behind `getCached`. So the Setup Log "shadow" filter already reflects the corrected
  recommendations the moment `backtest_setup_status.mjs` writes them, with no restart. (This is
  by design — the 2026-07-17 fix that replaced the hardcoded `SHADOW_SETUP_TYPES` list made it a
  live query specifically so it couldn't go stale.)

- **Standalone pollers:** `minuteBarSignalDetector.js:getLiveStatus()` (line 84), and
  `acd.js:getOvernightLevelLiveStatus()` (line 1004) and `getStackVolBreakLiveStatus()` (line 1025),
  all read `active_setups` directly (real resolved trades), **not** `performance_audit SETUP_STATUS`.
  They are therefore unaffected by both the cascade contamination (their setup families are
  `MOMENTUM60_*`, `*_OVERNIGHT`, `STACK_VOL_BREAK_LIVE_*` — disjoint from the level-fade names the
  cascade rows used) and by this re-baseline. No nudge needed, and no stale SETUP_STATUS copy exists
  there to go stale.

So: re-run + restart is complete. (Caveat, stated for honesty: I'm asserting "no other cache"
from grep; if there is a second long-lived Node process e.g. a separate worker under pm2 that
also builds `liveStats`, the restart must cover it too — but nothing I grepped caches
SETUP_STATUS outside `acd.js`'s `levelFadeStats` key.)

**Part 1 verdict: the cleanup was correct and the reasoning sound, with one real gap — the
`setup_outcome_backtest` ON-DELETE-CASCADE table was never checked or backed up, so "full
provenance preserved" is unproven for it. Everything else (deletion choice, re-baseline,
restart) is right.**

---

# Part 2 — is "setups never get promoted" structural?

## 2.1 Verdict on your framing: mostly right, but it mis-classifies one of the four and
misses the sharper version of the root cause

You proposed: *"multiple, independent, unilateral gates, each able to block a setup from ever
reaching ACTIVE, and no single place audits whether the promotion path is structurally
reachable end-to-end."*

I think that framing is **right on the conclusion, wrong on the classification**, and the
mis-classification matters because it affects which fix you build. The four incidents are not
four instances of one bug; they are **two (arguably three) distinct bug classes that produce
the same symptom**, and the thing they genuinely share is the *absence of a reachability
audit*, not a common mechanism:

- **Item 2 (shadowCandidates hardcoded SHADOW)** — this is a genuine unilateral gate. The
  insert path at `acd.js:8636-8650` writes literal `'SHADOW','SHADOW'` (line 8640) and never
  consults `SETUP_STATUS` at all. A setup in this array cannot leave SHADOW regardless of data.
  This is the cleanest match to your "unilateral gate" model.

- **Item 3 (TIME_EXPIRED exclusion)** — this is NOT a gate; it's an **undercounted input to a
  gate**. The gate itself (`n < SUPPRESS_MIN_N` → THIN_N) is working; the `n` fed into it is
  silently missing ~7% of real trades. Classifying it as "a gate" leads you to look for the
  wrong fix (another eligibility check) when the fix is "the population query is wrong."

- **Item 1 (cascade-breaker contamination)** — this is **contaminated input, and it cut BOTH
  directions**, which your "gate that blocks promotion" framing doesn't capture. It falsely
  *promoted* 11 types (ACTIVE on inflated real_n) at the same time it falsely *suppressed* 7
  others. That's not a gate; it's poisoned data. It belongs in the same family as the
  BACKFILL/UNKNOWN `origin_status` contamination fixed 2026-07-20 and the `CAM_S2_FADE_SHORT`
  blended-EV contamination fixed 2026-08-10 — a data-integrity bug, not a promotion-path bug.

- **Item 4 (OPTIMAL_STOP circuit breaker)** — this is a **frozen-calibration** problem, a
  *different axis entirely*. A circuit-breaker-frozen setup can still be `ACTIVE` and fire live;
  it just fires with a stale stop/target. It shares the *shape* of your symptom ("accumulates
  data, never improves") but not the *mechanism* (no relation to `SETUP_STATUS`/ACTIVE-SHADOW
  at all). Conflating it with items 2-3 will make you design a fix that doesn't touch it.

So the honest answer to your first question: **no single common root cause across all four.
There are at least two, and a strong case for three.**

But — and this is the part where I think you are right and it's the valuable part — there is a
**meta** root cause that does explain why all four kept surfacing the same way: **there is no
single canonical definition of "can this setup type currently reach ACTIVE," so the gate is
re-implemented (and re-broken) in five separate places, and nothing asserts end-to-end
reachability.** Concretely, there are **five** distinct ACTIVE-vs-SHADOW decision sites, and
only two read the canonical source:

| # | site | reads canonical SETUP_STATUS? | note |
|---|---|---|---|
| 1 | `candidates` path (`acd.js:7682-7694` + `forceShadow` at `8494`) | yes (`_suppressedSetups`) | level-scalp + ibSetup |
| 2 | `getShadowSetupTypes()` (`acd.js:9113`) | yes (fresh) | display layer only |
| 3 | `shadowCandidates` INSERT (`acd.js:8636-8650`) | **no — hardcoded SHADOW** | the bug (#2) |
| 4 | `minuteBarSignalDetector.getLiveStatus()` (`:84`) | no — reimplements N≥20 & EV≥−$5 against `active_setups` | **still excludes TIME_EXPIRED** |
| 5 | `getOvernightLevelLiveStatus()` (`acd.js:1004`) + `getStackVolBreakLiveStatus()` (`acd.js:1025`) | no — same reimplementation | **still excludes TIME_EXPIRED** |

This is the sharper version of your hypothesis, and it's the one to build against: the codebase
has **one suppression *pipeline*** (which is the right idea — CLAUDE.md's "unified suppression
pipeline" rule) but **three reimplemented promotion gates** (sites 3/4/5) that each drifted
independently. Site 3 drifted to "never check at all"; sites 4/5 drifted to "check but with the
stale resolution filter."

And there is a **second** meta-thread you under-weighted: the codebase *already knows* the
"stale hardcoded filter/list" anti-pattern and has documented it twice —
`docs/CONVENTIONS_DETAIL.md` ("SHADOW_SETUP_TYPES hardcoded list anti-pattern") and CLAUDE.md
("never add a hardcoded suppression list") — plus a standing invariant
(`test_invariants.mjs` check `[6]`) that re-verifies `UNCALIBRATED_SHADOW_TYPES` against live
SETUP_STATUS so it can't drift. `shadowCandidates` is that exact documented anti-pattern hitting
a **third** location (the *firing* layer, after display and the fallback list were both fixed),
and `TIME_EXPIRED` is the *same shape* — a filter that was correct when written and went stale
when upstream changed. The defense exists but is **per-location, not systemic**. That is the
root cause worth naming.

## 2.2 The TIME_EXPIRED gap is still open today — and it's in the promotion gates themselves

You asked me to grep for `resolution IN` / `TARGET_HIT.*STOP_HIT` across `server/` and say
whether this is still an open gap. **It is.** `backtest_setup_status.mjs` itself was fixed
(2026-08-03, all 6 sites now include TIME_EXPIRED — confirmed at `scripts/backtest_setup_status.mjs:169/192/212/249/267/551/564`),
but the identical `resolution IN ('TARGET_HIT','STOP_HIT')` pattern (TIME_EXPIRED still absent)
survives in **~20 places**, including — critically — the three *independent promotion gates*:

| file:line | what it feeds |
|---|---|
| `server/services/minuteBarSignalDetector.js:88` | `getLiveStatus()` — the standalone-poller promotion gate |
| `server/routes/acd.js:1008` | `getOvernightLevelLiveStatus()` — overnight-level promotion gate |
| `server/routes/acd.js:1029` | `getStackVolBreakLiveStatus()` — stackvol promotion gate |
| `server/routes/acd.js` (17 total occurrences) | WR/EV-at-fire lookups (`7984`, `8742/8746/8750/8754`), decided-trade counts (`9326`, `9421/9424`, `9532/9533`, `9543/9547`, `10137`) |
| `server/routes/stats.js:831` | stats endpoint |
| `server/routes/setups.js:329/333` | setups history WR |
| `server/services/monteCarloService.js:115` | Monte-Carlo input |

Consequence for the user's actual complaint: the `momentum60`, `*_OVERNIGHT`, and
`STACK_VOL_BREAK_LIVE_*` families have a **second, independent, still-live undercounting bug**
inside their own promotion gates. A setup whose real trades mostly TIME_EXPIRE (common for
mean-reversion/continuation that doesn't hit a clean stop or target intraday) will have its
`n` undercounted by exactly those expiries, so it can sit at N=19 forever while holding 25 real
resolved trades. This is the SAME failure shape the user is worried about, still unfixed, in a
mechanism your Part-1 work did not touch. `OPEN_DECISION time_expired_exclusion_pattern_broader_audit`
is still PENDING (MEDIUM) as of the registry dump — correctly, because it is genuinely still
open.

## 2.3 What a real structural fix looks like (three layers, not one)

I'm going to react to your (a) and (b) and then add a third. None of these is a patch for any
one of the four items; they're the class-level fixes.

**Layer 1 — one canonical promotion gate, imported everywhere (your (b), and it's correct).**
Today sites 3/4/5 each decide ACTIVE-vs-SHADOW independently. Site 4 and 5 are literally the
"replicate the dynamic check manually" pattern CLAUDE.md rule 7 *requires* for standalone
pollers — and that rule has now produced **three** hand-rolled copies with a shared bug (all
three exclude TIME_EXPIRED). The fix is to stop replicating: export one function (e.g.
`isLiveEligible(setupType)` reading the same cached `_suppressedSetups`/`_dowSuppressToday` the
candidates path uses) and make every insert path call it — including `shadowCandidates` (which
today calls nothing). This single move fixes item #2 *and* removes the drift surface for items
#3/#4 in the pollers.

**Layer 2 — a standing *reachability* invariant, not a "something changed" invariant (your (a),
refined).** Your (a) as literally stated — "assert SOMETHING changed about its live-firing
eligibility for every type crossing N=20" — is the wrong invariant. It's time-dependent and
noisy: it will fire on every week where a legitimately-EV-negative setup's N grows but its
recommendation correctly stays SUPPRESS, training you to ignore it. The invariant you actually
want is **structural reachability**, which is stable and snapshot-checkable:

> For every setup_type whose latest `SETUP_STATUS` recommendation is `ACTIVE` or `PROMOTE`,
> assert there exists at least one live insert path that is *capable* of emitting
> `origin_status='ACTIVE'` for it (i.e. it is not reachable **only** through a hardcoded-
> SHADOW insert path).

This is the check that would have caught item #2 the moment `backtest_setup_status.mjs` rated
`STOP_SWEEP_LONG` ACTIVE while its only firing path hardcoded SHADOW — which is exactly the
"0 ACTIVE rows ever despite ACTIVE rating" evidence you found. It's the natural sibling of the
existing `test_invariants.mjs` check `[6]` (which already asserts the *display* fallback list
hasn't drifted), so it has a home and a precedent. It also subsumes the per-type review the
F3 fix's own caveat demands: run it, and it *produces* the list of "ACTIVE-rated but
structurally SHADOW-only" types instead of a human eyeballing ~20 names.

**Layer 3 — one canonical "real resolved trade" predicate (the piece neither (a) nor (b)
names).** The TIME_EXPIRED bug is the clearest case where the *definition* itself drifted: the
rule "what counts as a real resolved trade" (origin_status IN (ACTIVE,SHADOW) AND resolution IN
(TARGET_HIT,STOP_HIT,TIME_EXPIRED) AND actual_pnl NOT NULL AND resolution_method NOT IN
(MARK_TO_MARKET, RECOVERY_MTM)) is copy-pasted into ~20 queries, and when the rule changed
(2026-07-20), 1 script got updated and ~20 call sites didn't. Extract that predicate into one
shared SQL fragment / helper, and require every consumer to use it. This is the only way to
stop the next resolution-method or status change from silently re-broken 20 places again. It is
*also* the thing that closes the still-open `minuteBarSignalDetector`/`acd.js` promotion-gate
gap from 2.2 in one shot.

**What I'd add that's not in your list:** the cheapest, highest-leverage artifact of all three
is a **single small audit script** (or an extension of `test_invariants.mjs`) that, per
setup_type, prints: (latest recommendation) → (real_n / real_ev per the canonical predicate) →
(the set of insert paths that can fire it, and whether each consults the gate) → ("reachable as
ACTIVE: yes/no, and why"). The user's complaint "why hasn't X promoted" should be answerable by
**reading one row of that report**, not by a manual trace through five decision sites. That is
the concrete deliverable that converts "a worried user asks, someone traces by hand" into "a
standing, queryable reachability table."

## 2.4 Priority read — F3 next, but NOT as a single-batch "flip all 20"

Your direct question: is the ~20-type hardcoded-SHADOW bug the very next thing, ahead of
anything else in the open-decisions queue?

**Yes on the what; no on the how-as-one-shot.**

- **Why yes:** it's the only one of the four that is a *hard* block (zero promotion possible,
  by construction) rather than a partial/contamination/calibration issue, it's the one the
  user's complaint points most directly at, and there's already a ready-made diff archived at
  `docs/LIVE_FIRING_AUDIT_20260814.md` §F3. Nothing else in the queue is a harder structural
  dead-end than ~20 types that literally cannot fire live.

- **Why not as one batch:** the F3 diff flips *all* non-suppressed shadowCandidates to live in
  one move. Its own caveats still stand and are not yet resolved: (1) `STOP_SWEEP_LONG/SHORT`
  are separately PAUSED (`OPEN_DECISION stop_sweep_long_calibrated_target_pause_or_keep`), and
  they are *also* the two the audit proves are ACTIVE-rated yet structurally SHADOW-only — so
  flipping them without resolving the pause would un-pause a deliberately-paused detector. (2)
  The per-type "should this actually fire live" review hasn't happened, and some of the ~20
  are noisy/thin.

  **Recommended sequencing, in order:**
  1. Ship **Layer 2's reachability invariant** first (small, zero blast radius, no DB writes).
     It immediately produces the authoritative "ACTIVE-rated but structurally SHADOW-only" list
     — which IS the per-type review the F3 caveat demands, done mechanically instead of by hand.
  2. Then ship **F3**, but scoped: apply the `shadowIsLive` insert change to the ~20 types,
     *excluding* STOP_SWEEP_LONG/SHORT until their pause decision resolves (or resolve the
     pause first — either order is defensible; the point is don't couple them).
  3. Then do **Layer 3** (canonical resolved-trade predicate) — because it's the only thing
     that closes the still-open TIME_EXPIRED undercount in the three poller promotion gates,
     and until it lands, the user's "setups never get promoted" symptom will keep recurring
     for the momentum60/overnight/stackvol families regardless of F3.

  If you only do one thing next and it can't be the invariant: do F3 **scoped** (exclude
  STOP_SWEEP) rather than F3 full-batch. The full-batch version couples two unresolved
  decisions and makes the blast radius larger than it needs to be.

**Bottom line for the user's verbatim worry ("I dont want to keep having an issue where setups
aren't getting promoted. Its fundamental here."):** they are right that it's fundamental — but
not because there's one bug; because there are five independent ACTIVE-vs-SHADOW decision sites
with no single definition and no reachability audit. The durable fix is a canonical gate +
a canonical resolved-trade predicate + a standing reachability invariant. Fixing any one of the
four incidents without those will leave the next one waiting to be discovered the same way —
by a worried user manually tracing the pipeline.
