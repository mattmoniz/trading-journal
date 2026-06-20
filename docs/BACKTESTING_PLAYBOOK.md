# Trading Journal — Backtesting Playbook

> Complete reference for backtesting methodology, scripts, results, and edge-finding strategies.  
> Last updated: June 2026. Instrument: NQ (Nasdaq 100 E-mini futures).

---

## 1. Test Methodologies

Six validated test types, listed in order of rigor:

| # | Test Name | Question It Answers | When to Use |
|---|-----------|-------------------|-------------|
| 1 | **Forward-Bar Directional WR** | "Did price go my way within N bars?" vs unconditional baseline | First screen — does an edge exist at all? |
| 2 | **Bracket Resolution Replay** | "Did price hit fixed T1 before fixed stop?" with MFE/MAE | Testing actual trade setups with defined risk |
| 3 | **Confluence Correlation** | "Do setups near level X win more?" — observational | Quick screen for which levels matter |
| 4 | **Controlled Confluence Test** | Same as #3 but isolating the level's contribution within same (setup_type + day_type + NL30) groups | The real test — does the level add INDEPENDENT edge? |
| 5 | **Target Optimization** | For each validated confluence, which fixed-point target maximizes expectancy at a given stop? | Calibrating the actual trade parameters |
| 6 | **Level Fade Backtest** | "Does price bounce off this level?" as a standalone trade with confirmation bars, MFE/MAE, day-type splits | Testing levels as standalone trades |

### Critical Rules

- **Always compare to baseline.** "Price went up 60% of the time" is meaningless if the baseline is 53%. The DELTA is the edge, not the raw number.
- **Control for confounds.** NQ has a long-term uptrend — every bullish signal looks predictive. Split by direction, day type, and NL30 to isolate real edge.
- **Flag n<20.** Any result with fewer than 20 observations is unreliable. Note it, don't act on it.
- **Timezone alignment.** `fired_at` is stored as timestamptz (UTC). `price_bars.ts` is timestamp without time zone in ET. Use `et_min` matching on `trade_date`, NOT `ts > fired_at`.

---

## 2. Backtesting Scripts

### Setup & Outcome Backtests

| Script | Purpose | Key Parameters |
|--------|---------|---------------|
| `scripts/backtest_setups.js` | Replays every setup in active_setups against price_bars | Standard bracket (T1/stop), MFE/MAE |
| `scripts/backtest_edges.js` | Second-breakout decay + time-of-day edge | Proportion z-test, p-value |
| `scripts/backtest_timeofday.js` | Hour-by-hour win rate for all setup types | Hourly buckets, baseline comparison |

### Level & Confluence Backtests

| Script | Purpose | Key Parameters |
|--------|---------|---------------|
| `scripts/full_level_edge_backtest.mjs` | 19 structural levels as fade entries with confirmation | PROX=20pt, 5/10/20-bar horizons, day-type/NL30/volume splits |
| `scripts/combo_backtest.js` | Level confluence (multiple levels within proximity) | PROX_THRESHOLD=20pt, 12 predefined combos |

### Volatility & Regime Backtests

| Script | Purpose | Key Parameters |
|--------|---------|---------------|
| `scripts/volatility_regime_backtest.js` | Setup performance by vol regime | z>=1.0 HIGH, z<=-1.0 LOW, trend_str 0.50 split |
| `scripts/volatility_predictive_backtest.mjs` | Morning vol vs afternoon predictive signal | Vol tiers (33rd/66th pctile), Kaufman ER median |

### Pattern & Temporal Backtests

| Script | Purpose | Key Parameters |
|--------|---------|---------------|
| `scripts/temporal_pattern_backtest.js` | Day-of-week, month, quarter, OPEX effects | 7 temporal dimensions, 20-session trailing median |
| `scripts/coiling_edge_backtest.mjs` | Compression + volume dry-up + pop surge | 15-bar range <40pt, vol <40% baseline, surge 1.8x |
| `scripts/acceptance_engine_backtest.js` | Developing value / acceptance read | POC migration, VA overlap, profile shape checkpoints |

### Other Specialized

| Script | Purpose |
|--------|---------|
| `scripts/daytype_reassessment_backtest.js` | Day-type classifier accuracy |
| `scripts/daytype_reassessment_engine_backtest.js` | Live reassessment engine validation |
| `scripts/auction_backtest.js` | Auction read (overnight inventory) edge |
| `scripts/case_backtest.js` | Case engine conviction score validation |
| `scripts/monday_morning_texture_backtest.js` | Monday-specific texture patterns |
| `scripts/custom_trade_edge_backtest.js` | Custom trade hypothesis testing |
| `scripts/swatted_level_backtest.js` | Level sweep/rejection patterns |

