# Roster scoreboard — pre-registration (2026-10-25)

Question: from the first clean day of the LIVE_ROSTER gate, is trading only the roster's setup types better than trading everything? Settled by one table, built once and then left alone, so the answer is not re-argued after a good or bad day. The roster is a de-risking filter (about 6 false passes expected out of ~247 tested), so the honest hypothesis is **risk-adjusted improvement and lower drawdown**, not "it prints money".

Committed BEFORE any look. Code: `server/services/rosterScoreboard.js` (pure), `scripts/roster_scoreboard.mjs` (daily, after `calibrate_live_roster.mjs`), tests `scripts/test_roster_scoreboard.mjs`. Output: `performance_audit` `signal_type='ROSTER_SCOREBOARD'` (`CURRENT` daily, `PREREG` the frozen look schedule), `RESEARCH_CLAIM roster_scoreboard_20261025`, `GET /api/setups/roster-scoreboard`, a card at the top of `setup-performance.html`. Nothing here changes live behaviour.

## Window
`fired_at >= 2026-10-25 18:00 ET` (first Globex open under the gate; before it the old "everything live" regime ran). Open positions are not counted until they resolve.

## Population (mandatory filters)
Primary rows only (`is_cluster_primary IS NOT FALSE`; siblings share a touch and would double count), `origin_status IN ('ACTIVE','SHADOW')`, `actual_pnl` not null, not `NOT_FILLED`, none of the four `*_basis` flags, not fired 16:00–18:00 ET. `POC_ROTATION_JOIN%` is excluded from every headline arm and shown as its own line (confound boundary 2026-10-11/12; exit reverted and force-SHADOW 2026-10-21). Mark-to-market closes are kept: this is an account-level view and an MTM close is realized P&L. RTH and Globex are reported separately as well as combined.

## Arms
| Arm | Rows |
|---|---|
| ROSTER_LIVE | origin `ACTIVE` (what actually fired under the gate) |
| ROSTER_WOULD_BE | setup_type on the roster row **in force at that row's `fired_at`** (newest `LIVE_ROSTER` row created at or before it; ACTIVE + SHADOW origin) |
| TAKE_ALL | every row (the old-regime counterfactual) |
| TAKE_ALL_EX_ROSTER | everything not on the roster at fired_at |

The roster is joined by timestamp, not by today's roster, so a type that was on the roster Monday and dropped Tuesday counts only on Monday (tested). Per-trade means are sum/N, never the day-weighted mean. Win rate is shown only at N >= 20. Max drawdown is on the resolve-time-ordered running sum.

## Comparison and rule
- **Per-day account view:** for each trading day, (sum of roster-type trades) − (sum of all trades). Mean of that series with a day-blocked bootstrap 95% CI (resample days).
- **Per-trade view:** roster trades vs the rest (non-overlapping groups), per-trade mean difference, day-blocked delta CI.
- **Verdict (frozen):** PASS = per-day-view CI lower bound above 0 **and** both chronological halves of the days positive. FAIL = CI upper bound below 0 and both halves negative. Anything else, or fewer than 4 days: NOT SHOWN YET. A null is stated as "not shown, and here is what could not be shown", never as "the idea is wrong".
- **Looks (optional-stopping rule):** one scheduled look at a day count derived from the explore period and frozen, then one per 10 further distinct days. No decisions between looks. Derivation: the number of distinct days at which the 95% half-width of the mean daily difference equals one typical day of the all-trades arm (median absolute daily sum), using the SD of the daily difference over the 60 trading days before the start with the 2026-10-25 roster applied (the roster was selected on that data, so its MEAN there is biased; only the SD is used). Frozen result (`PREREG` row): **14 distinct days** (SD 807.23, typical day 436.65, 60 explore days). The 10-day recurrence is the pre-registered cadence from the scope doc. Each look flags `OPEN_DECISION roster_scoreboard_look_<n>_20261025` (HIGH) carrying the numbers.
- **Churn is part of the result:** per roster row, types added/dropped; and the roster-type trades taken in the first 5 days of a type's current membership are reported separately from later ones (promotion-lag effect).

## Honest limits
- Live N will be tiny for weeks (two roster types as of 2026-10-25, one to a few fires a day). A null at 14 days is the expected outcome.
- ROSTER_WOULD_BE includes SHADOW rows of roster types; they are not independent of ROSTER_LIVE.
- The 14-day schedule rests on a roster-selected explore period; if the roster changes a lot, the SD could differ. The schedule is not re-derived (that would be peeking).
- Roster timestamps come from `performance_audit.created_at`; a same-day re-run updates a row in place without changing `created_at`, so the roster content at a time between two same-day runs can be misdated by hours. The daily run creates a new row per day, so this affects only manual same-day re-runs.
- Model P&L (`actual_pnl`), not broker P&L; the card does not show broker fills.
- A roster stale for more than 10 days fails closed in the gate (nothing live); the scoreboard would then show an empty live arm, which is the correct reading.
