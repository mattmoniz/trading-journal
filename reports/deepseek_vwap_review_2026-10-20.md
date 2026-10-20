# POC_ROTATION_JOIN VWAP review — 2026-10-20 (review-only, adversarial)

Scope of what I actually verified vs. inferred:
- **VERIFIED = read the code/docs/data myself, cited as `path:line`.**
- **INFERRED = reasoning about behavior from that code (no execution).**
- **RUN OUTPUT = numbers printed in `scratch/*_out_*.txt` or derived from those — I did not re-run node/DB, so I cannot confirm these; they are reported, not re-derived.**
- The only data I directly read was `scratch/poc_join_vwap_rows_20261020.json` (a saved data file, read with grep, not by executing the study). Direction counts below are from that file.

---

## 1. VWAP-slope direction gate — verdict: PARTLY

**PARTLY.** The *negative conclusion* ("do not promote a slope-direction gate") is robust and I agree with it; but the *construction* is degenerate in a way that means this test did **not** cleanly test the user's idea ("is VWAP sloping up/down"). It tested something closer to "is price above a slow, 23h-anchored cumulative VWAP". The failure is real but under-scoped.

### What is sound (VERIFIED)
- **No lookahead in the feature.** `vwapOf()` anchors at `18:00` prev evening (`scripts/study_poc_join_vwap_slope_gate_20261020.mjs:9`); `slope = vw[t] - vw[t-K]` with `t = e.trig - e.a` (trigger-bar index, line 13-14). Entry is the next bar's open, and `vw[t]` uses bars through the *closed* trigger bar — so the slope is knowable at entry. The rolling flat cut `flatCut()` uses only the 20 prior dates (`:11`). Correct.
- **class/aligned/opposed logic matches the prereg.** `cls = slope>c?'UP':slope<-c?'DOWN':'FLAT'`, `aligned=(long&&UP)||(!long&&DOWN)`, `opposed=(long&&DOWN)||(!long&&UP)` (`:14-15`). Internally consistent: UP 2552 + DOWN 352 + FLAT 722 = 3626, aligned 1515 + opposed 1389 = 2904 = UP+DOWN.
- **The fill convention is the right one.** E1 via `simE1` in `scripts/lib/pocJoinLoader.mjs:46-50` implements the CLAUDE.md:130 rule (`fill = min(stop, open)` long / `max(stop, open)` short) and the live constants (100pt stop, arm breakeven at forward bar 60, cap 24h, next-event bound via `fwd` at `pocJoinLoader.mjs:44`) match `pocRotationJoinDetector.js:70-72`.

### What is degenerate / under-tested (VERIFIED against code, reasoning follows from it)
1. **Anchoring at 18:00 is not "session VWAP" as the user means it.** `computeRunningVwapSeries` (`server/services/developingValueService.js:79-89`) is a *cumulative* typical-price VWAP over the whole 23h detector session (18:00→17:00, `pocJoinLoader.mjs:35`). By RTH open it has already dragged ~15h of thin Globex prices into the denominator. This is *consistent with the event session*, but it is not the RTH-open VWAP a trader means by "is VWAP sloping up/down".
2. **The 60-min "slope" of a cumulative average is nearly the same thing as "price above/below VWAP", and it is non-stationary.** The 60-min change of a cumulative mean is ≈ (recent volume-weighted deviation of price from VWAP) / cumulative volume. So (a) `slope` is almost collinear with the *position* check the prereg itself ran as "price-side" — and the price-side exploratory came out flat (+7.1 vs +7.0, run output), which strongly suggests slope and price-side are the same null quantity; (b) the slope *shrinks* intraday as cumulative volume grows, while the flat cut is calibrated on pooled |slope| (including late-session, naturally-smaller slopes) — so the UP/DOWN/FLAT classification drifts within the day.
3. **The flat cut is calibrated on the full 23h session, not RTH.** `samples()` samples `|vw[t]-vw[t-60]|` every 15th bar of the *whole* session (`:10`), pooled over 20 prior dates (`:11`). Globex is ~21 of those 23 hours, so the "flat" threshold is set by Globex slope magnitudes and then applied to RTH joins. The spec's phrase "20 RTH trade dates" is about *date selection* (dates with ≥300 RTH bars), not about *where* the slope samples come from. This is a real construction mismatch.
4. **The UP skew makes the short side of the gate untestable, and the N-criterion masks it.** From the saved rows file (I counted directly): long 1745 / short 1881; long∧UP **1261**, short∧UP **1291**, long∧DOWN **98**, short∧DOWN **254**. So:
   - The "fire SHORT only when VWAP slopes DOWN" leg rests on **254** joins total (the whole DOWN class is 352/3626 ≈ 10%).
   - The opposed cell is dominated by short∧UP = **1291** (short a 65pt down-rotation *while the 23h VWAP still slopes up*).
   - Criterion 1 (N aligned ≥150 overall, ≥50 per cell) passes **on pooled aligned**, which is carried by long∧UP (1261); it does **not** check that short∧DOWN has any meaningful N. The gate's short side is effectively untested.
