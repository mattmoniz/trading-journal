# Pre-Registered Evaluation of POC_ROTATION_JOIN Value-Edge Launch Rule
**Date:** 2026-10-20  
**Specification:** `docs/POC_JOIN_VALUE_EDGE_RULE_PREREG_20261020.md`  
**Execution Script:** `scratch/gemini_poc_join_value_edge_rule.mjs`  
**Raw Results:** `scratch/gemini_poc_join_value_edge_rule_results.json`  
**Status:** Independent Build & Run Complete — **OVERALL VERDICT: FAIL**

---

## 1. Executive Summary

This study independently evaluates the pre-registered "value-edge launch" rule for `POC_ROTATION_JOIN` signals against the live-exit realistic-fill E1 model (100pt initial stop, breakeven stop armed at forward bar 60, exit on next signal or 24 hours, realistic execution fills at `min/max(stop, open)`).

The rule hypothesizes that join rotations launched from the prior day's value edge (`|anchor - PD_VAL| <= 0.15 * ATR20` for longs, `|anchor - PD_VAH| <= 0.15 * ATR20` for shorts) isolate higher-quality trades.

Across 3,889 eligible events (2023-03-06 through 2026-10-16, NQ roll weeks excluded), the rule fails 5 of the 6 pre-registered pass criteria:
1. **Delta vs Unselected Baseline is Negative Overall and in PRE Era:** Passing events underperform the unselected baseline overall (-$0.91/trade) and severely underperform in the PRE era (-$4.44/trade). The overall 95% day-blocked bootstrap confidence interval `[-$10.12, +$8.83]` heavily spans zero.
2. **Value-Edge Location Shows No Edge Over Arbitrary Shifts (Placebo 2):** Shifted levels (-0.6, -0.3, +0.3, +0.6 x ATR20) produced a higher mean P&L ($7.02) than the true value edge ($5.78), yielding a negative difference of -$1.24 with a 95% CI of `[-$13.85, +$12.37]`.
3. **Severe Lottery Tail Concentration:** Net profits are driven entirely by an extreme tail: the top 5 trades generated $6,225.50, representing **115.96%** of the total net P&L of the entire passing set ($5,368.50).
4. **Win Rate on Large Gainers Degraded:** The probability of a >= +$100 win drops from 12.50% in the general population down to 10.23% in the passing set.

**Final Verdict:** **FAIL**. POC join winners are **not identifiable pre-entry** using the prior day's value-edge proximity rule. Per pre-registration guidelines, the strategy must be treated as a lottery for sizing purposes.

---

## 2. Methodology & Construction

The test was built strictly to the pre-registration specification (`docs/POC_JOIN_VALUE_EDGE_RULE_PREREG_20261020.md`):
- **Universe & Dates:** All trading days from `developing_value_log` between `2023-03-06` and `2026-10-16` (889 candidate sessions after excluding NQ roll weeks via `isInsideNqRollWeek`).
- **Signal Generation:** Canonical `detectSignalEvents(65, 'standard', theta, [{ t: d, bars }], 'fixed')` with point-in-time `THETA` (180-day rolling median of intraday bar range).
- **Session Bar Filtering:** Sessions spanning previous day 18:00:00 to date `d` 16:59:59 ET with `>= 100` bars and `>= 90%` minute density.
- **Entry & Forward Window:** Entry at the open of the bar immediately following the trigger bar (`ev.trigger_idx + 1`). Forward window extends strictly after the entry bar to the next signal entry or 24 hours (whichever is earlier). Trades with `< 2` forward bars were dropped (2 trades).
- **Realistic E1 Exit Simulation:**
  - Initial 100 pt catastrophic stop.
  - Breakeven stop moved to entry price starting at forward bar `k = 60` (armed before bar evaluation).
  - Realistic stop fills at `min(stop, open)` for longs and `max(stop, open)` for shorts if bar gaps or opens through stop.
  - Contract sizing: $2/point, $2 round-trip commission.
- **Era Assignment:** Assigned strictly by the event's trade date `d`:
  - `PRE`: `d < '2025-06-01'`
  - `POST`: `d >= '2025-06-01'`
