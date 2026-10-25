# Design critique — `docs/BAR_CONTEXT_STUDIES_PREREG_B_20261026.md` (multi-timeframe trend at level touches, Part B)

**Mode:** read-only. No code executed, no DB run, no source file edited except this report. Written 2026-10-26, before any outcome is computed.

## Verification status (what I actually read vs. UNVERIFIED)

**Verified against real files:**
- `docs/BAR_CONTEXT_STUDIES_PREREG_B_20261026.md` (full), `docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md` + Amendment 1, `reports/deepseek_bar_context_prereg_A_2026-10-26.md`, `reports/deepseek_bar_context_partA_code_review_2026-10-26.md`.
- `docs/NEXT_STEPS_SCOREBOARD_AND_BAR_STUDIES_SCOPE_20261025.md` (Part 2-B and the protocol, lines 55–95).
- `scripts/study_rotation_gate_roster_replay_20261020.mjs` and `scripts/study_replay_with_times_20261020.mjs` (the latter is the actual producer of the referenced events file — see S1), `scripts/study_roster_replay_20261019.mjs`.
- `scratch/rotation_gate_replay_rows_ts_20261020.json` — **21,480 events** (matches), **813 distinct dates** (not "~700"), **65 distinct levels**, **127 distinct types**; first date 2023-04-03, last 2026-10-16; max 55 events/day; max **15 events on one touch timestamp** (e.g. 15 levels at `2023-11-17 09:35:00`). Schema is `{d, ts, lvl, type, long, rd, agree, pnl, era}` — **there is no `f` field and no `family` field** (it is a `long` boolean + `lvl`/`type`), contrary to the prereg's "fade direction f / level family/type" description. Direction rule (both producers): `long = !(C[gi-5] < C[gi])` → price rose over 5 bars ⇒ short fade, fell ⇒ long fade.
- `server/services/acdRiskGates.js` (DirGate/MomFade shadow tags), `server/services/openingDriveGate.js`, `server/services/rotation65ptGateShadow.js`, `server/services/pocRotationService.js`, `scratch/globex_level_fade_rotation_backtest_20261012.mjs`.
- The RESEARCH_CLAIM texts: `momentum_against_fade_filter_20260905`, `direction_alternation_after_loss_gate_20260905`, `roster_65pt_rotation_direction_gate_20261008`, `opening_drive_counter_trade_20260925`, `istrendcounterfade_fix_sign_contradicts_prior_test_20260925` (via `scratch/claims_list_full_20261020.txt` and the service headers).
- `CLAUDE.md` conventions: no-lookahead (L41), Globex reverses directional-pressure signals (L59), day-blocked bootstrap over tercile (L58), pooled-verdict/opposite-signed-subgroups (L87), optional stopping (L103), self-referential target = tautology (L117), ZigZag-leg alternation tautology.

**UNVERIFIED (could not run the DB per the task):** the true per-cell WITH/AGAINST/MIXED counts (they depend on the rolling median-|T| threshold, which itself depends on the bars); the per-trade P&L SD (I estimate it below from the rotation-gate numbers); whether NQ roll-week dates are present in the events file (no exclusion exists in the producer, so they are almost certainly present — the sparse-window dates are demonstrably present); the exact `run_date` of the `OPTIMAL_STOP` rows (the query takes the *latest* row, which is definitionally in-sample to the 2023-04..2026-10 replay). Every DB-dependent assertion below is marked UNVERIFIED.

---

## Executive severity ranking

