# Monte Carlo Simulator — Full Build Spec

## Overview

A rigorous Monte Carlo simulation engine for NQ futures prop firm accounts that tests every combination of setups, filters, and sizing rules against realistic prop firm constraints. The goal: find the optimal system configuration that maximizes returns while maintaining 95%+ survival rate under random trade sequencing.

## Why Monte Carlo

A single backtest shows what happened in one specific order. Monte Carlo answers: "If these same trades happened in 10,000 different random orders, what's the range of outcomes?" A system that looks great in one sequence might blow up if the first 5 trades are all losers. Monte Carlo stress-tests the system against every possible bad streak.

---

## Architecture

### Backend: `server/services/monteCarloService.js`

The engine that runs simulations. Stateless — takes configuration in, returns results out.

### Database: `monte_carlo_runs` table

Stores simulation results for comparison and historical tracking.

```sql
CREATE TABLE monte_carlo_runs (
  id SERIAL PRIMARY KEY,
  run_date TIMESTAMPTZ DEFAULT NOW(),
  config JSONB NOT NULL,        -- full configuration used
  results JSONB NOT NULL,       -- simulation output
  summary JSONB NOT NULL,       -- key metrics for quick display
  notes TEXT,
  created_by TEXT DEFAULT 'system'
);
```

### API: `/api/monte-carlo/`

- `POST /api/monte-carlo/run` — run a new simulation
- `GET /api/monte-carlo/runs` — list past runs
- `GET /api/monte-carlo/runs/:id` — get full results
- `DELETE /api/monte-carlo/runs/:id` — delete a run

### Frontend: `MonteCarloPanel.jsx`

Configuration form + results display on the Backtest tab.

---

## Configuration Schema

The user configures a simulation through the UI. Every parameter has a default but is adjustable.

```javascript
{
  // ACCOUNT RULES
  account: {
    startingBalance: 2000,       // $
    instrument: 'MNQ',           // MNQ ($2/pt) or NQ ($5/pt)
    pointValue: 2,               // $/point
    commission: 0.50,            // per contract round trip
    maxContracts: 20,            // hard cap
    dailyLossLimit: 400,         // $ — scales with equity thresholds
    dllScaling: {                // when DLL increases
      4000: 600,
      6000: 800,
      10000: 1200,
      20000: 2000,
    },
    trailingDrawdown: 1500,      // $ cushion from peak
    drawdownFreezeProfit: 3000,  // DD stops trailing after this much profit
  },

  // TRADE SELECTION
  setups: {
    // Which setup types to include (checkboxes in UI)
    include: ['VA_RESP_SHORT', 'IB_BEARISH', 'C_STANDALONE_DOWN', ...],
    // OR: 'ALL' to test everything, 'ACTIVE' for current 6, 'CUSTOM' for manual selection
    mode: 'CUSTOM',
  },

  // FILTER STACK (each on/off toggle in UI)
  filters: {
    nl30Counter: true,           // suppress NL30 counter trades
    doubleHeadwind: true,        // suppress only when NL30 + overnight both counter
    pocMigration: true,          // suppress POC migration counter
    pd2Gate: false,              // require PD-2 VA proximity (for C_STANDALONE)
    wideORSuppressTRT: true,     // suppress TRT_LONG on wide OR
    lowVolSkip: true,            // skip LOW_VOL except VA_RESP_SHORT
    tripleStackAvoid: true,      // skip death combos
    overnightCounterOnly: false, // only suppress overnight counter (ignore NL30)
  },

  // SIZING RULES
  sizing: {
    mode: 'RISK_PCT',            // RISK_PCT | FIXED | CONVICTION_SCALED
    riskPctPerTrade: 0.015,      // 1.5% of equity
    maxRiskPct: 0.05,            // 5% hard cap per trade
    stopDistance: null,           // null = use actual stop from trade, or fixed (e.g. 50)
    convictionMultipliers: {     // only used in CONVICTION_SCALED mode
      MAXIMUM: 2.0,
      VERY_HIGH: 1.8,
      HIGH: 1.5,
      MODERATE: 1.0,
      STANDARD: 1.0,
      LOW: 0.5,
    },
    postLossReduction: 0.5,      // halve size after a loss today
  },

  // SIMULATION PARAMETERS
  simulation: {
    runs: 10000,                 // number of Monte Carlo iterations
    tradeCount: null,            // null = use actual trade count, or fixed (e.g. 250)
    method: 'BOOTSTRAP',         // BOOTSTRAP (sample with replacement) | SHUFFLE (permutation)
    seed: null,                  // for reproducibility
  },

  // WALK-FORWARD (prevents overfitting)
  walkForward: {
    enabled: false,
    trainMonths: 6,              // optimize filters on this window
    testMonths: 3,               // test on this window
    stepMonths: 3,               // slide by this amount
  },

  // DATE RANGE
  dateRange: {
    start: '2025-06-18',         // or 'ALL'
    end: '2026-06-22',
  },
}
```

