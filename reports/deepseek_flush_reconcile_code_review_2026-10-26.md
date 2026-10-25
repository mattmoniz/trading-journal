# Code review: `scripts/study_flush_reconcile_20261026.mjs` vs its pre-registration

**Reviewer mode:** read-only. I did not execute the study, did not touch the database, did not edit any source file. I read the study, the pre-registration + Amendment 1, the backtest, the live detector, `flushMechanics.js`, `rigorDiagnostics.js`, `compute_levels.js`, `server/index.js` (cron blocks), `touchQuality.js`, and `acdShared.js`. Anything I could not confirm against the live DB is explicitly marked **UNVERIFIED**.

Files compared:
- `scripts/study_flush_reconcile_20261026.mjs` (the study)
- `docs/FLUSH_RECONCILE_PREREG_20261026.md` (pre-reg + Amendment 1)
- `scripts/backtest_flush_patterns.mjs` (the backtest)
- `server/services/rthFlushDetector.js` (live detector)
- `server/services/flushMechanics.js` (shared mechanics)
- `server/services/rigorDiagnostics.js` (`dayBlockedBootstrapCI`)
- `scripts/compute_levels.js`, `server/index.js`, `server/services/touchQuality.js`, `server/services/acdShared.js`

Severity ranking used below: **HIGH** (changes a primary result or makes the claim false), **MEDIUM** (misleading number or an inconsistency that affects interpretation), **LOW / NOTE** (unpreregistered guard, unenforced assumption, cosmetic).

---

## 1. Verbatim equivalence of the copied functions, and any behavioural difference in the trigger loop / `evalFromTrigger`

**Verdict: the five named functions are verbatim-equivalent (behaviourally identical). The driver loop differs in one un-advertised way (a date bound on the bar load) that changes the volume baseline warm-up.**

- `percentile` — study `:16` vs backtest `:53-57`: identical, character-for-character logic. ✓
- `pearson` — study `:17` vs backtest `:58-64`: identical; the study uses the `mean()` helper for the two means, backtest inlines `reduce/length`. Since `pearson` is only ever called with `volZs` of length ≥ 5, `mean` never sees an empty array, so the `null`-on-empty branch of `mean` is never hit. Equivalent. ✓
- `loadLevels` — study `:18-26` vs backtest `:66-94`: identical logic (variable renames only). The two SQL queries are identical. ✓
- `evalFromTrigger` — study `:27-34` vs backtest `:96-119`: identical, including the `volZ` window `sessBars.slice(triggerIdx+1, entryIdx+1)`, the `>=5` guard, and the `mfe` walk from `entryIdx+1` to session end. ✓
- `simulateExit` — study `:36-40` vs backtest `:121-136`: identical exit logic (stop-first, exact `stopPrice`/`targetPrice` fills, session-close default). The study drops the informational `stopDist`/`targetDist` fields (unused by arm A/B) and uses `PPT`/`COMM` aliases. Equivalent. ✓

**Trigger loop** — study `:64-73` vs backtest `:261-289`: behaviourally equivalent. Both take the *first* IB break (`mod < 630`, i.e. from 10:30) or ONH/ONL close break (from 9:30), and tie-break by `Math.min` (whichever fires first). Study stores indices as numbers, backtest as `{idx}` objects — cosmetic. ✓

**`evalFromTrigger` / `computeBalanceAndResolution`** — both go through the shared `flushMechanics.js` function (study `:7`, backtest `:47`, live `:30`), so entry = resolution-bar close and stop = opposite balance edge are identical by construction. ✓

**The one real difference in the driver:** the bar load. Backtest `:184-189` loads *all* bars with `ORDER BY ts ASC` (no lower bound). Study `:58` loads `… WHERE symbol='NQ' AND ts >= '2023-01-15' ORDER BY ts ASC`. The 90-bar per-minute rolling `volZ` baseline (`:59-61` / backtest `:195-207`) is seeded from `allBars` in arrival order, so the study's baseline warms up from 2023-01-15 while the backtest's warms up from the earliest bar in the table. For RTH minute-buckets this is almost certainly immaterial (the pre-2023-03 rows are daily placeholders at non-RTH times, and B/C/D are filtered to `date >= '2023-03-06'` anyway), but it is a deviation from "verbatim", and it means arm A's earliest `avgVolZ`/`volZTrend` are not bit-identical to the backtest's. **LOW** (arm-A parity was already demoted by Amendment 1).

