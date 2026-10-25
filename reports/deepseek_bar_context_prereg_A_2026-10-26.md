# Design critique — `docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md` (overnight→RTH, Part A)

**Mode:** read-only critique. No code executed, no DB run, no file edited except this report. Written 2026-10-26, before any outcome is computed.

## Verification status (what I actually read vs. UNVERIFIED)

**Verified against real files:**
- `docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md` (full).
- `docs/NEXT_STEPS_SCOREBOARD_AND_BAR_STUDIES_SCOPE_20261025.md` (Part 2 + protocol, lines 19–20, 55–95).
- `server/services/developingValueService.js` — `computeProfile()` spreads each bar's volume evenly over its high–low at `TICK=0.25`, builds a 70%-of-total value area around the POC, returns `{poc, vah, val, maxVol, totalVol, entries}`; POC tie-break = first (lowest-price) index, VA expansion breaks ties upward. OHLC-derived approximation, not tick-true — the prereg correctly says so.
- `server/services/rigorDiagnostics.js` — `MIN_GROUP_N_FOR_CONFIRMATION = 20`; `top5DayPct` counts **observation counts** in the top 5 days (event-level metric), and `clustered = top5DayPct > 50`.
- `CLAUDE.md` Conventions: no-lookahead (L41), day-blocked bootstrap preferred over tercile (L58), containment-vs-same-window tautology (L127), percentile-bucket-boundary ties (L139).
- `docs/DB_BACKUP_CATALOG.md` (L141) and `server/services/acdShared.js` (`isInsideNqRollWeek` exists, L399).
- The same-clock / random-direction placebo precedent in `scripts/backtest_major_pivot_next_open_exit_20261019.mjs`.