5. **Degenerate top-5 metric.** `top5 = sum(top5)/sum(aligned)` (`:23`). When the aligned total is ≤0 this yields a negative share that *trivially* "passes" `< 50%`. The PRE cell prints "top5 -644%" (run output) — a sign that the PRE aligned total is ≤0, not a real concentration measure. In the slope run only the OVERALL cell (46%) is actually gated (criterion 6, `:43`), so here it's cosmetic — but see §2 where the same defect *does* gate.

### Placebo verdict
The within-month×session label shuffle (`:30-33`) is a *valid but weak* null. It preserves the label multiset but reshuffles labels **across** long and short joins, so the null "aligned" set is allowed to have a different long/short composition than observed. If long joins have a higher base P&L than short (very likely over a 2023–2026 NQ uptrend), the shuffle adds variance from the long/short base rate rather than isolating "does the VWAP label itself predict direction". A cleaner null would shuffle labels **within direction** (among longs separately, among shorts separately), holding long∧UP/short∧DOWN counts fixed. p=0.83 is not going to be rescued by this refinement, but it is the correct critique of the placebo.

## 2. Bad-day state test — verdict: AGREE (fail-and-stop is right), with a real lookahead defect

**AGREE** with the conclusion (the VWAP gate does not help on losing days; stop). The "+26.6 in bad state" is not evidence of mean reversion — it is regression-to-the-mean/selection noise in a lottery-shaped, day-clustered, heavy-tailed P&L. But the STATE itself has a one-bar lookahead that should be fixed before this is ever revisited.

### The state has a one-bar lookahead (VERIFIED against code)
- `simE1` marks a held-to-end position at `C[last]` (`pocJoinLoader.mjs:50`), where `last` is the last bar with `T <= bound` and `bound = min(entry+1440, nextEvent.ep)` (`fwd`, `pocJoinLoader.mjs:44`).
- For the join **immediately preceding** the current join r, the "next event" is r itself, so `last = r.ei` (r's own entry bar) and the preceding join is marked at **the close of r's entry bar** (`exitK = r.ei`).
- The state filter is `x.ei < r.ei && x.exitK <= r.ei` (`scripts/study_poc_join_bad_day_vwap_20261020.mjs:8`). With `exitK == r.ei`, the preceding join's mark-to-market **at `C[r.ei]`** is included in r's state — but r enters at **`O[r.ei]`**, before that close is known. In live terms the preceding join closes at r's entry *open*, not close. This is a real one-bar lookahead (magnitude ~ the entry bar's range × $2/pt, small vs the −$400 threshold but nonzero at the boundary).
- Fix: use `x.exitK < r.ei` (strict), or mark hold-to-end at `O[last]` instead of `C[last]`.

### The "+26.6 bad-state mean" is not a finding (INFERRED from the reported numbers)
- Reported run output: bad state N=179 on 60 dates; all +26.6 vs non-bad +6.1; difference CI [−5.9,+53.3] (per the user's framing; the script's own primary CI is aligned−all [−69.7,+11.5]). The CI includes zero → not significant.
- The P&L is heavy-tailed (top-5 share of aligned total −12820%, run output) and day-clustered (179 joins / 60 dates). Conditioning on "already lost −$400 today" selects times with recent bad luck; the next draw regresses toward the (slightly positive, lottery-carried) mean. This is exactly the gambler's-fallacy shape, and it is *not* the pre-registered question anyway — the primary was "aligned minus all **within** bad state", which is −26.8.