- **Rule Definition (Primary Bandwidth = 0.15 x ATR20):**
  - `ATR20(d)`: Mean RTH (09:30–15:59 ET) high-low range over the 20 RTH sessions strictly preceding trade date `d`.
  - `PD_VAL` and `PD_VAH`: Taken from `level_prices` for trade date `d`.
  - Leg Anchor Price: Low of the bar at `ev.leg_start` for an `UP` leg (Long); High of the bar at `ev.leg_start` for a `DOWN` leg (Short).
  - Passing condition: `|anchor - PD_VAL| <= 0.15 * ATR20` for Longs; `|anchor - PD_VAH| <= 0.15 * ATR20` for Shorts.
  - Events missing ATR20 (sessions prior to 2023-03-31) or level prices (holiday/half sessions) were excluded from the rule test (83 events out of 3,972 total valid events, leaving N = 3,889).

---

## 3. Primary Comparison

Bootstraps use 2,000 day-blocked resamples (reproducible PRNG seed 42) computing pooled per-trade means (`sum / N`):

| Cohort | Sub-Period | N | Mean P&L ($) | Win Rate (%) | Delta vs ALL ($) | 95% Day-Blocked Bootstrap CI ($) |
|---|---|---|---|---|---|---|
| **ALL Events** | Overall | 3,889 | $6.69 | 36.31% | — | — |
| **ALL Events** | PRE (< 2025-06-01) | 2,081 | $0.60 | 35.13% | — | — |
| **ALL Events** | POST (>= 2025-06-01) | 1,808 | $13.70 | 37.67% | — | — |
| **PASSING (0.15 ATR)** | Overall | 929 | $5.78 | 36.17% | **-$0.91** | `[-$10.12, +$8.83]` |
| **PASSING (0.15 ATR)** | PRE (< 2025-06-01) | 486 | -$3.83 | 34.16% | **-$4.44** | `[-$14.62, +$5.49]` |
| **PASSING (0.15 ATR)** | POST (>= 2025-06-01) | 443 | $16.33 | 38.37% | **+$2.62** | `[-$13.26, +$19.73]` |

*(Note: If evaluating across all 3,972 valid trades including the 83 with missing levels/ATR, ALL Overall Mean is $6.76, PRE is $0.40, POST is $14.24; Delta is -$0.98 overall, -$4.23 in PRE, and +$2.08 in POST. Conclusions are identical.)*

---

## 4. Tail Metrics

1. **Probability of Large Gainers (`P(PnL >= +$100)`):**
   - **ALL Events:** 12.50% (486 / 3,889)
   - **PASSING Events:** 10.23% (95 / 929)
   - *Result:* Passing the value-edge rule actually **reduces** the frequency of +$100 winners by 2.27 percentage points.
2. **P&L Captured as Share of Total:**
   - Total P&L of ALL events: **$26,028.50**
   - Total P&L of PASSING events: **$5,368.50**
   - Share captured: **20.63%** (while passing events constitute 23.89% of trades).
3. **Top-5 Event Concentration:**
   - Top-5 passing trades: `[+$1,869.50, +$1,144.50, +$1,099.00, +$1,056.50, +$1,056.00]`
   - Sum of Top-5 trades: **$6,225.50**
   - Total net P&L of the entire 929-trade passing set: **$5,368.50**
   - Top-5 share: **115.96%** (exceeds 100% because the remaining 924 trades have an aggregate net loss of -$857.00).

---

## 5. Placebo 1: Direction Inversion (Random Direction)

Evaluated under two formulations:
1. **Re-Simulated E1 (Opposite Entry Direction):** Simulated with inverted trade direction (Short instead of Long, Long instead of Short) with its own E1 rules (100pt stop on opposite side, BE arming at forward bar 60).
2. **Exact-Fill Inverted P&L:** Inverting realized trade points on the identical exit fill (`-pts * 2 - 2`).

| Direction Mode | Period | Passing Mean P&L ($) | Placebo 1 Mean P&L ($) | Beats Placebo? |
|---|---|---|---|---|
| **Re-Simulated E1** | Overall | +$5.78 | -$5.61 | **YES** |
| **Re-Simulated E1** | PRE | -$3.83 | -$1.42 | **NO** (Placebo lost less) |
| **Re-Simulated E1** | POST | +$16.33 | -$10.22 | **YES** |
| **Exact-Fill Inversion** | Overall | +$5.78 | -$9.78 | **YES** |
| **Exact-Fill Inversion** | PRE | -$3.83 | -$0.17 | **NO** (Placebo lost less) |
| **Exact-Fill Inversion** | POST | +$16.33 | -$20.33 | **YES** |