| # | Severity | Finding | Q |
|---|----------|---------|---|
| S1 | **Critical** | The referenced events file does **not** implement the prereg's own exclusions: the 2025-09-28..11-19 sparse window is present (42 such dates verified) and the producer has no roll-week exclusion. The prereg's "Excluded:" line is false for the data it cites, the producer citation is wrong, and the schema differs (`long`/`lvl`, no `f`/`family`). | Q2/population |
| S2 | **Critical** | The primary `pnl` outcome is built on **in-sample-calibrated** stops/targets (`OPTIMAL_STOP` latest row, fit over the same 2023-04..2026-10 window) → selection/circularity and lookahead in the *outcome* construction. Forward signed returns are the trustworthy outcome. | Q5 |
| S3 | **High** | Event-level circular-shift placebo is anticonservative under day-persistent trend states (a shift of a few hundred events still lands in the same trend day). Unit of analysis is the *touch*, not the event, and the 15-levels-per-touch nesting is not collapsed. | Q3 |
| S4 | **High** | The feature is **not new**: it is `momentum_against_fade_shadow` at a longer horizon (MomFade = same "fade against recent momentum" claim over 5/15/30 bars), plus the same "don't fade the trend" claim as `isTrendCounterFade()` and the 65pt rotation gate (`rd`/`agree` is already a column in the events file). Must be framed as a re-test at 60/240 bars. | Q1 |
| S5 | **Med-High** | Confound control is under-specified: the scope doc's **random-timestamp placebo is dropped**, opening-range position and day_type are unmodeled, and the stratified SHOWN gate has no per-stratum size floor. | Q4 |
| S6 | **Med** | Sign/tautology and threshold: the 5-bar approach is a sub-window of T_60/T_240 (mechanical overlap to quantify); "previous 60 trading days of events" is ambiguous and effectively day-weighted; the "15-bar control" is orphaned (mentioned, never operationalized). | Q2 |
| S7 | **Med** | Multiplicity is fine (BH q=0.10 over ~32 heavily-correlated RTH cells is conservative), but the 300-event/60-date floor is far too weak for the stratified-excess SHOWN gate; resolvable effect ~$7–12/trade pooled, >$20 stratified. | Q6 |
| S8 | **Med** | Globex arm is **not comparable** (simulated bar-level RTH replay vs. real-fill `active_setups` rows) and is expected to reverse per CLAUDE.md L59; keep descriptive or drop, but don't spend 8 cells or let it leak into a "sign reversal visible" claim. | Q7 |
| S9 | **Low-Med** | Implementation: "change in total simulated P&L" is unrealizable under a 1-contract, one-position constraint (15 events can share one touch), entry at `close[t]` vs live `open[t+1]`, and "skip" vs the house "force-SHADOW, never skip" convention. | Q8 |

---

## Findings (ranked, each with a concrete fix)

### S1 — The data file does not implement the prereg's exclusions; producer citation and schema are wrong (Critical)

The prereg (line 9) says the population is `scratch/rotation_gate_replay_rows_ts_20261020.json`, "produced by `scripts/study_rotation_gate_roster_replay_20261020.mjs` / `study_roster_replay_20261019.mjs`" and "Excluded: sparse window 2025-09-28..2025-11-19, NQ roll weeks (event day or prior day)."

