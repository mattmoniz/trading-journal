# Dynamic Take Profit Recommendation Spec
## Purpose: Show a recommended TP at trade entry time
## so the trader can set it in Sierra Chart before
## walking away from the screen.
## Builds on: SETUP_LIFECYCLE_SPEC.md, KEY_LEVEL_ANALYSIS,
##             PATTERN_MEMORY_SPEC.md

---

## Overview

The setup card must show one clear number before
the trade is placed: the recommended TP price level
and the point distance from entry.

This number is calculated from three inputs weighted
by recency:
1. Nearest structural level distance (always highest weight)
2. Average winning move from pattern memory (30d/90d/alltime)
3. Day type modifier (trend vs bracket vs tight)

The trader sets this number as their TP in Sierra Chart
before stepping away. The dashboard does not need to be
watched after entry.

---

## Data Sources

### Source 1 — Structural levels

Reuse the exact same level queries already used by
the counter-trend management panel and phase change
detector. Do not create new queries.

Levels available (already in system):
- composite_val, composite_vah, composite_poc
- prior_day_val, prior_day_vah, prior_day_poc
- ib_high, ib_low (from today's OR calculation)
- overnight_high, overnight_low

For a LONG setup, find the nearest resistance level
ABOVE the entry zone:
  composite_vah, prior_day_vah, ib_high, overnight_high
  Return the one with smallest positive distance from entry.

For a SHORT setup, find the nearest support level
BELOW the entry zone:
  composite_val, prior_day_val, ib_low, overnight_low
  Return the one with smallest negative distance from entry.

Level distance = abs(level_price - entry_zone_midpoint)
entry_zone_midpoint = (entry_zone_low + entry_zone_high) / 2

### Source 2 — Historical move magnitude

Query active_setups for completed setups of the same type:

SELECT
  AVG(
    CASE
      WHEN setup_type LIKE '%LONG%' OR
           setup_type LIKE '%BULLISH%' OR
           setup_type LIKE '%UP%'
      THEN t1_level - entry_zone_low
      ELSE entry_zone_high - t1_level
    END
  ) as avg_move,
  COUNT(*) as sessions
FROM active_setups
WHERE resolution = 'TARGET_HIT'
  AND setup_type = $1
  AND fired_at >= NOW() - INTERVAL '[N] days';

Run three times: N = 30, N = 90, no date filter.

If avg_move returns null or sessions < 3,
use these Key Level Analysis medians as fallback:
  IB_BEARISH / IB_BULLISH: 34 points
  OPEN_DRIVE: 34 points
  TRT: 33 points
  C_REVERSAL: 30 points
  FAILED_AUCTION: 28 points
  VALUE_AREA_RESPONSIVE: 28 points
  BRACKET_BREAKOUT: 40 points
  Default: 32 points

### Source 3 — Day type modifier

Pull from existing Big Picture data:
structural_state + OR volatility flag already calculated.

TRENDING modifier: 1.20
  When structural_state IN ('TRENDING_UP','TRENDING_DOWN')
  AND nl30 > 9 (bull) or nl30 < -9 (bear)

BRACKET modifier: 0.85
  When structural_state IN ('BRACKET','BRACKET_TILTING_UP',
  'BRACKET_TILTING_DOWN')
  AND or_volatility_flag = 'NORMAL' or 'ELEVATED'

TIGHT modifier: 0.70
  When or_volatility_flag = 'HIGH'
  OR structural_state = 'BRACKET' AND nl30 between -9 and +9

STANDARD modifier: 1.00
  All other conditions

### ATR regime check (used for modifier only)

Calculate 10-day session ATR from price_bars:
SELECT AVG(daily_range) as atr_10d
FROM (
  SELECT trade_date, MAX(high) - MIN(low) as daily_range
  FROM price_bars
  WHERE trade_date >= CURRENT_DATE - 14
    AND trade_date < CURRENT_DATE
    AND EXTRACT(HOUR FROM ts) BETWEEN 9 AND 16
  GROUP BY trade_date
  ORDER BY trade_date DESC
  LIMIT 10
) recent;

Compare to 20-day ATR (same query, LIMIT 20).
If atr_10d > atr_20d * 1.15: add +0.10 to modifier
If atr_10d < atr_20d * 0.85: subtract -0.10 from modifier

ATR is used ONLY to adjust the modifier.
ATR is NOT used as a direct target calculation.

---

## Weighting Logic

```javascript
function calculateRecommendedTP(
  levelDistance,
  avgMove30d, sessions30d,
  avgMove90d, sessions90d,
  avgMoveAllTime, sessionsAllTime,
  dayModifier
) {
  let baseTarget;

  if (sessions30d >= 10) {
    // Enough recent data — weight near term heavily
    baseTarget =
      (levelDistance   * 0.40) +
      (avgMove30d      * 0.35) +
      (avgMove90d      * 0.15) +
      (avgMoveAllTime  * 0.10);
  } else if (sessions90d >= 10) {
    // Limited recent data — lean on 90d and level
    baseTarget =
      (levelDistance   * 0.50) +
      (avgMove90d      * 0.35) +
      (avgMoveAllTime  * 0.15);
  } else {
    // Insufficient session data — structure only
    baseTarget =
      (levelDistance   * 0.60) +
      (avgMoveAllTime  * 0.40);
  }

  // Apply day type modifier
  const adjustedTarget = baseTarget * dayModifier;

  // Round to nearest 0.25 points
  return Math.round(adjustedTarget * 4) / 4;
}
```

---

## Stop Calculation

Stop = OR Low for long setups
Stop = OR High for short setups
(already calculated in existing setup detection)

Stop distance = abs(entry_zone_midpoint - stop_level)

R:R = recommendedTP_points / stop_distance_points

---

## Display on Setup Card

Add below the existing entry/stop/T1 levels
on the setup card. This section replaces or
updates the existing T1 display.

```
RECOMMENDED TP                              [info icon]

T1:  29408   (34 pts from entry)
Stop: 29276  (16 pts)
R:R: 2.1:1   ← green when >= 2.0
              ← amber when 1.5–1.9
              ← red when < 1.5

Nearest level: Prior Day VAH  (33 pts)
Conditions: BRACKET TILTING · NL30 +41 · Normal OR
Modifier: 0.85× (bracket)

Based on:
30d: 31 pts avg (8 trades)
90d: 34 pts avg (22 trades)
All time: 33 pts avg (47 trades)
★★★ Level median: 33 pts (638 touches)
```

When R:R < 1.5, show:
"Low R:R — consider waiting for better entry
 or skipping this setup"
in amber below the R:R line.

When sessions_30d < 10, show:
"30d: insufficient data (<10 trades) — using 90d"
in gray.

The info icon tooltip:
"T1 is calculated from the nearest structural
level in the trade direction (40-60% weight)
combined with your actual historical move
data from similar setups (30d weighted most).
Day type adjusts the result up on trend days,
down on bracket or wide-open days.
Set this level as your TP in Sierra Chart
before entering the trade."

---

## Status Bar Update

The persistent status bar at the top of the page
currently shows T1 as a price level only.

Update to show point distance:
"T1: 29408 (34 pts) · Stop: 29276 (16 pts) · R:R 2.1"

One line. No additional text.

---

## Profit Protection Banner Integration

The profit protection banner fires when open profit
reaches a threshold. That threshold should scale
with the recommended TP:

When target tier modifier = TIGHT (0.70):
  Banner threshold = 15 points
  Text: "PROFIT PROTECTION — 15+ pts open (tight day)
  Bracket conditions — take profits near current level."

When target tier modifier = BRACKET (0.85):
  Banner threshold = 20 points
  Text: "PROFIT PROTECTION — 20+ pts open
  Move stop to breakeven. Data: 68/112 trades
  with this profit reversed without management."

When target tier modifier = STANDARD (1.00):
  Banner threshold = 25 points (existing behavior)

When target tier modifier = TRENDING (1.20):
  Banner threshold = 35 points
  Text: "PROFIT PROTECTION — 35+ pts open
  Consider partial exit or trail stop.
  Trend conditions — runner possible above this."

---

## Nightly Pre-Calculation

To ensure the TP recommendation is available
instantly when a setup fires (no real-time wait),
add to the nightly pattern memory update:

For each setup type, pre-calculate and cache:
- avg_move_30d and sessions_30d
- avg_move_90d and sessions_90d
- avg_move_alltime and sessions_alltime

Store in condition_memory or a new
setup_move_stats table:

CREATE TABLE IF NOT EXISTS setup_move_stats (
  id SERIAL PRIMARY KEY,
  calculated_date DATE NOT NULL DEFAULT CURRENT_DATE,
  setup_type VARCHAR(30) NOT NULL,
  avg_move_30d NUMERIC,
  sessions_30d INTEGER,
  avg_move_90d NUMERIC,
  sessions_90d INTEGER,
  avg_move_alltime NUMERIC,
  sessions_alltime INTEGER,
  UNIQUE(calculated_date, setup_type),
  updated_at TIMESTAMP DEFAULT NOW()
);

The setup card reads from this table rather than
calculating on the fly. Fast display, no delay.

Add to patternMemoryUpdate.js after existing
three functions:

async function updateSetupMoveStats(tradeDate) {
  const setupTypes = [
    'TRT_SHORT','TRT_LONG','TRT_MAH_SHORT','TRT_MAH_LONG',
    'IB_BEARISH','IB_BULLISH',
    'OPEN_DRIVE_LONG','OPEN_DRIVE_SHORT',
    'C_REVERSAL_SHORT','C_REVERSAL_LONG',
    'FAILED_AUCTION_SHORT','FAILED_AUCTION_LONG',
    'VALUE_AREA_RESPONSIVE_LONG','VALUE_AREA_RESPONSIVE_SHORT',
    'BRACKET_BREAKOUT_LONG','BRACKET_BREAKOUT_SHORT'
  ];

  for (const setupType of setupTypes) {
    // Query active_setups for TARGET_HIT resolutions
    // Calculate avg T1 distance for 30d, 90d, alltime
    // Upsert into setup_move_stats
  }
}

---

## API Route

GET /api/setups/tp-recommendation?setupType=TRT_SHORT

Returns:
{
  "setupType": "TRT_SHORT",
  "recommendedPoints": 34,
  "levelDistance": 33,
  "levelType": "PRIOR_DAY_VAH",
  "levelPrice": 29408,
  "avgMove30d": 31,
  "sessions30d": 8,
  "avgMove90d": 34,
  "sessions90d": 22,
  "avgMoveAllTime": 33,
  "sessionsAllTime": 47,
  "dayModifier": 0.85,
  "modifierReason": "BRACKET conditions",
  "atrRegime": "NORMAL",
  "stopDistance": 16,
  "riskReward": 2.125,
  "rrLabel": "GOOD",
  "dataQuality": "MODERATE",
  "dataQualityReason": "30d < 10 sessions — using 90d weights"
}

Called when setup card renders.
Cached in setup_move_stats for instant response.

---

## Implementation Order

1. Create setup_move_stats table
2. Add updateSetupMoveStats() to patternMemoryUpdate.js
3. Run nightly update once to populate initial data
4. Build GET /api/setups/tp-recommendation route
5. Update setup card UI to show recommended TP section
6. Update status bar to show point distances
7. Update profit protection banner thresholds
   to scale with day type modifier
8. Add tooltip explaining the calculation

---

## Critical Constraints

The recommended TP is a suggestion not a command.
Never block trade entry based on R:R.
Show the R:R warning but do not enforce it.

ATR is used ONLY as a modifier adjustment input.
Never display ATR as the target itself.
Never say "1x ATR target" anywhere in the UI.

Level distance always gets the highest weight
(40-60%) because structure is more reliable
than statistics for intraday NQ targets.

When setup_move_stats has no data yet for a
setup type, use the Key Level Analysis medians
as hardcoded fallbacks. Never show 0 or null
as a target recommendation.

All timestamps ET.
New components need tooltips.
1 CONTRACT MAX remains on status bar at all times.