---

## 3. Active Setups — Ranked by Edge

Tested with: Forward-bar directional WR, Bracket resolution replay, Controlled confluence test, OR width controlled test, Day-type splits, NL30 alignment. All 12-month NQ data (2025-06 to 2026-06) unless noted.

### Positive Edge (ACTIVE)

| Rank | Setup | Edge (10-bar Δ) | Frequency | Best Context | Calibrated Target | Resolution |
|------|-------|----------------|-----------|-------------|-------------------|------------|
| 1 | **9 EMA Snap-Back** | +23.5% | 1.0/day (35%) | All regimes | Custom: 50% revert to EMA | EMA_REVERT |
| 2 | **Absorption Long** | +18.4% | 10% of days | BALANCE 73.9%, @PD1-VA 90.9% | 25pt stop / 40pt target | Standard bracket |
| 3 | **OPEN_DRIVE_SHORT** | +18.9% | 0.09/day | @VA 78%, tight OR 91% (+45%) | OR measured move | Standard bracket |
| 4 | **VA_RESP_SHORT** | +17.4% | 0.25/day | TURB 90%, NL30 aligned 93%, tight OR 82% | PD POC (18pt avg stop) | Standard bracket |
| 5 | **Coil Surge → VWAP** | +16.1% | 1.08/day | TREND 65.3%, NL30 aligned 60% | Custom: 50% revert to VWAP | VWAP_REVERT |
| 6 | **OPEN_DRIVE_LONG** | +15.9% | 0.17/day | TREND 83%, tight OR 78% (+14%) | OR measured move | Standard bracket |
| 7 | **BRACKET_BK_LONG** | +4.4% | 0.20/day | @PD1-VA 73%, wide OR 63% (+11%) | VA extension | Standard bracket |
| 8 | **IB_BEARISH** | +1.3% | 0.37/day | TREND 73%, tight OR 63% (+15%) | PD VAL or IB extension | Standard bracket |
| 9 | **TRT_LONG** | +24% @20bar | 0.12/day | TREND 100%, 120min expiry | PD VAH or OR measured move | Standard bracket |
| 10 | **OTD_LONG** | +0.6% | 0.31/day | Marginal edge | Probe low stop | Standard bracket |

### Gated (fire only with PD-2 VA confluence)

| Setup | Baseline Edge | @PD-2 VA Edge | Gate Reason |
|-------|-------------|--------------|-------------|
| C_STANDALONE_DOWN | -12.0% | +32% (81% WR, N=16) | Only profitable at PD-2 VA |
| OTD_SHORT | -5.6% | +23% (73% WR, N=11) | Only profitable at PD-2 VA; tight OR +32% |

### Removed (negative edge at all configurations)

| Setup | Edge | Why Removed |
|-------|------|-------------|
| IB_BULLISH | -7.5% | Negative all contexts, even NL30 aligned only 45% |
| C_STANDALONE_UP | -6.5% | Negative all contexts |
| VA_RESP_LONG | -5.0% | Negative all contexts |
| TRT_SHORT | -10.1% | 100% on tight OR but N=6 — too small to trust |

### Retired (absorbed by better signal)

| Setup | Edge | Replaced By |
|-------|------|-------------|
| RSI Divergence (standalone) | +5.0% bear / +1.7% bull | Absorption Long (71.4% WR vs 54.8%) |

---

## 4. Confluence Levels — Controlled Test Results

Tested with: Controlled confluence test (isolates independent contribution within same setup_type + day_type + NL30 groups). Target optimization with 20pt stop.

### Positive Confluence (levels that independently improve setups)

| Level | Controlled Δ | Optimal Target | Hit Rate | Exp/Contract | Profile |
|-------|-------------|---------------|----------|-------------|---------|
| **PD-2 VAH** | +44.8% | 15pt | 83% | $45 | Scalp |
| **PD-2 VAL** | +20.5% | 75pt | 33% | $55 | Extension |
| **PW Low** | +15.0% | 100pt | 33% | $100 | Extension |
| **PD-3 VAH** | +14.7% | 15pt | 85% | $48 | Scalp |
| **PD-1 VAH** | +9.6% | 30pt | 52% | $31 | Scalp |
| **PD-1 POC** | +9.0% | 20pt | 62% | $25 | Scalp |
| **OR Midpoint** | +6.9% | 20pt | 69% | $38 | Scalp |
| **PW High** | +5.1% | 15pt | 72% | $26 | Scalp |

### Anti-Confluence (levels that HURT setups)