---

## Simulation Engine Logic

### Step 1: Load and Tag Trades

Query all resolved trades from `active_setups` within the date range. Tag each trade with:

- Setup type
- Resolution (TARGET_HIT / STOP_HIT)
- Actual P&L (at $5/pt from DB)
- Entry, stop, target prices
- Stop distance in points
- Direction (LONG/SHORT)

**Filter dimensions (computed per trade):**
- NL30 state (BULLISH/BEARISH/RANGING) and counter flag
- Overnight inventory (SHORT_TRAPPED/LONG_TRAPPED/NEUTRAL)
- Open vs prior value (ABOVE/INSIDE/BELOW)
- Overnight alignment (ALIGNED/COUNTER/NEUTRAL)
- Double headwind flag (NL30 counter AND overnight counter)
- POC migration direction and counter flag
- PD-2 VA proximity flag
- OR width (tight/normal/wide)
- Day type (TREND/BALANCE/TURBULENT)
- 20-day range quintile (BOT/LOWER/MID/UPPER/TOP)
- Triple stack conviction (MAXIMUM/VERY_HIGH/HIGH/MODERATE/STANDARD/LOW/AVOID)
- Day of week

### Step 2: Apply Filters

Based on the configuration, remove trades that fail the selected filters. This produces the "tradeable universe" — the pool of trades to sample from.

### Step 3: Compute Per-Trade P&L

For each trade in the universe:

```javascript
// If using actual stops
stopPts = Math.abs(entry - stop);

// If using fixed stop override
if (config.sizing.stopDistance) {
  // Cap the P&L: if actual loss > fixed stop, use fixed stop loss
  // If actual win, keep actual win (targets don't change)
  if (resolution === 'STOP_HIT') {
    pnlPts = -config.sizing.stopDistance;
  } else {
    pnlPts = actualPnlPts; // keep the actual win
  }
}

// Convert to dollar P&L per contract
pnlPerContract = pnlPts * config.account.pointValue;
```

### Step 4: Monte Carlo Loop

For each of `config.simulation.runs` iterations:

```javascript
function simulateRun(tradePool, config) {
  let balance = config.account.startingBalance;
  let peak = balance;
  let ddFloor = balance - config.account.trailingDrawdown;
  let ddFrozen = false;
  let blown = false;
  let dayPnl = {};
  let prevTradeDate = null;
  let prevLoss = false;
  let dllHits = 0;
  let maxDD = 0;
  let trades = 0;

  // Sample trades
  const tradeCount = config.simulation.tradeCount || tradePool.length;
  for (let i = 0; i < tradeCount; i++) {
    const trade = config.simulation.method === 'BOOTSTRAP'
      ? tradePool[Math.floor(Math.random() * tradePool.length)]
      : tradePool[shuffledIndices[i]]; // pre-shuffled

    // DLL check
    const dll = getDLL(balance, config.account.dllScaling, config.account.dailyLossLimit);
    const dateKey = trade.date || `sim_day_${Math.floor(i / 3)}`; // ~3 trades per day
    if (!dayPnl[dateKey]) dayPnl[dateKey] = 0;
    if (dayPnl[dateKey] <= -dll) { dllHits++; continue; }

    // Position sizing
    const stopPts = config.sizing.stopDistance || trade.stopDistance || 50;
    const riskPerContract = stopPts * config.account.pointValue + config.account.commission;
    let baseRisk = balance * config.sizing.riskPctPerTrade;
    let contracts = Math.floor(baseRisk / riskPerContract);

    // Conviction multiplier
    if (config.sizing.mode === 'CONVICTION_SCALED' && trade.tripleStackConviction) {
      contracts = Math.round(contracts * (config.sizing.convictionMultipliers[trade.tripleStackConviction] || 1.0));
    }

    // Post-loss reduction
    if (config.sizing.postLossReduction && prevLoss) {
      contracts = Math.round(contracts * config.sizing.postLossReduction);
    }

    // Hard caps
    contracts = Math.max(1, Math.min(config.account.maxContracts, contracts));
    if (contracts * riskPerContract > balance * config.sizing.maxRiskPct) {
      contracts = Math.max(1, Math.floor(balance * config.sizing.maxRiskPct / riskPerContract));
    }
    if (contracts * riskPerContract > dll + dayPnl[dateKey] && dayPnl[dateKey] + dll > 0) {
      contracts = Math.max(1, Math.floor((dll + dayPnl[dateKey]) / riskPerContract));
    }

    // Execute trade
    let tradePnl;
    if (trade.resolution === 'STOP_HIT') {
      tradePnl = -(config.sizing.stopDistance || trade.stopDistance || 50) * config.account.pointValue * contracts - config.account.commission * contracts;
      prevLoss = true;
    } else {
      tradePnl = trade.actualPnlPts * config.account.pointValue / 5 * config.account.pointValue * contracts - config.account.commission * contracts;
      prevLoss = false;
    }

    balance += tradePnl;
    dayPnl[dateKey] += tradePnl;
    trades++;

    // Trailing DD
    if (balance > peak) peak = balance;
    if (!ddFrozen) {
      ddFloor = peak - config.account.trailingDrawdown;
      if (peak - config.account.startingBalance >= config.account.drawdownFreezeProfit) {
        ddFrozen = true;
        ddFloor = peak - config.account.trailingDrawdown;
      }
    }
    const dd = peak - balance;
    if (dd > maxDD) maxDD = dd;

    // Blow-up check
    if (balance <= ddFloor) {
      blown = true;
      break;
    }
  }

  return {
    finalBalance: balance,
    peakBalance: peak,
    maxDrawdown: maxDD,
    maxDrawdownPct: peak > 0 ? maxDD / peak : 0,
    blown,
    ddFrozen,
    ddFloor,
    tradesExecuted: trades,
    dllHits,
  };
}
```

