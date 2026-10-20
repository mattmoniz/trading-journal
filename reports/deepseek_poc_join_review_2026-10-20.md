# Adversarial review — POC-join session 2026-10-19/20 (4 items)

Scope: READ-ONLY. I read code/docs only; I did NOT run the backtests, hit the DB, or execute
the simulators. Anything that is a *number produced by a run* (means, CIs, p-values, live-exit
tallies) is marked INFERRED/UNVERIFIED — I can only confirm the *code would produce* it, not
that it did. Anything I traced through source and can quote a `file:line` is marked VERIFIED.

---

## 1. EXIT REPLAY + FILL ARTIFACT — VERDICT: **AGREE** (with caveats: the fill is slightly *lenient*, and the forward-window couples events)

The headline is correct: the profit-lock advantage was an artifact of "fill at the stop price
even when the stop is already beyond the market", and with a realistic fill nothing beats E1.
But the "realistic" fill is slightly **too lenient**, not too harsh, so E1's "realistic" +6.76
is an *upper bound*, not a faithful live number.

### Verified findings

1. **The realistic-fill rule is standard and reasonable.**
   - Gemini `scratch/gemini_poc_join_exit_review_realistic.mjs:220-224`: `getRealisticStopFill`
     = `min(stop, open[k])` long / `max(stop, open[k])` short.
   - Claude `scripts/study_poc_join_exit_review_20261020.mjs:46`: `fill = REALISTIC ? (long ?
     Math.min(stop, O[i]) : Math.max(stop, O[i])) : stop`.
   - Normal intrabar hit (bar opens on the good side, trades *through* the stop) → `min/max` gives
     the stop price (correct). Gap-through / already-beyond → open (correct direction). This is the
     conventional "gap fills at open" approximation. **Not too harsh.**

2. **"Arm at k>=60 BEFORE checking that bar" is faithful to live, not a review bug.**
   - Live `server/services/pocBreakevenHoldWalker.js:39` does `armed = state.armed ||
     state.barsElapsed >= armAtBars`, then `sp = armed ? entry : …` (40), then hit check (41).
     The comment (36-38) says arm-before-check matches the backtest's `simBEHold`.
   - Both backtests arm before the hit check on the same iteration (Gemini 307 vs 331-352;
     Claude 43 vs 46). The review reproduces what live *already does* — which is arguably itself a
     live defect, but the review is faithful to it.

3. **"best" is previous-bars only — no same-bar lookahead in the lock/trail.**
   - Gemini `runAdaptive` (296-304): `if (k>0) update best from fwdBars[k-1]`, then arm, then
     lock, then hit check on bar k. Stop for bar k uses best over bars 0..k-1.
   - Claude (44-48): lock/trail uses `best`, then hit check, then `best` is updated. Same effect.
   - Matches the spec handed to Gemini (`claude_request_20261020_poc_join_exit_done.md:16`).

4. **Arming-bar identity is consistent across live and both backtests (no off-by-one on *which* bar).**
   - Live forward bars = `ts > fired_at` (`resolveSetups.js:402`); backtests = `ts > entry ts`
     (Gemini `upperBound(ev.entryTs)` 178; Claude `fi = upperBound(T, e.ep)` 55). Entry = entry-bar
     open, so `fwdBars[0]` = the bar *after* entry everywhere; `k=60` = 61st bar after entry, and
     `barsElapsed` reaches 60 on that same bar in all three.

### Disagreements / caveats

5. **The realistic fill is too LENIENT in the underwater-at-arming case (the case that matters).**
   The replay fills at the arming bar's **open**. But live arms only when the walker processes the
   arming bar as a *completed* bar, and the real flatten is a MARKET order sent by `placeExitOrder`
   on a *later* poll (`reconciliation.js:647`), i.e. ~one bar later at whatever price is then
   available. For a trade already underwater, filling one bar earlier at the open is, on average,
   the *most favorable* realistic assumption. So the true live P&L is equal or worse than the
   review's numbers — this strengthens "nothing beats E1", but means "E1 +6.76" is still optimistic
   vs. real fills. The review also uses `open`, never the bar's low/high, so adverse intrabar
   excursion beyond the open is ignored (another leniency in the same direction).

