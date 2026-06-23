# Monte Carlo Simulator V2 — Complete Spec

## What V1 Missed

V1 only tested setup × filter combinations from active_setups. Missing:
- Triple stack conviction combos (the money/death combos)
- Edge signals (EMA Snap-Back, Coil Surge, Absorption)
- Level-based trades (OR Mid, balance edges, PW High/Low, Floor pivots)
- Portfolio optimization (best combination of everything running together)

V2 covers all of it.

---

## Three Trade Sources

### Source 1: Pipeline Setups (from active_setups)

The 23 setup types that fire through the detection engine. Each has:
- Historical resolution (TARGET_HIT / STOP_HIT)
- Entry, stop, target prices
- Tagged with: NL30, overnight alignment, POC migration, day type, OR width, range quintile, triple stack conviction

**Already in the database.** ~985 resolved trades.

### Source 2: Edge Signals (synthetic from bar replay)

EMA Snap-Back, Coil Surge, Absorption have zero resolved trades because they never fired in production. To test them, the engine replays historical bars and detects when they WOULD have fired, then resolves them against subsequent price action.

**Detection logic (mirrors acd.js):**

**EMA Snap-Back:**
```
For each day:
  Resample to 5-min bars
  Compute 9 EMA and ATR(14)
  If close > EMA + 2.0 × ATR → SHORT signal
  If close < EMA - 2.0 × ATR → LONG signal
  Resolution: did price revert 50% toward frozen EMA within 15 bars?
  Stop: ATR distance from entry
```

**Absorption Long:**
```
For each day (BALANCE days only):
  Resample to 2-min bars
  Compute RSI(14)
  20-bar window: lowCluster >= 4, rsiDrift > 4, priceFlat
  Resolution: 25pt stop, 40pt target bracket
```

**Coil Surge → VWAP:**
```
For each day (TREND/NL30-aligned only):
  15-bar range < 40pt, vol < 40% baseline
  Volume surge >= 2.5x
  Resolution: fade toward VWAP, 50% revert = win
```

**Output:** Synthetic trade records with entry, stop, target, resolution, P&L — same format as pipeline trades. Tagged with same filter dimensions.

### Source 3: Level Trades (synthetic from bar replay)

For each trading day, scan bars for touches at structural levels. When price touches within proximity, simulate a bracket trade.

**Levels to test:**
- OR Mid (5-min OR midpoint)
- PD-1 VAH, PD-1 VAL, PD-1 POC
- PD-2 VAH, PD-2 VAL
- PD-3 VAH, PD-3 VAL
- PW High, PW Low
- Floor PP, S1, S2, S3, R1, R2, R3
- Balance zone edges (upper/lower from overlapping VA detection)
- IB High, IB Low (initial balance boundaries)
- G-Line (weekly open)

**For each level touch:**
```
Entry: close of the touch bar
Direction: fade (bounce off level) — long at support, short at resistance
Stop options: 15pt, 20pt, 25pt, 50pt (configurable)
Target options: 15pt, 20pt, 30pt, 50pt (configurable)
Resolution: replay subsequent bars — did target or stop hit first?
```

**Additional tags per level trade:**
- Absorption detected at touch? (bar clustering + volume + RSI)
- Volume spike at touch? (1.5x average)
- How many other levels within 15pt? (confluence count)
- Balance zone position (inside/outside/at edge)
- 20-day range quintile at time of trade

**Output:** Synthetic trade records. One per level touch per day, first touch only.

---

## Triple Stack Conviction as a Tradeable Dimension

Every trade (pipeline, edge, or level) gets tagged with its triple stack:

```
Range quintile: BOT / LOWER / MID / UPPER / TOP
Overnight alignment: ALIGNED / COUNTER / NEUTRAL  
Day type: TREND / BALANCE / TURBULENT
```

This produces the conviction tier: MAXIMUM / VERY_HIGH / HIGH / MODERATE / STANDARD / LOW / AVOID

The Monte Carlo engine can then filter or size by conviction:
- **Filter mode:** Skip all AVOID trades, only take MAXIMUM/HIGH
- **Sizing mode:** 2x on MAXIMUM, 1.5x on HIGH, 0.5x on LOW
- **Portfolio mode:** Test conviction-filtered subsets as separate strategies

---

## The Optimizer

### Individual Optimization

For each of the ~40 trade sources (23 setups + 3 edges + ~15 levels):
- Test all 256 filter combinations (8 binary filters)
- For each positive combo, run 1000 Monte Carlo iterations
- Track: median equity, survival rate, max DD, $/trade
- Walk-forward validate: train on 6 months, test on 3

### Portfolio Optimization

The real question: **which combination of profitable trade sources produces the best risk-adjusted return on a single $2K account?**

Step 1: Identify all individually profitable source+filter combos (from above)
Step 2: Test portfolios of 2, 3, 4, ... sources running together
Step 3: For each portfolio, Monte Carlo with proper sizing:
  - Trades happen in chronological order (not random — to test real-day interactions)
  - DLL applies across all sources per day
  - Post-loss reduction applies across sources
  - Account equity determines position size for all sources