### Step 5: Aggregate Results

After all runs complete:

```javascript
{
  summary: {
    runs: 10000,
    tradesPerRun: 135,
    setupsIncluded: ['VA_RESP_SHORT', 'IB_BEARISH', ...],
    filtersApplied: ['doubleHeadwind', 'pocMigration', ...],

    // Equity distribution
    median: 8197,
    mean: 8450,
    p1: 4200,
    p5: 5800,
    p10: 6200,
    p25: 7100,
    p75: 9500,
    p90: 10800,
    p95: 11500,
    p99: 13200,
    min: 2100,
    max: 18500,

    // Risk metrics
    survivalRate: 0.95,          // % of runs that didn't blow up
    blowUpRate: 0.05,
    avgMaxDrawdown: 1200,
    avgMaxDrawdownPct: 0.12,
    medianMaxDrawdown: 1050,
    p95MaxDrawdown: 2100,        // worst 5% of drawdowns

    // Return metrics
    avgReturn: 0.31,             // 310% avg
    medianReturn: 0.28,
    sharpeApprox: 2.1,           // (mean return - risk free) / std dev
    profitFactor: 2.13,
    avgTradesPerRun: 135,

    // Conviction breakdown (if CONVICTION_SCALED)
    byConviction: {
      MAXIMUM: { n: 18, wr: 0.78, avgPnl: 346 },
      HIGH: { n: 27, wr: 0.63, avgPnl: 195 },
      AVOID_SKIPPED: 14,
    },
  },

  // Full distribution data for charting
  equityDistribution: [4200, 4300, 4400, ...], // sorted finals
  drawdownDistribution: [200, 300, 400, ...],   // sorted max DDs
  
  // Sample equity curves (first 20 runs for visual)
  sampleCurves: [
    { trades: [2000, 2050, 1980, 2100, ...] }, // balance after each trade
    ...
  ],
}
```

---

## Walk-Forward Validation

Prevents overfitting by splitting data into train/test windows:

```
Window 1: Train on Jun 2025 - Nov 2025 → Test on Dec 2025 - Feb 2026
Window 2: Train on Sep 2025 - Feb 2026 → Test on Mar 2026 - May 2026
Window 3: Train on Dec 2025 - May 2026 → Test on Jun 2026 - Aug 2026
```

For each window:
1. **Train phase:** Run the filter optimizer on training data to find best filter combo per setup
2. **Test phase:** Apply those filters to out-of-sample test data
3. **Compare:** If test WR is within 10% of train WR, the filters are robust. If test WR drops >15%, the filters are overfit.

Report: "6 of 8 filter configurations survived walk-forward. 2 were overfit and should not be trusted."

---

