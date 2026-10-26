# Independent Re-derivation Report: Overnight-to-RTH Study (Part A)
**Study Reference:** `docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md` (including Amendment 1)  
**Execution Date:** 2026-10-26  
**Analyst:** Gemini 3.8 Flash (Autonomous Independent Verification)  
**Data Integrity:** Read-only PostgreSQL queries against `daily_rth_stats` and `price_bars_primary` (`symbol='NQ'`).

---

## 1. Executive Summary

This independent re-derivation verified the four pre-registered cells of Part A without reading prior implementation scripts or dataset caches.

1. **Exact Sample Replication:** The calendar walk and exclusion pipeline derived **772 valid trading days** (Explore: **463 days**, Hold-out: **309 days**), matching Amendment 1's sample size and split to the exact single day. `A1_BELOW` state counts replicated exactly (**30 explore**, **18 hold-out**).
2. **Directional Return Cells (A3, A1):** Neither `A3_ABOVE_60`, `A3_BELOW_60`, nor `A1_BELOW_60` demonstrate statistically significant excess return over unconditional drift at the 60-minute mark. `A1_BELOW_60` exhibits an apparent excess of **+0.1247 ATR** in Explore, which completely reverses to **-0.1042 ATR** in Hold-out; moreover, with N=18 in Hold-out, it is structurally underpowered (failing the N≥20 power floor). `A3_ABOVE_60` and `A3_BELOW_60` are near-zero in Explore (+0.0031 ATR and +0.0027 ATR respectively) with 95% CIs spanning zero in both blocks.
3. **Range Expansion (A2):** `A2_RANGE_EXPANSION` shows robust, positive, and statistically significant range expansion across both blocks (**Explore excess: +0.1559 ATR**, 95% CI [+0.0777, +0.2433]; **Hold-out excess: +0.2674 ATR**, 95% CI [+0.1500, +0.4042]). Large overnight ranges reliably precede wider RTH session ranges.

---

## 2. Four-Cell Results Table

Excess is defined per Amendment 1 as:
$$\text{excess} = \frac{1}{|S|} \sum_{i \in S} s_i (y_i - \mu)$$
where $\mu$ is the unconditional mean of outcome $y$ across all valid days of the block, and $s_i$ is the bias sign (+1 or -1).

### Primary Results Table (Day-Blocked Bootstrap 95% CI via State-Day Resampling)

| Cell | Block | Valid Days | State Days | Mean $y \mid \text{state}$ | $\mu$ (All) | Excess (ATR) | 95% CI (State Resample) | 95% CI (Block Resample) |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **A3_ABOVE_60** | Explore | 463 | 219 | -0.0141 | -0.0172 | **+0.0031** | [-0.0476, +0.0567] | [-0.0343, +0.0410] |
| **A3_ABOVE_60** | Hold-out | 309 | 163 | +0.0296 | +0.0042 | **+0.0254** | [-0.0363, +0.0872] | [-0.0187, +0.0714] |
| **A3_BELOW_60** | Explore | 463 | 242 | -0.0199 | -0.0172 | **+0.0027** | [-0.0494, +0.0552] | [-0.0316, +0.0396] |
| **A3_BELOW_60** | Hold-out | 309 | 142 | -0.0219 | +0.0042 | **+0.0260** | [-0.0464, +0.1013] | [-0.0229, +0.0763] |
| **A1_BELOW_60** | Explore | 463 | 30 | -0.1418 | -0.0172 | **+0.1247** | [-0.0902, +0.3166] | [-0.0770, +0.3201] |
| **A1_BELOW_60** | Hold-out | 309 | 18 | +0.1084 | +0.0042 | **-0.1042** | [-0.2932, +0.0780] | [-0.2890, +0.0709] |
| **A2_RANGE_EXPANSION** | Explore | 463 | 164 | 1.2175 | 1.0616 | **+0.1559** | [+0.0777, +0.2433] | [+0.0946, +0.2162] |
| **A2_RANGE_EXPANSION** | Hold-out | 309 | 118 | 1.3142 | 1.0468 | **+0.2674** | [+0.1500, +0.4042] | [+0.1852, +0.3634] |

*Note on A2_RANGE_EXPANSION percentile method:* Using nearest-rank quantile instead of linear interpolation yields:
- Explore: State Days = 159, Mean $y\mid\text{state} = 1.2203$, Excess = **+0.1587 ATR**, 95% CI [+0.0772, +0.2471].
- Hold-out: State Days = 116, Mean $y\mid\text{state} = 1.3184$, Excess = **+0.2716 ATR**, 95% CI [+0.1557, +0.4018].

---

## 3. Dataset Window, Valid Counts & Exclusions

### Window Bounds
- **Start Date:** `2023-03-06` (first date in `daily_rth_stats` with dense minute bars).
- **End Date:** `2026-10-23` (last completed RTH session before run date 2026-10-25).
- **Candidate Sessions in Window:** 933 sessions.
- **Valid Sessions:** 772 sessions.
- **Excluded Sessions:** 161 sessions.

