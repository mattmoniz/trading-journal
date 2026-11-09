# Handoff 2026-11-04 (read after any context clear; supersedes docs/HANDOFF_20261103_NEXT_SESSION.md for state, which stays as history)

Written 2026-11-04 ~10:20 ET. The user asked (2026-11-04): "audit and organize everything so that we don't miss anything, and restart after", and "make sure that everything stays organized as we test and move forward with other tests or test variants".

## 0. UPDATE 2026-11-04 afternoon (read this first; it supersedes the state in section 3)
- **RESTART DONE at 13:20:32 ET (user: 'just restart'), with the long 519 open: verified (see OPEN_THREADS 'Resolved 2026-11-04 13:20:32'); the items below about the restart are history. Still to check in the next session: the first fire of the next session writes D/E/F rows (`tell_shadow_trades` book in D,E,F), 519 closes at the 15:55 flatten or its stop and its A/B/C shadow rows close (code_version was realigned), no AMT alarm.** (old text:) The restart WAS pending. The broker was NOT flat at 13:18 ET (tell long 519, +1 at 28,760.50 on Sim1, order stop 28,493.25 live in Sierra), so it was not restarted (rule: only when flat). The system flattens at 15:55; a one-shot reminder was scheduled in the session for 16:07 ET. If it did not survive a context clear: after 16:00 ET follow section 4 exactly (flat check, one process, reader 8897 and sidecar 8898, monitor-summary has `ovnArms` / `nextSteps` / `dayContext.rotation`, shadow rows for books D/E/F appear on the NEXT session's first fire, `tell_shadow_trades` OPEN rows must be 0 first, switch re-armed on Sim1; warn the user first that a restart disarms the switch).
- **Built, tested, NOT live until that restart:** shadow stop books D/E/F (`shadow.py`, forward-only from 2026-11-05, DeepSeek round S applied, parity 0 mismatches), the rotation guide (`rotationGuide.js`, Day context rows and a per-fire line), `nextSteps` on every Monitor card, `ovnArms` forward race. UI guards tolerate the absent keys (cv-112: a regression on the phone Monitor tab was caused and fixed this morning).
- **Exit and stop research done today (all explore, claims recorded, none is an edge):** stop placement arms (K4 +2.99, Sierra-style node +3.84, day-extreme +1.61: leads), rotation-leg VWAP filter (underpowered, not shown), hold-value and trail (winners pull back a median 5.3 typical bars, p90 9.6; fixed trails cut winners), structure exit arms (nearest overnight thin zone only about 38 points away: targets bank early), leg-profile stop and distance-floor exits (the tell's wide stops over 100 points carry the profit: R0 -39.79 per trade there), cost-of-risk curve (cap at 100-150 points gives up 13-18 percent of profit and cuts the worst loss -522 to -202/-302; below 80 it is expensive; caps do not improve worst day or drawdown). See `docs/RESEARCH_INDEX.md` and register rows 10-13.
- **Decisions waiting on the user:** the stop cap (e.g. 100-150 points) as a forward shadow book; whether to take against-the-leg early tell fires in the leg's direction (register row 11, needs a prereg); the live overnight detector alignment; Stage 2 / tell hold-out result; the five-flip checkpoint; the two LOW end-of-year decisions.
- **Next piece of work (scoped, not built): `docs/TRADE_WATCHER_MARKS_AND_LABELS_SCOPE_20261104.md`:** per-minute NOW-versus-LATELY features, marks on charts, a blind labelling protocol (about 30 events) so the user's stall reads (digestion vs absorption) become data; delta stays out until the user says how they read it; DeepSeek design critique before building.
- **Open trade at the time of writing:** long 519, stop 28,493.25 (267 points, about $534 risk), left untouched (Stage 2 frozen). User's own reads are recorded in the register as reads, not rules.

## 1. Where everything is (one place each)

| What | Where |
|---|---|
| Every prereg / scope / design doc since 2026-10-25, joined to its ledger looks and claims | `docs/RESEARCH_INDEX.md` (GENERATED: `node scripts/build_research_index.mjs`; never edit by hand) |
| What each result left behind, the cheapest next test, the retire rule, status | `docs/IMPROVEMENT_REGISTER_20261104.md` (rows 1-8 research, 9a-9j the monitors) |
| Unfinished work, newest first | `docs/OPEN_THREADS.md` (top entry of 2026-11-04 is the audit/organization entry) |
| Decisions waiting on the user | `node scripts/flag_decision.mjs --list` (29 pending; the new ones are in section 5) |
| Every tested claim | `performance_audit` `RESEARCH_CLAIM` via `recordClaim()` (hr-024); every look in `research_looks` (hr-023) |
| What each Monitor & Learning card does next (judged when, if it holds, if it fails) | `server/services/monitorNextSteps.js`, key `nextSteps` of `GET /api/setups/monitor-summary`; phone `nxt()` in `quick-check.html`; app `NextSteps.jsx` |
| The standing checklist for every new test or variant | CLAUDE.md co-023 (full text `docs/CLAUDE_MD_ARCHIVE/collaboration.md#co-023`) |
| Mechanical guard | `node scripts/check_research_organized.mjs` (Stop hook runs it; exit 1 lists the problem) |

## 2. The standing process (co-023), applied at the START of every test or variant

1. Prereg doc frozen before any outcome is read; look logged in `research_looks` first (hr-023).
2. A claim for every result, positive or null (`recordClaim()`), linked to the look (`claim_slug` or `ref`).
3. A register row: evidence, salvageable part, cheapest next test, retire rule, status. A variant row states its basis (data, not a guess); the user asked for this on 2026-11-04.
4. Pending user decision: `flag_decision.mjs`. Unfinished item: OPEN_THREADS. New card on the Monitor & Learning page: an entry in `monitorNextSteps.js`.
5. `node scripts/build_research_index.mjs`, then `node scripts/check_research_organized.mjs` must say "all clear".

## 3. State at the time of writing (2026-11-04, Wed, ~10:20 ET)

- Server running since the 09:25 ET restart (one `node server/index.js`). Live: Day context card, tell context overlay, watcher and shadow books, live flip override (maxFlipsPerDay 2), Stage 2 tell orders on Sim1 (armed).
- NOT live until the next restart: the `ovnArms` key (forward race for overnight order flow) and the `nextSteps` key (all Next lines). The code, tests and rendered pages are verified (Playwright intercept with injected data: 14 Next lines, no console errors; `npm run lint:frontend` shows only the old UpdateDot message; `npm run build` passes; `node scripts/test_ovn_arms.mjs` passes).
- Tell today: 3 fires (10:03, 10:05, 10:11, all short) all lost, all labelled UNKNOWN. That is by design: fires before 60 RTH minutes read UNKNOWN (value area too young), so the flip override cannot act in the first hour. Reader healthy, parity failures 0, no fires without a context row, 0 live flips so far. Stage 2 totals: 28 trades on 5 days, about -$666 model P&L, floor 150 trades and 60 dates.
- Research arc results (all in the index): tell flat to negative on the hold-out; flip unproven (5-flip checkpoint pending); watcher stop not confirmed; day-shape forecast: width predictable, balance vs imbalance not; overnight order flow: research rule real only in the last ~12 months, live detector is a different, stricter rule (closes only, threshold 7).

## 4. Restart (the user said "restart after"; wait for the close)

Do it after 16:00 ET (no new entries 16:00-18:00 ET). Steps, in order, none skipped:
1. Broker flat: no open setups, no resting orders, no position, no open tell trade (`/api/sierra-chart/summary`, `active_setups` OPEN/PENDING for today, Sim1 position 0).
2. Warn first (cv-102): a restart disarms the switch; Sim1 re-arms itself only with `DTC_AUTO_REARM_SAFE` after a clean reconciliation, otherwise wait for the user's go. The sandbox may block arming (cv-109): then stop and hand it over.
2b. Shadow stop books D/E/F ride this restart (`scripts/tell_context/reader.py` is a separate process the server supervises): `SELECT count(*) FROM tell_shadow_trades WHERE status = 'OPEN'` must be 0 first; the books are forward-only from `shadow.STOP_BOOKS_FROM_DATE` (2026-11-05); the first fire of the next session must write D, E, F rows; `docs/TELL_STOP_PLACEMENT_ARMS_PREREG_20261104.md` sections 7 and 7-A1.
3. `systemctl --user restart trading-journal-server`; then `ps -ef | grep "node server/index.js"` shows exactly ONE (hr-017); reader `:8897/health`, sidecar `:8898/health`.
4. Verify: `GET /api/setups/monitor-summary` has `ovnArms` and `nextSteps` (14 keys); `/api/sierra-chart/summary` shows ARMED on Sim1; open the phone Monitor tab and the app Learning view once (hr-049: check `[CLIENT_ERROR]`).
5. Record the restart in OPEN_THREADS (time, flat evidence, one process).

## 5. Decisions waiting on the user (new or changed on 2026-11-04)

- `ovn_orderflow_detector_alignment_20261104` (MEDIUM): align the live overnight order-flow detector to the researched rule (highs and lows, threshold 6), keep it, or re-calibrate. Needs a restart and the user's go.
- `tell_holdout_baseline_negative_20261104` (HIGH): the tell is flat to negative on the hold-out; what the user wants done with Stage 2.
- `flip_override_vs_explore_replay_20261103` and `tell_override_first_five_flips_checkpoint` (HIGH): review after 5 live flips.
- `ml_retire_end_of_year_review_20261231` and `learning_bot_placeholder_review_20261231` (LOW, new): proposals of mine, dates are mine.
- `tell_globex_rth_profile_state_prereg_draft` (MEDIUM): draft, needs the user's go on A7.
- Resolved today: `sim_trades_by_day_shape_and_b_timeline_queued`, `overnight_to_rth_shape_backtest_queued` (verified against claims and ledger looks).

## 6. Next tests, in the order the register names them (each needs the co-023 steps before it runs)

1. Row 1: pre-registered split of the 9,942 shadow fires by tell side at the fire (no new data).
2. Row 4: width-scaled stops and targets, shadow only (the one usable forecast output).
3. Row 5: forward arms tracker is collecting (BASE, RISK-300, MOM, MIRROR for the researched rule and the live rule); first look at 15 qualifying nights, second at 30.
4. Row 2: a TPO-based AGAINST label for the flip.
5. Row 6: hold-vs-flatten on the overnight order-flow nights once the tracker has 15 nights.
6. Row 7: one forward test on IB_HIGH_FADE_SHORT (the only shadow setup with a stable positive sign in both halves).

## 7. Things that were wrong once and must not recur

- The overnight order-flow research did not match the live detector (close-only legs, threshold 7). Before any variant of a live setup is tested, run the replication of the live rule on the live fires (cv-031, hr-022). Claim `ovn_orderflow_live_rule_differs_20261104`.
- A late-logged ad hoc look (id 108) was read before it was in the ledger; it is disclosed and linked to claim `tell_fallback_stop_lead_explore_20261103`. Log the look first (hr-023).
- Never judge across the 2026-10-11/12 boundary (hr-061); the hold-out bars are validated by tick high/low, not by DB volume (hr-070).