6. **E1 is faithful to the live state machine, and "ideal" mode faithfully reproduces the live
   *booking* bug.** The E1 model matches `stepPocBreakevenHold` exactly. "Ideal" (fill at `stop`)
   models what live *writes* to `actual_pnl` (`priceAtRes = sp`); "realistic" models what the broker
   *realizes*. Neither single mode is a complete model of live (which has two divergent numbers).
   The review's framing (ideal = shipped claim, realistic = correction) is the right way to state it.

7. **Forward-bar window: no bias vs live, but it couples consecutive events.** Bound =
   `min(entry+24h, next event ts)` matches live (`resolveSetups.js:387-398`); "strictly after entry
   bar" matches `ts > fired_at`. No *variant-comparison* bias (same bound for all variants). But
   because the bound is the *next event of either direction*, a trade's holding period (and P&L) is
   truncated by the next signal's fire — outcomes are not independent across the event chain. This
   doesn't distort the paired deltas, but it matters for the CI in item 3.

8. Minor build inconsistency: Claude's era split uses session/trade date `e.d < SPLIT`
   (`study_…:56`), Gemini uses entry calendar date (`entryTs.slice(0,10) < '2025-06-01'`, gemini
   194-195). Evening entries near 2025-06-01 can be classed one day differently. Doesn't move the
   *overall* means ("agree to the cent"), but era-split cells can differ by a few events.

---

## 2. LIVE EXIT SHIPPED ON THE SAME ARTIFACT — VERDICT: **AGREE** (verified directly, code-level)

1. **The original backtest books an underwater-at-minute-60 trade as breakeven.**
   `scratch/poc_rotation_breakeven_hold_20261008.mjs:93-105` (`simulateBreakevenHold`): at
   `k >= armAtMin` it sets `stopPrice = entryPrice`, then `stopHit = bars[k].low <= stopPrice`
   (long). For a long underwater at minute 60, `bars[k].low <= entryPrice` is true, so it returns
   `(stopPrice - entryPrice)*2 - 2 = -2`. **VERIFIED** — market price is never consulted; a trade
   10 or 50 pts underwater exits at 0 pts / -$2.

2. **Live does the same in `actual_pnl`.**
   - `pocBreakevenHoldWalker.js:39-53`: armed → `sp = entry`; hit returns `priceAtRes: sp` (52),
     i.e. the stop/entry price, not the market.
   - `resolveSetups.js:408-412` copies `step.resolution.priceAtRes`; line 426 computes
     `pnl = (priceAtRes - entry)*PNL_PER_POINT - COMMISSION` → an underwater-at-arming trade books
     `-COMMISSION` (≈ -$2). **VERIFIED.**

3. **The real flatten is a market order.**
   - `orderSweep.js:418` (`sweepExits`) selects `status IN ('RESOLVED','EXPIRED')` rows and calls
     `placeExitOrder`; `reconciliation.js:647` sends `orderType:'MARKET', price1:null, price2:null`.
     **VERIFIED** — broker realizes the true (worse) price while the row's `actual_pnl` says -$2.

4. **The shipped "+39.13/trade" is the same artifact.** `pocBreakevenHoldWalker.js:13-18` cites
   `poc_rotation_breakeven_hold_100pt_stop_20261008` (delta +39.13 [16.88, 69.28]). That delta is
   `simBEHold` (books breakeven on underwater-at-60 trades) minus `simFixed` (books the stop
   correctly). The phantom "no loss" inflates the breakeven-hold arm. **VERIFIED** (mechanics in
   code; the +39.13 value itself is run output).

