# Opus Audit #15 — Follow-through on Audit #14's ML strategy recommendations

## Context

Opus Audit #14 (`scratch/opus_audit_14_ml_strategy_results.md`, `docs/OPUS_AUDIT_PROMPT_14.md`)
reviewed this session's ML work (Track A live meta-labeler, Track B tick-microstructure
pilot, Track C depth-absorption pilot) and produced a ranked build order (its own section 7):
step 0 (evaluation-protocol fix), step 1 (direction-signed features + bar-level control +
logistic baseline), step 2 (forward-path table + exit-policy evaluator), step 3 (upgrade to
the ordinal `reach_R` target), step 4 (the bigger bar-history market-event model, gated on a
reconciliation check), step 5 (a narrow bank-vs-trail ML decision, gated on 3+4).

Since that audit, steps 0-3 have been executed, plus a bounded first-pass pilot toward step
4's own prerequisite gate. **This audit's job: independently critique the RESULTS, the TEST
DESIGN, and how each test was EXECUTED — then give concrete, prioritized next steps toward
real trading profitability, not just more research.** Read everything below like a skeptical
reviewer, not a rubber stamp — several of this session's own findings only survived because a
first version was wrong and got caught (see the "self-caught bugs" list below); assume more
exist and go looking.

## What to read first

1. `scratch/opus_audit_14_ml_strategy_results.md` — the prior audit, for full context on the
   original recommendations and their pass/kill criteria (particularly sections 2.3-2.4, 3,
   5, 6, 7).
2. `docs/OPEN_THREADS.md`'s 2026-09-24 entry ("Opus Audit #14 (ML strategy) acted on...") —
   the summary of everything done since, with file paths and headline numbers.
3. The actual code, not just the summary — all touched/new files:
   - `scripts/tick_microstructure/recheck_tick_trend_fade_finding.mjs` (step 0)
   - `scripts/tick_microstructure/freeze_model.py`, `score_frozen_model.py` (step 0)
   - `server/services/rigorDiagnostics.js` (`dayBlockedBootstrapDeltaCI`, new this session)
   - `scripts/pretest_direction_signed_recentdelta.mjs` (step 1, real-data replication of
     the audit's own illustrative check)
   - `scripts/tick_microstructure/build_trade_level_dataset.py`,
     `train_fade_outcome_model.py` (step 1's full comparison matrix: TICK_UNSIGNED vs
     TICK_SIGNED vs BAR_CONTROL, each with LightGBM and logistic)
   - `scripts/build_trade_forward_path.mjs`, `scripts/evaluate_exit_policies.mjs` (step 2)
   - `scripts/tick_microstructure/train_ordinal_model.py` and the `compute_reach_r()`
     function added to `build_trade_level_dataset.py` (step 3)
   - `scripts/pretest_market_event_substrate_reconciliation.mjs` (step 4's prerequisite
     gate, bounded single-level-family pilot, still failing at 8.6% vs the >=90% bar)
   - `scripts/depth_absorption/quiet_moment_diagnostic.py` (the depth park-diagnostic)
4. `docs/DEPTH_ABSORPTION_PILOT_SPEC.md` section 9, `docs/TICK_MICROSTRUCTURE_PILOT_SPEC.md`
   (updated status header) — current state of both pilots.

## Real numbers to scrutinize (don't just accept these — verify the methodology behind each)

- **Step 1**: TICK_SIGNED beat TICK_UNSIGNED (LightGBM AUC 0.548 vs 0.515). Logistic beat
  LightGBM on every feature set (TICK_SIGNED: 0.578 logistic vs 0.548 LightGBM). TICK_SIGNED
  and BAR_CONTROL (1-minute bars only) tied almost exactly (0.5481 vs 0.5480). The frozen
  canonical model is now logistic/TICK_SIGNED, cleared a 200-permutation day-block null at
  **p=0.025**.
- **Step 2**: none of 4 alternative exit policies (3 time-stops, a 1.5x-wider-target
  reimplementation) beat the real historical exit on 1,626 real RTH fade trades — all
  deltas negative, no CI excludes zero.
- **Step 3**: ordinal `reach_R` model (statsmodels `OrderedModel`, cumulative logit, top-10
  features by gain, N=1,631/55 days) scored Spearman=0.2875 (p<0.0001) on held-out test
  days, calibration cleanly monotone. **A first version of the leakage control was itself
  wrong** (shuffled training features but scored against real unshuffled test features,
  producing a spurious "leakage" reading of 0.212 instead of ~0) — caught and fixed by
  switching to the day-block label-permutation convention already used elsewhere in this
  session, which then read -0.0224 as expected. Sanity-check that the FIX is actually
  correct, not just that it produced a more convenient number.
- **Step 4 prerequisite gate**: bounded PD_VAH-only, 90-day reconciliation pilot. **Three
  iterations, two self-caught bugs**: v1 (match only the day's first touch) → 0.6%; v2 (match
  every touch, still no `is_rth` filter) → 3.9%, exposed a real cross-session scope-mismatch
  bug (55.6% of real `PD_VAH_FADE_*` fires are Globex-hours under the identical setup_type
  name); v3 (RTH-scoped on both sides) → 8.6%, still far under the audit's own >=90% bar,
  with a real, specific, evidenced next lead (the 15pt flat touch-proximity used here is
  probably far looser than whatever `acd.js`'s live `nearLevels` filter actually uses).

## Explicit questions

1. **Result-by-result critique**: for each of the 4 numbered findings above, is the
   methodology actually sound, or is there a leakage/confound/multiple-comparisons risk not
   yet caught? (This session already found and fixed 2 self-inflicted control bugs on its
   own — assume a comparable base rate of undiscovered ones and look specifically for that
   shape of mistake.)
2. **Test-design critique**: were the RIGHT tests chosen for each step (not just executed
   correctly)? In particular: is the ordinal-target bucket scheme, the exit-policy menu, and
   the PD_VAH-only reconciliation pilot's scope each a reasonable design choice, or should a
   different design have been used?
3. **Execution critique**: anything about HOW these were run (day-blocked splits, embargo
   handling, commission accounting, RTH-only scoping, the frozen-model mechanics) that looks
   fragile, inconsistent across scripts, or likely to break silently later?
4. **Given everything fixed and found across Audit #14 and this follow-through — what should
   the concrete next steps be to actually move toward real trading profitability, not just
   more diagnostics?** Be specific and prioritized (not a menu of options) — what's the
   single highest-leverage next action, what's realistically achievable soon vs. genuinely
   gated on more data (the ~55-65 distinct real trading days ceiling this whole thread keeps
   running into), and is there a point where this ML program should shift from research mode
   toward an actual live-wiring decision (with the appropriate 3-phase review this codebase's
   own CLAUDE.md requires for anything touching live risk/execution)?

Write your findings to `scratch/opus_audit_15_followthrough_results.md`. Be direct about
anything you think is wrong, overstated, or premature — this audit only has value if it's a
real, skeptical second look, not agreement with what's already been written down.
