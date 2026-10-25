# Code review: Globex-flush and momentum-chase walk-forward studies vs their pre-registrations

**Reviewer mode:** read-only. I did not execute either study, did not touch the database, did not edit any source file. I read the two studies, both pre-registrations, the shared `scripts/lib/flushStudyLib.mjs`, the Globex section of `scripts/backtest_flush_patterns.mjs`, `server/services/globexFlushDetector.js`, `server/services/momentumChaseDetector.js`, `scripts/calibrate_momentum_chase_width.mjs`, `server/services/volatilityRegime.js`, `scripts/backfill_garch_vol_scale_history.py`, `server/services/queries.js` (`getPriorDayRthRange`), `server/services/flushMechanics.js`, `server/config/instruments.js`, and the earlier `reports/deepseek_flush_reconcile_code_review_2026-10-26.md`. Anything I could not confirm against the live DB is marked **UNVERIFIED**.

Files compared:
- `scripts/study_globex_flush_walkforward_20261026.mjs` (the Globex study)
- `docs/GLOBEX_FLUSH_WALKFORWARD_PREREG_20261026.md`
- `scripts/study_momentum_chase_walkforward_20261026.mjs` (the Momentum study)
- `docs/MOMENTUM_CHASE_WALKFORWARD_PREREG_20261026.md`
- `scripts/lib/flushStudyLib.mjs`, `scripts/backtest_flush_patterns.mjs`, `server/services/globexFlushDetector.js`, `server/services/flushMechanics.js`
- `server/services/momentumChaseDetector.js`, `scripts/calibrate_momentum_chase_width.mjs`, `server/services/volatilityRegime.js`, `scripts/backfill_garch_vol_scale_history.py`, `server/services/queries.js`

Severity ranking used below: **HIGH** (changes a primary result or makes a claim false), **MEDIUM** (misleading number or an inconsistency that affects interpretation), **LOW / NOTE** (unpreregistered guard, unenforced assumption, cosmetic, minor fidelity gap).

## PART 1 — Globex-flush study vs pre-registration, backtest, and live detector

### 1.1 Departure / sequence / balance / resolution / pace / mfe / volZ construction

**Verdict: verbatim-equivalent to the Globex section of the backtest; equivalent to the live detector on balance/resolution/stop, NOT on trigger window or volume baseline.**

- **Departure** — study `:34-40` vs backtest `:354-366`: identical. Both iterate chronological RTH dates, `getLevelsForDate(date)` → `PD_VAL`/`PD_VAH`, filter that date's bars to `mod >= 959 && mod <= 989` (15:59–16:29 ET = 4:00–4:30 PM), and take the first close `< val` (DOWN) or `> vah` (UP), one departure per date. Both use `b._idx` assigned over `allBars`. ✓
- **Sequence** — study `:43` vs backtest `:372-380` (`sequenceFor`): identical. Starts at the departure bar and walks the global `allBars` array until (exclusive) a bar with `mod 570–959` (next 9:30 AM open). ✓
- **Balance/resolution** — both call the shared `computeBalanceAndResolution(seq.slice(1))` (`flushMechanics.js:33-50`), so entry = resolution-bar close, stop = opposite balance edge, threshold = 50pt, balance = 30 bars, are identical by construction. ✓
- **Pace** — study `:47` vs backtest `:399`: identical `computeEntryPace(dep.departurePrice, seq[0].ts, res.entryPrice, entryBar.ts)` (pace from the departure bar to entry). ✓
- **mfe** — study `:48` vs backtest `:400-405`: identical walk from `entryIdx+1` to `seq.length` (i.e., to the end of the overnight sequence). ✓
- **volZ** — study `:49` vs backtest `:406-419`: identical `seq.slice(1, entryIdx+1)` window, `>=5` guard, `pearson` trend. ✓
- **Bucket / setup_type** — study `:50-51` `mode = dep.dir === res.dir ? 'CONTINUATION' : 'REVERSAL'` and `typeOf()` map exactly onto the backtest's 4-bucket naming (`GLOBEX_FLUSH_LONG/SHORT`, `GLOBEX_FLUSH_REVERSAL_LONG/SHORT`). ✓

The study's header claim "a verbatim port of the Globex section of scripts/backtest_flush_patterns.mjs" is accurate for the construction above. The only construction-level deviation is the bar-load lower bound (see G3).

