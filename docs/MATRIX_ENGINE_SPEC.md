# The Dual-Timeframe Matrix Engine: Implementation Spec

## 1. Overview
The current Morning Prep dashboard relies on generalized descriptive statistics (e.g., "70% chance of a down afternoon"). As proven by our recent audit, these metrics blend opposing market regimes and encourage confirmation bias. 

This spec outlines the architecture for the **Matrix Engine**, a new system that dynamically calculates the exact short-term and macro regimes every morning, and filters the trader's playbook to display *only* the setups mathematically authorized for those specific market physics.

## 2. Backend Architecture (`server/routes/matrixEngine.js`)
We will create a lightweight, dedicated endpoint (e.g., `/api/morning-prep/matrix`) that calculates the environment daily.

### The Math (The Lookback Calculator)
Every morning before the bell, the server will query the `price_bars_primary` table to pull the daily candles for the last 90 trading days. 
It will calculate the High, Low, and Range for two specific windows:
1. **The 30-Day Window** (Short-Term Momentum)
2. **The 90-Day Window** (Macro Boundary)

For both windows, it will calculate where the current pre-market price sits relative to the range:
```javascript
Position = (CurrentPrice - Low) / (High - Low)
```
* If `Position` is between `0.25` and `0.75`, the timeframe is tagged as **MIDDLE**.
* If `Position` is `< 0.25` or `> 0.75`, the timeframe is tagged as **EDGE**.

The resulting string is the **Matrix Status** (e.g., `Edge30+Mid90`).

### The Matrix Dictionary
The backend will house a hardcoded dictionary mapping the Matrix Status to the specific setups that possess a mathematically proven real-data edge in that environment. 

```javascript
const MATRIX_DICTIONARY = {
  "Edge30+Mid90": {
    physics: "Macro Chop / Mean Reversion",
    authorized_setups: ["IB_BEARISH", "IB_MID_SCALP_FADE_LONG", "CAM_S2_FADE_SHORT", /* ... */]
  },
  "Mid30+Edge90": {
    physics: "Macro Breakout / Trend Continuation",
    authorized_setups: ["OR_HIGH_FADE_SHORT", "OR_LOW_FADE_LONG"]
  }
}
```

## 3. Frontend Architecture (Morning Prep Dashboard)
The React frontend will undergo a philosophical shift from *Predictive Forecasting* to *Regime Identification*.

### UI Changes
1. **Remove the Fluff:** We will delete or deprecate the components serving broad "Time of Day" or "Morning vs Afternoon" statistics.
2. **The Matrix Banner:** The top of the dashboard will feature a prominent banner displaying today's Matrix Status and its associated Market Physics (e.g., *Mean Reversion: Short-term momentum is hitting a macro brick wall*).
3. **The Dynamic Playbook:** Instead of a static list of 20 setups, the dashboard will only highlight the 5-10 setups authorized by the `MATRIX_DICTIONARY` for that specific day. Unauthorized setups will be dimmed, collapsed, or marked with a warning icon.

## 4. The Shadow Tagger (Future Data Collection)
To ensure we never rely on simulated backfill data again, we will wire the Matrix Engine into the live trade logger.

When the live trading engine inserts a new row into `active_setups`, it will automatically ping the Matrix Engine and stamp the trade with the current `regime_matrix` (e.g., `Edge30+Mid90`). 
This "Shadow Tagging" operates entirely in the background, allowing us to passively collect real forward-tested data on *all* setups over the next 6 months without risking capital. Once a dimmed setup crosses N=20 and proves its EV, it graduates into the Matrix Dictionary.
