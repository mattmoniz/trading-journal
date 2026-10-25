# Scope: roster scoreboard + bar-level context studies — 2026-10-25

Written so a fresh session can continue after a context clear. Nothing here is built. Origin: user, 2026-10-25 ("So now what to make further improvements to make further progress" → "Scope out both and ill clear context"). The two items are (1) a pre-registered scoreboard for the live roster gate and (2) a pre-registered set of bar-level event studies (multi-timeframe context + overnight-to-RTH claims). Read `docs/OPEN_THREADS.md` and `node scripts/flag_decision.mjs --list` first.

## User priority (2026-10-25, last message before the context clear)
"Refining and getting larger gains is very important now." Keep the scoreboard small and fast (it only starts the clock), then weight the research toward where larger gains could actually come from, in this order of evidence already in the repo: (1) which setups earn live status and how fast (roster rule; the interval test, not the count floor, is the binding constraint, `live_roster_count_floors_not_binding_20261025`); (2) trade management/exits, since the user keeps seeing winners given back ("sometimes you wish you took profits earlier": check the T1-floor runner and capture-vs-MFE audits already in the repo before inventing anything, and remember every runner finding needs the negative-trace/stress battery); (3) the bar-level context studies in Part 2 (multi-timeframe trend, overnight-to-RTH). Size is not a lever: the user trades exactly 1 MNQ contract. Do not promise gains the data have not shown; report each result as shown / NOT SHOWN with what could not be shown.

## Where things stand (verified 2026-10-25, do not re-derive)
- **LIVE_ROSTER gate is live** (commit aa81313 + e21e5ba, server restarted 2026-10-25 15:04 ET, Sim1 re-armed). `server/services/setupEligibility.js` (`LIVE_ROSTER_GATE`), data row = `performance_audit` `signal_type='LIVE_ROSTER'`/`signal_name='CURRENT'`, written daily by `scripts/calibrate_live_roster.mjs`, tests `scripts/test_live_roster.mjs`. Fails closed. Live today = ONE type, `IB_HIGH_FADE_SHORT` (n135/40d, +14.4, CI lower +0.9); `IB_LOW_FADE_LONG` and `OR30_LOW_FADE_LONG` were seeded 10-21 and dropped 10-22/23. User decided 2026-10-25: **keep it data-derived** (decision `live_roster_shrank_to_one_type_user_wanted_three_20261025` resolved), so the scoreboard compares against whatever the daily roster is.
- **First day the gate is a clean before/after boundary: 2026-10-25 (Globex open 6PM ET).** Everything earlier is the old "everything live" regime (`PROMOTE_ALL_MODE`, ~254 ACTIVE types). Report `POC_ROTATION_JOIN` separately always (confound boundary 2026-10-11/12 plus its exit revert 10-21 and its force-SHADOW 10-21).
- **ML is log-only** (`ML_VETO_GATE.enforce=false`), the scoring checkpoint was `metalabel_v20260928_202126` for the whole 10-14..10-23 window, so no ML change can explain any result in that window. Weekly unseen-trade scorecard (`scripts/ml_unseen_scorecard.mjs`, Sunday night) is the only real ML test; needs >=20 unseen days and two consecutive passes. Wed-Fri 10-21..23 TAKE vs VETO: right on Wed/Fri, wrong on Thu (3 days = noise).
- **Live vs All, Thu 10-22 (+793 vs -533) was overnight-fade winners in a 21-trade Live book while the Shadow pile lost -1,326; Fri 10-23 was -137 vs -312.** Not a lasting finding. Do not cite it as evidence of anything.
- Standalone detectors now tag rows with the observation-only 65pt rotation read (POC Gate tab coverage); `POC_ROTATION_JOIN` is deliberately untagged.
- Fade Rating Pilot analysed (take vs step-aside NOT SHOWN, N=40, charts lacked multi-timeframe context): `RESEARCH_CLAIM fade_rating_pilot_take_vs_aside_not_shown_20261025`.
- Watchlist of ML-input and overnight ideas already recorded: `OPEN_DECISION ml_feature_and_overnight_context_ideas_watchlist_20261025`.