| Level | Controlled Δ | Finding |
|-------|-------------|---------|
| **IB Low** | -28.1% | Worst anti-confluence — avoid setups near IB Low |
| **IB High** | -23.9% | Setups near IB High perform dramatically worse |
| VWAP | -1.3% | Raw edge (+3.9%) was a confound — disappeared after controlling |
| PD High | -1.3% | Raw edge (+8.8%) was a confound — correlated, not causal |

### Confluence Count Effect

| Levels Stacked | N | WR | MFE | MAE |
|---------------|------|------|-----|-----|
| 0 levels | 226 | 48.2% | 37pt | -65pt |
| 2+ levels | 189 | 45.0% | 34pt | -29pt |
| 4+ levels | 114 | 57.9% | 25pt | -25pt |

### Top 2-Level Combinations (controlled)

| Combo | N | Raw WR | Controlled Δ |
|-------|------|--------|-------------|
| PD-2 VAH + PD High | 10 | 90.0% | +41.8% |
| PD-1 POC + PD-2 VAL | 9 | 88.9% | +41.5% |
| PD-2 VAL + VWAP | 20 | 85.0% | +35.0% |
| PD-1 VAH + OR Mid | 36 | 72.2% | +13.7% |
| PD-High + OR Mid | 52 | 63.5% | +13.7% |

---

## 5. Context Filters

### NL30 Alignment (controlled)

| Context | N | 10-bar WR |
|---------|------|----------|
| NL30 aligned | 344 | 56.4% |
| NL30 neutral | 242 | 46.3% |
| NL30 counter | 259 | 40.2% |

**Rule:** Suppress all setups when direction opposes NL30 (counter = 40.2% WR, below baseline).

### OR Width (controlled, +6.3% independent effect for tight)

| Setup | Tight OR WR | Δ vs Rest | Wide OR WR | Δ vs Rest |
|-------|------------|-----------|-----------|-----------|
| OPEN_DRIVE_SHORT | 91% (N=11) | +45% | 33% | -30% |
| TRT_SHORT | 100% (N=6) | +82% | 17% | -30% |
| OTD_SHORT | 69% (N=16) | +32% | 48% | +6% |
| VA_RESP_SHORT | 82% (N=11) | +19% | 61% | -9% |
| BRACKET_BK_LONG | 33% (N=9) | -27% | 63% (N=16) | +11% |

**Rules:**
- Suppress BRACKET_BREAKOUT_LONG and OTD_LONG on tight OR
- Suppress TRT on wide OR

### Day Type

| Day Type | Best Setups | Worst Setups |
|----------|------------|-------------|
| TREND | OPEN_DRIVE_LONG 83%, IB_BEARISH 73%, TRT_LONG 100% | OTD_LONG 56%, VA_RESP 57% |
| BALANCE | Absorption Long 73.9%, VA_RESP_SHORT 65%, C_STANDALONE_DOWN @PD2 81% | Most breakout setups ~50% |
| TURBULENT | VA_RESP_SHORT 90%, IB_BEARISH 62% | IB_BULLISH 22%, OTD_LONG 46% |

---

## 6. Signal-Only Edges (not in active_setups)

### 9 EMA Snap-Back (now in active_setups with custom resolution)
- **Trigger:** 5-min close ≥2.0 ATR(14) from 9 EMA
- **Edge:** 96.2% revert toward EMA within 15 min (N=533), +23.5% vs baseline
- **Resolution:** Custom EMA_REVERT — resolves when price moves >50% back toward CURRENT EMA position
- **Works:** All day types (TREND 93.3%, BALANCE 94.9%, TURBULENT 92.8%)

### Coil Surge → VWAP Fade (now in active_setups with custom resolution)
- **Trigger:** 15-bar range <40pt + volume <40% baseline → volume surge ≥2.5x baseline
- **Edge:** 65.3% WR on TREND days (+16.1%), $24/trade expectancy, R:R 3.08
- **Resolution:** Custom VWAP_REVERT — resolves when price moves >50% toward VWAP
- **Gate:** TREND days or NL30-aligned only. BALANCE = coin flip.
- **Finding:** Pop direction is random. The edge is fading TOWARD VWAP regardless of pop direction.

### Bullish Absorption (now in active_setups with standard bracket)
- **Trigger:** 4+ bars clustering at support (within 5pt), RSI(14) rising >5pt, price flat
- **Edge:** 71.4% WR at 5 bars (+18.4%), BALANCE days 73.9% at 20 bars
- **Calibrated:** 25pt stop / 40pt target = 50% WR, $31/trade; or 25pt/20pt = 72% WR, $32/trade
- **Gate:** BALANCE days only. @PD-1 VA: 90.9% WR (N=11).
- **Finding:** Bearish absorption (at resistance) has NO edge on NQ — uptrend overwhelms.

---

## 7. Edge-Finding Prompt Strategies

### The Process That Works