### 1.2 Walk-forward lookahead (the explicit question)

**Verdict: no lookahead.** The prior-event `mfe` used for tier calibration is known at the time of any later event, including a later event whose trigger date is the next trading day.

Reasoning from the code:
- `setups` is built by iterating `departures`, which is built by iterating `[...rthDates].sort()` (`:34`); one departure per date, so `setups`/`kept` are strictly increasing by trigger date.
- `prior = kept.slice(0, i).filter(p => same bucket)` (`:69`) is therefore strictly earlier by trigger date. ✓
- Tier calibration uses only `prior` (`calibrate(prior)`, `:71`), and `scoreOf(s)` on the current event uses only `s.pace`/`s.avgVolZ`/`s.volZTrend`, all known at the current event's **entry** (`flushMechanics.js:52-59`; `flushStudyLib.mjs:25`). No prior-event target uses the current event's `mfe`. ✓
- A prior event's `mfe` (`:48`) is measured over its own sequence, which ends at the bar before the next 9:30 AM open — i.e. it is finalized at **9:30 AM of the next trading day**. A later event's trigger is at **4:00–4:30 PM** of that same trading day (or a later one). So the prior `mfe` is complete ~6.5 h before the later event triggers. ✓
- The 15-prior minimum (`MIN_PRIOR_BUCKET = 15`, `:70`) is applied consistently and only drops early events (counted in `dropped`). ✓

### 1.3 Realistic arm (C) fills and the exit