### The ungated-stream state biases the conclusion *against* the gate, not for it (INFERRED)
- The prereg already flags this (`docs/POC_JOIN_BAD_DAY_VWAP_PREREG_20261020.md:7`). The direction of the bias matters: within bad state, **opposed +51.8 vs aligned −0.2** (run output). The opposed trades are precisely the ones a live gate would have *skipped* — so the ungated state is *more positive* than the gated state would have been (it includes the +51.8 recoveries). Under the gate the state would have gone deeper into BAD more often. So the ungated-state limitation understates the harm, not the benefit. The conclusion (fail) is robust.
- Also: STATE is computed only over joins that **have a defined class** (the slope script `continue`s before writing undefined/early joins, `:13`), so early-session losses (t<60) are missing from the running P&L — the −$400 threshold is harder to reach than a live trader's true realized day P&L would imply. Minor, same direction.

### Degenerate criterion pass (VERIFIED)
- Criterion 6 `top5 < 0.5` (`:38`) passes because the aligned total is −$15, making top5 = −12820% (run output, and `:19`). A negative-denominator "share" must not be allowed to satisfy a concentration guard — it means the opposite of what criterion 6 is for.

### Process gap (VERIFIED)
- The script header claims "Independent Gemini build: scratch/gemini_poc_join_bad_day_vwap.mjs" (`:3`), but **that file does not exist** in the repo (`ls` confirms). Neither VWAP test had the independent build the value-edge and density rules had. This is exactly the class of bug the fill convention (CLAUDE.md:130) warns about: single-build + shared spec can't catch a shared assumption.

## 3. How else VWAP could be used — verdict: AGREE with the framing ("VWAP is a regime/location check, not a signal"), with 3 concrete proposals + 1 constraint

AGREE that VWAP should be a **check of regime/location**, not a directional signal, and that **FLAT VWAP = balance** is a different regime. The failed tests were all *direction-alignment* gates; the untested, user-aligned idea is *location within a balanced regime*. Data confirmed available: 1-min bars (`price_bars_primary`), `level_prices` RTH/weekly/monthly VWAP (`scripts/compute_levels.js:11,364-403`), `computeProfile`/`computeRunningVwapSeries` (`developingValueService.js:27-57,79-89`), `rotation_events` (`server/schema.sql:8301`).

### Proposal 1 (most promising): FLAT-VWAP regime × outer-band location
- **Definition (point-in-time):** FLAT = the existing 60-min `|slope|` of the running session VWAP ≤ the rolling p33 cut (reuse `flatCut`, `study_poc_join_vwap_slope_gate_20261020.mjs:11`). Location = `dist = entry_open − runningVwap[t]`, normalized by a rolling σ of (typical price − running VWAP) over the trailing 390 session bars (or the `session_analysis` 30-session `(close−RTH_VWAP)` std already used in `acd.js:3532`). OUTER = `|dist| ≥ 1.5σ`. Population = POC joins with a defined class; outcome = realistic-fill E1; report RTH and Globex **separately** (mandatory, see constraint below).
- **Placebo:** shifted σ-band (dist recomputed vs VWAP±k·σ) and random-direction flip.
- **What changes a live decision:** if OUTER∧FLAT joins beat INNER∧FLAT joins with a day-blocked CI excluding zero, top-5 share <50% **with a positive denominator guard**, and the sign agrees in RTH and Globex → a SHADOW tag for "only take joins at the far edge of a balanced day".
- **Why it differs from what failed:** it is a *location × regime* condition (fade the outer edge of balance), not a *direction-alignment* condition. The failed gate asked "does the VWAP direction tell you which side"; this asks "does being far from a *flat* VWAP identify the fade-the-edge joins", which is the user's "b/D-shaped profile" intuition in VWAP terms.

### Proposal 2: Trend-day vs balance-day from IB expansion + developing profile shape (b/D/P), point-in-time — *not* VWAP slope
- **Definition (point-in-time):** (a) IB-range expansion = (high−low over first 60 RTH minutes)/ATR20; BALANCE if ≤ p33 of prior 20 days' expansion. (b) Profile shape from `computeProfile(session bars up to trigger bar)`: b-shaped = POC percentile within profile range < 0.33 (long upper tail); P-shaped = > 0.67; D-shaped = a second node with ≥0.6× max volume separated by ≥1 ATR from the POC; else balanced. Population/outcome/placebo as Proposal 1 (shuffle shape labels within month×session; random-direction flip).
- **What changes a live decision:** if join direction conditioned on shape (fade tails in b/D, join the node in P) beats a shuffled-shape placebo with RTH and Globex agreeing → SHADOW tag.
- **Why it differs:** this is a *structural* balance/trend classifier (volume-profile shape + range expansion), orthogonal to any VWAP slope. It directly operationalizes the user's "b"/"D"/"P" idea instead of proxying it with a price-average slope.