1. **Start with a hypothesis** — "Does X predict direction?"
2. **Run forward-bar directional WR** — quick screen, does it beat baseline?
3. **Split by confounds** — day type, NL30, OR width. Does the edge survive?
4. **Run controlled confluence test** — isolate independent contribution
5. **Optimize targets** — test fixed-point targets at various stops for maximum expectancy
6. **Test stability** — 12-month vs full history, monthly breakdown
7. **Implement with gates** — only fire in contexts where edge was validated

### Prompt Templates for Edge Discovery

#### "Does this level/signal have edge?"
```
Run a forward-bar directional WR test on [SIGNAL].
- Measure WR at 3/5/10/20 bars vs unconditional baseline
- Split by day type (TREND/BALANCE/TURBULENT)
- Split by NL30 alignment (aligned/counter/neutral)
- Split by OR width (tight/normal/wide)
- Flag n<20
- Report delta vs baseline, not just raw WR
```

#### "Is this confluence real or a confound?"
```
Run a controlled confluence test on [LEVEL].
- Compare setups near [LEVEL] (±25pt) vs away
- Control group: same setup_type + same day_type + same NL30 bucket
- Weight by group size for overall controlled delta
- Report both raw delta and controlled delta
- If controlled delta < raw delta, it's a confound
```

#### "What's the optimal target?"
```
For setups at [LEVEL], test fixed-point targets:
- Targets: 10, 15, 20, 30, 40, 50, 75, 100pt
- Stops: 10, 15, 20, 25pt
- For each combo: hit rate within 20 bars, expectancy = (hitRate × target × 5) - ((1-hitRate) × stop × 5) - 5
- Report best target by maximum expectancy per contract
```

#### "Should this be a setup or a signal?"
```
Test [SIGNAL] with bracket resolution replay:
- Define entry, stop, target
- Replay bars forward from fired_at (use et_min matching, NOT ts > fired_at)
- Track TARGET_HIT / STOP_HIT / EXPIRED
- If the target is a MOVING value (like an EMA or VWAP), use custom resolution
  (check if price moved >50% toward the current value)
- If bracket WR is dramatically lower than directional WR, the signal
  has a moving-target problem → keep as signal, not setup
```

### What Kills Edges

| Pitfall | How to Detect | Example |
|---------|--------------|---------|
| **NQ uptrend confound** | Bullish signals look predictive regardless. Split by direction. | IB_BULLISH: 62.5% raw WR but -7.5% vs baseline |
| **Confounded confluence** | Raw edge disappears after controlling. | VWAP: +3.9% raw → -1.3% controlled |
| **Moving target** | Bracket WR << directional WR. | 9 EMA snap-back: 96% directional, 15% bracket |
| **Small N** | Exciting results evaporate with more data. | TRT_SHORT tight OR: 100% but N=6 |
| **Timezone mismatch** | Replay hits wrong bars. | `ts > fired_at` was replaying overnight bars |

### What Creates Real Edge

1. **Structural levels with proven independent contribution** (PD-2 VA: +44.8% controlled)
2. **Context gating** (NL30 alignment: 56.4% vs counter 40.2%)
3. **OR width filtering** (tight OR + short setups: massive boost)
4. **Confirmation bars** (RSI div raw 76.6% → confirmed 86.1%)
5. **Day-type matching** (VA_RESP_SHORT on TURBULENT: 90%)
6. **Custom resolution for moving targets** (EMA revert, VWAP revert)

---

## 8. Database Tables

| Table | Purpose |
|-------|---------|
| `active_setups` | All fired setups with entry/stop/target/resolution/PnL |
| `setup_daytype_winrates` | Weekly-computed win rates by setup type and day type |
| `setup_outcome_backtest` | Resolved trade outcomes with MFE/MAE |
| `combo_stats` | Level confluence statistics |
| `vol_backtest_cache` | Volatility regime tiers and expansion targets |
| `acd_daily_log` | Daily ACD data (OR, A levels, day type, daily score) |
| `developing_value_log` | Daily VAH/VAL/POC with session high/low |
| `price_bars_primary` | Continuous-contract price bars (via calendar view) |

---

## 9. Output Locations

| Location | Content |
|----------|---------|
| PostgreSQL tables above | Persistent backtest results |
| `/tmp/all_setups_replay.json` | Full setup replay output |
| `/tmp/vol_regime_sessions.json` | Vol regime session data |
| Console output | All scripts output to stdout |
| Backtest & Edge Registry (App.jsx) | Live dashboard reference |

---

*Generated from project analysis, June 2026. All edge numbers are from 12-month NQ data (2025-06 to 2026-06) unless noted. Full history (Nov 2023 → present) used for Absorption Long.*