5. **Internal arithmetic checks (not a re-run):**
   - Era means reconcile to overall: `(2146*0.40 + 1826*14.24)/3972 ≈ 6.76` (matches "E1 realistic
     +6.76"). OK.
   - Era Ns (2,146 pre / 1,826 post) match Gemini's report. OK. "Stop is 5x wider": 100/20 = 5. OK.

6. **Unverifiable in a read-only review:** `record_poc_join_review_20261020.mjs:6`'s "14 live
   POC_BEHOLD_BE_STOP exits since 2026-10-11, 8 at the 61-63 min arming bar, some 8-55 pts adverse,
   all booked -2; broker_pnl only for 4 ACTIVE rows, 3 near zero" is a live-DB query result, not
   derivable from any file. Plausible given the walker, but flag as UNVERIFIED, not CONFIRMED.

7. The inference "POC join SETUP_STATUS/real_ev is flattered by the -2 booking" is sound *given*
   the booking bug, but the *magnitude* of the flattery is unverified.

---

## 3. CONTEXT RANKER PILOT — VERDICT: **PARTLY** (no-OOS-signal probably right; but one real (mild) lookahead, and the "planted signal" positive control is NOT in committed code)

### Lookahead audit (mostly clean, one real leak)

1. **Core boundaries causal — VERIFIED.** `scripts/study_poc_join_context_20261020.mjs:33`:
   `trig = a + ev.entry_idx - 1` (trigger bar), `ei = a + ev.entry_idx` (entry bar),
   `entry = O[ei]` (next-bar open). Features iterate `i <= trig` (flow/vwap/session range) or
   `bars.slice(0, ev.entry_idx)` for `detectRotationLegs` (41) = bars 0..trigger, entry excluded.
   `atr20` (22) uses `rthRange(addDay(d,-k))` — prior days only, no current-day range. `leg_start`
   used as anchor; `legExt`/`priorExt` bounded by `trig`. Correct.

2. **REAL LOOKAHEAD: `ONH`/`ONL` for Globex entries.**
   - Level list (24) includes `level_name IN ('ONH','ONL')`; per `setupDefinitions.js:142` /
     `compute_levels.js:7` these are the *overnight session* high/low (18:00 prior ET → 09:29
     current ET) — a same-session level.
   - For a Globex entry at e.g. 19:00 on the prior evening, `ONH/ONL` for `trade_date = d` is only
     fully formed at d 09:29, ~14h *after* entry. Yet `ahead`/`behind` (45) and hence `runwayAtr`,
     `supportAtr`, `levelsCrossed` (3 of 21 features) use these levels.
   - So "every feature computed only from bars up to the trigger bar" is **not literally true** for
     those 3 features on the ~59% Globex/early-morning events. Mild (ONH/ONL only; PD_/PW_/etc. are
     fine; RTH entries unaffected), but a genuine, un-disclosed lookahead.

### Walk-forward leakage audit (clean)

3. **24h purge sufficient.** `pilot_…walkforward_20261020.py:39`: `tr = df[df['ts'] < t0 - 24h]`.
   Label is realized within `min(next event, 24h)` of entry ts, so a train event at `ts < t0-24h`
   has its outcome window end `≤ ts+24h < t0` — no train label touches test bars. **VERIFIED sound.**
4. **Imputation/scaling inside folds correct** (19-20): median imputation from train, `StandardScaler`
   fit on train then transform both. No leakage.
5. **Day-blocked bootstrap sound** (25-31): resamples days w/ replacement, pools events. Minor:
   clusters by CSV `d` (session date), one day off from entry calendar date for evening entries —
   consistent cluster unit, not a bug.
6. **Within-quarter shuffle null is valid for "does ranking carry info"** (44-46: permute scores in
   quarter, re-median-split, top-half mean − all). But it is a *weak* null: it only asks whether the
   ordering beats random **on the top-half-minus-all mean**, which is dominated by the tail.

### What undercuts the conclusion

7. **The positive control is NOT in committed code — "null is meaningful" is unverifiable as shipped.**
   - `record_poc_join_review_20261020.mjs:8` and `OPEN_THREADS.md:586` claim "a planted weak signal
     (0.15 SD) is detected (ridge +17.8, CI [11,24], p<0.001)".
   - `pilot_poc_join_context_walkforward_20261020.py` is 51 lines with **no** planted-signal code. I
     grepped `scripts/`, `scratch/`, `reports/` for `plant`/`positive control`/`0.15`/`17.8`/`inject`/
     `synthetic` — nothing in the context-ranker pipeline. `git show --stat 9e4959b` lists only the 8
     files, none with a positive control. So that sentence is an assertion, not a reproducible result.

8. **Even if it existed, it wouldn't prove power for the effect that matters.** Target is heavy-tailed
   (~20% winners; top 20 events > 100% of total). "Top-half minus all" over N_test≈3,150 averages
   ~1,575 events; a ranker that correctly finds the top *decile* is diluted by the other 40% of the
   "top half", so the metric is structurally insensitive to exactly the tail that carries the P&L.
   A 0.15-SD **linear-in-mean** signal (what ridge-on-pnl detects) is a different, easier target than
   "separate the top-20 lottery tickets." So the no-signal conclusion is probably true (terciles
   non-monotone, 11 folds near zero), but the positive-control logic does not actually defend it.

---

## 4. PATH TO PROFITABILITY — VERDICT: honest read is that **none of the four tested ideas has a real edge yet**, and the highest-value next move is to fix a measurement bug, not to test a 5th idea.

### Stop doing

1. **Stop exit-variant research in the L/T family.** L25/L50/L75/T65/T130 are a dead end — their
   whole edge was the fill artifact (item 1). No more lock/trail tuning on any "fill at stop price"
   simulator.
2. **Stop trusting `actual_pnl`/`real_ev` for POC_ROTATION_JOIN until the booking is fixed.** The
   -$2 booking on underwater-at-arming trades means current `real_ev` is not a real broker number.
   Any keep/revert/scale decision made on it is on flattered data.
3. **Stop mining unconditional touch-level averages.** Roster replay (-$4), value traversal, and
   early-Globex rotation were all unconditional/placebo-negative. Another "does price react at X"
   average is unlikely to be the edge; the only near-miss was structural (pause-and-go), not touch-level.

### Test next (specific, pre-registered, lookahead-free)

**T1 (prerequisite, not an edge hunt): fix the booking and re-measure.**
Change `stepPocBreakevenHold` so an arming-bar hit where the market is already beyond the breakeven
stop books `priceAtRes = bar.open` (market) instead of `entry`. Population: all live POC_ROTATION_JOIN
rows since 2026-10-11. Decision rule: if the market-booked `real_ev` over N≥20 ACTIVE rows is ≤ 0
(or below the old 20pt/60min exit), revert to the old exit or force SHADOW; if positive, keep. This
is the only item with immediate risk consequence (5× wider stop, up to 24h hold).

**T2 (the one real lead): stress the pause-and-go "later pause" lead.**
Pre-register before touching outcomes: within an RTH leg, "pause" = ≥N bars with range inside the
prior bar's range (no new extreme); "pause-break" = first bar making a new extreme in leg direction
after the pause. Population = RTH legs with ≥2 pauses; outcome = 240m continuation in leg direction
(the metric that showed +0.19/+0.27 ATR at N=198/115). Placebo = shift the "pause" label to a random
same-leg bar (equal count). Require (a) day-blocked CI excludes zero, (b) top-5 share < 50%,
(c) survives pre/post 2025-06. Any failure = not promotable.

**T3 (replace the 21-feature ranker with a tail-sensitive, pre-registered discriminator).**
Because POC-join P&L is lottery-shaped, "top-half minus all" is the wrong metric. Use a right-tail
metric: mean pnl of top decile by score, or P(pnl ≥ +100), or total (sum) pnl captured by the
selected subset. Test exactly ONE pre-registered discriminator first (e.g. "join direction agrees
with the prior-day value-area edge AND the leg anchor sits within THETA of a defended prior-period
level") — not 21 more features. Placebo = random-direction join on the same events. Promote to a
SHADOW gate only if it separates the tail in BOTH eras on a tail metric; if it doesn't, conclude
"POC-join winners are not identifiable pre-entry" and size/treat the strategy as a lottery.

---

## Final ranked list — the 3 things most worth doing next

1. **Fix the live booking bug** (`stepPocBreakevenHold` / `resolveSetups.js` POC branch: book the
   market price, not `entry`, on an arming-bar hit where the stop is already beyond the market) and
   re-measure POC-join `real_ev`. Risk item (5× wider stop, 24h hold) hiding behind a flattered
   number; only item with immediate live consequence.
2. **Close the positive-control gap.** Commit a reproducible planted-signal check to
   `pilot_poc_join_context_walkforward_20261020.py` (or drop the "planted signal detected" sentence),
   and switch the evaluation metric from top-half-minus-all to a right-tail metric — the current
   metric cannot see the effect that matters for a lottery-shaped P&L.
3. **Run the pause-and-go later-pause stress test (T2)** with a real placebo + OOS split. The only
   result in the whole 2026-10-19/20 session that still looks like a live lead, and the cheapest to
   confirm/kill before any more feature mining.

---
*Method note: VERIFIED = traced to a specific `file:line` in source. Anything numeric that is a run
output (means, CIs, p-values, live-exit tallies) is INHERENTLY UNVERIFIED in a read-only review and
is labeled as such where it matters.*


