# DeepSeek design/method critique — order-flow research packet 2026-10-20

Convention: **[V]** = verified vs file/line; **[I]** = inference. I take the packet's run outputs as given (cannot re-run) but flag what I find implausible *as interpreted*. Read: packet, claims (59 rows), 4 pre-regs, 4 scripts; deepseek_* reviews read by name only (not repeated).

## 0. One-line diagnosis
The packet admits it [V: packet L34]: order-flow was tested **unconditionally** and as **flags**, never as the conjunctive, level-anchored, regime-aware composite the trader reads. Every "null" is therefore "not shown," not "false." The highest-value fix is to capture *what the human sees* before more single-cue event studies.

---

## 1. MISSING (ranked)

1. **Location relative to the faded level.** [V: packet L6, L34] Big orders tested "any time," never *where* the order sits vs the PD/PW/OR/IB/VWAP/profile level. A stuffed sell 2 pts above VWAP != 30 pts below in freefall. *Data:* ticks + level tables. *Test:* restrict events to within +-k ATR20 of the touched level (k=1 primary); pass = roster-flag delta or forward return beats placebo on hold-out. *Rule:* level-adjacency tile on the gate.

2. **Depth / resting liquidity / absorption (iceberg).** [V: packet L9 "depth files exist … not used"] "Absorbed by resting limits vs run over" is invisible from prints alone — needs the book (bid/ask size per level, imbalance, iceberg decay). *Data:* `.depth` files (need a reader). *Test:* does aggressive size absorbed by resting depth at a level predict forward move better than the print-only stuffed label? Pass = CI excludes zero, both halves. *Rule:* depth-absorption gate/tile.

3. **Tape speed / pace / order-count vs size.** [V: pre-reg BUBBLE L3, packet L14 "flood of small orders … run over"] Tests use net size and underwater volume^2; none use *arrival rate*, *acceleration*, or *small-order flood ratio*. The user's "pace and aggressiveness" is a rate. *Data:* ticks. *Test:* pace = prints in last N min vs same-clock 60-session baseline (N=5); pass = predicts stuffed failure / step-aside. *Rule:* "tape too hot to fade" size-down.

4. **Regime / day-type conditioning.** [V: packet L8 "+8.9 middle / -6.0 expansion"] The 3 big-order families were NOT split by regime; bubble result strongest after big falls (-0.25) [V: claims L98] hints the signal lives only in expansion days. *Data:* ATR20/range. *Test:* re-run conditioned on expansion-day tercile; pass = effect in expansion, absent in middle. *Rule:* regime gate that only lets flow veto on expansion days.

5. **Timing as a distribution, not fixed horizon.** [V: claims L2 "median 17 min … upper quartile 40-71 min"; L94] Counterpunch exists but at variable lag; fixed 5/15/30-min outcomes dilute it. *Data:* ticks. *Test:* CDF of time-to-counterpunch conditioned on the feature; pass = hazard differs from unconditional same-clock distribution. *Rule:* entry-timing tile (delay fade to hazard peak).

6. **Cross-market lead-lag (ES/YM/RTY/ZN/VIX).** [V: packet L35 "NQ only"] NQ is often a follower; a real lead (ES stalls while NQ big sellers print) is invisible. *Data:* ES/ZN ticks/bars (not ingested). *Test:* NQ big-order direction conditioned on ES/ZN lead-lag predicts forward NQ move; pass = CI excludes zero, hold-out. *Rule:* cross-market confluence tile.

7. **Session phase + scheduled events + options-expiration/gamma.** [V: packet L35 "no options/news/session-auction context"] Clock-bucket != auction phase, event days, or gamma pinning. *Data:* calendar + opex + phase labels. *Test:* do features interact with phase/opex? Pass = interaction CI excludes zero. *Rule:* phase/event-day gate.

8. **Human memory selection effects.** [V: packet L11-15, claims L14] Memorable cases (297 sell, 10-15 burst) are memorable *because* at an inflection; hundreds of unremarkable big orders are forgotten. No test mimics the human *selection*. *Data:* the user's own labelled moments (§3.3). *Test:* are the user's rated "strong" moments informative? Pass = labels carry info beyond unconditional features. *Rule:* convert the read to a labelled feature set.

9. **Fixed OPTIMAL_STOP hides "right read, wrong exit."** [V: packet L7] A "drift-then-recover" read still books a loss under fixed stops; dollar test can't separate wrong read from bad stop width. *Data:* replay + variable-stop sim (cf. claims L250). *Test:* does the edge appear with flow-adaptive stops? Pass = CI excludes zero. *Rule:* stop/size-adaptation rule, not a gate.

10. **Loss-cluster / drawdown regime as target.** [V: packet L15 "+864 -> -1,100 giveback"] Damage is correlated (a class of fades bleeding into an expansion day), yet every test scores per-trade pnl. *Data:* replay pnl series. *Test:* can flow predict the next hour's roster drawdown? Pass = CI excludes zero, hold-out. *Rule:* session-level size-down/stand-aside. (= §3.1.)

