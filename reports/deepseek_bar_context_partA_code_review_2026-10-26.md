# Code review — Part A overnight→RTH implementation (vs `docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md` + Amendment 1)

**Mode:** read-only. No code executed, no DB run, no file edited except this report. Written 2026-10-26.

Reviewed against the real files:

- `scripts/build_overnight_rth_dataset_20261026.mjs` (79 lines, the dataset builder)
- `scripts/study_overnight_rth_20261026.mjs` (141 lines, the analysis)
- `docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md` (prereg + Amendment 1; Amendment overrides the original)
- `reports/deepseek_bar_context_prereg_A_2026-10-26.md` (my earlier design critique)
- Support: `server/services/developingValueService.js` (`computeProfile`), `server/services/rigorDiagnostics.js` (`dayBlockedBootstrapCI`), `server/services/acdShared.js` (`isInsideNqRollWeek`/`getNqRollWeekDates`), `scripts/build_daily_rth_stats.mjs`, `scripts/record_claim.mjs`.

**UNVERIFIED (could not run the DB per the task):** the actual `price_bars_primary` contents and density; whether any date genuinely has an ON bar count ≠ ~930; the true per-state day counts; the real `daily_rth_stats.rth_range` values in/around the sparse window and roll weeks. Every DB-dependent assertion below is marked UNVERIFIED.

---

## 1. Does the code implement the amended spec exactly? (walk of every cell / definition)

Verdict: **yes, essentially exactly, with three small deviations noted inline.**

**Definitions (builder `build_overnight_rth_dataset_20261026.mjs`):**

- **PD resolution.** L28 `D = stats[i].d, PD = stats[i-1].d` — PD is the previous row of `daily_rth_stats` (actual RTH dates, holiday-aware), never `D−1`. Matches Amendment §9 exactly. ✓
- **Window / exclusions.** L29–32: `D < WINDOW_START`, sparse window, `isInsideNqRollWeek(D) || isInsideNqRollWeek(PD)`, RTH density `n_bars < 371`. 371 = ⌈0.95·390⌉ (0.95·390 = 370.5). ✓
- **ATR20 strictly prior.** L33 `stats.slice(i-20, i).reduce(...)/20` — 20 RTH sessions strictly before D (slice excludes index i). ✓
- **RTH / O / horizons.** L42 `O = rth[0].open`, `at(k) = rth[Math.min(k, rth.length)-1].close`. k=15→rth[14] (09:44), k=30→rth[29] (09:59), k=60→rth[59] (10:29); "to close" L51 = `rth[rth.length-1].close` (15:59 bar when the session is full). Matches "close of the bar at 09:30+k−1". ✓
- **ON window incl. 16:00–18:00 exclusion.** L36–37 `bars(PD 16:00, D 09:30)` then `filter(b.mod >= 1080 || b.mod < 570)`. This drops minute-of-day [570,1080) = 09:30–17:59; within the queried range the only bars dropped are PD 16:00–17:59, i.e. exactly the 16:00–18:00 post-close stretch. ✓
- **Prior VA / prior close.** L34 `prth = getRth(PD)`, L39 `pp = profile(prth)`, L41 `priorClose = prth[prth.length-1].close`. ✓
- **ON POC.** L39 `onp = profile(on)` (same `computeProfile`, spread-volume, TICK=0.25, 70% VA). ✓
- **ON range / net move / volume.** L43 `onL/onH` (low/high extrema), L48 `onOpen=on[0].open`, `onClose=on[on.length-1].close`, L49 `onVol=Σ volume`. ✓
- **First/second Globex half split at 00:00.** L44 `fh = on.filter(mod >= 1080)` (18:00–23:59) and `sh = on.filter(mod < 570)` (00:00–09:29). The split boundary is exactly 00:00 (mod 0). ✓
- **Per-bar volume.** study L27 `onVolBar = onVol/onBars`, `fhVolBar = fhVol/fhBars`. ✓ (Amendment §6.)
- **Same-type prior percentile, Monday N=15 / Tue–Fri N=60.** study L18–25 `typeOf = dow===1 ? 'MON' : 'OTH'`, `N = MON ? N_MON(15) : N_OTH(60)`, prior collected by walking `j = i-1 … 0` over same-type rows only — strictly prior. ✓
- **bigOnMove median rule.** study L27–28 `onMoveAtr = |onClose−onOpen|/atr`, `cutMove = priorStat(onMoveAtr, med)` (median, not a tercile); L32 `bigOnMove = onMoveAtr >= cutMove`. ✓
- **A4 direction requires bigOnMove.** study L56: state = `hiOnVol && bigOnMove ? onDir : 0`; `onDir = sign(onClose−onOpen)`. Near-zero moves get s=0. ✓