**UNVERIFIED (could not run the DB per the task):** the actual `price_bars_primary` density; the contents of `macro_events` (the prereg's "19 forward-looking rows"); the true per-state day counts (ABOVE/BELOW frequencies). I mark every DB-dependent assertion accordingly.

---

## Executive severity ranking

| # | Severity | Finding | Where |
|---|----------|---------|-------|
| S1 | **Critical** | The headline statistic — `delta = mean(side-signed outcome \| state) − mean(outcome \| not-state)` — is **drift-dominated and mathematically blind to continuation vs. mean-reversion**. The "unconditional" baseline is defined but never subtracted. | Q2, Q5 |
| S2 | **High** | Day-level power/concentration guards are void: no minimum N-per-state floor for rare A1/A2 states, and the "top-5-day share < 60%" check does nothing at one observation per day. | Q4 |
| S3 | **High** | 8:30 releases are unexcludable (no history) yet contaminate **every overnight feature** (range/POC/volume/open) and the Globex "to 09:29" **outcomes**. A5 is honestly marked untestable, but the downstream contamination is unstated. | Q1, Q3, Q6 |
| S4 | **High** | A4/G4 volume percentile not de-seasonalized by session type → HIGH ≈ weeknights, LOW ≈ Sunday-nights/holidays; 67th-pct tie boundary on N=60; "HIGH vs not-HIGH" = top-third vs bottom-two-thirds dilution. | Q1, Q2, Q3 |
| S5 | Medium | Confounds (gap size, prior-day range, trend days, month-end/expiry) with no cheap matched control bucket. | Q3 |
| S6 | Medium | "33 cells" is arithmetically honest but the effective independent surface is far smaller; BH(q=0.10) relies on PRDS; explore/hold-out split sits on the acknowledged sign-flip boundary. | Q2 |
| S7 | Medium | Spec drift vs. its own scope doc (RTH range instead of `day_type`; A1 missing "to close"); fixed horizons instead of MFE/MAE or close-to-a-data-derived-time. | Q5 |
| S8 | Low-Med | Globex analogue: 00:00–09:29 second half is heterogeneous (illiquid early hours + 8:30 + pre-open); the 00:00 split is arbitrary. | Q6 |
| S9 | Low | Data window is probably fine (2026-10-19 tick rebuild supports 2023-03), but the earliest ~6 months (NQM23/NQU23) are tick-rebuild-only; scope doc L20 + CLAUDE.md L373 are now **stale**. | Q1, Q7 |
| S10 | Low | Circular-shift placebo: 1,000 random offsets over ~870 possible; seed unpinned. | Q2 |

## Q1 — Lookahead / information-set errors

**Verdict: no lookahead bug in the feature definitions themselves.** Every feature is computable strictly before its outcome window opens:

- `O` = open of the 09:30 bar — known at 09:30:00, before the 15/30/60-min outcomes that close at 09:44/09:59/10:29. ✓
- `ATR20` = mean of `daily_rth_stats.rth_range` of the 20 sessions **strictly before D** — does not include D's own range. ✓
- Prior `[VAL, VAH]` / prior close = from **PD's** RTH bars. ✓
- ON `[onL, onH]` / POC / volume = from ON bars ending 09:29. ✓
- 67th-percentile volume rule = prior N=60 sessions, strictly prior. ✓
- Globex first half (18:00–00:00) vs. second half (00:00–09:29): first-half feature known at 00:00, before the second-half outcome. ✓

**Tautology check:** none of the containment checks compares a window against a value derived from the *same* window. A1's `onL ≥ VAH` uses the prior day's VA (independent reference) — the *correct* non-tautological form the CLAUDE.md L127 convention demands. A2's `O > onH` uses ON extremes vs. the RTH open. No "100%-pass" containment tautology here.

**What *is* wrong in Q1's territory (implementation-adjacent, not yet a bug):**

1. **Prior-date lookup across weekends/holidays.** The scope doc's own failure-mode list (L83) warns: a "most-recent-date-then-filter-to-hours" query returns NULL after a 2-day closure. `ON(D)` is defined off "the prior RTH date PD"; that lookup must be `>=`/`ASC` over a weekday calendar, not `date = D − 1`. The prereg should state the PD resolver explicitly (it doesn't). Cheap fix: precompute a session calendar (holiday-aware) and pin it, same as the pinned end date.
2. **A2's state and outcome share a boundary point, not a lookahead but a coupling.** `ABOVE_ON` is defined by `O` (the open), and the "RTH range" outcome is measured *from that same open*. Not a tautology (the overnight high `onH` is not inside the RTH window, so the gap is correctly excluded from RTH range), but gap-up/gap-down days have mechanically different range/open-location behaviour — so this cell is really "gap-open → range", which is exactly what the S5 confound control must separate (see Q3).
3. **8:30 releases sit inside the feature windows.** 08:30 is *before* 09:30, so releases do not leak into the RTH *outcome* window, but they drive the ON range/POC/volume and the open `O` on release days. A1–A4 states are therefore a mixture of "quiet overnight" and "news-driven overnight". This is a *confound*, not lookahead, but it is the single largest silent contamination and it is unexcludable because `macro_events` has no history (UNVERIFIED contents, but the prereg asserts this and correctly declines to source dates from memory). Detailed in Q3/Q6.
4. **S9 data-window reconciliation (UNVERIFIED against the DB).** The prereg claims ~1,100–1,175 bars/date from 2023-03-06, which at first glance contradicts the scope doc L20 ("pre-2025 is single daily placeholder rows, usable intraday ~2025-06"). **The apparent contradiction is resolved by `DB_BACKUP_CATALOG.md` L141**: on 2026-10-19 the pre-2025 NQ bars were *rebuilt from raw Sierra tick files* (875,410 minute bars, 2023-03-03→2025-05-26), i.e. *before* the prereg's 2026-10-25 density check. So the 870-day window is plausible. Two residual caveats: (a) the earliest contracts **NQM23/NQU23 (2023-03→2023-09) have no independent minute-bar ground truth** — validated only by adjacent-contract correlation 0.92–0.93, so the first ~6 months of the sample are the least trustworthy; (b) scope doc L20 and CLAUDE.md L373 still say "placeholder", which is now **stale** and should be corrected so a future session doesn't waste time re-verifying a non-issue. Recommend re-running the per-date bar-count query once more and printing the per-contract count, not just the aggregate.

## Q2 — Test statistic and null

**S1 (Critical): the delta of a side-signed outcome is drift-dominated and blind to the effect.** This is the central problem and it invalidates the headline for A1, A2's return cells, A3, and G1 (and partially A4). Algebra, using A1 with two states and raw RTH return `r_d` (in ATR units):

- "bias-signed return": ABOVE → `+r_d`, BELOW → `−r_d`.
- `delta_ABOVE = mean(outcome | ABOVE) − mean(outcome | BELOW)`
  = `mean(r | ABOVE) + mean(r | BELOW)`.