---

## 2. FLAWS in the tests as run

**False-negative (HIDE a real effect):**
- **F1. 60 s / 5-min labels too short, non-selective.** [V: pre-reg STUFFED L14/L36, claims L9-10] Examples reclaim by 41/110/9/41 pts; deep sweeps take 17-71 min [V: claims L2]; 95% of orders "reclaim" under def B (near-tautology). Label = micro-noise.
- **F2. Fixed 5/15/30-min outcomes.** [I] Same root as §1.5: variable lag diluted at any single horizon.
- **F3. Fixed OPTIMAL_STOP exits.** [V: packet L7] Confounds read-vs-exit (§1.9). [I] The 10-20 giveback was stops hit in a flat tape — exactly where a flow read says "don't cut yet."
- **F4. Busy-market control.** [V: claims L10 "opposite-side flag … 55-60% … busy-market proxy"] "Flag" ~= "active market" (volatility-confounded); clock+size matching leaves location/regime confounded.
- **F5. De-clustering removes the structure of interest.** [V: pre-reg BURST L23] A burst *is* a cluster; de-clustering to the first minute changes the estimand, hiding a "cluster -> regime shift."
- **F6. Population/session selection.** [V: claims L9 "127 non-tick, 66 no volume match"] Skipped mid-2024 / Jul-Aug 2025 sessions plausibly the more volatile days [I], biasing the sample calmer.

**False-positive (create a FAKE effect):**
- **F7. Bubble P2b "pass" is entangled with "big fall."** [V: claims L98] Corr +0.47 with fall size; partial Spearman survives at -0.105, but [I] "trapped buyers above price" is *definitionally* downstream of "price fell a lot into a level" — the roster's existing edge. Passes only at W30 (W10 = -0.02) [V: claims L98] — a single-window cell.
- **F8. Multiple testing across 3 families + sensitivities + POC_JOIN/counterpunch/flow streams.** [V: packet L36-37] Bonferroni/97.5% local, not family-wise; enough cells => one passes (F7). Hold-out/sensitivity rules mitigate, not eliminate, garden-of-forking-paths in *definitions*.
- **F9. Pre-reg authored by the same assistant that executes.** [V: packet L37] No independent author; cannot guard against specification search baked into definitions (rank cuts, window, 70-contract floor). Credibility limit, not demonstrated bias.
- **F10. 1 ms merge + price-scaling sniff + layout reconciliation.** [V: extract_stuffed L54 "<=1000 us", L22 median-sniff] "Big order" is really a same-side print cluster; >1 ms gap fragments one order. 1/100 scaling = median over first 300 ticks; mis-detection corrupts ATR labels. Sizes validated [V: packet L9], prices less so.

---

## 3. REFRAME

No. Three reframes:
1. **Predict loss-clusters/regime, not per-trade sign.** The giveback is correlated; the POC gate is day-type dependent. Ask "does flow predict the next hour's roster drawdown / an expansion regime?" -> session-level size-down/stand-aside — what "our buying needs to step aside" actually means.
2. **Trade-management / exit, not entry.** F2 (blanket extension loses; 13% of T1 winners beat banking) [V: claims L90-91] shows money is not in a blanket hold — but a *conditional* hold/cut on flow-and-absorption **at a level** is untested. Reframe to "does flow predict *whether to hold past T1 / cut early*."
3. **Human-in-the-loop labelling study.** User blind-labels "stuffed/sweep/absorption moment at a level" on replay; test whether *his labels* carry information the unconditional features don't. Decomposes the read into pre-registerable components and answers "why does the chart read work while stats find nothing."

**FIRST: #3 (human labelling).** Cheapest, highest-information (replay exists, user offered), forces the "multi-cue at a level" conjunction into measurable form, and reframes 1-2 + missing-data fixes (§1.1-1.2) all need to know *what the human sees* first. Then build the depth reader + location-conditioned absorption test on what his labels pick out.

---

## 4. Dead vs merely untested

**Currently UNTESTED** — no test has (a) used depth, (b) conditioned on location vs the level, (c) conditioned on regime, (d) used the human's labels, or (e) modelled timing as a distribution. "Not shown" != "false" until (a)-(e) run.

**DEAD if**, after (a)-(e): a pre-registered human-label study on >= a few hundred replay moments finds the user's "strong" moments indistinguishable from placebo, AND the depth-conditioned absorption test's primary CI includes zero in both halves, AND the loss-cluster reframe shows no excess drawdown predictability. The idea dies only when the *conjunctive, level-anchored, regime-aware, depth-informed* claim is tested and found null — not yet done.

Implausible *as interpreted* (not arithmetic): (i) bubble P2b "pass" reads as "big fall into a level," not absorption [V: claims L98 corr +0.47]; (ii) counterpunch "100% rebound >=1 ATR20 in 3 days" is partly mechanical for a hindsight low (claim concedes) [V: claims L94]; (iii) the 297-contract 23-pt flush [V: packet L14] dominates human memory precisely because rare — the §1.8 survival-bias case.