**Cell inventory (study L39–64) vs Amendment §"Cell count after the amendment: 39":**

| Family | Cells in code | Spec count | Match |
|---|---|---|---|
| A1 | ABOVE/BELOW/POOLED × {15,30,60,close} = 12 | 12 | ✓ |
| A2 | UPPER/LOWER × {15,30,60,close} = 8 + `A2_RANGE_EXPANSION` = 9 | 9 | ✓ |
| A3 | ABOVE/BELOW × {15,30,60,close} = 8 | 8 | ✓ |
| A4 | HIVOL_{60,close} + HIVOL_RANGE = 3 | 3 | ✓ |
| G1 | ABOVE/BELOW/POOLED × {60,180} = 6 | 6 | ✓ |
| G4 | HIVOL_180 = 1 | 1 | ✓ |

39 total. ✓

- **A1 state.** `inv = onL>=VAH ? +1 : onH<=VAL ? −1 : 0` — matches `ABOVE=onL>=VAH, BELOW=onH<=VAL, else INSIDE`; bias long-for-ABOVE/short-for-BELOW; pooled cell = bias-signed (Amendment §3). ✓
- **A2 redefined.** `pos = (O−onL)/(onH−onL||1)`, UPPER `pos>=2/3`, LOWER `pos<=1/3`; plus `A2_RANGE_EXPANSION` = `hiOnRng → rthRangeAtr` (renamed "range expansion"). Matches Amendment §2. ✓
- **A3.** `O > onPoc ? +1 : O < onPoc ? −1 : 0`. ✓
- **G1.** first-half range vs prior VA (`fhL>=VAH` / `fhH<=VAL`), outcome = second-half drift at +60/+180 only (to-09:29 dropped, Amendment §7). ✓
- **G4.** high first-half volume/bar → `fhDirSign` (sign of first-half net move) × sh(180) only. ✓

**Three small deviations from a literal reading (all Low severity, none verdict-changing):**

1. **μ is over *evaluable* days, not literally ALL valid days.** `prep` (study L67–71) filters `s !== null`, so the early rows whose rolling threshold is null (fewer than `Math.min(N,12)` prior same-type sessions) are dropped from μ. This excludes ~12 OTH days and ~12 *Mondays* (~3 months of Mondays) at the sample start. Because those same days also cannot be state days, the deviation is symmetric and tiny, but it is technically not "μ over ALL valid days" as Amendment §1 words it.
2. **The prior-percentile warmup floor is an implementation choice, not in the spec.** study L23 `prior.length >= Math.min(N, 12)` means Tue–Fri uses as few as 12 (not 60) prior sessions early in the sample. Reasonable, but unstated.
3. **`q(0.67)` on N=15 Mondays flags the top 6/15 (40%), not exactly "top third" (5/15).** `q` L26 uses `Math.floor(p*(len-1))`; for len=15, index=⌊0.67·14⌋=9 → 6 values ≥ cutoff. For N=60 it gives exactly the top 20 (33%). Negligible at these N.

---

## 2. Lookahead

Verdict: **no feature uses information at or after its outcome-window start.** Walked every item in the prompt:

- **`at(k)` indexing** — outcomes, not features; rth[14]/[29]/[59] closes at 09:44/09:59/10:29, all after the 09:30 open. ✓
- **`shBase`/`sh60`/`sh180`** — `shBase` is the 00:00 open (first-half end / second-half base), `sh60/sh180` are second-half closes at 00:59/02:59. For G1 the feature (first-half vs prior VA) is known at 00:00; for G4 `fhDirSign = sign(shBase − onOpen)` is known at 00:00, before the 00:59/02:59 outcomes. ✓ (Mild coupling, not lookahead: `shBase` anchors *both* the G4 sign and the drift base — the same boundary-point coupling I flagged for A2 in the earlier critique.)
- **Rolling same-type percentiles** — `j = i-1 … 0`, strictly prior. Values from excluded/invalid days do **not** leak in: `R = ds.rows` is the builder's `kept` array (post density screen), so sparse/roll/density-failed days are already gone. ✓
- **`atr` window** — `slice(i-20, i)`, strictly prior. ✓
- **ON bars query bounds** — upper bound `ts < D 09:30:00` (L36), so the last ON bar is 09:29 and the 09:30 open is not contaminated. ✓
- **Density screen using medians over ALL rows** (build L58–60) — this is the one thing worth calling out explicitly. It is **not** an outcome lookahead: the median is computed over *bar counts* (a data-completeness metric), never over outcomes, so the exclusion is outcome-blind and cannot manufacture a false-positive excess. It *is* a mild in-sample selection (a day's inclusion threshold is data-adaptive over the whole sample including the hold-out, rather than strictly-prior or fixed a priori). Because the screen only drops low-density days and is symmetric, this does not change any verdict; it is a procedure wart, not a lookahead. Also note the L38 `on.length < 60` hard floor is an extra exclusion not in the spec and is counted as `noPrior` rather than `onDensity`.

No lookahead bug found.



---

## 3. The statistic

- **excess = mean over state days of s·(y−μ), μ over all usable days in the block.** `prep` (L67–71) computes `μ = mean(y over u)`, `cellStat` (L80–83) computes `st = u.filter(s!==0)`, `vals.pnl = s·(y−μ)`, `stat = mean(pnl)`. This is exactly Amendment §1's conditional-minus-unconditional. Continuation → positive, mean-reversion → negative, drift cancels. ✓
- **s===0 handling.** s===0 rows ("not in state") are *excluded from the state mean* (L80 `s!==0`) but *included in μ* (L69 `mean(u.map(y))`, u contains s===0 rows). This matches the spec's "μ over ALL valid days". ✓ (The only caveat is deviation #1 above — s===null rows are excluded from μ.)
- **Circular-shift permutation null** (`permNull` L72–77): shifts the signed state sequence `S` circularly against fixed `Y = y−μ`, exhaustive over `off = 1 … L−1` (no random draw), recomputing the same excess. ✓
  - Group sizes preserved: a circular shift is a bijection, so the multiset of s (and hence the count of state days, and separately the counts of +1 and −1 for pooled cells) is identical at every offset. The denominator `c` is therefore constant (= n state days). ✓
  - The `−μ·Σs` term is a *constant* across all offsets (Σs over the shifted state positions = Σs over the fixed multiset), so subtracting μ does not distort the permutation comparison. ✓
- **One- vs two-sided.** BH on explore uses `pTwo` (= fraction of |v| ≥ |stat|, the "|excess|" test of the original spec); the hold-out gate uses `pOne` (directional, `< 0.05`). This matches the spec's split ("permutation p-value for |delta|" for screening; "one-sided permutation p < 0.05" for hold-out). ✓
- **BH over evaluable cells.** L104–107: `m =` cells with `stat != null && n >= MIN_EXPLORE(30)`; standard BH at q=0.10 with threshold `p_i ≤ (i/m)·q`. ✓
- **Matched control** (L88–93): `ctl = u.filter(s===0)` (non-state days, same block); distance = hypot((ΔgapAbs)/sg, (ΔpdRangeAtr)/sp) with `sg`,`sp` the block SDs (standardised); `slice(0,5)` = 5 nearest; per-day contribution `s·(y − mean y of controls)`; `stat = mean`, CI via `dayBlockedBootstrapCI` (day-blocked). Matches Amendment §5 exactly (5 nearest non-state days on |gap|/ATR20 and prior-day RTH range/ATR20, standardised, day-blocked CI). ✓
  - Note: "same block" matching is full-block (a state day may match *future* non-state days within its block). This is a post-hoc diagnostic, not a tradable feature, so it is not a lookahead and is consistent with the spec's "same block" wording.
- **Leave-top-5-out influence check** (L85–86): sorts state days by |s·(y−μ)| descending, drops the top 5, requires `sign(statDrop)===sign(stat)` and `|statDrop| ≥ 0.5·|stat|`. Matches Amendment §4. ✓ (It is applied to the **explore** excess only; the spec is silent on whether it should also gate the hold-out — minor ambiguity, see §6.)

One thing to flag precisely: the influence check and matched control are computed correctly, but the influence gate (`x.ex.influenceOk`, L115) is the *explore* leave-top-5-out; a hold-out excess driven by 5 days is only caught indirectly by the hold-out `pOne < 0.05` permutation. Low severity.


---

## 4. Off-by-one and edge cases

- **PD across holidays** — L28 `stats[i-1].d`, holiday-aware. ✓
- **09:30 / 15:59 minute-of-day** — RTH = query `[09:30, 16:00)`, so first bar 09:30, last 15:59; `daily_rth_stats.n_bars` uses `BETWEEN 570 AND 959` (15:59), consistent with `ts < 16:00`. `rth.length` and `n_bars` agree. ✓
- **`rth.length < 371` screen** — L32/L35; 371 = ⌈0.95·390⌉. ✓ (Half-days like the post-Thanksgiving 13:00 close produce ~210 RTH bars and are excluded.)
- **Days where the first half has no bars** — L45 sets `fhL/fhH = null`; `gInv` (L58) returns 0 and `fhVolBar` (L27) returns null → `hiFhVol = null` → G4 state null → excluded from those cells. Handled. ✓ (In practice such days usually fail the overnight density screen first.)
- **DST days** — the ON window and `shAt`/`at` horizons are **bar-count** horizons. On the 2 DST-shift days/year the ON window is 870 bars and "+180 min" is 181 (or 179) clock minutes; `mod` still labels each bar's true wall-clock minute so the 18:00/00:00/09:30 boundaries stay correct. Negligible, but "180 min" is really "180 bars".
- **sign 0 for state days** — confirmed consistent with spec (see §3): s===0 is "not in state", excluded from the state mean, included in μ. ✓


---

## 5. Could the two SHOWN cells be false positives? (A2_RANGE_EXPANSION, A4_HIVOL_RANGE)

**Yes — the shared-ATR20-denominator artifact is real, and it is the single biggest threat to A2_RANGE_EXPANSION.**

- **A2_RANGE_EXPANSION**: state = `hiOnRng`, where `onRngAtr = (onH−onL)/atr` (study L27, flag L31); outcome = `rthRangeAtr = stats[i].rng / atr` (build L52). **Both the state feature and the outcome are divided by the same day-specific `atr`.** A day with an unusually low ATR20 (quiet prior 20 sessions) mechanically gets a *larger* `onRngAtr` (more likely to clear the top-third threshold and be flagged HIGH) **and** a *larger* `rthRangeAtr` (the outcome). This induces positive correlation between the state and the outcome even if "overnight range" has no predictive content at all. The excess `mean(rthRangeAtr | HIGH) − μ` would then be inflated by ATR20-lowness, not by the stated mechanism. This is a ratio artifact, not a leak — the code is faithful to the (amended) spec, but the spec's own normalization creates the confound.
- **A4_HIVOL_RANGE** is *not* a shared-denominator artifact in the same way: its state `hiOnVol = onVol/onBars` is volume-per-bar (no `atr`), and only the outcome `rthRangeAtr` is `atr`-scaled. So a low ATR20 can still inflate the outcome, but the state flag is not co-inflated by `atr`. The more relevant threat here is the already-acknowledged volume↔volatility correlation ("high overnight volume → wide day" is a market description, not an edge).

**Does the matched control expose it?** Partially. The control matches on `gapAbs = |O−priorClose|/atr` and `pdRangeAtr = pdRange/atr` — both of which *also* divide by `atr`. Matching on these aligns `atr` levels between state and control days only *indirectly*: two days can share the same (gapAbs, pdRangeAtr) with different raw gap/pdRange and different `atr`. So the control shrinks the artifact but does not eliminate it. The gap-controlled label (study L117–118) is therefore not fully decisive for the range-expansion cells.

**Controls that would expose it (see (c) below):** re-normalize the ON range and the RTH range by *different* scales (e.g. ON range in raw points vs RTH range/ATR, or both / a longer fixed-window ATR), add `atr` (or log atr) as a third matching variable, or run a placebo whose state is "ATR20 in the bottom third of prior same-type sessions".


---

## 6. Bugs that would change a verdict

No **definite** code bug changes a verdict. The items below are the closest to verdict-affecting, ranked:

1. **(Confound, not a bug — but can flip A2_RANGE_EXPANSION) Shared `atr` denominator** — build L52 vs study L27/L31. See §5.
2. **(Low) ATR20 contaminated by sparse/roll sessions** — build L33 `stats.slice(i-20, i)` is *not* filtered by the density/roll exclusions, so the ~20 sessions after the 2025-09-28..11-19 sparse window inherit tiny `rth_range` values that depress ATR20 (inflating both range ratios — feeding the same artifact). Spec does not forbid this, but it is an unstated data-quality wrinkle. UNVERIFIED magnitude (needs the actual `rth_range` values).
3. **(Low) Density-screen medians over the full sample** — build L58–60. Outcome-blind, so not a false-positive engine, but the inclusion threshold is data-adaptive over explore+hold-out together, and the L38 `on.length < 60` floor is extra and miscounted as `noPrior`.
4. **(Low) `μ` excludes s===null early rows** — study L67–71, vs the spec's "ALL valid days". Symmetric and tiny, but a literal deviation.
5. **(Low) Influence gate is explore-only** — study L115; a hold-out excess concentrated in 5 days is not directly influence-checked (only indirectly via `h.pOne`).
6. **(Low) Warmup/percentile edges** — `Math.min(N,12)` floor (L23) and `q(0.67)` on N=15 (L26).

None of these is a lookahead and none overturns the machinery; #1 is the one that can make a *specific cell* untrustworthy.

---

## (a) Bugs found (with file:line)

Ranked by severity. The "real" items are the first two; the rest are minor deviations/edge cases.

1. **Shared ATR20 denominator → ratio artifact (false-positive risk for A2_RANGE_EXPANSION).** `scripts/study_overnight_rth_20261026.mjs:27,31` (state `onRngAtr`) vs `scripts/build_overnight_rth_dataset_20261026.mjs:52` (outcome `rthRangeAtr`), both `/atr` (build `:33`). The matched control (`study:88-93`) only partially neutralises it because its two match keys (`gapAbs`, `pdRangeAtr`, build `:53`) are *also* `/atr`.

2. **ATR20 window unfiltered by density/roll exclusions.** `scripts/build_overnight_rth_dataset_20261026.mjs:33` — `stats.slice(i-20, i)` includes sparse-window (2025-09-28..11-19) and roll-week sessions' `rth_range`. Depresses ATR20 for ~20 sessions after the sparse window. UNVERIFIED magnitude.
3. **μ over evaluable days, not all valid days.** `scripts/study_overnight_rth_20261026.mjs:67-69`.
4. **Density screen medians computed over the full sample (incl. hold-out).** `scripts/build_overnight_rth_dataset_20261026.mjs:58-60`; plus the extra `on.length < 60` floor at `:38` (miscounted as `noPrior`).
5. **Warmup/percentile edges.** `scripts/study_overnight_rth_20261026.mjs:23` (`Math.min(N,12)` floor) and `:26` (`q(0.67)` on N=15 Mondays → top 6/15).
6. **Influence gate is explore-only.** `scripts/study_overnight_rth_20261026.mjs:115`.
7. **DST: horizons are bar-count, not clock-minute.** `scripts/build_overnight_rth_dataset_20261026.mjs:46,51` (and `study:36`).

## (b) Things that are fine

- **Every cell and every definition implements the amended spec**: ON window with the 16:00–18:00 exclusion, prior VA from the prior RTH row (`PD = stats[i-1]`), ATR20 strictly prior, open `O`, the 15/30/60/close horizons with correct bar indexing, per-bar volume, same-type prior percentile with the Monday N=15 / Tue–Fri N=60 rule, the bigOnMove median gate, and the 00:00 first/second-half split. Cell inventory = 39, exactly as specified.
- **No lookahead** anywhere — `at(k)`, `shBase/sh60/sh180`, the strictly-prior rolling percentiles (excluded days don't leak), the `atr` window, the `ts < D 09:30` ON bound, and the (outcome-blind) density screen all clear.
- **The statistic and null**: conditional-minus-unconditional excess with μ over the block; exhaustive circular-shift permutation of the signed state against fixed outcomes preserving group sizes; two-sided p for BH and one-sided p for the hold-out; BH over evaluable cells; the 5-nearest standardized matched control with day-blocked CI; and the leave-top-5-out influence check all match the amended spec.
- **s===0 handling** is consistent: "not in state" is excluded from the state mean but included in μ.
- **PD resolution across holidays, the 371-bar RTH screen, and empty-first-half days** are all handled correctly.

## (c) The single most important control to add before believing the SHOWN cells

**Add an explicit ATR20-level control to A2_RANGE_EXPANSION (and A4_HIVOL_RANGE).** Specifically, before trusting either SHOWN cell, run a placebo / re-normalisation that breaks the shared `atr` denominator:

1. **Re-normalise independently** — recompute the cell with the state in raw points (ON range) and the outcome in raw points (RTH range), or scale both by a *different* and *longer/fixed* volatility anchor (e.g. a trailing 120-session ATR or the full-sample ATR) so the two ratios no longer share the same day-specific `atr`. If the excess survives, the finding is real; if it collapses, it was the denominator.
2. **Direct placebo** — replace the state with "ATR20 in the bottom third of the prior same-type sessions" and check whether that reproduces the same "range expansion" excess. If it does, the SHOWN cell is the low-ATR artifact, not an ON-range→RTH-range mechanism.
3. **(Optional, cheapest)** Add `atr` (or `log(atr)`) as a third matching dimension in the existing matched control (`study_overnight_rth_20261026.mjs:88-93`), or regress the excess on `atr`.

This one control is decisive for A2_RANGE_EXPANSION (and, to a lesser degree, A4_HIVOL_RANGE), because it is the only way to separate "a quiet 20-day window inflates both the ON-range ratio and the RTH-range ratio" from a genuine overnight-range → RTH-range effect.

