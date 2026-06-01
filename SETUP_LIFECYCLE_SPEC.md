# Setup Card Lifecycle & Trade Timeline Spec

## Overview

Three connected features:
1. Setup cards auto-appear and auto-disappear based on real-time detection from live bar feed
2. When a setup card expires or resolves, it drops automatically to the Trade Timeline
3. The Trade Timeline is cleaned up — only statistically significant setups shown

---

## Table 1 — active_setups

CREATE TABLE active_setups (
  id SERIAL PRIMARY KEY,
  trade_date DATE NOT NULL DEFAULT CURRENT_DATE,
  setup_type VARCHAR(30) NOT NULL,
  fired_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP,
  resolved_at TIMESTAMP,
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
  resolution VARCHAR(20),
  entry_zone_low NUMERIC,
  entry_zone_high NUMERIC,
  stop_level NUMERIC,
  t1_level NUMERIC,
  t1_label VARCHAR(30),
  structural_level_touched NUMERIC,
  structural_level_type VARCHAR(30),
  price_at_detection NUMERIC,
  price_at_resolution NUMERIC,
  historical_win_rate NUMERIC,
  historical_sessions INTEGER,
  historical_avg_pnl NUMERIC,
  historical_t1_hit_rate NUMERIC,
  historical_source VARCHAR(20),
  nl30_at_detection INTEGER,
  structural_state_at_detection VARCHAR(30),
  confluence_score_at_detection INTEGER,
  actual_outcome VARCHAR(20),
  actual_pnl NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_as_trade_date ON active_setups(trade_date);
CREATE INDEX idx_as_status ON active_setups(status);
CREATE INDEX idx_as_fired_at ON active_setups(fired_at);

Setup type values:
TRT_SHORT, TRT_LONG, TRT_MAH_SHORT, TRT_MAH_LONG,
IB_BEARISH, IB_BULLISH,
OPEN_DRIVE_LONG, OPEN_DRIVE_SHORT,
C_REVERSAL_SHORT, C_REVERSAL_LONG,
C_STANDALONE_UP, C_STANDALONE_DOWN,
FAILED_AUCTION_SHORT, FAILED_AUCTION_LONG,
VALUE_AREA_RESPONSIVE_LONG, VALUE_AREA_RESPONSIVE_SHORT,
BRACKET_BREAKOUT_LONG, BRACKET_BREAKOUT_SHORT

Status values: ACTIVE, EXPIRED, RESOLVED
Resolution values: TARGET_HIT, STOP_HIT, TIME_EXPIRED, INVALIDATED

---

## Table 2 — trade_timeline_events

CREATE TABLE IF NOT EXISTS trade_timeline_events (
  id SERIAL PRIMARY KEY,
  trade_date DATE NOT NULL DEFAULT CURRENT_DATE,
  event_time TIMESTAMP NOT NULL,
  event_type VARCHAR(20) NOT NULL,
  setup_type VARCHAR(30),
  setup_id INTEGER REFERENCES active_setups(id),
  direction VARCHAR(5),
  entry_zone NUMERIC,
  stop_level NUMERIC,
  t1_level NUMERIC,
  t1_label VARCHAR(30),
  structural_level VARCHAR(30),
  resolution VARCHAR(20),
  price_at_resolution NUMERIC,
  historical_win_rate NUMERIC,
  historical_sessions INTEGER,
  window_duration_minutes INTEGER,
  signal_type VARCHAR(20),
  signal_price NUMERIC,
  signal_quality VARCHAR(10),
  alert_type VARCHAR(30),
  conditions_met INTEGER,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(setup_id)
);

CREATE INDEX idx_tte_trade_date ON trade_timeline_events(trade_date);
CREATE INDEX idx_tte_event_time ON trade_timeline_events(event_time);

event_type values: SETUP, SIGNAL, ALERT, SESSION_OPEN, SESSION_CLOSE, PHASE_CHANGE

---

## Setup Detection — Extend Existing Pattern

All detection stays in GET /api/acd/setup-detection.
Add new setup blocks following the existing pattern:
each block is a let with comment header, produces
null or an object, timestamp via INSERT ON CONFLICT DO NOTHING.

### TRT Detection (Trend Reversal Trade)

TRT SHORT fires when ALL of these are true in sequence today:
1. A_UP event exists in acd_setup_events for today
2. C_UP event exists for today (fired after A_UP)
3. Current bar closes BELOW the OR low (C Down condition)
4. Current bar close is also BELOW the A Up level

Result: { type: 'TRT_SHORT', direction: 'SHORT',
  entry: current close,
  stop: high of the failed A Up move,
  target: nearest structural support below,
  targetLabel: 'Prior Day VAL' or 'Composite VAL',
  description: 'A Up + C Up both failed. Trapped buyers fuel reversal.' }

TRT LONG fires when:
1. A_DOWN event exists today
2. C_DOWN event exists today
3. Current bar closes ABOVE the OR high
4. Current bar close is also ABOVE the A Down level

### TRT + MAH Detection

Same as TRT but additionally:
- nl_30day > 15 for BULL MAH, nl_30day < -15 for BEAR MAH
- At least 10 consecutive sessions where nl_30day stayed above +9 (bull) or below -9 (bear)
- Check acd_daily_log for consecutive extreme sessions

When both TRT and MAH conditions are met, use type TRT_MAH_SHORT or TRT_MAH_LONG.
MAH = "Mad As Hell" — extended trend exhaustion, not "Monthly A High".

### IB Confirmation Detection

IB_BEARISH fires when:
- IB is complete (time >= 10:00 AM ET)
- IB close (last bar before 10:00) is below IB midpoint
- Sum of bid_volume > sum of ask_volume during IB bars
- (sellers dominated the initial balance)

IB_BULLISH fires when:
- IB close is above IB midpoint
- Sum of ask_volume > sum of bid_volume during IB bars

IB midpoint = (ib_high + ib_low) / 2
IB bars = price_bars where ts between 9:30 and 10:00 ET

### Open Drive Detection

OPEN_DRIVE_LONG fires when:
- opening_call_type = 'OPEN_DRIVE' in auction_reads
- Drive direction is UP (first 15-min close > open)
- Price has pulled back to within 15 points of OR High
  without closing below OR Low

OPEN_DRIVE_SHORT fires when:
- opening_call_type = 'OPEN_DRIVE'
- Drive direction is DOWN
- Price has pulled back to within 15 points of OR Low
  without closing above OR High

### C Reversal Detection

C_REVERSAL_SHORT fires when:
- A_UP event exists today (A Up fired earlier)
- Current bar closes below OR Low (C Down condition)
- This is the FIRST C signal today

C_REVERSAL_LONG fires when:
- A_DOWN event exists today
- Current bar closes above OR High (C Up condition)
- This is the FIRST C signal today

### C Standalone Detection

C_STANDALONE_UP fires when:
- NO A_UP or A_DOWN event exists today
- Current bar closes above OR High for first time today

C_STANDALONE_DOWN fires when:
- NO A_UP or A_DOWN event exists today
- Current bar closes below OR Low for first time today

### Failed Auction Detection

FAILED_AUCTION_SHORT fires when:
- Price touched a structural level (within 5 points of
  composite VAH, IB High, or Overnight High)
- Within the next 3 bars price closed back below that level
- Volume on the approach bar was > 1.5x the 20-bar average volume

FAILED_AUCTION_LONG fires same logic at support levels
(composite VAL, IB Low, Overnight Low).

### Value Area Responsive Detection

VALUE_AREA_RESPONSIVE_SHORT fires when:
- open_vs_prior_value = 'INSIDE_VALUE' in auction_reads
- opening_call_type != 'OPEN_DRIVE'
- Current price within 20 points of composite VAH
- bracket_state = 'BRACKET'

VALUE_AREA_RESPONSIVE_LONG fires at composite VAL
with same conditions.

### Bracket Breakout Detection

BRACKET_BREAKOUT_LONG fires when:
- bracket_state was BRACKET for 3+ consecutive sessions
  (check last 3 rows of acd_daily_log or structure table)
- Today's developing value area (VAH) is entirely above
  the prior bracket high
- nl30 direction is BULLISH (nl_30day > 9)

BRACKET_BREAKOUT_SHORT fires same logic to downside.

---

## Priority Order

Only ONE setup shows as ACTIVE at a time.
Use same pattern as existing: const active = s1 || s2 || ...

Priority (highest first):
1. TRT_MAH_SHORT / TRT_MAH_LONG
2. TRT_SHORT / TRT_LONG
3. IB_BEARISH / IB_BULLISH
4. OPEN_DRIVE_LONG / OPEN_DRIVE_SHORT
5. C_REVERSAL_SHORT / C_REVERSAL_LONG
6. FAILED_AUCTION_SHORT / FAILED_AUCTION_LONG
7. BRACKET_BREAKOUT_LONG / BRACKET_BREAKOUT_SHORT
8. VALUE_AREA_RESPONSIVE_LONG / VALUE_AREA_RESPONSIVE_SHORT
9. C_STANDALONE_UP / C_STANDALONE_DOWN

---

## Expiry Rules

Expiry lookup table (minutes from fired_at):
TRT_SHORT / TRT_LONG: 50 minutes
TRT_MAH_SHORT / TRT_MAH_LONG: 50 minutes
IB_BEARISH / IB_BULLISH: session close (11:00 AM ET)
OPEN_DRIVE_LONG / OPEN_DRIVE_SHORT: session close
C_REVERSAL_SHORT / C_REVERSAL_LONG: 40 minutes
C_STANDALONE_UP / C_STANDALONE_DOWN: session close
FAILED_AUCTION_SHORT / FAILED_AUCTION_LONG: 30 minutes
VALUE_AREA_RESPONSIVE: session close
BRACKET_BREAKOUT: structural only (no time expiry)

Structural invalidation:
- OPEN_DRIVE_LONG: expires if price closes below OR Low
- BRACKET_BREAKOUT_LONG: expires if price closes back inside bracket
- VALUE_AREA_RESPONSIVE_LONG: expires if price closes outside value area
- All setups: expire at 11:00 AM ET regardless of window

Resolution:
- TARGET_HIT: price reaches t1_level
- STOP_HIT: price reaches stop_level
- TIME_EXPIRED: window elapsed
- INVALIDATED: structural invalidation

---

## Probability Display

Each setup card shows two probability lines:

Line 1 — Overall historical rate:
IB_BEARISH/BULLISH: 87.5%, 32 sessions, source: Edge Analysis ★★★
OPEN_DRIVE: 70.1%, 167 sessions, source: Edge Analysis ★★★
TRT: pull from condition_memory by nl30_bucket + structural_state
FAILED_AUCTION: pull from phase_change_backtest_results
Others: pull from condition_memory

Line 2 — Current condition rate:
Pull from condition_memory filtered by today's structural_state
and nl30_bucket. Show session count.
If sessions < 20: show "N sessions — building data"

Three timeframes on card:
All time: X% (N sessions)
Last 90d: X% (N sessions)
Last 30d: X% (N sessions) — "building" if N < 10

Trend: IMPROVING / STABLE / DEGRADING
(5% threshold vs all-time rate)

Star ratings: ★★★ p<0.001, ★★ p<0.01, ★ p<0.05

---

## Drop to Timeline

When setup transitions to EXPIRED or RESOLVED:
INSERT into trade_timeline_events using fired_at as event_time.
Never use current timestamp — always use fired_at from active_setups.

Timeline entry resolution color coding:
GREEN: TARGET_HIT
RED: STOP_HIT or TIME_EXPIRED
GRAY: MISSED (no matching trade in trades table)
AMBER: INVALIDATED

---

## Timeline Cleanup Rules

1. Default filter: Significant Only (p < 0.05, >= 20 sessions or >= 30 overall)
   Filter pills: [All] [Significant Only] [Taken] [Missed] [Target Hit] [Stopped]

2. Setups that PASS significance:
   IB Confirmation, Open Drive, TRT, C Reversal, Failed Auction at 4/5 conditions

3. Setups BUILDING (show in All, not in Significant Only):
   Value Area Responsive, TRT+MAH, C Standalone, Bracket Breakout

4. Overlap consolidation:
   Two setups within 5 minutes same direction: merge into one entry showing both
   Two setups within 5 minutes opposite direction: show conflict warning

5. One active card maximum at all times

---

## API Routes

GET  /api/setups/active         — today's ACTIVE setups
GET  /api/setups/today          — all today's setups for timeline
POST /api/setups/:id/outcome    — update actual_outcome and actual_pnl
GET  /api/setups/stats          — rolling performance by setup type
GET  /api/timeline/today        — trade_timeline_events ordered by event_time

---

## Socket.io Events

setup-detected: { setupId, setupType, firedAt (from DB), entryZone, stopLevel, t1Level, probability, sessions, windowMinutes }
setup-expired: { setupId, resolution, priceAtResolution }
setup-resolved: { setupId, resolution, priceAtResolution }
timeline-updated: { date }

---

## Implementation Order

1. Create active_setups table
2. Create trade_timeline_events table
3. Add new setup blocks to existing detection endpoint in acd.js
   following the exact existing pattern (let block, comment header,
   null or object, INSERT ON CONFLICT DO NOTHING for timestamp)
4. Add expiration checker — runs on each bar insert
5. Build dropToTimeline() function
6. Build probability lookup for each setup type
7. Add /api/setups routes
8. Add /api/timeline routes
9. Update setup card UI:
   - Read from active_setups
   - Add probability display (two lines + three timeframes)
   - Add window countdown
   - Wire to socket events
10. Build/update Trade Timeline component:
    - Read from trade_timeline_events
    - Add filter pills (default: Significant Only)
    - Wire to timeline-updated socket event
11. Apply cleanup rules: significance filter, overlap consolidation, conflict flagging

---

## Critical Rules

TIMESTAMP: fired_at set at detection time in backend only.
Test: reload page 10 min after setup fires — time must not change.

SAMPLE SIZE: always show N next to win rate percentage.

ONE ACTIVE CARD: only highest priority shows as ACTIVE.
Others drop directly to timeline as LOGGED.

NO CARRYOVER: all ACTIVE setups expire at 11:00 AM ET.

SIGNIFICANCE DEFAULT: timeline shows Significant Only by default.
