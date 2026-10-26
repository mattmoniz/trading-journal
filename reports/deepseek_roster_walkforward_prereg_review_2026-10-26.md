# Design review: ROSTER_RULE_WALKFORWARD_PREREG_20261026.md

1. **Rule thresholds are fit on the full sample, so "forward" is not out-of-sample (most serious).** The floor what-if (20/10->5), the halves test, and leave-best-day-out were all chosen after seeing the full 2026-07-09->now window. The "next-day winners" being scored are selected by a rule whose constants were tuned on that same data, including the forward days. A SHOWN would overstate generalizability; the verdict line carries no caveat for this even though "Known limits" mentions it. Fix: pre-specify constants on the first chronological half and score on the second; if infeasible, retitle the verdict "in-sample rule design" and say so next to SHOWN/NOT SHOWN.

2. **Same-day lookahead vs the 20:23 snapshot.** Live builds R_t at 20:23 ET on day t. The replay builds R_t from *all* events dated <= t, which includes day-t events that fire after 20:23 (evening session) or are not yet resolved (actual_pnl still null) at snapshot time. Fix: build R_t only from events with fired_at < 20:23 ET; conservative fallback is trade_date < t.

3. **Forward arm = roster-eligible events, not trades actually taken.** The script's own header says live = on roster AND not suppressed by SETUP_STATUS / DOW / CAPITAL_EXPOSURE_OVERRIDE, and SHADOW rows are not real orders. The replay pools all roster-type events regardless of suppression and includes SHADOW, so "earn more next day" measures signal detection, not realized PnL, and suppression (e.g. capital override after losses) may correlate with bad days. Fix: apply the eligibility pipeline to forward events, or relabel the outcome "detected-event mean" and drop the PnL framing.

4. **First-run hysteresis is mis-replayed.** Live's first-ever run had prevPassing=null, so it seeded from the base rule without leave-best-day-out. In the replay only day 1 is null; from day 2 prevPassing is an empty Set, which is truthy, so buildRoster demands passLeaveBestDayOut (MIN_DAYS+1 days) for the very first promotion. This delays first-pass dates and shifts roster membership/forward counts vs live's actual seed. Fix: keep prevPassing=null until a roster first exists, or seed at the real first-run date and document the difference.

5. **OTHER comparator is biased (complement includes past losers).** "ROSTER minus OTHER testable" compares past winners to everyone else; difference > 0 is a weak bar that can SHOW from mere non-mean-reversion even if the rule adds nothing beyond "avoid past losers". Fix: make the placebo (vs random same-size) the primary and demote OTHER to descriptive, or use a matched top-k past-winner baseline.

6. **NOT SHOWN reads as null.** With 1-2 roster types the CI is enormous and no minimum detectable effect is pre-registered. Fix: label the verdict INCONCLUSIVE and print raw difference, CI half-width, and MDE together.

7. **"~2.5% expected by chance" is not a valid null.** The pass bar is several correlated conditions (CI lo>0, both halves positive, hysteresis) and types are not independent (siblings/clusters). Fix: compute a permutation null pass rate, or drop the comparison.

8. **Table 3 "implied time-to-significance" will be read as a forecast.** The formula ignores day-blocking and selection, so it is optimistic despite the caveat. Fix: present as best-case with an explicit i.i.d. assumption, or omit.