- **The actual producer is `scripts/study_replay_with_times_20261020.mjs`** (line 34 `writeFileSync('scratch/rotation_gate_replay_rows_ts_20261020.json', …)`). The two cited scripts write *different* files with *different* schemas (`study_rotation_gate_roster_replay_20261020.mjs` writes `rotation_gate_replay_rows_20261020.json` as `{d,type,long,agree,pnl,plc,era}`, no `ts`/`lvl`). Methodology is the same, but the citation is wrong.
- **The exclusions are not applied.** The producer (`study_replay_with_times_20261020.mjs:21-23`) only skips the PD_CLOSE roll-gate mismatch; it has **no** sparse-window and **no** `isInsideNqRollWeek` filter. Verified directly: **42 dates inside 2025-09-28..2025-11-19 are present** in the file (e.g. 2025-09-29, 2025-10-01, …, 2025-11-10). KNOWN_ISSUES #16 says those bars are bad; T_240 (≈4 hours of bars) and ATR20 will be computed *across* them, and a 240-bar window that straddles a roll date spans a contract price jump. This corrupts the feature exactly where it matters, and silently inflates the day count (813 distinct dates vs. the prereg's "~700 days").
- **Schema mismatch:** the prereg says each event has "fade direction `f` (+1/−1)" and "level family/type"; the file has `long` (boolean) and `lvl`/`type` only. `family` must be re-derived (e.g. `study_roster_replay_20261019.mjs`'s `familyOf()`), and `f = long ? +1 : −1`.

**Fix (before any run):** (1) Rebuild the events file with `isInsideNqRollWeek(d) || isInsideNqRollWeek(prev)` and the sparse-window exclusion actually applied, print the exclusion counts, and pin the window end date (the scope doc's "pin one fixed upper-bound date in every script" rule). (2) Correct the producer citation to `study_replay_with_times_20261020.mjs`. (3) Add `f` and `family` to the file or state the mapping explicitly in the prereg. (4) Reconcile the day count ("~700" vs. the real 813).

---

### S2 — The `pnl` outcome is circular: in-sample stop/target calibration (Critical)

`simTrade()` (both producers) resolves every event with `ROUND(COALESCE(optimal_stop,p75_mae)) / ROUND(COALESCE(optimal_target,p50_mfe))`, the **latest** `performance_audit OPTIMAL_STOP` row per setup type (query: `DISTINCT ON (signal_name) … ORDER BY run_date DESC`). Those rows are calibrated on real fade history up to ~2026-10, i.e. **the entire replay window is in-sample for the stop/target**. Consequence:

1. Per-type quality is mechanically flattered (each type is traded with the stop/target that, by construction, best fits its own historical MAE/MFE), and — worse for this study — any WITH/AGAINST difference in the *distribution* of MAE/MFE is baked into the outcome, not discovered by it. A cell that "separates" could be a property of the stop/target calibration, not of the trend context.
2. It is lookahead in the *outcome*, distinct from feature lookahead (which the prereg handles correctly). The "market-fill rule" and "gambler's-ruin placebo" in step 6 fix the asymmetric-*geometry* artifact, not this in-sample-selection one.
3. The forward signed returns (`f × (c[t+k−1] − entry)/ATR20`) use **no** stop/target and are therefore parameter-free and clean. They are the trustworthy outcome for the question "does higher-timeframe direction separate fades".

**Fix:** (1) Make `ret30/60/120` the **primary** outcome and demote `pnl` to a secondary, clearly-labelled "simulated, in-sample-calibrated" number. (2) For the `pnl` outcome, either (a) recompute with **walk-forward stops/targets** (calibrated on data strictly before the event's date), or (b) use a **neutral symmetric** stop/target (e.g. ±1.0 ATR20) so the WITH/AGAINST comparison is not contaminated by per-type fitted geometry. The survivors-only step-6 replay must use the same de-circularized parameters.

---

### S3 — Event-level circular shift is not a valid null; unit of analysis is the touch (High)

21,480 events on 813 days (~26/day), up to 15 levels firing on the **same** timestamp, all sharing the same 5-bar approach direction (direction is a function of the bar, not the level). Two defects:

1. **The circular shift is at the event level.** The prereg (line 24) says "circular shift of the chronologically ordered event-state sequence." With ~26 events/day, a shift of up to ~26 events keeps essentially all events inside their original day. Because T_60/T_240/T_S are day-persistent (every event on a trend day gets the same sign), an event-level shift does not break the day-level state→outcome coupling — the null is much easier than it should be, and the p-values are anticonservative. Part A did this at the **day** level (one obs/day); Part B must too.
2. **The events are not independent at the touch level.** The day-blocked bootstrap (resample dates, pool their events) *does* correctly preserve within-day structure, so the **CI** is fine; but the **permutation p** and the effective-N arithmetic are not. The repo already has the tool for this: `collapseClusterSiblings` (used by `study_gate_roster_tagged_20261021.mjs` and the Globex backtest) collapses cluster siblings within a day.

**Fix:** (1) Make the permutation/shift unit the **day** (shift the day-indexed state sequence, keeping each day's events glued to their own state), or do a **day-blocked label permutation** — never a flat event-level shift. (2) Report two significance tracks: per-event effect size with a day-blocked CI, plus a **touch-collapsed** (day × bar) permutation for the verdict. (3) State the effective N as distinct *touches* and distinct *days*, not raw events, and use the touch as the unit for any "one event per day" alternative (the question's two options collapse into "cluster by touch" here, since multiple levels per touch share one direction).

---

### S4 — The feature is not new; it must be framed as a re-test at longer horizons (High)

Grep of the existing mechanisms and their RESEARCH_CLAIM texts:

- **`momentum_against_fade_shadow` (MomFade)** — `RESEARCH_CLAIM momentum_against_fade_filter_20260905`: "Fading against sharp recent momentum (15-bar lookback) predicts worse real fade outcomes… p75 cutoff=35.00pts, above which EV=−$8.63 (N=2003) vs middle quartiles −$2.50. Held up across **5/15/30-bar windows** and a chronological half-split." This is **the same feature family** ("is the fade going against recent momentum, signed by the fade's own direction") at short horizons. T_60/T_240 is exactly MomFade with the lookback stretched to 60/240 bars. **The study is a re-test with a different horizon and must say so**; the prereg names MomFade as "prior art to respect" but never states the direct equivalence.
- **`isTrendCounterFade()`** — a *day-type* classifier (`acd_daily_log.day_type`), not a momentum feature, and permanently inert (`dtClass` null all day). Its RESEARCH_CLAIM `istrendcounterfade_fix_sign_contradicts_prior_test_20260925` is **CONFIRMED: two independent tests of the same wiring gave opposite signs → "no stable effect"**, live TREND precision 23.3% (70.6% false-positive at fade-touch moments). T_60/T_240 does *not* duplicate the mechanism, but it is the **same claim** ("fade against trend is worse") with a directly-observable bar feature instead of a broken classifier. This is a reason to run it, but it must be stated as such.
- **`rotation_65pt_gate_shadow`** — the 65pt rotation-leg direction (`detectSignalEvents(65,…)`), a *price-magnitude* trend detector, not a fixed-bar momentum. It is already a column in the events file (`rd`, `agree`). `RESEARCH_CLAIM roster_65pt_rotation_direction_gate_20261008` (corrected): AGREE mean +$6.62 CI[−1.69,16.20], DISAGREE −$5.27 CI[−13.73,3.24] — pooled delta ~$11.89 but **both group CIs cross zero**. T_60/T_240 is technically distinct (fixed bar count) but the *claim* is the same; the natural question "is T_60/T_240 just the rotation leg at a different horizon?" is answerable for free since `rd` is already there.
- **`openingDriveGate.js`** — RTH 9:31–10:00 only, move-so-far vs 9:30 open ≥ p70 of prior 20 sessions (`opening_drive_counter_trade_20260925`). Not a session-wide trend, but it is a *known-losing* "fade against a strong move" population that will concentrate in the first-hour time bucket and in the AGAINST cells. Not a duplicate; a confound to report (see S5).

**Fix:** Reframe the intro and the "Honest expectations" section as: "This is MomFade (`momentum_against_fade_filter_20260905`) at 60/240-bar and prior-session horizons, plus a re-test of the `isTrendCounterFade` claim with a working feature; the 65pt rotation gate (`rd`) is reported alongside as the existing bar-magnitude trend read." Add an explicit **overlap table**: report the correlation of T_60/T_240 state with `rd`, and the MomFade 15-bar against-flag, so a SHOWN cell is attributed to the right mechanism.

---

### S5 — Confound control is under-specified; the random-timestamp placebo was dropped (Med-High)

The scope doc's Part 2-B and protocol explicitly require a **random-timestamp placebo** ("at random timestamps as the placebo"), which the prereg B silently omits — the only placebo is the circular shift. The stratified-excess gate is `family × time-bucket × LONG/SHORT`, which leaves unmodeled:

- **Position relative to the opening range.** The roster is dominated by OR/IB levels (OR5/OR10/OR15/OR30/IB); a fade touching OR_LOW in a down-trend is a different event from the same fade touching a mid-range level. Family is a weak proxy for range position.
- **Day type.** `acd_daily_log.day_type` (available end-of-day, so usable in backtest) is the same "trend vs balance" axis as T_240 — if a SHOWN cell is entirely explained by TREND days, the cell is the `isTrendCounterFade` claim, not a new multi-timeframe insight. This is the single cheapest decisive split.
- **Volatility regime** affects the dollar `pnl` outcome (the forward returns are already ATR-normalized, so this bites `pnl` only).
- **Opening-drive overlap** (S4): the 9:31–10:00 AGAINST population is already gated live; report it separately.

**Cheapest decisive additions:** (1) restore the **random-timestamp placebo** — same T_k/state/outcome machinery applied to random bars, same N, to show the WITH/AGAINST separation is specific to level touches and not a property of "with-trend wins everywhere" (the conditional-minus-unconditional excess already subtracts drift, but the placebo still isolates the touch mechanism). (2) Add a **`day_type` split** and an **OR-position split** (relative to the opening range) to the mandatory opposite-signed-subgroup report. (3) Set a **per-stratum floor** for the stratified-excess SHOWN gate (≥20 events/stratum, or coarsen to `family × direction` with time as a 2-way split — with 300 state events split into 18 strata you get ~17/stratum, which is noise).

---

### S6 — Sign/tautology and the threshold: three ambiguities (Medium)

1. **Is T_60/T_240 partly definitional?** Partly, and quantifiably small. The replay direction uses `close[i−5] vs close[i]` (the 5-bar approach, touch bar `i=t`); T_k uses `c[t−1] − c[t−1−k]`. The 5 approach bars `[t−5, t−1]` are a sub-window of T_60 (5/60 ≈ 8%) and T_240 (5/240 ≈ 2%). So a long fade is triggered by a 5-bar *down* move that also subtracts from T_60/T_240 — a mild mechanical negative correlation between "fade direction" and T_k, not a tautology (a long fade can still have T_60>0, the classic dip-in-uptrend). **Fix:** compute a disjoint variant `T'_k = f × (c[t−6] − c[t−1−k])` (exclude the 5 approach bars) and report it as a robustness column; if the SHOWN cells survive the disjoint variant, the mechanical overlap is not the story.
2. **The threshold "median |T| over the previous 60 trading days of events" is not fully pinned.** (a) "60 trading days of events" is ambiguous — 60 RTH sessions, or 60 event-days? (b) It is computed over the pooled event distribution, so it is **day-weighted** (a trend day contributes ~26 same-sign events, so the median |T| is effectively the median over ~40% of days). (c) The "≥100 prior events" floor is ~4 days of events, so it rarely binds — fine, but state whether the threshold is computed per-feature (it must be) and whether MIXED events are included in the |T| pool (they should be; |T| is direction-free). It is **lookahead-free in principle** (strictly prior days), which is correct. **Fix:** pin "60 prior RTH sessions (holiday-aware, same `daily_rth_stats` row-walk as Part A)", compute m per-feature over all events in those sessions, and print the resulting WITH/AGAINST/MIXED counts *before* any outcome (the Part A lesson).
3. **The "15-bar control" is orphaned.** It is mentioned in Features ("enters only as a control") but never appears in the Cells (line 20) or the Test (lines 22–29). It is also the wrong window for a control: 15 bars overlaps the 5-bar approach by 33%, and MomFade already covers 5/15/30. **Fix:** either define it (e.g. "does T_60 separate *within* T_15 MIXED?") or drop it; as written it is undefined and unfalsifiable.

---

### S7 — Multiplicity is fine; the power floor for the stratified gate is not (Medium)

40 cells total = 32 RTH (24 feature×state×outcome + 8 composite) + 8 Globex (descriptive, correctly excluded from BH). BH q=0.10 over the evaluable RTH cells is **conservative** here: the cells are massively correlated (same events; nested 30/60/120 horizons; ALL_WITH is a function of the three features), so the effective independent surface is well below 32 and BH's PRDS assumption is met in the conservative direction (same reasoning Part A accepted). This is not the problem.

The problem is **power vs. the stratified SHOWN gate**:

- Explore ≈ 60% of 21,480 ≈ 12,900 events on ~490 dates (the prereg's "~420 dates" is stale vs. the real 813-date file). WITH ≈ AGAINST ≈ 25% each ≈ ~3,200 events; MIXED ≈ 50%. The composites (ALL_WITH/ALL_AGAINST) are far smaller (~12.5% at best, less if the features are correlated — they are).
- **Resolvable effect (estimate; SD UNVERIFIED).** Anchor from the rotation-gate corrected numbers: AGREE CI[−1.69, 16.20] over ~2,700 trades → SE ≈ $4.5 → per-trade SD ≈ $4.5×√2700 ≈ **$230/trade** (bimodal stop/target P&L). Day-blocked: ~490 days, ~26 events/day → day-mean SD ≈ 230/5.1 ≈ $45, SE(day-mean) ≈ 45/√490 ≈ $2. So the **pooled** WITH/AGAINST excess resolves a **~$7–10/trade** difference at ~2 SE — enough to see a MomFade-sized (~$5) or rotation-sized (~$11) effect if it exists, but **not** a small (<$5) edge. **Stratified** (family × time × direction): a 3,200-event cell split 18 ways → ~180 events / ~60–90 days per stratum → SE ~$10–15 → only **>$20/trade** differences are resolvable. The SHOWN gate "stratified excess keeps sign and ≥ half magnitude" is therefore underpowered at the stated granularity for exactly the effect sizes this study is likely to find.
- The **300-event / 60-date** floor is adequate for the pooled cells but should be **tightened for the stratified gate** (per-stratum floor) and for the composites (ALL_WITH/ALL_AGAINST may fall below it; if so, mark them NOT EVALUATED rather than paying the multiplicity cost).

**Fix:** raise the stratified-gate floor to ≥20 events/stratum *and* ≥40 distinct dates/stratum (else coarsen the grid); report the smallest resolvable per-trade difference per cell (≈ half the day-blocked CI width) as the prereg already promises but now with the real, larger stratified number.

---

### S8 — The Globex arm is not comparable and is expected to reverse (Medium)

The RTH arm is a **simulated bar-level replay**; the Globex arm is **real `active_setups` rows** (real fills, real stops/targets, ACTIVE+SHADOW since 2026-07-09). These are different populations, so "the Globex sign reversal is visible next to RTH" conflates *simulated-vs-real* with *RTH-vs-Globex*. On top of that, CLAUDE.md L59 says exactly this class of signal (directional pressure "against the fade") **reverses in Globex** — confirmed 5+ ways, including MomFade's own re-derivation (RTH EV −$7.38 vs −$1.94; Globex +$1.59 vs −$5.77). So the Globex arm is a near-certain reversal, and the ~1,300 rows / ~75 nights is underpowered for anything but a sign check.

**Options, in order of preference:** (a) **Keep it descriptive-only** (the prereg already forbids Globex-only SHOWN), but *rename it* to "real-fill Globex, NOT comparable to the simulated RTH replay; reported solely to display the documented sign reversal" and reduce it from 8 cells to a single descriptive sign table — don't pay multiplicity for it. (b) If a *like-for-like* Globex comparison is actually wanted, build it from the **bar-level Globex touch replay** that already exists (`scratch/globex_level_fade_rotation_backtest_20261012.mjs` — reuses `resolve()` from `backtest_unified.js` and the real 65pt leg detector). (c) Dropping it entirely is defensible given L59 already answers the question; keeping it only adds a "the reversal reproduced" footnote. **Recommendation: (a) now, and note (b) as the correct instrument if a real Globex arm is ever needed.**

---

### S9 — Implementation path: single-position constraint and fill timing (Low-Med)

Step 6 measures "change in total simulated P&L and number of trades removed." Two realisability problems:

1. **The user trades 1 MNQ contract, one position at a time, but the replay takes all events** (one per level per day), including **15 events on a single touch** (e.g. 15 levels at `2023-11-17 09:35:00`, all the same direction). "Total simulated P&L" over 21,480 trades is not a realizable book, and "removing the AGAINST fades" only changes realized P&L when an AGAINST fade would have *occupied the single slot* with no simultaneous better candidate. The per-trade mean difference (already the primary statistic) is the right quantity; **demote "total P&L change" to illustrative**, and add a same-touch conflict rule (if a touch fires both a WITH and an AGAINST fade at the same bar, the single-slot trader takes the WITH one anyway, so the gate is a no-op there — report how much of the "removal" is realizable).
2. **Fill timing:** `simTrade` enters at `close[t]` (the touch bar's close) and starts resolving at bar `t+1`, with gap-aware fills (`min(stopP,O[k])` / `max(tgtP,O[k])`) and STOP-before-TARGET same-bar ordering — that part is already market-fill-realistic. The residual optimism is entry at the touch-bar close rather than `open[t+1]`. **Fix:** the survivors-only replay should enter at `open[t+1]` to match a live poller.

Also: the house convention is **force-SHADOW, never skip** (every gate, including MomFade/DirGate/opening-drive, keeps inserting shadow rows). A "skip" arm would stop accruing data. The prereg's "skip **or** SHADOW" should be resolved to **SHADOW** (reuse the `direction_gate_shadow` / `momentum_against_fade_shadow` precedent), otherwise the "removes bad fades" result cannot be re-observed forward.

---

## (a) The three changes I would make before running

1. **Rebuild the events file so it matches the prereg, and de-circularize the outcome (S1 + S2).** Apply the sparse-window and `isInsideNqRollWeek` exclusions (print the counts), fix the producer citation, add `f`/`family` to the schema, and reconcile the day count. Make `ret30/60/120` the primary outcome; recompute `pnl` with walk-forward (or symmetric ±1 ATR20) stops/targets instead of the in-sample latest `OPTIMAL_STOP`.
2. **Fix the inference unit (S3).** Day-level permutation/shift (not event-level), touch-collapsed significance, report effective N as distinct touches and distinct days, and use `collapseClusterSiblings` for the verdict.
3. **Restore the random-timestamp placebo and add the two cheap decisive splits (S5).** Random-timestamp arm (same N, same machinery), a `day_type` split, and an opening-range-position split; set a per-stratum floor (≥20 events / ≥40 dates) for the stratified SHOWN gate or coarsen to `family × direction`.

## (b) What I would DROP

- **Drop the 8 Globex cells** — replace with one descriptive sign table (S8). CLAUDE.md L59 already predicts the reversal; don't spend multiplicity on it.
- **Drop the orphaned "15-bar control"** unless it is operationalized (S6) — as written it is undefined, and 15 bars is the wrong window (33% overlap with the 5-bar trigger, and MomFade already covers 5/15/30).
- **Drop "change in total simulated P&L" as a headline** in step 6 (S9) — it is unrealizable under a 1-contract, one-position constraint; report per-trade mean difference instead.
- **Drop the in-sample `pnl` as the primary outcome** (S2) — keep it only as a labelled secondary.
- **Drop the "~700 days / ~420 dates" figures** from the prereg (S1) — the file has 813 distinct dates.

## (c) Direct read: usable edge, or mostly a description?

**Mostly a description, with a near-certain null on the one question that matters.** Three reasons, stated plainly:

1. **This is the third pass at the same claim.** `isTrendCounterFade()` was tested twice with opposite signs and closed as "no stable effect" (`istrendcounterfade_fix_sign_contradicts_prior_test_20260925`, CONFIRMED). MomFade (`momentum_against_fade_filter_20260905`) is the *same* "fade against momentum" feature at 5/15/30 bars and is the repo's most durable such finding — but it is a *description* of a $5–8/trade asymmetry that was never promoted to a live gate (still SHADOW-only, `momentum_against_fade_sizemultiplier_wiring_pending`). The 65pt rotation gate (`roster_65pt_rotation_direction_gate_20261008`) shows a pooled $11.89 delta whose **both** group CIs cross zero once corrected. T_60/T_240 is not a new mechanism; it is the same mechanism at longer horizons, and the prior for "longer horizon suddenly finds the stable effect the short horizon couldn't" is poor.
2. **The tradable magnitude, even if it survives, is at the cost floor.** The resolvable pooled effect is ~$7–12/trade; a 1-MNQ trade costs ~$2 round trip + spread, and the user is already single-position (so the gate's realized benefit is further capped by same-touch conflicts, S9). A SHOWN cell at that magnitude is a *filter*, not an edge — exactly what MomFade already is, still parked after 3 weeks.
3. **The design's own honesty will report this correctly if S1–S3 are fixed.** With the sparse window excluded, the day-level null, and the forward-return outcome, the likely result is "NOT SHOWN — smallest resolvable effect ~$7–12 pooled, >$20 stratified", which is a genuine finding about *persistence* (the 60/240-bar context the user reads by eye does not, in bar data, beat the unconditional fade). The Globex arm will show the L59 reversal and nothing more.

The value of running it is therefore **falsification + framing**, not a new trade: it lets the user see, on 21k touches, whether the higher timeframes he weighs by eye add anything over the 5–30-bar momentum already measured. Set expectations accordingly: this is a re-test of MomFade at longer horizons and of the dead `isTrendCounterFade` claim; a null is the expected and correct outcome.