*Result:* In the PRE era, the true passing trades performed **worse** than the flipped placebo trades under both models.

---

## 6. Placebo 2: Shifted Levels

The rule was evaluated with `PD_VAL` / `PD_VAH` shifted by `[-0.6, -0.3, +0.3, +0.6] * ATR20` at the same 0.15 bandwidth:
- Shift `-0.6 x ATR20`: N = 181
- Shift `-0.3 x ATR20`: N = 473
- Shift `+0.3 x ATR20`: N = 936
- Shift `+0.6 x ATR20`: N = 520
- **Pooled Shifted Population:** N = 2,110
- **Mean P&L of Shifted Controls:** **+$7.02**
- **Real Passing Mean:** **+$5.78**
- **Real Minus Shifted Difference:** **-$1.24**
- **Day-Blocked 95% Bootstrap CI of Difference:** `[-$13.85, +$12.37]`

*Result:* Shifted synthetic levels performed $1.24/trade better than the actual prior-day value edge. The confidence interval heavily overlaps zero, proving that proximity to the prior day value area edge possesses no specific structural edge over arbitrary price bands.

---

## 7. Sensitivity Analysis (0.10 and 0.25 x ATR20)

*Reported strictly for sensitivity checking; not used for selection.*

| Bandwidth Factor | N | Overall Mean ($) | PRE Mean ($) | POST Mean ($) |
|---|---|---|---|---|
| **0.10 x ATR20** | 619 | -$0.78 | -$5.91 | +$5.08 |
| **0.15 x ATR20 (Primary)** | 929 | +$5.78 | -$3.83 | +$16.33 |
| **0.25 x ATR20** | 1,507 | +$3.88 | -$4.50 | +$13.42 |

*Observation:* Narrowing the proximity to 0.10 x ATR20 turns the overall mean negative (-$0.78), while widening to 0.25 x ATR20 yields +$3.88. In all three bandwidths, the PRE era is consistently negative (-$4.50 to -$5.91).

---

## 8. Evaluation of the 6 Pre-Registered Pass Criteria

| # | Pre-Registered Criterion | Required Threshold | Observed Value | Verdict |
|---|---|---|---|---|
| **1** | Sample Size in Each Era | N >= 60 in PRE and POST | PRE: **486**, POST: **443** | **PASS** |
| **2** | Delta vs ALL in Both Eras & Overall CI | Delta > 0 in PRE & POST; Overall 95% CI > 0 | PRE: **-$4.44**, POST: **+$2.62**; CI: `[-$10.12, +$8.83]` | **FAIL** |
| **3** | Shifted Level Control (Placebo 2) | Real - Shifted CI excludes zero | Diff: **-$1.24**; CI: `[-$13.85, +$12.37]` | **FAIL** |
| **4** | Direction Placebo (Placebo 1) | Mean > Placebo 1 Overall, PRE, and POST | Overall: Win; PRE: **Loss (-$3.83 vs -$1.42)**; POST: Win | **FAIL** |
| **5** | Profit Tail Concentration | Top 5 trades < 50% of passing P&L | Top 5 Share: **115.96%** | **FAIL** |
| **6** | Win Rate on Large Winners | P(PnL >= +$100) PASS > ALL | PASS: **10.23%** vs ALL: **12.50%** | **FAIL** |

---

## 9. Conclusion

The pre-registered value-edge launch rule fails on 5 out of 6 mandatory criteria:
- It fails to generate positive excess return over the unselected baseline in the PRE era.
- Its overall performance delta is statistically indistinguishable from zero.
- It is beaten by arbitrary shifted-level placebos.
- It exhibits severe lottery-ticket concentration where 5 outliers exceed 100% of all net earnings.
- It dilutes rather than concentrates the probability of catching large runners.

**Overall Verdict:** **FAIL**. POC join winners are **not identifiable pre-entry** with this rule. POC rotation join strategies should be modeled as an unselected lottery distribution for sizing and risk management.