## Frontend UI: `MonteCarloPanel.jsx`

Located on the **Backtest tab** inside a collapsible section.

### Configuration Form

**Account Section:**
- Starting balance input ($2,000 default)
- Instrument toggle (MNQ/NQ)
- DLL input ($400 default)
- Trailing DD input ($1,500 default)
- Profit lock input ($3,000 default)

**Setup Selection:**
- Checkboxes for all 23 setup types, grouped by status (ACTIVE/SHADOW/EDGE)
- Quick-select buttons: "Active Only" | "All Positive" | "All" | "Custom"
- Each checkbox shows the raw WR and net PnL next to it

**Filter Stack:**
- Toggle switches for each filter
- Quick-select: "Current System" | "No Filters" | "Maximum Filtering" | "Custom"
- Each toggle shows the impact: "NL30 counter: removes ~30 trades, +3% WR"

**Sizing:**
- Mode dropdown: Risk % | Fixed Size | Conviction Scaled
- Risk % input (1.5% default)
- Fixed stop override input (blank = use actual, or 50pt, 100pt)
- Conviction multiplier sliders (only visible in Conviction Scaled mode)

**Simulation:**
- Runs input (1000 / 5000 / 10000)
- Method toggle: Bootstrap / Shuffle
- Walk-forward toggle with train/test month inputs

**Run Button:**
- "Run Simulation" — shows progress bar
- Estimated runtime displayed before running
- Cancel button

### Results Display

**Summary Cards (top row):**
```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  MEDIAN      │ │  SURVIVAL    │ │  MAX DD      │ │  PROFIT      │
│  $8,197      │ │  95.2%       │ │  $1,037      │ │  FACTOR      │
│  310% return │ │  4.8% blow   │ │  11.2% peak  │ │  2.13        │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

**Equity Distribution Chart:**
- Histogram of final equity across all runs
- Vertical lines at 5th, 50th, 95th percentiles
- Color coding: green (profitable), red (blown), amber (survived but below start)

**Equity Curve Fan Chart:**
- 20 sample equity curves overlaid
- Shaded bands for 25th-75th and 5th-95th percentile ranges
- Median curve highlighted

**Drawdown Distribution:**
- Histogram of max drawdowns
- "Worst case you should plan for: $X (95th percentile)"

**Conviction Breakdown Table (if Conviction Scaled):**
- Per conviction tier: N, WR, avg PnL, contribution to total

**Walk-Forward Results (if enabled):**
- Train vs Test WR per window
- "Robust" / "Overfit" badge per configuration
- Only robust configurations in the final results

**Compare Button:**
- Side-by-side comparison of two saved runs
- "What changed: +3 setups included, -1 filter, +$1,200 median"

---

## Preset Configurations

Quick-load buttons for common scenarios:

1. **Current Live System** — 6 active setups, double-headwind + POC + PD2 + wide OR + triple stack
2. **Conservative** — VA_RESP_SHORT + C_STANDALONE_DOWN only, all filters on, 1% risk
3. **Aggressive** — All profitable setups, minimal filters, conviction-scaled sizing
4. **Sniper Only** — VA_RESP_SHORT + VA_RESP_LONG, POC counter filter only
5. **Turbulent Hunter** — All setups but TURBULENT_ONLY filter, 2% risk
6. **Custom** — User builds from scratch

---

## Build Order

1. **Backend service** (`monteCarloService.js`) — the engine
2. **Database table** — store runs
3. **API endpoints** — run/list/get/delete
4. **Frontend config form** — setup selection, filter toggles, sizing inputs
5. **Frontend results display** — summary cards, charts, tables
6. **Walk-forward validation** — train/test splitting
7. **Preset configurations** — quick-load buttons
8. **Compare mode** — side-by-side run comparison

---

## Performance Considerations

- 10,000 runs × 135 trades = 1.35M trade simulations — runs in <5 seconds in Node.js
- Walk-forward with 3 windows × 128 filter combos × 23 setups = ~8,800 optimizations per window — runs in <30 seconds
- Store only summary + distributions in DB, not individual run details
- Run simulations in a background worker to not block the server
- Frontend shows progress bar during long runs

---

## What This Replaces

Currently, backtesting is done ad-hoc via node scripts in the terminal. This gives you:
- A UI to configure and run simulations without writing code
- Saved results you can compare over time
- Walk-forward validation to prevent overfitting
- Visual equity curves and distributions instead of text output
- Preset configs for quick "what if" scenarios
- The ability to answer "what's my blow-up risk?" with statistical rigor
