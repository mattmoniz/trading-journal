# Handoff, 2026-11-10 ~23:45 ET (user asleep; Claude finished the Fable audit build under the standing go)

Read: docs/FABLE_AUDIT_REVIEW_20261110.md section "BUILD LOG" (what changed, proof, what was NOT built), docs/OPEN_THREADS.md top entry, then CLAUDE.md. Decision `fable_audit_followups_user_20261110` (HIGH) lists what needs the user.

State: one restart at 22:30 ET 2026-11-10 (systemd user unit `trading-journal-server.service`, flat broker, sim profile auto-re-armed 22:30:44). Nothing committed. Server edits are LIVE; frontend (JobHealthSection) is built (`npm run build`) and served by Vite/dist as before.

First things to do in the morning:
1. Ask the user the 5 items (F16 P&L rule, Anthropic credits, crontab line for `scripts/rotate_logs.sh`, EMPTY live roster, F19 commit).
2. Verify the unconfirmed claims: loop freezes gone (`perf_snapshots` loop.maxMs at 08:03/09:33/11:03/16:11/17:17; `node scripts/perf_report.mjs`), `VOL_REGIME_HIST` succeeds at 16:10 (it was a slow script, fixed and backfilled 17 days), no `SIERRA_STOP_FAILED` / `SIERRA_UNPROTECTED_*` gate rows on a normal fill day, `grep protection` in `journalctl --user -u trading-journal-server`.
3. Next audit items, in order: golden detection replay (F27) -> F06 shadow persistence (confound boundary) -> F33/F26/F32; also F18, F28, F23, F20, F15.

Rules for the order path stand: `npm test` (harness) before and after any edit, kill switch / status lattice / broker-truth guard untouched, a restart disarms the switch (cv-102).
