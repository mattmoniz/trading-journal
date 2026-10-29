# Marks build framework (design 2026-10-29; shaped by the DeepSeek plan review, scratch/deepseek_response_context_plan_20261029.md)

Scope: how the spike/absorption marks and their context calibration would become a LIVE SHADOW system without repeating the 2026-10-29 lookahead bug. Nothing here places orders. Status: parts 1-4 are built and tested (marked BUILT); the live service itself is deliberately NOT built until the sealed look and the gate decision are made.

## Principles (from the review and CLAUDE.md)
1. ONE code path: the detector and the context features used live are the same functions the research uses (`scripts/amt_exhaust/spike.py`, `scripts/amt_marks_live/context.py`); a backtest never reimplements them (CLAUDE.md: export the real function).
2. CAUSALITY IS A TEST, NOT A PROMISE: a permanent prefix-invariance parity gate (below) proves every mark and feature is identical whether it is computed from the bars up to now or from the full day. It would have caught the lookahead found 2026-10-29 (verified by a mutation test that re-injects the old bug).
3. CALIBRATION IS OFFLINE AND VERSIONED; LIVE ONLY LOOKS UP: rolling baselines (median cumulative volume, 30-bar range and range-so-far at each bar over the prior 20 sessions), tercile cut points and any model coefficients are computed once per day/week by a script, stored in `performance_audit` (signal_type `MARKS_CTX_CALIB`) with a version hash, the training window end date and the git sha, and read back with `DISTINCT ON (signal_name) ... ORDER BY run_date DESC, id DESC` (CLAUDE.md performance_audit rule). Live code never recomputes them.
4. A HARD NO-ORDER BOUNDARY: shadow rows go to their own table (`amt_marks_shadow`), never `active_setups`, so `orderSweep`/`sweepExits` can never see them; `scripts/amt_marks_live/guard.py` carries `ORDERS_ENABLED = False` and a static test fails if any module under `amt_marks_live/` imports an order, DTC or `active_setups` writer.
5. RTH AND GLOBEX: the detector was tuned on RTH only; a Globex arm is a NEW detector (its own tuning and tests), not an extension (CLAUDE.md both-windows rule; momentum/flow signals have repeatedly reversed in Globex).
6. NO DEAD ENDS (CLAUDE.md four-part checklist): persisted (calibration rows, shadow table), a recalibration path (scheduled script, not yet scheduled: OPEN_DECISION), a consumer or an explicit flag (none yet: OPEN_DECISION), discoverable (ARCHITECTURE.md entry).

## Components
1. BUILT `scripts/amt_marks_live/context.py`: prefix-safe session series (cumulative volume, last-30-bar range, running range), baselines from the prior 20 sessions, and `features_at()` returning the stage-3 feature set at a confirmation bar (relative volume, volatility now, range so far, expansion score, overnight and prior-day location, overnight range and volume, gap, drift, spike size).
2. BUILT `scripts/amt_marks_live/parity.py` (+ `test_parity.py`): (a) prefix invariance of the session series; (b) prefix invariance of the spike marks at every bar of sampled sessions (events with u <= t must be identical from the prefix and from the full day); (c) a mutation test proving the harness fails on the old leaky detector; (d) `--full`: the module's features equal the research table `run_context.build()` for every mark (numerical equality). Run on any change to `spike.py`, `context.py` or the calibration code.
3. BUILT `scripts/amt_marks_live/calib_store.py` (+ test in a rolled-back transaction): write a versioned calibration row, read the latest by the deduplicating query, hash the parameters. NOT yet writing real rows (no consumer: would be a dead end).
4. BUILT `scripts/amt_marks_live/guard.py` + static test.
5. DESIGNED, NOT BUILT: `scripts/migrate_create_amt_marks_shadow_20261029.mjs` (written, NOT run; follows docs/DB_MIGRATION_PROTOCOL.md): shadow row = date, bar, direction, spike extreme, confirmation bar, feature vector, calibration version hash, gate decisions (G1..), the with-trend trade geometry (stop, flatten) and its simulated exit and P&L filled by a completion pass; unique index on (trade_date, fired_at, direction).
6. DESIGNED, NOT BUILT: the sidecar service, following the live-tell precedent (`scripts/amt_tell_live/sidecar.py`, supervised by a Node manager, health endpoint, alarms that surface on the quick-check banner, restart recovery); it will call the same modules as the research and write shadow rows and a daily completion pass.
7. DESIGNED, NOT BUILT: drift monitoring: per-feature population stability against the calibration window, shadow P&L against the exploratory estimate, pre-declared kill criteria (below).

## Sequencing (the review's order)
1. Context module + parity harness + calibration store + guard (BUILT here).
2. Gate decision: the walk-forward gate test (claim spike_withtrend_wf_context_gate_not_shown_20261029) did not show a benefit; the shadow system would start UNGATED with the gate decisions logged as tags (so forward data can judge them).
3. The single sealed look on the frozen primary claim (PREREG_SINGLE.md), only with the user's explicit go.
4. Shadow service (sidecar), 40-60 sessions of forward shadow, parity gate green on every deploy, drift monitors green.
5. Only then any discussion of orders; the hard flag stays False until then.

## Kill criteria (declared before any shadow data exists)
Stop and review if: the parity gate fails; any feature's population stability index against its calibration window exceeds the level fixed at the first calibration (to be set from the explore window's own month-to-month variation, not typed); forward shadow mean per session is below zero over the first 40 sessions with a day-blocked CI excluding the explore estimate; the sidecar misses more than a stated number of sessions (alarm raised, banner shown).

## Honest limits
All evidence behind the rule is exploratory (detector tuned by eye on the same sessions); the sealed hold-out is untouched; the news calendar covers three release types only; the gate showed no significant benefit. This framework makes a future shadow trial trustworthy; it does not make the rule validated.