Portfolio scoring:
```
Score = median_return × survival_rate / max_drawdown_pct
```

The optimizer finds the portfolio with the highest score.

---

## Simulation Engine V2

### Trade Pool Builder

```javascript
async function buildTradePool(config) {
  const pool = [];
  
  // Source 1: Pipeline setups
  if (config.sources.pipelineSetups) {
    const setups = await loadPipelineSetups(config);
    pool.push(...setups);
  }
  
  // Source 2: Edge signals (bar replay)
  if (config.sources.edgeSignals) {
    const edges = await replayEdgeSignals(config);
    pool.push(...edges);
  }
  
  // Source 3: Level trades (bar replay)  
  if (config.sources.levelTrades) {
    const levels = await replayLevelTrades(config);
    pool.push(...levels);
  }
  
  // Tag everything with triple stack
  for (const trade of pool) {
    trade.conviction = computeTripleStack(trade);
  }
  
  // Apply filters
  return applyFilters(pool, config.filters);
}
```

### Bar Replay Engine

```javascript
async function replayEdgeSignals(config) {
  const trades = [];
  const bars = await loadAllBars(config.dateRange);
  
  for (const [date, dayBars] of Object.entries(bars)) {
    // EMA Snap-Back detection
    const emaSnap = detectEMASnapBack(dayBars);
    if (emaSnap) {
      const resolution = resolveByBracket(dayBars, emaSnap.entryIdx, emaSnap.direction, emaSnap.stop, emaSnap.target);
      trades.push({ source: 'EMA_SNAP', date, ...emaSnap, ...resolution });
    }
    
    // Absorption detection (2-min resample)
    const absorption = detectAbsorption(dayBars, dayType);
    if (absorption) {
      const resolution = resolveByBracket(dayBars, absorption.entryIdx, 'LONG', 25, 40);
      trades.push({ source: 'ABSORPTION', date, ...absorption, ...resolution });
    }
    
    // Coil Surge detection
    const coil = detectCoilSurge(dayBars, nl30State);
    if (coil) {
      const resolution = resolveByVWAPRevert(dayBars, coil.entryIdx, coil.direction, coil.vwap);
      trades.push({ source: 'COIL_SURGE', date, ...coil, ...resolution });
    }
  }
  
  return trades;
}

async function replayLevelTrades(config) {
  const trades = [];
  const bars = await loadAllBars(config.dateRange);
  
  for (const [date, dayBars] of Object.entries(bars)) {
    const levels = computeLevelsForDate(date); // VA, pivots, PW, OR Mid, etc.
    
    for (const level of levels) {
      // Find first touch after OR close (10:00 AM)
      const touchIdx = findFirstTouch(dayBars, level.price, config.levelProximity || 10, 600);
      if (touchIdx < 0) continue;
      
      // Detect conditions at touch
      const absorption = detectAbsorptionAtTouch(dayBars, touchIdx, level.direction);
      const volumeSpike = detectVolumeSpike(dayBars, touchIdx);
      const confluenceCount = countNearbyLevels(levels, level.price, 15);
      
      // Resolve bracket trade
      const resolution = resolveByBracket(
        dayBars, touchIdx, level.direction,
        config.sizing.stopOverride || 20,
        config.sizing.targetOverride || 20
      );
      
      trades.push({
        source: 'LEVEL',
        levelType: level.name,
        date,
        direction: level.direction,
        absorption,
        volumeSpike,
        confluenceCount,
        ...resolution,
      });
    }
  }
  
  return trades;
}
```

### Portfolio Simulator

```javascript
function simulatePortfolio(tradePool, config) {
  // Sort all trades chronologically
  const sorted = tradePool.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.firedMin || 0) - (b.firedMin || 0);
  });
  
  let balance = config.account.startingBalance;
  let peak = balance, ddFloor = balance - config.account.trailingDrawdown;
  let ddFrozen = false, blown = false;
  let dayPnl = 0, currentDay = null, prevLoss = false;
  const equityCurve = [balance];
  
  for (const trade of sorted) {
    // New day reset
    if (trade.date !== currentDay) {
      dayPnl = 0; currentDay = trade.date; prevLoss = false;
    }
    
    // DLL check
    const dll = getDLL(balance);
    if (dayPnl <= -dll) continue;
    
    // Conviction-based sizing
    const stopPts = config.sizing.stopOverride || trade.stopDist || 50;
    const riskPerCt = stopPts * config.account.pointValue + config.account.commission;
    let contracts = computeContracts(balance, riskPerCt, trade.conviction, prevLoss, config);
    
    // Execute
    const tradePnl = trade.win
      ? trade.winPts * config.account.pointValue * contracts - config.account.commission * contracts
      : -stopPts * config.account.pointValue * contracts - config.account.commission * contracts;
    
    balance += tradePnl;
    dayPnl += tradePnl;
    prevLoss = !trade.win;
    
    // DD tracking
    if (balance > peak) peak = balance;
    if (!ddFrozen) {
      ddFloor = peak - config.account.trailingDrawdown;
      if (peak - config.account.startingBalance >= config.account.drawdownFreezeProfit) {
        ddFrozen = true;
      }
    }
    
    equityCurve.push(Math.round(balance));
    if (balance <= ddFloor) { blown = true; break; }
  }
  
  return { final: balance, peak, maxDD: peak - balance, blown, equityCurve };
}
```