## Standing constraints
- Pre-register (commit the doc) BEFORE running anything. Explore (earlier ~60% of days) vs hold-out (later ~40%), placebo, day-blocked bootstrap CI, cluster-sibling collapse, say "NOT SHOWN" for nulls and state what could not be shown (user preference: never "the idea is wrong").
- Market-behaviour hypotheses go through raw bar history FIRST (CLAUDE.md), RTH and Globex both, scale-free data-derived cutoffs only (no fixed numbers), conditional vs UNCONDITIONAL forward return (never vs zero).
- Bar queries: `price_bars_primary` is a VIEW; always give an explicit upper bound as well as a lower one; floor timestamps to the minute; `symbol='NQ'`; derive dates from SQL `CURRENT_DATE`; the pre-2025 NQ data is mostly single daily placeholder rows (KNOWN_ISSUES #17) so the usable intraday window starts about 2025-06 (the replay archives went to 3.5 years only via the tick archive and derived tables, see 2026-10-19 OPEN_THREADS entries). **Check real bar density per date before claiming a multi-year sample.**
- Use Gemini for mining/sweeps (audit its output, 2 correction attempts, then Claude takes over); DeepSeek for the design critique of each pre-registration BEFORE running and a code review after. Nothing here changes live behaviour; any wiring is a separate user-approved step.
- Every tested claim goes through `recordClaim()` (positive or negative), every unresolved fork through `flagDecision()`. Never write `$` through `node -e`; use a `.mjs` file.

---

## Part 1 — Roster scoreboard (one table, built once, then left alone)

### Purpose
Settle "is trading only the demonstrated-edge setups better than trading everything" from 2026-10-25 forward, without re-arguing it after a good or bad day. The roster is a de-risking filter (about 6 false passes expected out of ~247 tested, 3 passed), so the honest hypothesis is **risk-adjusted improvement and lower drawdown**, not "it will print money".

### Definitions (freeze these in the pre-registration, `docs/ROSTER_SCOREBOARD_PREREG_<date>.md`)
- **Arms, all from `active_setups`, same days, `trade_date >= 2026-10-25`:**
  - `ROSTER_LIVE`: rows with `origin_status='ACTIVE'` (what actually fired under the gate). Real-order truth = `order_placements`/`broker_pnl` where present, but score on `actual_pnl` for comparability and report broker P&L alongside.
  - `ROSTER_WOULD_BE`: rows whose `setup_type` is on that day's `LIVE_ROSTER` row (ACTIVE + SHADOW origin), i.e. what the roster would have traded had nothing else gated it. Use the roster row valid ON THAT DAY (the history is in `performance_audit`; DISTINCT ON run_date, id DESC), not today's.
  - `TAKE_ALL`: every primary row (ACTIVE + SHADOW origin) = the old regime counterfactual.
  - `TAKE_ALL_EX_ROSTER`: everything else (to see whether the excluded pile is net negative).
- **Filters (mandatory):** `is_cluster_primary` (primary only) for the real-capital view plus a clustered-collapsed view for CIs (`collapseClusterSiblings`), `resolution IS DISTINCT FROM 'NOT_FILLED'`, `actual_pnl IS NOT NULL`, drop `*_basis` flagged rows (`ib_window_stale_basis`, `stale_entry_price_basis`, `late_fill_past_expiry_basis`, `bad_bars_basis`), drop rows fired 16:00-18:00 ET, `POC_ROTATION_JOIN%` reported separately and excluded from the headline, RTH and Globex reported separately.
- **Metrics per arm per week and cumulative:** trades, distinct days, sum P&L, per-trade mean = sum/N (NOT the day-weighted mean; see the 2026-10-12 hard rule), win rate only with N>=20, max drawdown on the resolve-time-ordered equity curve, worst day, profit factor.
- **Comparison:** ROSTER_WOULD_BE minus TAKE_ALL per day, day-blocked bootstrap CI on the per-day difference (resample days), plus the per-trade mean difference with a day-blocked CI that pools trades from resampled days (paired within day is fine, the arms share days). Never compare two arms with different trades-per-day using day-weighted means.
- **Review rule (pre-register the numbers from the data, not by hand):** first formal look when distinct days >= the day count at which the roster arm's own per-day SD gives a CI half-width of about one typical day's P&L (derive from the explore period; do not hardcode 20 without stating why). Pass/fail definition written before the first look; a pass is "difference above zero with a day-blocked CI above zero, both chronological halves same sign", a fail is the mirror, anything else is "not shown yet, keep collecting". No peeking decisions between looks (optional-stopping rule in CONVENTIONS): one scheduled look, then one per 10 distinct days after.
- **Roster membership churn is part of the result:** record per day which types were on the roster, how many changed, and the P&L of types in their first 5 days on the roster separately (promotion-lag effect).

### Build
- `scripts/roster_scoreboard.mjs` (daily, `run_daily_calibration.sh`, after `calibrate_live_roster.mjs`) writes `performance_audit` `signal_type='ROSTER_SCOREBOARD'` (own type, never SETUP_STATUS), `signal_name='CURRENT'`, `window_days=0`, one row per run_date, full table in `notes` JSON plus a `RESEARCH_CLAIM roster_scoreboard_<prereg date>` whose text is regenerated from the row (so the Research Ledger shows it; write it with `await recordClaim`).
- Read-only display: a small card on `quick-check.html` (Performance tab area) or a section on `setup-performance.html` served by a new `GET /api/setups/roster-scoreboard` (`server/routes/setups.js`). **Add the path to `~/.cloudflared/config.yml` and verify `curl https://tj.6claire.page/api/setups/roster-scoreboard` returns 302** (standing rule). Every `fetch()` in quick-check needs `{ cache: 'no-store' }`; render an explicit "unknown" state on error.
- Test: `scripts/test_roster_scoreboard.mjs` with a synthetic roster history proving the day-correct roster join (a type on the roster Monday but not Tuesday is counted only on Monday) and the primary/cluster/basis/16-18h filters.
- ARCHITECTURE.md entry + `OPEN_DECISION roster_scoreboard_first_look_<date>` carrying the pre-registered review rule; resolve it at the look.
- Do NOT add per-day commentary or alerts that invite reacting to single days. One weekly line in the session-start output is enough.

### Honest limits to state in the pre-registration
Live N will be tiny for weeks (one setup, roughly one to three fires a day). The ROSTER_WOULD_BE arm helps because it includes the shadow rows of roster types, but those are not independent of ROSTER_LIVE. A null at 20 days is the expected outcome, not a failure of the idea.

---

## Part 2 — Bar-level context studies (the best use of the next research sessions)

### Purpose
Test the user's own hypotheses, which the 40-moment rating pilot could not (its charts omitted the higher timeframes he normally weighs), and the overnight-to-RTH claims he pasted on 2026-10-25, on raw bars where there are hundreds of days rather than a few weeks of live rows. These are market-behaviour questions, not "does a setup work" questions.

### Pre-registration document (write first, DeepSeek-critique it, commit, then run)
`docs/BAR_CONTEXT_STUDIES_PREREG_<date>.md` must state: the full hypothesis list below with exact definitions, the horizon set, the explore/hold-out split by date, the number of comparisons counted up front (multiple-comparison surface; report how many cells pass by chance), the pass bar, and what a NOT SHOWN will say. Data window: the longest span with real intraday bar density, verified by a per-date bar-count query before any claim (state the start date).

### Event definitions (all scale-free, thresholds from a rolling prior-period distribution, never fixed numbers)
**A. Overnight → RTH (Globex session 6PM-9:30AM ET as the "overnight", RTH 9:30-16:00; `daily_rth_stats`, `level_prices`/`developing_value_log`, `computeVolumeProfileForRange` for the overnight POC/VA — spread volume across each bar's H-L, never bucket at one price):**
1. *Overnight inventory*: overnight range located entirely above (or below) the prior day's value area / close ("100 percent long/short"). Outcome: RTH first-15/30-minute move relative to the open, direction versus the overnight bias (mean reversion claim).
2. *Open vs overnight range*: RTH open outside the overnight high/low vs inside. Outcome: RTH range / ATR20, trend-day share (use the existing `acd_daily_log.day_type` and `rotation` counts, do not re-derive a classifier), and first-hour direction.
3. *Open vs overnight POC*: RTH open above/below the overnight POC. Outcome: sign of RTH close-minus-open and first-hour move (the user's pasted "structurally bullish if above" claim).
4. *Overnight volume*: Globex volume z-score against the same-clock-time baseline over the prior N sessions (`touchQuality.js` `getVolumeBaseline()` pattern; N derived, not 20 by default — pick from the distribution's stability and record it). Claim: high z continues into RTH. Outcome: overnight net move sign vs RTH net move sign.
5. *8:30 data release reaction*: first 5/15 minutes after 8:30 on release days (needs a release calendar; check whether one exists in the DB before building, else mark as untestable and say so).
Each: RTH sample and a separate Globex-hours analogue where it makes sense; NQ only.

**B. Multi-timeframe trend/momentum context (the user's "I consider multiple time frames"):** at each level-touch event (reuse the real touch population and event times from the live roster's `active_setups` rows AND from the broader named-level touch scan, so it connects to setups) and at random timestamps as the placebo: direction and strength of the net move over 15 / 60 / 240 bars and over the prior session, each z-scored against its own rolling distribution; agreement (all aligned with, or all against, the fade direction) vs mixed. Outcome: forward return at 15/30/60/120 minutes in ATR units relative to the unconditional forward return at the same clock times, plus the real stop/target replay for any survivor (market-fill rule, placebo for asymmetric geometry). This is the test of whether the higher-timeframe context he applies by eye separates good fades from bad ones; it must be run per setup FAMILY (level family) AND pooled, with the opposite-signed-subgroups check (pooled verdict is a question, not an answer).

**C. Regime variable (only after A and B):** the fade vs continuation sign flipped between 2023-mid 2025 and the last ~16 months in earlier studies. Test whether a data-derived regime read explains it, and validate the classifier itself first (parameter sensitivity, independent predictive power) before trusting any split.

### Protocol (identical for every hypothesis)
1. Phase 1 forward-return screen: conditional vs unconditional, several horizons, RTH and Globex, day-blocked CI, random-timestamp placebo, chronological half-split, drop any cell with top-5-day concentration over 60 percent.
2. Survivors only: real stop/target bar-walk with the market-fill rule, gambler's-ruin placebo, then walk-forward with the cell chosen on explore only.
3. Record every result (positive or negative) with `recordClaim`; flag every open fork.
4. Dispatch the combinatorial sweeps to Gemini (read-only DB), then re-run its saved scripts yourself and spot-check 3-5 numbers (100/0 percent win rates, N counts, current-parameter cell vs baseline). DeepSeek reviews the pre-registration and the final script. Never trust a "successfully executed" claim without reading the script.

### Likely failure modes to check up front (they have each bitten this project)
- Lookahead: overnight levels must use only the overnight bars up to 9:30; "prior day" lookups must use `>=`/ASC across weekends (`level_prices` convention); the first trading day after a 2-day closure returns NULL for a "most recent date then filter to hours" query.
- Two scripts run hours apart against a live table are not comparable: pin one fixed upper-bound date in every script of the thread and reuse it verbatim.
- A bucket boundary with a 20-session reference sample (`pct >= 0.9` vs `pct >= 0.9 && pct < 1.0`) changes the population; isolate exact ties.
- Volume features measured at the touch bar's close can be a cushion artifact; take features from strictly before the event.
- Contract-roll weeks and the 2025-09-28..2025-11-19 sparse-bar window (KNOWN_ISSUES #16) must be excluded and stated.
- Weekend/holiday gap trades: an OVERNIGHT trade's MFE can be almost all gap; check the bar before `fired_at`.

### Suggested order
1. Part 1 pre-registration + build (small, one session), so the clock starts.
2. Part 2 pre-registration, DeepSeek critique, then A1-A4 bar-level screens (cheapest, densest), then B.
3. Report, with each result stated as shown / NOT SHOWN plus what could not be shown, and ask before any live wiring.

## Not in scope / still waiting on the user
- The weekly ML ablation report (watchlist decision) — build after Part 1.
- Sierra DTC auto-start/alerting after a PC reboot (the port was closed from the Saturday 17:43 reboot until the user opened Sierra); a banner exists for "DISARMED" but not for "DTC unreachable for hours".