In a drifting market both means are ≈ the unconditional drift `d`, so `delta ≈ 2d` — and it is **unchanged** by mean reversion: mean reversion adds `−e` to ABOVE and `+e` to BELOW, giving `(d−e) + (d+e) = 2d`. The signal `e` cancels out of the statistic exactly. The same cancellation holds for A2/A3/G1's "continuation" claims (there `e` enters `+e`/`−e` and also cancels). **delta cannot distinguish continuation from mean-reversion, and is dominated by the drift the prereg itself acknowledges ("never zero").**

Consequences:
- The circular-shift null becomes *degenerate*: under any shifted labelling the "ABOVE"/"BELOW" buckets are random halves, so `delta_shift ≈ 2d` for every shift — the null is centered where the observed statistic sits, so the permutation p-value is ≈ 1.0 regardless of any real signal. The test can only ever report "not significant," never a real effect in either direction.
- A3 (`O>POC` vs `O<POC`) has no INSIDE state, so "not state" is unambiguous and the `2d` result is exact; A1/A2 additionally have an **undefined outcome for INSIDE days** (INSIDE has no bias to sign by), so the complement mean is ill-defined — the prereg never says what "outcome" an INSIDE day contributes to `mean(outcome | not state)`.

**Fix (concrete):** drop "side-signed delta vs not-state". Revert to what the scope doc L77 already prescribes — **"conditional vs unconditional"** — i.e. for each state report `mean(outcome | state) − mean(outcome | all days)` (day-matched excess), with a day-blocked CI, and report the *raw* directional split `mean(r | ABOVE)` vs `mean(r | BELOW)` vs `mean(r | all)` so the sign of the effect (continuation = same sign, reversion = opposite sign vs the overnight bias) is visible and drift is separated. For a directional claim this is also simply `mean(r | ABOVE) − mean(r | BELOW)` on **unsigned** returns (this is what "does above-POC beat below-POC" actually means), not on side-signed returns.

**S6 (Medium): the null and multiplicity.**
- **Circular shift is actually the right null for autocorrelated labels** — it preserves the label *run structure* and the outcome autocorrelation separately, so "is there association beyond both series' own persistence" is what's tested. Keep it. Two nits (S10): 1,000 random offsets sample only ~870 distinct shifts (some repeats) — use all `n−1` offsets exhaustively and pin the seed; and the shift should be applied *within* the explore block, not across the explore/hold-out boundary.
- **BH at q=0.10 over 33 cells:** BH controls FDR only under positive-regression-dependence (PRDS); it is *not* guaranteed under arbitrary dependence, and your 33 cells are strongly positively correlated (ABOVE/BELOW are mirror images sharing the complement; A2 `O>onH` ⊂ A3 `O>POC`; 15/30/60 horizons nest). Positive dependence is the *safe* direction for BH (it makes BH conservative, not anti-conservative), so this is acceptable, but if you want the arbitrary-dependence guarantee use Benjamini–Yekutieli. The stated "expected false positives at 5% ≈ 1.7" is loose framing (it's the uncorrected α=0.05 count, not what BH(q=0.10) controls) — harmless but rewrite it as "BH controls the FDR among declared explore survivors."
- **"33 cells" is arithmetically honest** (6+8+8+3+6+2). But the *effective independent surface* is closer to ~10–15 because of the mirror/overlap/nesting above — so BH over 33 is *over*-correcting, not under-correcting. The real reason nothing will be shown is S1, not multiplicity.
- **Explore/hold-out vs the sign-flip.** The two-stage rule (BH survivor on explore + same-sign one-sided p<0.05 on hold-out + top-5-day<60%) is reasonably strict — with a truly independent hold-out, the expected spurious-SHOWN count ≈ (explore FDR 0.10) × 0.05 ≈ tiny, so it is *not* double-counting and *not* too loose. The actual tension is that the hold-out is the **most recent 40%**, which the prereg itself says is the regime where the fade/continuation sign flipped. An effect real in 2023–2024 will by construction fail the 2025–2026 hold-out and be reported "NOT SHOWN (explore only)". That's *correct* (it means the effect isn't persistent), but you should say up front that this design is deliberately biased toward rejecting any pre-2025-only effect — otherwise "explore-only" cells will be read as "almost findings."

## Q3 — Confounds that would make a "shown" result meaningless

Ranked, with the cheap decisive control each time:

