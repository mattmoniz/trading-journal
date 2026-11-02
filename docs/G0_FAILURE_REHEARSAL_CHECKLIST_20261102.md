# G0 failure rehearsal (2026-11-02)

Rule: sim account only (the profile file must say sim and `DTC_AUTO_REARM_SAFE=true`); a rehearsal never calls `arm()`/`halt()` on the kill switch from a script; the user does any arming. After every scenario read `gated_candidates`, `order_placements` and `live_attestations` (broker-side truth cannot be asserted in-process).

## Automated (no broker, no live state): `node scripts/test_g0_safety.mjs`
- Stale feed acceptance test of the entry gate: fresh passes, stale / empty / unknown age / future-dated / query error all block, ET-naive timestamp parses to the right age.
- Boot self-test with mutation tests: an armed switch at boot, an eligible order while halted, a throwing check and a hanging check each fail it and suppress auto-rearm; a later passing run re-allows it.
- Wiring checks: gate placed after `isOrderEligible` and the daily-loss gate; self-test between `forceHaltOnBoot` and `connectOnce`; auto-rearm consults the self-test before arming. Also standing in `test_invariants.mjs` [27].

## Manual, on the sim account, after the next coordinated restart
| # | Scenario | Pass criteria |
|---|---|---|
| 1 | First restart with G0 | one `node server/index.js` (`ps -ef`); `live_attestations` has `boot_selftest` = OK; log shows `[bootSelfTest] PASSED`; sim auto-rearms after a clean reconcile; `GET /api/sierra-chart/summary` shows ARMED |
| 2 | Force a self-test failure (use a throwaway branch where one check is edited to fail; never by editing live env) | switch stays HALTED after LOGON, log shows `[BOOT_SELFTEST_FAILED]` and `auto-rearm SUPPRESSED`, quick-check banner shows BOOT SELF-TEST FAILED; revert and restart returns to #1 |
| 3 | Stale feed with a resting MARKET entry candidate (stop the Sierra bar export or point at a stale file during a quiet period) | `gated_candidates` row with reason starting `FEED_STALE`; no entry order; exits and stops untouched; banner shows PRICE DATA STALE after 10 min; entries resume within one sweep once bars flow |
| 4 | Restart mid-position | switch halts at boot, self-test passes, reconcile finds the broker position, exits still managed; no duplicate server process |
| 5 | Refused exit retried while a different position opens | the retried exit does not close the unrelated position (the 2026-10-18 retired-exit rule) |
| 6 | Sleep / wake of the machine | after wake: one server process, stale-feed gate engaged until bars resume, no entry on old information, attestation row for the day present |
| 7 | DTC disconnect mid-order | order state reconciled from the broker on reconnect, no phantom position, switch not silently re-armed against a mismatch |
Record each result (date, pass or fail, what was read) under this table; a failed scenario blocks calling G0 done.

## Results
- 2026-11-02 06:39 EST, scenario 1: PASS. One server process, `[bootSelfTest] PASSED (6 checks)`, `live_attestations` boot_selftest = OK, Sim1 auto-armed after a clean reconcile, `GET /api/sierra-chart/summary` ARMED, live-flags `bootSelfTest.passed = true`, tell sidecar LIVE. Open item: `could not learn the price multiplier for MNQZ26.CME yet` logged once at startup (retried; confirm at the first fill).