## 2. Walk-forward lookahead

**Verdict: no lookahead found in the target path. `prior = kept2.slice(0, i)` is strictly earlier; the building medians/target come only from `prior`; arm-A's `avMed/trMed/bTgt` never leak into B/C/D. Two unpreregistered guard thresholds and one extra filter exist (flagged below).**

- `kept2` is built by filtering `setups` in place (`:88-90`), and `setups` was pushed in `dates` (sorted ascending) order (`:64`), so `kept2` is chronological and `slice(0, i)` is strictly earlier events. ✓
- Prior-event `mfe` is measured from that event's entry to the end of **its own** session (`evalFromTrigger` `:31`), so it is fully known at that prior day's close and legitimately available at event `i`'s entry. **Fine.** ✓
- `base`, `pv`, `am`, `tm`, `pb` (`:94-97`) are all computed from `prior` only; the building tier requires `pv.length >= 20` and `pb.length >= 10` and only then overrides `tgt`. ✓
- Arm-A's `tgtA`, `avMed`, `trMed`, `bTgt` (`:74-76`) are used **only** in the arm-A map (`:77`) and arm-A console lines; they are not referenced in the B/C/D loop. **No leakage.** ✓
- **MIN_PRIOR rule** (`:94`): `prior.length < MIN_PRIOR (30)` → `dropped++; continue;`. Applied to B, C and D together (all three pushed in the same guarded block `:98`), so it is consistent across arms and matches the pre-reg ("at least 30 prior events"). ✓

**Unpreregistered additions (LOW / NOTE):**
- `pv.length >= 20` and `pb.length >= 10` (`:96-97`) are sensible sub-minima for the building split but are not stated in the pre-reg.
- The short-session cutoff `s.sessBars.length >= 371` (`:88`) is the code's concretisation of "last complete RTH date" but the number 371 is not in the pre-reg.
- `kept2` additionally drops events whose **previous trading day** is an NQ roll week (`:89-90`). The pre-reg only says "NQ roll weeks excluded"; excluding the *prior* day is a reasonable reading (the prior evening feeds ONH/ONL) but is not spelled out.

---

## 3. Realistic fills (arm C) and the mirrored placebo (arm D)

**Verdict: the target re-anchoring and gap-aware target fill, stop-first ordering, and session-close exit are all correct. The STOP construction is wrong — the study converts the structural stop price into a distance and re-anchors it at the new entry, which contradicts both the pre-reg text and the live detector (both treat the stop as the structural *price*). This is the most material bug in the study.**