1. **Gap size / gap-open (largest).** A1 ABOVE and A2 ABOVE_ON are both, mechanically, *gap-open states*: overnight above VA or open above the overnight high means price opened a meaningful gap. Gap-open days have known, distinct RTH behaviour (gap-fill vs gap-and-go) that has nothing to do with "value area" or "overnight POC" specifically. A "shown" mean-reversion in A1 would almost certainly be *gap-fill*, not "overnight inventory vs prior VA".
   - **Control (cheap & decisive):** for each state day, form a matched control of the K non-state days with the **nearest gap magnitude** (`|O − onH|` or `|O − VAH|`) and nearest prior-day range; compare the state's excess return to that control's excess return. This is the "same-selection-minus-signal" bucket; the repo already has the precedent (`backtest_major_pivot_next_open_exit_20261019.mjs`'s same-clock control).
2. **Prior-day range / volatility.** ABOVE/BELOW and gap-open states are more frequent after high-volatility prior days; high-vol days have different RTH range/return. ATR20 normalization helps but does not *condition* on it. → match on prior-day `rth_range` (and ON range) in the same matched-control bucket as #1.
3. **Trend days.** Wide-range / strongly-directional days concentrate the outcome for the extreme states (ABOVE/BELOW, gap-opens). → report each cell split by `acd_daily_log.day_type` (already exists — see Q5); an effect living only on trend days is a description, not a signal.
4. **Day-of-week / session type (also S4).** Overnight volume/range differ sharply between a Sunday-night (Monday) session and a weekday session; month-end/expiry differ too. A4's raw prior-60-session 67th percentile will classify weeknights as HIGH and Sunday-nights/holidays as LOW for reasons unrelated to "unusually high volume". → compute the percentile **within session-type** (weekday-overnight vs Sunday-night/holiday-overnight), and add a month-end/expiry flag to report (or exclude) those sessions.
5. **8:30 releases (S3).** Releases drive the *features* on release days. With no history in `macro_events` you cannot exclude them, so the honest minimum is (a) state the contamination explicitly in the report, and (b) run a cheap **within-sample proxy split** — e.g. days whose ON range/volume is in the top decile *for that session-type* — and report whether the effect concentrates there. (A proxy is not a clean exclusion, but it is decisive: if the effect only exists on the proxy release days, it isn't the quiet-overnight claim.)

## Q4 — Power and the minimum per-state N

- **ABOVE/BELOW (A1, A2) are rare.** An overnight range sitting *entirely* above the prior VA or an open *outside* the overnight range is plausibly ~5–15% of days (UNVERIFIED — I could not count). At 10%, ~50 explore / ~35 hold-out days *per state*; at 5%, ~25/~17.
- With one obs/day, a state's mean has SE ≈ `sd/√N`. Day-level RTH return SD in ATR units is typically ~1, so N=50 → SE ≈ 0.14 ATR, N=25 → SE ≈ 0.2 ATR. The prereg's own floor ("effects below ~0.1 ATR unresolvable") is **optimistic for the rare states** — realistically you resolve ≥ ~0.3 ATR at N=25–50, an implausibly large conditional effect for a 1-min-bar context signal. The common states (A3's O>POC ~50%; A4's HIGH 33%) are the only cells with real power.
- **Minimum N before evaluating a cell:** ≥ **30 distinct days per state in explore** (and ≥ 20 in hold-out to attempt the hold-out test), consistent with — slightly above — the repo's own `MIN_GROUP_N_FOR_CONFIRMATION = 20`. Below 30, report "not evaluated — thin," not "not shown."
- **The "top-5-day share < 60%" guard is void for day-level data (S2).** `computeRigor().top5DayPct` counts *observation counts* across days; at one obs/day the top-5-day share is `500/N %`, which is < 60% for any N ≥ 9 — the check passes trivially for every cell. The day-level analogue of "a few days carry the result" is a **leave-k-out influence check**: recompute the mean dropping the top-1 and top-5 days by `|excess return|`, and flag the cell if the sign or CI flips. Replace the guard with that.

## Q5 — Do the cells actually test the stated claims?

| Claim | Cell as written | Does it test it? |
|---|---|---|
| A1 "mean reversion after one-sided overnight inventory" | bias-signed delta vs not-state | **No** — the delta cancels the reversion term (S1). Right test: `mean(r \| ABOVE) − mean(r \| all) < 0` and `mean(r \| BELOW) − mean(r \| all) > 0` (excess vs unconditional), or a one-sample test of the signed return against zero with drift made explicit. |
| A3 "structurally bullish if open above overnight POC" | side-signed delta, ABOVE_POC vs BELOW_POC | **No** — same cancellation. Natural test: `mean(r \| O>POC) − mean(r \| O<POC)` on **unsigned** returns (does above-POC actually outperform below-POC?), plus the "to close" cell (`close−open > 0` frequency) which is the literal "structurally bullish" claim. |
| A4 "high overnight volume continues into RTH" | signed-by-ON-net-move return (HIGH vs not-HIGH) + RTH range | **Partially, and A4 is the most defensible cell.** Signing by the day's *own* ON net move (a pre-open feature) makes drift partially cancel (mean sign ≈ 0), so `delta = continuation(HIGH) − continuation(LOW)` is a reasonable statistic. But (a) "high volume continues" most naturally means *activity* continues → the RTH-range cell, not the directional cell; (b) HIGH vs not-HIGH (top third vs bottom two-thirds) dilutes — contrast HIGH vs LOW (drop the middle); (c) near-zero ON net move days get a random sign and add noise — impose a minimum |ON net move| or report the sign-noise. |

**Outcome-variable improvements (S7):**
- **A2 spec drift:** scope doc L66 says use the *existing* `acd_daily_log.day_type` + rotation counts for the trend-day share ("do not re-derive a classifier"). The prereg instead uses `RTH range / ATR20`, a weaker proxy. Use `day_type`, or rename the cell "range expansion" so it isn't mistaken for the user's trend-day claim.
- **MFE/MAE.** For a 1-contract MNQ trader, "how far does it go my way before against me" is the tradable quantity; a fixed-horizon return understates it. Add a secondary outcome: MFE and MAE within the first 60 min (ATR units), so a "shown" cell can be read as "a real stop/target would have worked," not just "the mean moved."
- **A1 horizon inconsistency:** A1 stops at 60 min while A3/A4 include "to close." If mean reversion is a *session* claim, add "to close" to A1 for consistency.

## Q6 — The Globex analogue

**Sensible in spirit, misleading as written.**

- The mapping is coherent: first-half range vs prior VA → second-half drift mirrors A1. No lookahead (first-half feature known at 00:00).
- **The second half (00:00–09:29) is not one market.** 00:00–~03:00 is the thinnest, widest-spread part of the session; 08:30–09:29 is pre-open/news; the "to 09:29" outcome therefore **sweeps straight through the 8:30 release**, which the prereg cannot identify (no history). `+60/+180 min` (ends 01:00/03:00) are clean; "to 09:29" is not.
- The 00:00 split is arbitrary (wall clock). Sensitivity to the split (e.g. 18:00–01:00 vs 01:00–09:29) isn't reported.
- Same S1 statistic problem: "bias-signed drift over the second half" with a between-state delta is drift-dominated; fix to conditional-vs-unconditional exactly as in Q2.

**Changes:** (a) drop "to 09:29" from G1/G4 and keep +60/+180, or truncate the outcome at 08:25; (b) fix the statistic; (c) de-seasonalize G4's volume percentile by session type; (d) state explicitly that the second half is a low-liquidity + news window, so G1/G4 are *descriptive* of overnight microstructure, not a signal the user would trade.

## Q7 — Anything else that would make me distrust the result, and a cheaper design

**Further distrust triggers:**
- The single biggest one is S1 — as written, the headline can only report "not shown," and a "shown" result in any *other* formulation would be drift masquerading as signal. Fix the statistic before trusting any number.
- The `delta = state vs not-state` framing deviates from the scope doc's own "conditional vs unconditional" (L19, L77); the prereg should either follow the scope or explicitly justify the deviation.
- A4/G4's "sensitivity N=20/120" is a mild hidden multiplicity: three thresholds × the same cells. If any of the three is allowed to *look* like a finding, that's tuning; the prereg says "reported, not tuned," but freeze the N=60 headline as the only pass/fail and treat 20/120 as pure robustness with no SHOWN eligibility.
- The independent Gemini re-derivation is the right idea and the "shared loader can't catch a shared bug" caveat is correct; make sure Gemini re-derives the *fixed* statistic, not the drift-contaminated delta.

**Cheaper/faster design that answers the same questions:**
1. First pass = one descriptive table only, no permutation machinery: per state, N, `mean(excess | state)` = conditional − unconditional (day-matched) at each horizon, day-blocked CI, plus the raw `mean(r | state)` vs `mean(r | all)` split. This is one pass over ~870 days and immediately shows which cells have (a) N ≥ 30 and (b) |excess| above noise. Only cells that clear both go to the BH + hold-out stage.
2. The gap-matched control (Q3 #1) is ~10 lines on top of that pass and is the single most decisive confound check — run it before any permutation test.
3. Skip the 33-cell BH sweep for the rare states (A1/A2) until you know their N; if a state has < 30 explore days, mark it "not evaluated" and stop. Don't pay the multiplicity cost for cells that can't be tested.

---

## (a) The three changes I'd make before running

1. **Fix the test statistic (S1).** Replace `delta = mean(side-signed outcome | state) − mean(outcome | not-state)` with **conditional − unconditional** excess return (day-matched, day-blocked CI), and report the raw directional split so continuation vs. reversion is visible. For directional cells use unsigned `mean(r | A) − mean(r | B)`. This also un-degenerates the permutation null.
2. **Freeze the data window and reconcile the docs (S9).** Re-run the per-date bar-count query, print it *per contract*, and confirm the 2023-03 window survives the 2026-10-19 tick rebuild; note that NQM23/NQU23 (2023-03→09) are tick-rebuild-only. Update scope doc L20 and CLAUDE.md L373 (stale "placeholder" claims).
3. **De-seasonalize + harden the guards (S2/S4).** Volume percentile within session-type (weekday vs Sunday-night/holiday); a ≥30-day-per-state explore floor (else "not evaluated"); replace the void top-5-day-share gate with a leave-k-out influence check.

## (b) What I'd DROP

- **Drop the "side-signed delta vs not-state"** for A1/A2/A3/G1 (reformulate, don't just relabel).
- **Drop "to 09:29" from G1/G4** (or truncate to 08:25) — it sweeps the 8:30 release you can't identify.
- **Drop `RTH range / ATR20` as the A2 trend-day proxy** — use the existing `acd_daily_log.day_type`, or rename the cell "range expansion."
- **Drop the N=20/120 volume-threshold "sensitivity" from SHOWN eligibility** — keep N=60 as the only pass/fail; report 20/120 as robustness only.
- Consider **deferring A1 as specified** (rarest state + a mean-reversion claim the current delta cannot see); if kept, reformulate as "open-gap-vs-VA fill" with the gap-matched control.

## (c) Direct read: usable edge or market description?

**Mostly a description of the market, not a usable edge for a 1-contract MNQ account.** Three reasons, stated plainly:

1. The hypotheses are *gap/overnight-microstructure* descriptions. "Overnight above the value area mean-reverts into RTH," "open above overnight POC is bullish," "high overnight volume precedes a wide RTH" are, at best, restatements of gap-fill, drift, and volume-volatility correlation — all well-documented behaviours that are already priced by the time a 1-contract discretionary trader can act on them.
2. The tradable magnitude is below the cost floor. Even a generous "shown" excess of ~0.1–0.2 ATR on ~1/3 of days, with a day-level SD of ~1 ATR, is a Sharpe near noise; after MNQ round-trip commission + spread (~$1 round trip, i.e. ~0.5 NQ points) and the slippage of trading the *open* (the exact moment these states are realized), the edge is not positive in expectation. The one cell with a plausible practical use is **A4's "high overnight volume → larger RTH range"** — but that is a *context/sizing* input ("expect a wider day"), not an entry edge, and the repo already has a similar descriptive finding in `GLOBEX_ROTATION_BADGE` that it deliberately refuses to trade.
3. The design's own honesty will surface this correctly *if* the statistic is fixed: with the chronological hold-out sitting on the acknowledged sign-flip, any effect that isn't persistent across 2023→2026 dies at the hold-out, and the honest "NOT SHOWN / explore-only" report is the likely and correct outcome.

The value of running this is therefore **not a new trade**, but (i) cheaply falsifying the user's folk claims with bar data instead of vibes, and (ii) if anything survives, handing it to the *real* stop/target replay (which the prereg already gates correctly). Set expectations accordingly: this is a de-risking/description exercise, and a null is the expected, not the disappointing, result.