**Verdict: correct after the fix.** `flushStudyLib.mjs:35-50` `realistic()`:
- `:39` entry = `sessBars[entryIdx+1].open` (open of the bar after the resolution bar) — matches prereg arm C. ✓
- `:40-41` `const stop = mirror ? ... : setup.stopPrice` — **the structural stop PRICE is now kept for arm C** (the earlier review's finding #1 is fixed). For the mirror arm it reverts to a distance-based stop, as pre-registered. ✓
- `:41` target = `entry ± targetPts` (distance from the real entry) — matches prereg "target distance from the real entry". ✓
- `:42-43` gap-aware "already through the structural stop at the open → fill at the open". ✓
- `:44-48` loop: stop-first, gap-aware stop fill (`min/max(stop, b.open)`), gap-aware target fill (`max/min(tgt, b.open)`), session-close default (`sessBars[last].close` = end of overnight sequence). ✓
- `:49` `pnl = (long ? exit-entry : entry-exit) * PPT - COMM`, `win = pnl > 0`, with `PPT = MNQ $2/pt`, `COMM = $2` (`instruments.js:28,44`). ✓

One intended asymmetry worth stating plainly (it is pre-registered, not a bug): arm C's stop is the **structural** price while its target is a **fixed tier distance**, so a wide-balance event carries a larger real stop than its target distance — this is exactly the "realistic" treatment the prereg specifies, and it is the honest (harsher) fill model compared to the live detector, which enters at the resolution-bar close (`globexFlushDetector.js:262`) rather than the next open.

### 1.4 Mirrored placebo (D)

**Verdict: correct geometry control.** `realistic(s, tgt, true)` (`:72`) flips direction (`long = up !== !!mirror`) and re-places stop at `entry ± |entry - setup.stopPrice|` and target at `entry ∓ tgt` (`:40-41`) — same stop **distance** and same target **distance**, opposite side. `:49` uses the same `tgt` and `entry`, so `C - D` is a paired per-event difference (`:81`). ✓

### 1.5 Live matching (exact setup type within one day)

- `:90` loads live rows `origin_status IN ('ACTIVE','SHADOW') AND actual_pnl IS NOT NULL`, ordered by `fired_at`.
- `:93` matches `c.key === l.setup_type` (exact bucket, e.g. `GLOBEX_FLUSH_REVERSAL_LONG` distinct from `GLOBEX_FLUSH_LONG`) within `|c.entryDate - fired_at_date| <= 1` day.

This is a **slightly more specific** match than the prereg's literal "matched by direction" (`GLOBEX_FLUSH_WALKFORWARD_PREREG_20261026.md:18`), and it uses the replay **entry** date (resolution date) vs `fired_at` date, which is actually correct because live `fired_at` is the resolution-bar timestamp (`globexFlushDetector.js:267`). Benign deviation; see G5.

The material caveat on this comparison is the trigger-window mismatch (G1 below): the study only generates replay events for 4:00–4:30 PM departures, so live rows fired on the detector's widened overnight window have no replay event and silently fall out of "X of Y matched".

### 1.6 Roll / sparse exclusion (trigger day, entry day, next day)

- `:65` `kept = setups.filter(s => s.date >= '2023-03-06' && !(sparse window) && !isInsideNqRollWeek(s.date) && !isInsideNqRollWeek(s.entryDate) && !isInsideNqRollWeek(addDay(s.date,1)))`.

Matches the prereg ("trigger day and the next day outside NQ roll weeks"; sparse 2025-09-28..2025-11-19; sequences >= 60 bars at `:44`). The explicit `entryDate` check is redundant with trigger-day + next-day (entry is within {trigger day, trigger day + 1}), but harmless. See G4 for the calendar-arithmetic nuance.

## PART 2 — Momentum-chase study vs pre-registration, live detector, calibration, regime

### 2.1 Regime classification walk-forward

**Verdict: correct, no lookahead.**

- **Row semantics.** `backfill_garch_vol_scale_history.py:188-190` loops `for i in range(GARCH_WARMUP_DAYS, len(dates)): d = dates[i]; hist_ret = returns.iloc[:i]` — returns **strictly before `d`** — and writes `run_date = d`, `signal_name = str(d)` (`:285-305`). The file's own comment (`:229-232`) confirms "each row `d` … is the forecast FOR today, made using yesterday's close." So **a row dated D is the forecast FOR D made from the prior close**, exactly as the prereg states. ✓
- **Live classification.** `volatilityRegime.js:125-161` `getCurrentGarchRegime()` compares `latest.scale` (the LATEST row) against `p30/p80` of `getVolRegimeHistory(2000)` = all non-LATEST rows → **whole-history cutoffs**, matching the prereg's "(796 rows, so the cutoffs use future data)". ✓
- **Study walk-forward.** `study_momentum_chase_walkforward_20261026.mjs:31-34`: reads non-LATEST rows ordered by `run_date ASC`; `regWF` classifies row `k` using `garch.slice(0, k)` (prior rows only) and requires `k >= MIN_PRIOR_GARCH` (150). So the gate for day D uses only rows dated before D, and the day's own forecast is the value being classified. ✓
- **Study whole-history variant.** `regFull` (`:32-34`) uses `percentile(allScales, 0.30/0.80)` — identical to `getCurrentGarchRegime`'s whole-history percentile, and to `calibrate_momentum_chase_width.mjs:41-55`. ✓

`GARCH_WARMUP_DAYS = 100` (`backfill…py:58`) plus `MIN_PRIOR_GARCH = 150` (`study…:9`) ≈ 250 trading days, consistent with the prereg's "events start about 2024-03". ✓

### 2.2 Trailing-90-day width

**Verdict: correct, strictly prior, no lookahead.**

- `widthFor` (`:35`): `lo = addDay(d, -90)`; iterates `dates` and `if (x >= d) break` → only `x < d` (strictly prior); `if (x < lo) continue`; `if (want && regMap.get(x) !== want) continue` (same-regime days only for the gated arms; all days for ungated); `arr.push(...ranges5.get(x))`; requires `>= 20` bars (`MIN_WIDTH_BARS`); returns `Math.round(percentile(arr, 0.75))`. ✓
- `ranges5` (`:29`) is built from 5-minute RTH bar ranges (`Math.floor(b.mod/5)`, `hi - lo > 0`), over RTH-only bars (`:24-25` `BETWEEN 570 AND 959`). ✓
- This mirrors `calibrate_momentum_chase_width.mjs:61-80` (90 days, `ts::date < CURRENT_DATE`, RTH 570–959, `>= 20` bars, p75), except the study re-derives per-event rather than once per night. Pre-registered ("width … re-derived, not the live values"). ✓
- The event day's own bars are **never** in the width (`x >= d` breaks). ✓
- For the walk-forward arms the prior days' regime tags come from `regWF` (themselves walk-forward), so no future data leaks through the regime filter. ✓

### 2.3 First-signal rules — arm B and arm C

- **Arm C** (`:43`): 1-minute bars, `b.mod < 575 || b.mod >= 720` → 9:35–11:59 ET; first `close > pdh` (long) or `close < pdl` (short); `cIdx = i`; entry = `bars[cIdx+1].open` (next open). Matches prereg arm C and the live detector's 9:35–11:59 window (`momentumChaseDetector.js:71,81`). ✓
- **Arm B** (`:44-46`): 5-minute buckets `Math.floor(b.mod/5)`, window `k*5 >= 570 && k*5+5 <= 720` (9:30–11:55 buckets); **`if (idxs.length < 5) continue`** (requires a full 5-bar bucket); `c = bars[last].close` (the 5-min bucket close = last 1-min close); `bIdx = last`; entry = `bars[bIdx].close` (ideal). Matches prereg arm B and the `idxs.length >= 5` requirement in the review brief. ✓
- One event per day per arm (`break` after first). Arm B legitimately includes 9:30–9:35 while arm C (and live) start at 9:35 — this is the pre-registered "research-style B vs live-like C" distinction, not a bug.

### 2.4 Gap-aware fills and stop-first

`simulate` (`:12-20`) is symmetric 1:1 stop/target, stop-first, `ideal` (exact `stop`/`tgt`) for arm B and realistic (`min/max(stop/tgt, b.open)`) for arm C/D, default exit at `bars[last].close` (15:59, since bars are RTH-only). Arm C starts the walk at `startIdx = cIdx+1`, so the entry bar itself is checked for stop/target — correct for a next-open entry with gap fills (open-beyond-stop fills at open; open-beyond-target fills at open). ✓

### 2.5 Mirrored placebo (D)

`simulate(e.bars, e.cIdx+1, en, !e.cLong, w, false)` (`:60`) — same entry and width, direction flipped; `C`/`D` are pushed in the same iteration so `C[i] - D[i]` (`:63`) is a correct paired difference. ✓

### 2.6 PDH/PDL definition vs `getPriorDayRthRange`

- Study `:27,42`: `prevOf` = previous date in `dates`, where `dates` is filtered to `byDate.get(d).length >= 371` RTH bars. `pdh/pdl` = `max(high)/min(low)` over that prior day's RTH bars. This is "previous **full** RTH session high/low", matching the `daily_rth_stats` full-session convention (`>= 371` bars) cited in the prereg. ✓
- Live detector uses `getPriorDayRthRange` (`momentumChaseDetector.js:87`), which in `queries.js:163-178` selects `MAX(ts::date) < d` with **any** RTH bar (570–959), **no** 371-bar minimum. So after a half-day/early-close, the study's PDH/PDL uses the day before the half-day while live uses the half-day itself. A few dates per year only — see M2.

### 2.7 Lookahead checks

- PDH/PDL are computed from the **prior** day's completed RTH session, so they are fully known at 9:30 of day D. ✓ No lookahead.
- The width uses only `x < d` bars (see 2.2). ✓
- Regime gate uses only prior GARCH rows (see 2.1). ✓

### 2.8 Whole-history-cutoff variant and live matching

- `out.FULL = run(regFull, 'MEDIUM', 'WHOLE-HISTORY cutoffs MEDIUM (live definition)')` (`:68`) uses whole-history cutoffs for both the gate and the width's same-regime filter — this is the live detector's own definition. ✓
- Live matching (`:75-77`) pairs live `MOMENTUM_CHASE_*` rows against `out.FULL.C` events on the same `trade_date` and direction. Using `out.FULL` is correct (live uses whole-history cutoffs). The match rate < 17 is expected and pre-registered: live triggers on the 15-sec poll of the live price (`momentumChaseDetector.js:91-92`) while arm C requires a 1-min bar **close** beyond PDH/PDL, so intrabar-only breaches produce a live row with no arm-C replay (see M3). ✓

## (a) Bugs found (ranked by severity, `file:line`)

There are **no HIGH-severity bugs**: the frozen SURVIVES gates, the walk-forward calibrations, the realistic fills, and the placebos in both studies are implemented as pre-registered. The findings below are all interpretation-level or fidelity-level.

**MEDIUM**

1. **Globex — the study does not test the live detector's trigger window, so the live comparison is structurally incomplete.**
   `study_globex_flush_walkforward_20261026.mjs:36` (departure `mod 959–989`, 4:00–4:30 PM) vs `globexFlushDetector.js:120-126` (`findDeparture`: `ts::date = D AND mod >= 959` **OR** `ts::date = D+1 AND mod < 570`, i.e. 4:00 PM through next 9:30 AM). The pre-reg *acknowledges* this ("matched only by direction/date proximity"), but the consequence is stronger than "proximity": a live row whose departure developed after 4:30 PM has **no** corresponding replay event, so it silently drops out of the "X of Y matched" count (`:93-94`), and the "live mean vs simulated mean" covers only the 4:00–4:30-departure subset. The live comparison cannot be read as a clean live-vs-backtest reconciliation.

2. **Globex — the pace/volume features use the backtest's in-sample volZ, not the live detector's trailing baseline, so the walk-forward tier targets are not what live would compute.**
   `flushStudyLib.mjs:54-59` (90-bar per-minute rolling z-score) vs `globexFlushDetector.js:240-246` (`getVolumeBaseline`, a trailing 90-day per-minute-of-day baseline). The study is a correct port of the *backtest*, but a live-fired event scored by the study's `calibrate()` can land in a different tier than the live detector would assign. Pre-registered as direction/date-proximity-only, but it caps how much the live-vs-simulated comparison can say.

**LOW / NOTE**

3. **Globex — bar-load lower bound shifts the volZ warm-up for the earliest Globex events.**
   `flushStudyLib.mjs:56` (`ts >= $1`, called with `'2023-01-15'` at `study_globex_flush_walkforward_20261026.mjs:29`) vs `backtest_flush_patterns.mjs:188` (no lower bound). Overnight minute-buckets may not have a full 90-bar history by 2023-03-06, so early `avgVolZ`/`volZTrend` can differ slightly from the backtest's. Affects only the pace/volume feature inputs, not trigger/sequence/resolution/mfe. Carried over from the earlier RTH review.

4. **Globex — roll-week "next day" uses calendar +1, not next trading day.**
   `study_globex_flush_walkforward_20261026.mjs:65` `addDay(s.date, 1)`. Functionally safe because a roll week spans Thu→Mon (so a Friday trigger is already caught by the trigger-day check) and `isInsideNqRollWeek(s.entryDate)` covers the overnight-crossing case; noted only for fragility, not a bug.

5. **Globex — live match is by exact setup type + entry date, a (benign) tightening of the pre-registered "by direction".**
   `study_globex_flush_walkforward_20261026.mjs:93`. `c.key === l.setup_type` (so `REVERSAL_LONG` ≠ `LONG`) and `c.entryDate` vs `fired_at` date (correct, since live `fired_at` is the resolution timestamp). More specific than pre-registered; harmless.

6. **Momentum — the ungated "ALL" arm is not "all events since 2023-03-06"; it requires a walk-forward regime to exist.**
   `study_momentum_chase_walkforward_20261026.mjs:57` (`if (!want && !regMap.has(e.d)) continue`). ALL therefore starts ~2024-03, not 2023-03-06. The prereg's "ungated (ALL) results for context" slightly overstates the population. Minor.

7. **Momentum — PDH/PDL uses "previous full RTH session (>=371 bars)", live uses "previous day with any RTH bar".**
   `study_momentum_chase_walkforward_20261026.mjs:27,42` vs `queries.js:163-178` (`getPriorDayRthRange`, no 371-bar minimum). Diverges on the session after a half-day/early close; a few dates per year.

8. **Momentum — live matching can miss intrabar-only breaches.**
   `study_momentum_chase_walkforward_20261026.mjs:43` (1-min close beyond PDH/PDL) vs `momentumChaseDetector.js:91-92` (live-price poll beyond PDH/PDL). Pre-registered ("the live poll price is approximated by the 1-minute close").

9. **Momentum — even the whole-history (FULL) arm re-derives width per event rather than reading the frozen nightly `MOMENTUM_CHASE_WIDTH_CALIB` LATEST value.**
   `study_momentum_chase_walkforward_20261026.mjs:35` vs `momentumChaseDetector.js:95-102`. Pre-registered ("width and regime cutoffs are re-derived, not the live values").

## (b) What is fine

- **Globex construction is a faithful port.** Departure (4:00–4:30 PM), continuous overnight sequence to the next 9:30 open, `computeBalanceAndResolution` via shared `flushMechanics.js`, pace-from-departure, mfe-to-sequence-end, and the volume window `seq.slice(1, entryIdx+1)` are character-for-character the backtest's Globex logic (`backtest_flush_patterns.mjs:354-419`).
- **Globex walk-forward has no lookahead.** `prior = kept.slice(0,i)` is strictly earlier by trigger date; calibration uses prior-only `mfe`/`pace`/`volZ`; the 15-prior minimum is enforced and counted; and a prior event's `mfe` (finalized at 9:30 AM of the next trading day) is known ~6.5 h before any later event's 4:00 PM trigger. The task's stated worry is unfounded.
- **Globex realistic arm is now correct.** `realistic()` keeps the **structural stop price** for arm C (`flushStudyLib.mjs:41`), uses target-as-distance, gap-aware fills, stop-first, and the overnight-sequence-close exit — resolving the earlier review's finding #1.
- **Globex placebo and C−D pairing** are a valid geometry control (`flushStudyLib.mjs:40-41`, `study…:72,81`).
- **Globex rule plumbing** (pooled arm C across 4 buckets, day-blocked 95% CI, paired C−D CI, chronological halves, top-5-day share) maps exactly onto the frozen SURVIVES rule.
- **Momentum regime walk-forward is clean.** The row-dated-D-is-forecast-for-D-from-prior-close semantics are verified in `backfill_garch_vol_scale_history.py:188-190,229-232`, and the study's `garch.slice(0,k)` classification plus `MIN_PRIOR_GARCH=150` match the prereg. `regFull` matches `getCurrentGarchRegime()`'s whole-history p30/p80.
- **Momentum width is strictly prior**, trailing-90-day, same-regime (or all days for ungated), 5-min RTH ranges, `>=20` bars — no event-day bars leak in.
- **Momentum first-signal rules, gap-aware fills, stop-first, and mirrored placebo** are all as pre-registered (arm B: 5-min close, `idxs.length>=5`, ideal; arm C: 1-min close 9:35–11:59, next-open entry, realistic; arm D: flipped, same width).
- **Instrument convention.** Both studies model MNQ (`PPT=$2`, `COMM=$2`, `instruments.js:28,44`), consistent with the live instrument and the "+$13.23/trade" research scale.
- **The earlier review's HIGH finding (arm C stop not structural) is confirmed fixed** in `flushStudyLib.mjs:40-41`.

## (c) The single most important caveat on the two claims

Both "GLOBEX_FLUSH pooled: NOT SHOWN" and "MOMENTUM_CHASE WF-MEDIUM: NOT SHOWN, research +15 shrinks to +5 with realistic fills" are **honest, pre-registered de-selection results — and they must be read as tests of the *backtest-port strategies*, not of the *live detectors*.** The Globex study runs the backtest's original 4:00–4:30 PM departure, its in-sample 90-bar volume z-score, and a next-open realistic fill; the live detector actually fires on a **widened overnight** departure window (4:00 PM → 9:30 AM), a **trailing 90-day** volume baseline, and a **resolution-close** entry. The momentum study re-derives the regime cutoffs (expanding) and the width (trailing 90 days) walk-forward, and MEDIUM was selected **after** seeing LOW and HIGH. So "NOT SHOWN" does **not** mean the live setups are broken or unprofitable — it means the full-sample/self-referential edges (the stored `FLUSH_BACKTEST_REFERENCE`, and the +13.23/trade one-off MEDIUM width) do not survive the pre-registered walk-forward + realistic-fill + mirrored-placebo treatment, which is precisely the prudent, expected shrinkage the studies were built to measure. Concretely: treat "research +15 shrinks to +5" as "the in-sample MEDIUM estimate collapses toward the cost-only placebo once width/regime are made walk-forward and fills are made realistic," and treat the Globex "NOT SHOWN" as "the pooled arm-C variant (walk-forward tiers, next-open fills) has no surviving day-blocked edge," while remembering both verdicts describe the backtested strategy on today's bars, not the live detectors' exact behavior — and the live comparisons in both studies are weakened by the trigger-window and volume-baseline mismatches flagged in (a).1–(a).2 and (a).8.

---

*UNVERIFIED items (require DB access I was instructed not to touch):* the live row counts and means ("about 4–13 per type", "17 momentum rows", "14 of 17 in the first 6 minutes", the ~796 GARCH rows, "N=128, +13.23, 58.6%"), the stored `FLUSH_BACKTEST_REFERENCE` values and their run_date, the printed N/WR/EV/CI values of both studies, the exact number of events dropped by the 15-prior/20-bar/150-row minima, and whether any BACKFILL/UNKNOWN-origin `GLOBEX_FLUSH_*` or `MOMENTUM_CHASE_*` rows exist outside the `origin_status` filters used.