Details of `realistic()` (`:42-51`):
- Entry at `sessBars[entryIdx+1].open` — first tradeable price after the resolution bar closes. ✓ (no lookahead)
- `stopDist = Math.abs(setup.entryPrice - setup.stopPrice)` and `stop = long ? entry - stopDist : entry + stopDist` (`:44-45`). `setup.entryPrice` is the resolution-bar close, `setup.stopPrice` is the structural stop (opposite balance edge). So the study's stop is `entry − |resolutionClose − structuralStop|` for longs — i.e. the structural edge **shifted by the resolution-close→next-open gap**, not the structural edge itself.
  - The live detector holds the stop at the structural *price*: `stop = res.stopPrice` (`rthFlushDetector.js:185`), and `flushMechanics.js:43/46` returns `stopPrice = balanceLow`/`balanceHigh`.
  - The pre-reg's own arm-C wording is "stop fills at `min(stop, open)` (long) / `max(stop, open)` (short) on a gap" — a price-level stop with a gap-aware fill. It explicitly says "**Target** distance measured from the realistic entry", and says nothing about re-anchoring the stop.
  - **Consequence:** whenever the next bar opens away from the resolution close, arm C's stop is not the balance edge. A gap-up entry lowers the long stop below `balanceLow` (wider); a gap-down entry raises it (tighter). It is a *distance* model (constant risk-per-trade) rather than the *structural* model the live detector and pre-reg describe. This biases arm C's `pnl`/`win`, hence its pooled EV CI — the first SURVIVES gate — and the h1/h2 halves (third gate).
  - **Mitigation note:** because arm D mirrors the stop about the same entry (`entry + stopDist`), the gap-shift is symmetric, so the `C − D` delta is largely insensitive to this bug. The bug lives mostly in arm C's *level* of stop, not in the placebo subtraction.
  - **Severity: HIGH** (arm C is the primary arm; it is no longer a faithful realistic-fill model of the live strategy's stop).
- Target `tgt = entry ± targetPts` (`:45`) — correct per pre-reg ("walk-forward point target distance applied from the real entry"). ✓
- Gap-aware target fill `Math.max(tgt, open)` / `Math.min(tgt, open)` only when the bar opens through the target (`:49`) — correct. ✓
- Stop-first (`:48` before `:49`) — correct: a bar spanning both stop and target is scored as a stop. ✓
- Exit at the last RTH bar's close (`let exit = sessBars[sessBars.length - 1].close`) — correct (last RTH bar is `mod 959` = 15:59). ✓
- `if (entryIdx + 1 >= sessBars.length) return null;` (`:43`) — guards the no-next-bar case, and both C and D are gated together (`if (!c || !d) continue;` `:98`), so C/D stay index-aligned. ✓

**Is arm D a valid geometry placebo?** Yes, modulo the stop bug it inherits. It flips direction about the entry while keeping the same stop distance and target distance (`long = (resolutionDir === 'UP') !== !!mirror`), which is the intended driftless-walk control: with a near target / far stop, a symmetric walk mechanically favours the near barrier, and `C − D` removes that. The only caveat is that the shared `stopDist` is the (arguably wrong) `|resolutionClose − structuralStop|` rather than a distance measured from the real entry, but since it is identical for C and D, the placebo subtraction still isolates the directional edge. ✓

## 4. Statistics

**Verdict: the bootstrap/CI plumbing is correct and matches the frozen rule. Two low-severity notes (a gross-vs-net win-rate inconsistency, and a paired-difference CI that relies on index alignment without a date assertion).**

- `dayBlockedBootstrapCI` (`rigorDiagnostics.js:245-259`) resamples whole days; with one event per date (the study produces at most one setup/day) this degenerates to per-trade resampling, which is correct for these ~independent 1/day events. The study passes `iters: 3000` via `ci()` (`:110`). ✓
- The C-minus-D **paired** difference is computed per event `pnl: r.pnl - Dp[i].pnl` (`:111`) and passed to the one-sample `dayBlockedBootstrapCI`. For a 1:1 per-date pairing this is the right, more powerful approach than the two-group `dayBlockedBootstrapDeltaCI`; the pre-reg says "events paired by date", and the index pairing == date pairing because C and Dp are built in lockstep. **Note (LOW):** there is no `C[i].date === Dp[i].date` assertion; it is safe by construction but would silently mis-pair if either array ever went out of lockstep.
- Halves (`:112`): `sorted = [...C].sort(by date)`, `h1`/`h2` = means of the two chronological halves. ✓
- **SURVIVES rule vs printed verdict** (`:113`): `res['C'].lo > 0 && dci.lo > 0 && h1 > 0 && h2 > 0` maps exactly onto the frozen rule (pre-reg line 18): C pooled EV CI lower bound > 0, C−D CI lower bound > 0, both C halves positive. If any CI is null (N < 4 → `{lo:null}`), `null > 0` is false → "NOT SHOWN", which is the correct thin-data behaviour. ✓
- **Note (LOW):** `ci()` gates on `arr.length >= 4` before running a 95% bootstrap; a CI from 4 events is statistically meaningless (it will just echo the 4 values). Harmless as a guard, but it can still print a "CI" that looks real at N=4..8.
- **Note (MEDIUM, cosmetic):** win-rate definitions differ by arm. `simulateExit` returns `win` on **gross** price (`win: up ? exitPrice > entryPrice : …`, `:40`), i.e. arm A/B WR ignores commission. `realistic` returns `win: pnl > 0` (`:51`), i.e. arm C/D WR is **net** of commission. EV is net everywhere. The verdict uses EV/CI/halves, not WR, so this does not affect SURVIVES — but the printed arm-A/B WR is not directly comparable to the printed arm-C/D WR.

---

## 5. Live reconciliation

**Verdict: the match logic and the extraLive logic are correct as written, but (a) the frozen denominator is all backtest event days from 2026-07-09 (including the pre-2026-08-28 period), so the printed 36% understates the post-launch comparability, and (b) the "81% over post-launch days" figure is not computed by the script — it is a user-derived number.**

- Window: `LIVE_FROM = '2026-07-09'` (`:13`), `win = setups.filter(s => s.date >= LIVE_FROM)` (`:121`), live rows `WHERE … trade_date >= $1` (`:119`). Same bound both sides. ✓
- `liveByDate` builds a `Map<date, rows[]>` (`:120`); the matcher uses `l[0]` (`:126`). The live detector inserts at most one row per day in normal operation (`_cache.firedToday` `:101`, plus `ON CONFLICT DO NOTHING` on `(trade_date, setup_type, fired_at)` `:225`), so "at most one row/day" holds for genuine live rows. **Note (LOW/UNVERIFIED):** it is an assumption, not enforced — a server restart clears `_cache` and a re-evaluation on changed bars could insert a second row with a different `fired_at`; and the query does **not** filter `origin_status`, so any BACKFILL/UNKNOWN-origin row in the window would be counted as "live". `l[0]` would then pick the first by `fired_at`. I could not check the DB for such rows (UNVERIFIED).
- Match categories (`:123-129`): direction mismatch → `directionDiffers`; entry/stop within 1 pt → `match`; else `priceDiffers`; no row → `missingLive`. Entry (`entry_zone_low`) and stop (`stop_level`) are both the resolution close and structural stop in live, so comparing them to `s.entryPrice`/`s.stopPrice` within 1 pt is apples-to-apples. ✓
- `extraLive` (`:130`): live rows on dates with no backtest event (`!evDates.has(d)`), where `evDates` = all `win` dates (the A procedure, unfiltered by sparse/roll/short). Correct: a live fire with no backtest counterpart is "extra". ✓
- **Match-rate denominator (MEDIUM):** the denominator is `win.length` — every A-procedure backtest event from 2026-07-09 onward, **including the ~32 trading days before the 2026-08-28 target change** (the live detector's building-tier target dates from 2026-08-28, `rthFlushDetector.js:52`). During 2026-07-09..2026-08-27 those days will mostly land in `missingLive`, mechanically deflating the rate. So a printed 36% is **misleading as a statement of "are live and backtest the same strategy today"**, and the post-launch figure (~81%) is the right one to answer that question. Two caveats I must flag:
  - The exact "32 days" count and the "launched 2026-08-28" boundary are **UNVERIFIED** (I cannot count trading days or confirm the first OPTIMAL_STOP/`FLUSH_BACKTEST_REFERENCE` run_date without the DB). The code evidence is: the live target logic is labelled 2026-08-28 (`rthFlushDetector.js:52`), and the live detector returns early if no `OPTIMAL_STOP` row exists (`rthFlushDetector.js:104`), so it cannot fire before the first calibration row.
  - The script computes **only** the frozen 2026-07-09→ match rate (`:131-132`). It prints per-day `DIAG` lines for `date >= '2026-08-28'` (`:134-137`) but does **not** compute a post-launch match rate. The "81%" is derived by the reader from those DIAG lines, not by the script. So the script, as written, will print the 36% (fails the 80% gate) and leave the 81% implicit.
  - Note the frozen Amendment-1 gate is "below 80% ⇒ state live and backtest are not the same strategy". On the frozen denominator it fails; on the honest post-launch denominator it passes (≈81%, just above). Both numbers deserve to be printed together.

## 6. Diagnosis claims (a)–(c) and the inference that they explain the post-launch mismatches

**(a) `compute_levels.js` builds ONH/ONL from the prior BUSINESS-day evening, so Monday ONH/ONL exclude the Sunday-evening session — CORRECT.**
- `priorDay = await priorBusinessDay(date)` (`compute_levels.js:142`); `priorBusinessDay` (`:56-65`) returns the max prior trading date (a bar in 570–959 mod). For Monday that is Friday.
- The ON query (`:221-232`) is `(ts::date = $2 AND EXTRACT(hour) >= 18) OR (ts::date = $1 AND hour*60+min < 570)` with `[date, priorDay || date]` (`:232`). With `$2 = Friday`, the Sunday-evening bars (calendar `ts::date = Sunday`) are never selected. Confirmed at lines ~142 and ~219-232. ✓

**(b) "08:00 ET cron writes the weekday row before the overnight is complete and the 11:00 cron recomputes it" — first half CORRECT, second half WRONG for ONH/ONL.**
- The 8:00 AM Mon-Fri cron (`server/index.js:1182`, `0 8 * * 1-5`) runs `node scripts/compute_levels.js ${today}` (`:1187`) — the full row, including OVERNIGHT ONH/ONL. At 08:00 the overnight (prior-evening 18:00–23:59 + today 00:00–09:29) is incomplete (today 08:00–09:29 not yet present), and for Monday the prior-evening half is the *wrong* evening (Friday, per (a)). So ONH/ONL written at 08:00 are a partial (and on Monday, wrong-window) value. ✓
- But the 11:00 AM cron (`server/index.js:1212`, `0 11 * * 1-5`) runs `--category=CURRENT` (`:1223`) and `--category=OPENS` (`:1236`) **only**. `ONH/ONL` are category `OVERNIGHT` (`compute_levels.js:234-235`), so they are **not recomputed at 11:00**. The claim that "the 11:00 cron recomputes it [the weekday row]" is misleading for the overnight levels — the row's ONH/ONL stay frozen at the 08:00 partial value for every weekday, and Monday's stay missing Sunday evening, unless a manual/backfill run later rewrites them. **This is a factual error in the diagnosis.** (The `--category` scoping was added 2026-08-31 specifically so the 11:00 pass would NOT rewrite full-session levels; see `server/index.js:1217-1222` and `compute_levels.js:557-565`.)

**(c) Live RTH_FLUSH detector reads `level_prices` with `trade_date <= today` DISTINCT ON latest — CORRECT.**
- `rthFlushDetector.js:132-136`: `SELECT DISTINCT ON (level_name) … WHERE trade_date <= $1 AND level_name IN ('ONH','ONL') ORDER BY level_name, trade_date DESC`, `$1 = tradeDateStr`. ✓

**Is the inference ("these explain the post-launch mismatches") justified? Mostly NO — and the main stated mechanism (b) is wrong.**
- The backtest's `loadLevels`/`getLevelsForDate` (`study :18-26`, backtest `:66-94`) reads the **same `level_prices` table** and, for a given date, resolves to that date's own row (latest checkpoint `<= date`), which is the same row the live detector's `trade_date <= today` query picks. So for any given day the backtest and live read **identical ONH/ONL values** (the 08:00-frozen values). ONH/ONL staleness therefore **cannot, by itself, produce a backtest-vs-live mismatch on a specific day** — both sides see the same (possibly wrong) level. It *can* matter only if `level_prices` was rewritten *after* the live fire (so the backtest now reads different ONH/ONL than the detector used at fire time). There is no evidence in the reviewed code that a post-hoc rewrite of ONH/ONL happens automatically (the 11:00 cron does not touch OVERNIGHT), so the (a)/(b) mechanism is at best a partial, second-order contributor.
- **More plausible causes for the post-launch mismatches (all consistent with the code):**
  1. **The 2026-10-19 `price_bars` rebuild** (KNOWN_ISSUES #17, corroborated; Amendment 1 already blames the arm-A parity failure on it). The backtest now runs on the rebuilt, denser bar set, while the live rows were fired on the pre-rebuild (patchier) bars. A different bar array for the same day shifts the IB trigger, the 30-bar balance window, the resolution bar, the entry close and the structural stop — i.e. exactly the fields the match checks (direction, entry, stop). This is the strongest candidate for the per-day mismatches.
  2. **Intraday poll timing + `_cache.firedToday` lock-in** (`rthFlushDetector.js:101`, set true on first fire or first no-op `:234/240`). The live detector resolves once per day against the bars available at its poll time and then stops. Any transient gap/placeholder in the live bar array at that moment changes the balance window and can lock in a different trigger/resolution than the final rebuilt bars imply. This is a genuine path-dependence the backtest (run on complete data) cannot reproduce.
  3. **Volume baseline difference** (`touchQuality.js:21-43` trailing 90-**day** per-mod average vs the backtest's 90-**bar** rolling per-mod `:59-61`; pre-reg line 22 already flags this as a known difference). This cannot change direction/entry/stop, so it does **not** affect the match rate — but it flips the building-vs-not-building split and therefore the target (t1_level) and the realized-vs-simulated P&L comparison (`study :138-139`).
- Bottom line for §6: (a) and (c) are correct code readings; (b) is half-wrong (the 11:00 cron does not recompute ONH/ONL); and the inference that (a)–(c) explain the post-launch mismatches is **not justified as stated** — the level staleness is shared by backtest and live, and the leading causes are the bar rebuild plus intraday poll timing / `firedToday` lock-in (and the volume baseline for the P&L comparison).

---

## (a) Bugs found (file:line)

1. **HIGH — `scripts/study_flush_reconcile_20261026.mjs:44-45`.** `realistic()` converts the structural stop *price* into a distance and re-anchors it at the next-bar open (`stop = entry ± |resolutionClose − structuralStop|`). This deviates from the pre-reg (arm C says "stop fills at `min(stop, open)`", implying the structural price) and from the live detector (`stop = res.stopPrice`, `rthFlushDetector.js:185`). Arm C's stop is no longer the balance edge whenever the entry gaps; it biases arm C's EV/WR/CI (the first SURVIVES gate) and the halves gate. (Partially cancels in C−D because the placebo mirrors the same distance.)
2. **MEDIUM — diagnosis claim (b) is factually wrong.** The 11:00 AM cron (`server/index.js:1223/1236`) runs `--category=CURRENT` and `--category=OPENS` only, so ONH/ONL (category OVERNIGHT) are **not** recomputed at 11:00; they stay frozen at the 08:00 partial value (and Monday's stay missing Sunday evening). The diagnosis overstates the remediation.
3. **MEDIUM — `scripts/study_flush_reconcile_20261026.mjs:121/131`.** The match-rate denominator is all backtest event days from 2026-07-09, including ~32 pre-2026-08-28 days, so the printed 36% (fails the 80% gate) understates post-launch comparability; the script never computes the post-launch (≈81%) rate the reader must derive from the `DIAG` lines (`:134-137`).

## (b) What is fine

- All five copied functions are verbatim-equivalent; the trigger loop and `evalFromTrigger` are behaviourally equivalent (only the bar-load adds `ts >= '2023-01-15'`, a minor baseline-warm-up deviation).
- Walk-forward target construction is clean: `prior = kept2.slice(0,i)` is strictly earlier; prior MFE is measured within each prior session (legitimate); building medians/target are prior-only; arm-A's `avMed/trMed/bTgt` do not leak into B/C/D; MIN_PRIOR=30 is applied consistently.
- Target re-anchoring, gap-aware target fills, stop-first ordering, session-close exit, and the direction-mirrored placebo geometry are all correct (placebo is a valid geometry control).
- CI plumbing (`dayBlockedBootstrapCI` on 1/day events, the paired C−D difference, chronological halves) and the SURVIVES verdict expression map exactly onto the frozen rule.
- Pre-reg "code review before any run" items 1–4 (shared `flushMechanics.js`, self-referential target, ideal fills, live gate N≥20/EV≥−5) are all confirmed in the real files.
- Diagnosis claims (a) and (c) are correct code readings (`compute_levels.js:142/219-232`; `rthFlushDetector.js:132-136`).
- Match logic itself (direction/entry/stop within 1 pt, `extraLive`) is correct; the `liveByDate`-one-row assumption holds for genuine live rows.

## (c) Single most important caveat on "NOT SHOWN, positive point estimate, SHORT stronger"

The one caveat that matters most: **the walk-forward target and the arm-C stop/fill model are only as faithful as the data they run on, and the data changed under the strategy.** Arm A already cannot reproduce the stored `FLUSH_BACKTEST_REFERENCE` because those reference rows predate the 2026-10-19 `price_bars` rebuild (Amendment 1), and the same rebuild is the most likely reason the live rows (fired on pre-rebuild bars, once per day, locked in by `_cache.firedToday`) do not match the backtest's re-derived events at more than ~81% even after launch. So a "positive point estimate / SHORT stronger" read from arm C rests on (i) a stop construction that is not the live strategy's structural stop (`study:44-45`) and (ii) a backtest bar universe that is not the universe the live fires actually saw. Treat any SHORT-vs-LONG strength claim as a statement about the *backtested strategy on today's bars*, not about the *live* RTH_FLUSH strategy — and even that backtest statement is weakened until the stop is rebuilt as the structural price the pre-reg and the live detector both describe.

---

*UNVERIFIED items (require DB access I was instructed not to touch):* the exact number of pre-2026-08-28 trading days ("32"), the precise launch/calibration date, the stored `FLUSH_BACKTEST_REFERENCE` run_date/N values cited in Amendment 1, the printed 36%/81% values themselves, and whether any BACKFILL/UNKNOWN-origin `RTH_FLUSH_*` rows exist in the 2026-07-09+ window.




