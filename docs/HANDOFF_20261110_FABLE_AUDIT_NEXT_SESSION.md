# Handoff, 2026-11-10 ~22:30 ET (written before the user cleared context): continue Fable's whole-app audit

Read this, then docs/FABLE_AUDIT_REVIEW_20261110.md (verdicts, dispositions), scratch/fable_audit_report_20261110.md (the report), scratch/fable_audit_designs_20261110.md (designs), scratch/fable_audit_rules_table_20261110.md, then CLAUDE.md as usual.

## STANDING AUTHORIZATION (user, 2026-11-10 night: "Ill clear and then you can continue on fables audit without asking me to go constantly")
Work through the accepted audit items without asking for a go on each one. Keep these limits, they come from the rules and not from caution:
- The order path (`server/services/sierraChart/`, `amtTellOrders.js`, `vacuumLiveOrders.js`, `turnSignalOrders.js`): write the fake-broker harness / unit tests FIRST (Fable's own precondition), test every change against it, keep the status lattice, the kill switch and the broker-truth guard untouched (do-not-touch list, report section 7), and state plainly what each change does to a live position.
- A server restart disarms the Sierra switch (cv-102). Batch all server edits into ONE planned restart, only with the broker flat (check `/api/sierra-chart/status`, `brokerPositionCount` 0) and outside RTH; check `ps -p <pid> -o etime` afterwards (hr-048), exactly one `node server/index.js` (hr-017, hr-071). Re-arm only if the profile auto-rearms (`DTC_AUTO_REARM_SAFE`, sim profile) or the user is present; the sandbox blocks arming the switch (cv-109): stop and report, do not retry another way.
- Do not kill `scripts/argon_vacuum_live/shadow.py` (it is the Q4-4 forward logger). Do not stop the running `./start.sh`.
- Commit nothing without the user (F19 stays a user decision), no force-push, no dropping data.
- Every DB change follows docs/DB_MIGRATION_PROTOCOL.md (backup table, catalog entry, additive first).

## Done tonight (see the review doc for detail)
- Review of all S1 items and the quick wins F01-F09, F11-F13, F19, F20, F24 (all confirmed; one correction: F20 'orphan' is the Q4-4 logger) and a second pass over F14, F16-F18, F21, F26, F27, F29, F33-F36.
- Applied (nothing in the order path or the running server): `start.sh` starts the liquidity-pull daemon; session-start hook capped (178 KB -> 29 KB); stale memory / KNOWN_ISSUES / CLAUDE.md duplicated ids fixed and the add-rule script bug; `performance_audit` index `idx_pa_type_name_run_id` created concurrently (the latest-row read dropped from 37,916 disk reads to 2,679 buffers in the plan; `scripts/migrate_performance_audit_latest_index_20261110.mjs`; undo `DROP INDEX CONCURRENTLY idx_pa_type_name_run_id`).
- Decision `fable_audit_s1_order_safety_20261110` (HIGH) is now covered by the standing authorization above; resolve it with what was built when done.

## Next, in Fable's order (wave 1), each with its proof
1. F03 + F13 + F07 + F24: take `VOL_REGIME_HIST` (fails ETIMEDOUT every weekday, 60.06 s freeze at 16:11) and every `execSync` cron block out of the web process (`server/index.js`, 50 `execSync`, 38 `cron.schedule`): one async `runJob(name, cmd, {timeoutMs})` helper with a lock and a `process_log` row, or the system crontab; delete the in-server copies of `context_analysis.js` (line ~1115) and `mine_session_bias.mjs` (~1104) that the crontab already runs; fix the Sunday refresh test (~1447). Proof: `perf_snapshots.metrics.loop.maxMs` under 1 s at 08:03, 09:33, 11:03, 16:11, 17:17 for a week. Needs the one planned restart.
2. Fake DTC server harness (designs file section 3), then F05 (stop failure = alarm row, retry, flatten + halt), F09 (no `'Sim2'` fallback in `orderSweep.js:253`), F02 (fill state from the filled quantity, keep the lattice; test with the recorded 11-09 message), F04 (re-place the stop on a rejected exit), F01 (protection sweep every 15-30 s and on reconnect: idempotent, reads the broker's open orders first). The hr-069 strict halt and `killSwitch.js` stay as they are.
3. F07 `process_log` failure card and F08 deduplicated alerts on the Monitor page (one section, cv-110), F22 (empty vs unavailable roster), F20 outside dead-man check (Home Assistant already polls quick-check).
4. F06 (shadow persistence behind the early return, `acd.js` ~6350 / ~6917) ONLY with the confound boundary recorded (hr-061: 2026-10-26 to the fix date) and the replay before and after (ACTIVE rows identical).
5. Wave 2: F28, F17 cache helper, F10, F11 `dayRange` helper and lint, F15, F27 `npm test` + golden replay (the gate to wave 3), F16 after the user answers one question (below), F34 views, F35, F18, F23, F29, F21, F30.

## One question that needs the user (do not stall on it)
F16: `server/routes/dailyLogs.js:65-70` sums FlatToFlat on purpose (comment: CumPL diff breaks when a prop firm resets an account while keeping the same id) while hr-004 forbids it. Ask once, in the morning summary: do resets happen on the prop account? Meanwhile build the shared P&L SQL helper and the 30-day equality invariant without changing either endpoint.

## Also done tonight, outside the audit (so nothing is lost)
- NQ bar repair complete (docs/NQ_RAW_BAR_REPAIR_20261110.md PHASE B DONE; decision resolved; stitch list 85 -> 8 bad dates).
- Liquidity pull (formerly 'vacuum') items 1-3, bar-6 exit and Globex split: rows 52-54, looks 272-276, all NOT SHOWN (docs/VACUUM_TAKE_PREREG_20261110.md, VACUUM_THIN_VS_CROWDED_PREREG_20261110.md, VACUUM_BAR6_EXIT_PREREG_20261110.md; Q4 queue now 8 of 8). The bar-6 status is stored on live rows (`vacuum_live_events.b6_*`); forward read once at 30 taken deteriorating rows per track.
- Still waiting on the user: paste Fable's STRATEGY-review reply (A2 library families, Part B candidates); the F16 answer; the commit of the pending paths.