---

## Configuration Schema V2

```javascript
{
  // ... all V1 config plus:
  
  sources: {
    pipelineSetups: true,        // active_setups trades
    edgeSignals: true,           // EMA snap, coil, absorption (bar replay)
    levelTrades: true,           // OR Mid, VA edges, pivots (bar replay)
  },
  
  // Level trade settings
  levels: {
    include: ['OR_MID', 'PD1_VAH', 'PD1_VAL', 'PD1_POC', 'PD2_VAH', 'PD2_VAL',
              'PW_HIGH', 'PW_LOW', 'FLOOR_PP', 'FLOOR_S1', 'FLOOR_S3', 'FLOOR_R1',
              'BALANCE_UPPER', 'BALANCE_LOWER', 'IB_HIGH', 'IB_LOW', 'GLINE'],
    proximity: 10,               // pts from level to trigger
    stopOverride: 20,            // fixed stop for level trades
    targetOverride: 20,          // fixed target
    requireAbsorption: false,    // only take with absorption detected
    requireVolumeSpike: false,   // only take with volume spike
    minConfluence: 0,            // minimum nearby levels (0 = no filter)
  },
  
  // Conviction filtering
  conviction: {
    mode: 'SIZE',                // FILTER (skip low) | SIZE (scale by conviction) | NONE
    minConviction: null,         // null = no minimum, or 'HIGH', 'MODERATE', etc.
    skipAvoid: true,             // always skip AVOID combos
  },
  
  // Portfolio optimization
  portfolio: {
    mode: 'MANUAL',              // MANUAL (user selects) | OPTIMIZE (engine finds best)
    maxSources: 6,               // max trade sources in optimized portfolio
    optimizeMetric: 'SCORE',     // SCORE | MEDIAN | SURVIVAL | SHARPE
  },
}
```

---

## Frontend Additions

### Configuration Panel (Backtest tab)

**Three-tab layout:**
1. **Sources** — checkboxes for pipeline setups, edge signals, level trades with sub-options
2. **Filters & Conviction** — filter toggles, conviction mode, min conviction
3. **Account & Sizing** — balance, DLL, DD, sizing mode, stop/target overrides

**Presets dropdown:**
- Current Live System
- All Sources Unfiltered  
- Snipers Only (VA_RESP + levels with absorption)
- Turbulent Hunter (all sources, turbulent only)
- Conservative (top 3 setups + filtered levels)
- Maximum Conviction (MAXIMUM + VERY_HIGH only)
- Custom

### Results Panel

**Summary row:** Median | Survival | MaxDD | PF | Trades/year

**Equity fan chart:** 20 sample curves with percentile bands

**Source breakdown table:**
```
Source                    N    WR   Net$   $/trade  Contribution
VA_RESP_SHORT (setup)    55   24%  $1,202  $22     19%
OR_MID + absorption       32   60%  $1,024  $32     16%
IB_BEARISH (TURB)        15   73%  $1,790  $119    28%
Balance edge fade         18   55%  $890    $49     14%
...
```

**Conviction breakdown:**
```
MAXIMUM:    N=18  WR=78%  sized 2x   contributed $2,300
HIGH:       N=27  WR=63%  sized 1.5x contributed $1,500
AVOID:      N=14  SKIPPED            saved $1,200
```

**Drawdown distribution:** histogram with 95th percentile marked

**Walk-forward results:** train vs test WR per window, robust/overfit badges

---

## Build Order

1. Bar replay engine (edge detection + level touch detection)
2. Trade pool builder (merge all 3 sources)
3. Triple stack tagging for all sources
4. Portfolio simulator with chronological ordering
5. Exhaustive optimizer (per-source best filters)
6. Portfolio optimizer (best combination of sources)
7. Monte Carlo wrapper (run portfolio sim N times with shuffled sequences)
8. Walk-forward validator
9. Frontend config panel
10. Frontend results display with charts
11. Presets and compare mode
12. Save/load runs

Estimated build: 3-4 sessions.

---

## What This Answers

After running V2, you'll know:
- Which combination of setups + edges + levels produces the best risk-adjusted return
- Whether edge signals add value beyond pipeline setups
- Whether level trades (OR Mid, balance edges) are independently profitable
- Whether conviction-scaled sizing beats flat sizing
- What the worst realistic drawdown looks like across 10,000 random sequences
- Whether the system survives prop firm rules (DLL, trailing DD) in 95%+ of sequences
- Which filters are robust (walk-forward validated) vs overfit
