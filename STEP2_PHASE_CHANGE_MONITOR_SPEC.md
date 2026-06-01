# Dashboard Step 2 — Phase Change Monitor (Full Spec)
# Live bar feed auto-detection version
# Build only after Step 1 (visual hierarchy) is confirmed working.

---

## Context

price_bars table receives live 1-minute bar data from
Sierra Chart during market hours via existing intraday feed.
All five phase change conditions auto-detect from incoming bars.
Manual override available for each condition.

Before building, confirm:
1. price_bars columns: does cum_delta exist? What is volume
   column called? What is bar timestamp column called?
2. How composite VAL/VAH/POC and prior day levels are queried
   (reuse existing counter-trend management queries exactly)
3. Whether WebSocket/SSE infrastructure exists already

---

## Table 1 — phase_change_alerts

CREATE TABLE phase_change_alerts (
  id SERIAL PRIMARY KEY,
  trade_date DATE NOT NULL DEFAULT CURRENT_DATE,
  alert_time TIMESTAMP NOT NULL DEFAULT NOW(),
  price_at_alert NUMERIC,
  structural_level NUMERIC,
  level_type VARCHAR(30),
  distance_to_level NUMERIC,
  near_structural_level BOOLEAN DEFAULT FALSE,
  volume_declining BOOLEAN DEFAULT FALSE,
  delta_diverging BOOLEAN DEFAULT FALSE,
  range_compressing BOOLEAN DEFAULT FALSE,
  profile_stopped BOOLEAN DEFAULT FALSE,
  conditions_met INTEGER DEFAULT 0,
  volume_source VARCHAR(15) DEFAULT 'AUTO',
  delta_source VARCHAR(15) DEFAULT 'AUTO',
  range_source VARCHAR(15) DEFAULT 'AUTO',
  profile_source VARCHAR(15) DEFAULT 'AUTO',
  volume_declining_override BOOLEAN,
  delta_diverging_override BOOLEAN,
  range_compressing_override BOOLEAN,
  profile_stopped_override BOOLEAN,
  prior_phase_direction VARCHAR(20),
  bars_in_current_move INTEGER,
  alert_acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMP,
  outcome_15min NUMERIC,
  outcome_30min NUMERIC,
  outcome_60min NUMERIC,
  did_reverse BOOLEAN,
  reversal_magnitude NUMERIC,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_pca_trade_date ON phase_change_alerts(trade_date);
CREATE INDEX idx_pca_alert_time ON phase_change_alerts(alert_time);

level_type values:
COMPOSITE_VAL, COMPOSITE_VAH, COMPOSITE_POC,
PRIOR_DAY_VAL, PRIOR_DAY_VAH, PRIOR_DAY_POC,
BRACKET_LOW, BRACKET_HIGH

volume_source / delta_source / range_source / profile_source values:
AUTO, MANUAL, UNAVAILABLE

---

## Table 2 — phase_change_backtest_results

CREATE TABLE phase_change_backtest_results (
  id SERIAL PRIMARY KEY,
  run_date TIMESTAMP DEFAULT NOW(),
  proximity_points INTEGER DEFAULT 20,
  min_conditions INTEGER DEFAULT 3,
  volume_lookback_bars INTEGER DEFAULT 3,
  delta_lookback_bars INTEGER DEFAULT 5,
  range_lookback_bars INTEGER DEFAULT 3,
  profile_lookback_bars INTEGER DEFAULT 10,
  forward_window_minutes INTEGER DEFAULT 30,
  reversal_threshold_points INTEGER DEFAULT 15,
  sessions_analyzed INTEGER,
  total_bars_scanned INTEGER,
  date_range_start DATE,
  date_range_end DATE,
  total_events INTEGER,
  events_3_conditions INTEGER,
  events_4_conditions INTEGER,
  events_5_conditions INTEGER,
  reversal_rate_3 NUMERIC,
  reversal_rate_4 NUMERIC,
  reversal_rate_5 NUMERIC,
  avg_reversal_magnitude_3 NUMERIC,
  avg_reversal_magnitude_4 NUMERIC,
  avg_reversal_magnitude_5 NUMERIC,
  best_level VARCHAR(30),
  best_level_reversal_rate NUMERIC,
  best_level_avg_magnitude NUMERIC,
  best_level_event_count INTEGER,
  results_by_level JSONB,
  results_by_combo JSONB,
  run_duration_seconds INTEGER
);

---

## Real-Time Detection Service

New file: services/phaseChangeDetector.js
Triggered by existing bar ingestion pipeline on each bar insert.
Do NOT poll. Do NOT run on a timer. Hook into the existing
event or callback that fires after a bar is saved.

Detection parameters:
proximityPoints: 20
volumeLookback: 3 bars
deltaLookback: 5 bars
rangeLookback: 3 bars
profileLookback: 10 bars
minConditions: 3
Market hours: 9:30 AM to 11:00 AM ET only

CONDITION 1 — Near structural level (AUTO)
Check if current bar close is within proximityPoints of any level.
Reuse existing level queries from counter-trend management exactly.
Expected levels: composite VAL, VAH, POC, prior day VAL, VAH, POC.

CONDITION 2 — Volume declining (AUTO)
Last volumeLookback bars each have lower volume than the prior bar.
bars[0] = most recent (least volume), bars[N] = oldest (most volume).
Reset to false when any bar has higher volume than prior.

CONDITION 3 — Delta diverging (AUTO)
If cum_delta column exists in price_bars:
  Price making new low but delta making higher low = bearish divergence
  Price making new high but delta making lower high = bullish divergence
  Compare over last deltaLookback bars.
If cum_delta does not exist:
  Calculate as running sum of (ask_volume - bid_volume) per session.
  If ask_volume/bid_volume also unavailable: delta_source = UNAVAILABLE,
  condition = false, but keep manual override available.

CONDITION 4 — Range compressing (AUTO)
Last rangeLookback bars each have smaller high-low range than prior bar.
bars[0].range < bars[1].range < bars[2].range = compressing.
Reset when any bar has larger range than prior.

CONDITION 5 — Profile stopped at level (AUTO)
Last profileLookback bars have made no new extreme in the current
move direction. Determine direction from 10-bar trend.
If price has not made a new high (in uptrend) or new low (in downtrend)
for profileLookback bars = profile stopped.

DETECTION LOGIC:
- Evaluate all 5 conditions on each bar insert
- Count conditions_met
- Always broadcast current state to connected clients
  regardless of threshold (used for live UI display)
- Only create alert row and auto-expand panel when:
  conditions_met >= minConditions AND near a structural level
- Duplicate prevention: do not create new alert for same
  level_type within 15 minutes of prior alert at that level

PRIOR DIRECTION:
Determine from last 10 bars:
DRIVE_DOWN: close dropped more than 10 points
DRIVE_UP: close rose more than 10 points
BALANCED: within 10 points

ALERT CREATION:
INSERT into phase_change_alerts with:
- alert_time set to bar timestamp (NOT current time)
- all condition values and sources
- prior_phase_direction and bars_in_current_move
- conditions_met count

BROADCAST via existing Socket.io after alert created:
Event 'phase-change-alert': { alertId, conditionsMet, levelType,
  levelPrice, price, historicalRate, historicalCount }
Event 'condition-state': fires on every bar with current
  conditions regardless of threshold:
  { timestamp, price, nearLevel, volumeDeclining, deltaDiverging,
    rangeCompressing, profileStopped, conditionsMet, hasDelta }

---

## Proximity Banner

Location: above the status bar, visible during market hours only.
Updates on each bar insert using most recent price_bars row.
Falls back to polling /api/phase-change/current-state every 30s
if socket connection drops.

When price within 20 points of any structural level:
Amber: "Approaching [LEVEL NAME] [price] — [N] pts away"

When within 10 points:
Orange: "AT [LEVEL NAME] [price] — [N] pts away"

When conditions also building (2+ conditions met) and within 10 pts:
Orange bold: "AT [LEVEL NAME] [price] — [N] pts | [X]/5 conditions"

Hidden when no level within 20 points.
Hidden outside market hours.
Price from most recent price_bars row for today.

---

## Phase Change Monitor UI Component

Location: inside SESSION CONTEXT collapsible section
Auto-expands the section when conditionsMet >= 3

Display layout:
PHASE CHANGE MONITOR [info icon]
Live — updating on each bar

Near: [LEVEL TYPE] [price] ([distance] pts away)

[score] / 5  [status label]  [progress bar]

Condition          Auto-Detected    Your Read
Near level         YES (auto)       —
Volume declining   YES / NO         [override tap]
Delta diverging    YES / NO / N/A   [override tap]
Range compressing  YES / NO         [override tap]
Profile stopped    YES / NO         [override tap]

Prior move: [DRIVE_DOWN/UP/BALANCED] | [N] bars

Historical base rate:
[LEVEL TYPE] · [N] conditions
→ [X]% reversal | avg [Y] pts over 30 min
from [N] historical events

[Acknowledge] [Add note]

Score thresholds:
0-2/5: panel hidden (section stays collapsed)
3/5: WATCH — amber — section auto-expands
4/5: HIGH PROBABILITY — orange
5/5: EXHAUSTION CONFIRMED — red

When backtest not yet run:
"Run backtest on Backtest tab to see historical rates"

"from N historical events" is mandatory — never show
percentage without sample size.

After 11:00 AM ET — outcome form appears:
Price 30 min later: [input]
Did price reverse? [YES] [NO]
Magnitude if yes: [input] pts
Notes: [input]
[Save outcome]

Auto-detect column:
YES = condition true from live bars
NO = condition false
N/A = data unavailable (shown for delta when unavailable)

Manual override:
[override] button next to each auto-detected value.
Click shows YES/NO toggle.
Override saves to alert record and shows "(you)" suffix.
Trader observation always takes precedence.

---

## Backtest Engine

New file: services/phaseChangeBacktest.js
Runs async — same job pattern as ACD backtest.
Return jobId, poll for completion. Never in request handler.

Input parameters (user-configurable):
proximityPoints, minConditions, volumeLookback,
deltaLookback, rangeLookback, forwardWindowMinutes,
reversalThresholdPoints, startDate, endDate

For each session in price_bars history:
1. Load structural levels for that session date
   (reuse same level queries as detector)
2. Scan bars after market open
3. For each bar near a structural level:
   a. Check all 4 detectable conditions
      (skip delta if unavailable)
   b. Count conditions_met
   c. If >= minConditions: record event
   d. Measure price change at 15, 30, 60 min forward
   e. Classify as reversed if:
      - price moved >= reversalThresholdPoints
      - direction opposite to prior 5-bar trend

Analyze events by:
- condition count (3, 4, 5)
- level type
- combo (count + level type)

Filter by minimum sample size of 10 events per category
before showing rates. Below 10: "Insufficient data".

Save to phase_change_backtest_results table.

---

## API Routes

GET  /api/phase-change/current-state
  Returns latest condition evaluation from most recent bar.
  Used as polling fallback when socket disconnected.

GET  /api/phase-change/alerts/today
  Returns all phase_change_alerts for today.

POST /api/phase-change/alerts/:id/override
  Body: { condition, value }
  condition: volume_declining | delta_diverging |
             range_compressing | profile_stopped
  value: true | false
  Updates override column on alert record.

PUT  /api/phase-change/alerts/:id/acknowledge
  Sets alert_acknowledged = true.

PUT  /api/phase-change/alerts/:id/outcome
  Body: { outcome15min, outcome30min, outcome60min,
          didReverse, reversalMagnitude, notes }

POST /api/phase-change/backtest/run
  Body: { proximityPoints, minConditions, volumeLookback,
          deltaLookback, rangeLookback, forwardWindowMinutes,
          startDate, endDate }
  Returns: { jobId }

GET  /api/phase-change/backtest/status/:jobId
  Returns: { status, progress, estimatedSeconds }

GET  /api/phase-change/backtest/results
  Returns latest phase_change_backtest_results row.

GET  /api/phase-change/forward-test
  Aggregates logged alerts with outcomes filled in.
  Compares to backtest predictions.

---

## Backtest Tab Addition

Add Phase Change section below existing backtest results.

Display:
PHASE CHANGE BACKTEST
Last run: [timestamp]
Sessions analyzed: N | Bars scanned: N

Parameters: proximity [N]pts · min [N] conditions · [N]min window

RESULTS BY CONDITION COUNT
Conditions  Events  Reversal%  Avg Move
3 / 5         N       X%       N pts
4 / 5         N       X%       N pts
5 / 5         N       X%       N pts

RESULTS BY STRUCTURAL LEVEL
Level              Events  Reversal%  Avg Move
Composite VAL        N       X%       N pts
Prior Day VAL        N       X%       N pts
[etc]

[Run Backtest] [Adjust Parameters]

Parameters panel (collapsible):
Proximity to level: [20] points
Minimum conditions: [3]
Volume lookback: [3] bars
Delta lookback: [5] bars
Range lookback: [3] bars
Forward window: [30] minutes
Reversal threshold: [15] points
Date range: [start] to [end]

FORWARD TEST VALIDATION (shows when >= 10 alerts have outcomes):
Your logged alerts: N events, X% reversal rate
vs backtest prediction: Y% at N conditions
Status: Within expected variance / Outside expected variance

---

## End of Day Outcome Prompt

After 4:00 PM ET, if any phase_change_alerts from today
have no outcome recorded, surface prompt in SESSION CONTEXT:

"Complete today's alert outcomes (N alerts need outcomes):"
For each: [time] · [N]/5 conditions · [level type]
Price 30 min later: [input]  Reversed? [YES] [NO]
[Save]

---

## Implementation Order

1. Read price_bars schema — confirm column names
   especially: timestamp column, volume column,
   bid_volume/ask_volume or cum_delta existence
   Report findings before writing any detection code.

2. Read existing counter-trend level queries —
   identify exact function or query used.
   Detection service must reuse this exactly.

3. Check existing Socket.io infrastructure —
   confirm event names already in use to avoid conflicts.

4. Create phase_change_alerts table

5. Create phase_change_backtest_results table

6. Build phaseChangeDetector.js service
   Hook into existing bar ingestion pipeline trigger.
   Do not create new polling loop.

7. Add Socket.io broadcasts for condition-state
   and phase-change-alert events

8. Build all API routes

9. Build proximity banner component
   Wire to most recent price_bars row for live price.
   Use socket event for real-time updates.

10. Build Phase Change Monitor UI component
    Wire to socket for live condition updates.
    Wire historical rate from backtest results.
    Manual override toggles.

11. Build backtest engine (phaseChangeBacktest.js)
    Async job pattern.

12. Add backtest section to Backtest tab

13. Add forward test validation section

14. Add end-of-day outcome prompt

---

## Critical Constraints

Detection triggers on bar insert only.
Not on timer. Not on poll. Hook into existing pipeline.

Duplicate alert prevention:
Do not create new alert for same level_type within
15 minutes of prior alert at that level. One alert
per level per 15-minute window.

Delta unavailability:
If cum_delta and bid/ask volume both unavailable,
delta_source = UNAVAILABLE, condition shows N/A in UI,
condition does not count toward score automatically
but manual override still available.

Sample size always shown:
"from N historical events" mandatory next to any percentage.
If N < 10: show "Insufficient data (N events)" not a rate.

Backtest runs async:
Return jobId, poll status endpoint.
Never block request handler.

All timestamps in ET using existing timezone utilities.

All new components need tooltips.

1 CONTRACT MAX must remain visible in status bar
during any phase change alert condition.
SPECEOF