### Proposal 3 (one-shot, cheap): anchor check to close the slope thread for good
- **Definition:** re-run the *exact* slope gate from §1 but with the running VWAP anchored at the **RTH open** (09:30) instead of 18:00, as a single pre-registered sensitivity (do not sweep anchors/horizons and report the best). Optionally also compare the static `level_prices.RTH_VWAP/WEEKLY_VWAP/MONTHLY_VWAP` as point-in-time references.
- **What changes a live decision:** if the null persists under the RTH-open anchor, "VWAP slope as a direction check" is dead and should never be revisited; if it flips, the §1 null was an artifact of the 18:00 anchor and the whole thread is re-opened. Either way it answers the audit's open question rather than leaving it ambiguous.

### Constraint (fold into 1 and 2, not standalone): RTH/Globex must be a pass criterion, not a split to cherry-pick
- CLAUDE.md:59 documents that against-the-trade directional-pressure signals validated in RTH **reverse** in Globex for this roster. The §1 run already shows the reversal signature (aligned−all RTH +4.5 vs GLOBEX −5.2, run output). Any VWAP position/location signal must be pre-registered to require sign agreement in **both** sessions, exactly as the slope-gate prereg already required (`docs/POC_JOIN_VWAP_SLOPE_GATE_PREREG_20261020.md:21`).

### I would NOT bother with
- **More VWAP slope on other anchors/horizons as a direction-alignment gate** (weekly/24h/30/120-min sweeps): this is a p-hacking minefield; the price-side check was already flat and the direction alignment already failed. Only the single RTH-open anchor check (Proposal 3) is worth one shot.
- **VWAP cross/reclaim as a POC-join idea:** already exists as separate setups — `VWAP_RECLAIM_HOLD` (trend-continuation away from VWAP, `acd.js:3649`) plus `RTH_VWAP_FADE`/`GLOBEX_VWAP_FADE`/`WEEKLY_VWAP_FADE`/`MONTHLY_VWAP_FADE` (`acd.js:4291-4398`). Redundant.
- **VWAP as an exit/target reference:** this is profit-lock/trailing-exit research, which is on the user's stop-list.
- **Unconditional "does price react at VWAP" averages:** on the stop-list, and the price-side exploratory already confirmed null.

## 4. Ranked next steps

1. **Pre-register and run Proposal 1 (FLAT × outer-band location).** It is the only remaining VWAP hypothesis that (a) matches the user's actual belief (balance → fade the outer edges), (b) is orthogonal to the failed direction-alignment, and (c) has a concrete point-in-time definition. Require RTH/Globex agreement and an independent second build.
2. **Run Proposal 3 (one-shot RTH-open anchor check) to permanently close the "VWAP slope as direction check" thread.** Cheap, pre-registered, no sweep. This converts the §1 "PARTLY" into a final "the anchor wasn't it either" or "the anchor was it".
3. **Fix the shared methodological defects before any further VWAP work:** (a) the degenerate top-5-share criterion (denominator ≤0 must FAIL, not PASS — currently it silently blesses lottery-shaped subsets); (b) the bad-day STATE lookahead (`exitK < ei` or mark hold-to-end at `O[last]`); (c) require an independent build for any VWAP test and make the missing `gemini_poc_join_bad_day_vwap.mjs` either exist or stop being cited.

### What to stop
- **All VWAP-slope direction-alignment variants** (any anchor, any horizon) — after Proposal 3, permanently.
- **Bad-day loss-conditioning** — underpowered, wrong-direction point estimate, state lookahead, and a "does a bad run predict anything" question that is a regression-to-the-mean trap in a lottery P&L.
- **VWAP-as-target / profit-lock / trailing exit** — reaffirm the existing stop-list item.
- **Trusting POC join's recorded `real_ev`** — reaffirm (CLAUDE.md:130 and OPEN_THREADS.md:585 document the flattered `real_ev`).



