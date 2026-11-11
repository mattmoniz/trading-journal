# Handoff, 2026-11-11 ~08:10 ET (user clearing context): F26 + F32 in progress, F06 live, verification PENDING

Read this, then docs/OPEN_THREADS.md (top entries), docs/FABLE_AUDIT_REVIEW_20261110.md (BUILD LOG), CLAUDE.md (cv-115/116/117).

## State of the server vs the files
- LIVE (restart 07:42 ET): F06 shadow persistence (`persistShadowCandidates` above the `if (!active)` early return, forceShadow = SHADOW only), F33 import moves, everything from the 22:30 restart.
- ON DISK, NOT LIVE (needs the next restart, broker flat, outside RTH, re-arm is automatic on the sim profile): F26 (`server/services/strategyOrderCore.js`; amtTellOrders/vacuumLiveOrders/turnSignalOrders now use it), F32 step 2 (`runDetectionCycle()` returns `{status, body}`; route handler calls it), `server/services/shadowPersister.js` (verbatim move of the persister, closure wrapper in acd.js), `server/db.js` `setQueryInterceptor`.
- Do NOT restart until the replay validation below passes on RTH recordings.

## Golden replay (new, scripts/replay/, rule cv-117)
- `node scripts/test_replay_golden.mjs` replays every recording in scratch/replay_golden/ against the current route code (no DB, frozen clock, writes suppressed). `--route`/env REPLAY_ROUTE replays against another copy of the route file.
- Recording: scratch/replay_golden/20261111_0756_globex.json exists (Globex, 2 writes, passes on all three code copies). A background scheduler `REPLAY_ROUTE=server/routes/acd_golden.js scripts/replay/record_schedule.sh 0940 1035 1135 1335 1500` writes RTH passes into scratch/replay_golden/ (log scratch/replay/schedule_20261111.log). If the clear killed it, re-run it (it records with the frozen pre-refactor snapshot).
- TEMP FILES (untracked, delete when done): server/routes/acd_golden.js (snapshot = acd.js after F06 + F33, BEFORE F32 step 2 and the persister move: the golden reference), server/routes/acd_prevF06.js (acd.js before F06: replay it to show F06 added ONLY SHADOW inserts).

## To do, in order
1. When RTH recordings exist: `node scripts/test_replay_golden.mjs` (current acd.js) must show 0 decision differences on every recording; also `REPLAY_ROUTE=server/routes/acd_prevF06.js node scripts/test_replay_golden.mjs` should show diffs = added `INSERT INTO active_setups ... SHADOW` writes only (that is F06's effect). Any other diff = a bug in step 2 / the persister move: fix before any restart.
2. The 10:00 ET F06 check output: /tmp/claude-1000/-home-mmoniz-trading-journal/16cc42fd-b2a4-4fbb-b631-aa67a3e65b41/scratchpad/f06_check.out (background script f06_check.sh, written by the previous session, NOT scratch/replay; rows with SHADOW_CAUSE `NO_ACTIVE_SLOT_PERSIST`, no unexpected ACTIVE rows, errors). Confirms F06 live.
3. After 16:00 ET with a flat broker: `systemctl --user restart trading-journal-server.service`, verify one process, `/api/sierra-chart/status` armed, journal clean; then watch the first tell/vacuum/turn fire (F26 is unit-tested only; no live fill has gone through it).
4. Delete acd_golden.js / acd_prevF06.js (STILL TO DO, only after step 1 passes). DONE 08:20 ET: ARCHITECTURE.md rows (strategyOrderCore.js, shadowPersister.js, scripts/replay/); OPEN_THREADS already carries the F26/F32 entry. regenerate nothing in schema.
5. (Now recorded as OPEN_DECISION `vacuum_like_matches_turn_types_20261111`, 08:20 ET.) Open finding to decide: vacuumLiveOrders reconcile uses LIKE 'VACUUM\_EXP\_%' which also matches the turn-signal types VACUUM_EXP_TURN_* (and turn's double-entry check likewise): a turn misfire can pause vacuum. Kept identical in the refactor on purpose.
6. F32 steps 3-8 remain (one inputs loader, decisions as data, extract families one at a time, selection/gates, separate timers, backtests on the same detect()); each step is validated by test_replay_golden.mjs.

Still needing the user (decision fable_audit_followups_user_20261110): F16 P&L rule, Anthropic credits, rotate_logs.sh crontab line, EMPTY live roster, F19 commit.