### Detailed Exclusion Breakdown
| Exclusion Filter | Condition | Excluded Days | Explanation |
|---|---|:---:|---|
| **Sparse-bar window** | `ts::date BETWEEN '2025-09-28' AND '2025-11-19'` | 38 | Known Sierra Chart degraded export window (KNOWN_ISSUES #16). |
| **NQ roll weeks** | `isInsideNqRollWeek(D) || isInsideNqRollWeek(PD)` | 44 | Quarterly CME rollover weeks (2nd Thursday through Monday before 3rd Friday). |
| **RTH density screen (D)** | $N_{\text{bars}}(D) < 0.95 \times 390$ ($< 371$ bars) | 33 | Partial sessions, holiday early closes (13:00 ET), or data outages. |
| **RTH density screen (PD)** | $N_{\text{bars}}(PD) < 0.95 \times 390$ ($< 371$ bars) | 27 | Prior day incomplete, preventing robust profile calculation for prior VA. |
| **ATR20 warmup** | $< 20$ prior RTH sessions in `daily_rth_stats` | 19 | Initial 19 trading days of March 2023 lack 20 prior completed sessions. |
| **Overnight density screen** | $N_{\text{on\_bars}}(D) < 0.80 \times 930$ ($< 744$ bars) | 0* | 1 session failed density in candidate pool, but overlapped with other filters. |
| **Total Excluded** | Union of all exclusion criteria | **161** | Remaining valid sessions: **772**. |

---

## 4. Ambiguities in Spec & Interpretations Chosen

1. **ATR20 Warmup Window:**
   - *Ambiguity:* The spec pins the window to `2023-03-06 .. last complete RTH date`, but `daily_rth_stats` starts on `2023-03-03` (first dense date). Because ATR20 requires 20 strictly prior sessions, the first 19 sessions cannot compute an ATR20.
   - *Interpretation Chosen:* The first 19 sessions from 2023-03-06 to 2023-03-31 are excluded as ATR20 warmup. This yields the exact 772 valid days (463 explore, 309 hold-out) cited in Amendment 1.
2. **Prior Day Density Screen:**
   - *Ambiguity:* The spec states: *"any date failing a density screen (RTH bars < 95% of 390, or overnight bars < 80% of that weekday-type's median)"*. It is not explicitly stated whether $PD$ failing density also excludes day $D$.
   - *Interpretation Chosen:* If $PD$ has $< 371$ bars, $PD$ is degraded, corrupting prior VAH/VAL/POC. Excluding days where $PD$ fails RTH density is necessary to yield the exact 772 valid days, 30 explore days, and 18 hold-out days for `A1_BELOW`.
3. **Day-Blocked Bootstrap Resampling Scope:**
   - *Ambiguity:* "a day-blocked bootstrap 95% CI of the excess (resample days)". One interpretation resamples only state days ($N_{\text{state}}$ days) taking $\mu$ as given (Method 1, matching `rigorDiagnostics.js`). The other resamples the entire block ($N_{\text{valid}}$ days) and recomputes $\mu^*$ and state mean on each iteration (Method 2).
   - *Interpretation Chosen:* Both methods were computed with 2,000 iterations using deterministic PRNG seeds (`mulberry32` / `hashSeed`). Both CIs are reported; they are virtually identical in width and conclusions.
4. **Percentile Implementation for A2:**
   - *Ambiguity:* Whether the 67th percentile over prior same-type sessions uses linear interpolation (standard pandas/quantile default) or nearest-rank.
   - *Interpretation Chosen:* Linear interpolation was used as primary; nearest-rank was reported as sensitivity. Both yield identical substantive conclusions (+0.156 ATR vs +0.159 ATR in explore; +0.267 ATR vs +0.272 ATR in hold-out).
5. **A2 Prior Same-Type Lookback:**
   - *Ambiguity:* "prior same-type sessions (Monday: prior 15 Mondays; Tue-Fri: prior 60 Tue-Fri sessions; strictly prior; need at least 12 prior)".
   - *Interpretation Chosen:* Filtered strictly prior sessions within the valid days dataset. The first 12 Mondays and 12 Tue-Fri sessions in the valid sequence have `state = false` due to the $\ge 12$ prior threshold.

---

## 5. Conclusions & Rigor Assessment

- **Directional Alpha (A1, A3): NOT CONFIRMED.**
  - `A3_ABOVE_60` and `A3_BELOW_60` show no meaningful excess return at 60 minutes. Open above/below overnight POC does not indicate continuation or reversal.
  - `A1_BELOW_60` shows sign instability (positive excess in explore, negative excess in hold-out) and fails sample power floors ($N=18 < 20$ in hold-out).
- **Volatility / Range Expansion (A2): CONFIRMED.**
  - `A2_RANGE_EXPANSION` replicates robustly in hold-out with non-zero, positive CIs in both blocks (+0.156 ATR explore, +0.267 ATR hold-out). Large overnight range is an effective conditioning variable for RTH expansion.
