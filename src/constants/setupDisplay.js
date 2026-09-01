// Setup-type display constants shared across App.jsx, ACDView.jsx, and CalendarView.jsx.
// Extracted 2026-07-13 — these lived as unexported consts in App.jsx before the view
// files were split out, which left ACDView.jsx/CalendarView.jsx referencing them as
// undefined globals (caught via the eslint no-undef check added the same day).

export const SETUP_DISPLAY_LABELS = {
  IB_BULLISH:              'IB Bullish',
  IB_BEARISH:              'IB Bearish',
  FAILED_SWEEP_REVERSAL_LONG:  'Failed Sweep ↑ (Setup B)',
  FAILED_SWEEP_REVERSAL_SHORT: 'Failed Sweep ↓ (Setup B)',
  OPENING_DRIVE_15MIN_LONG:  'Opening Drive ↑ (Setup D)',
  OPENING_DRIVE_15MIN_SHORT: 'Opening Drive ↓ (Setup D)',
  MOMENTUM_60m_60m_TREND_LONG:  '60m Momentum ↑ (Trend)',
  MOMENTUM_60m_60m_TREND_SHORT: '60m Momentum ↓ (Trend)',
  BRACKET_BREAKOUT_LONG:   'Bracket Break ↑',
  BRACKET_BREAKOUT_SHORT:  'Bracket Break ↓',
  OPEN_TEST_DRIVE_LONG:    'OTD Long ↑',
  OPEN_TEST_DRIVE_SHORT:   'OTD Short ↓',
  OPEN_DRIVE_LONG:         'Open Drive ↑',
  OPEN_DRIVE_SHORT:        'Open Drive ↓',
  TRT_LONG:                'TRT Long',
  TRT_SHORT:               'TRT Short',
  TRT_LONG_V2:             'TRT V2 Long',
  TRT_SHORT_V2:            'TRT V2 Short',
  TRT_MAH_LONG:            'MAH TRT Long',
  TRT_MAH_SHORT:           'MAH TRT Short',
  FAILED_AUCTION_LONG:     'Failed Auction ↑',
  FAILED_AUCTION_SHORT:    'Failed Auction ↓',
  VALUE_AREA_RESPONSIVE_LONG:  'VA Responsive ↑',
  VALUE_AREA_RESPONSIVE_SHORT: 'VA Responsive ↓',
  GAP_FILL_LONG:           'Gap Fill ↑',
  GAP_FILL_SHORT:          'Gap Fill ↓',
  FLOOR_R1_FADE_SHORT_TRAIL: 'Floor R1 Fade ↓ (Trail)',
  PW_HIGH_FADE_LONG_TRAIL:    'PW High Fade ↑ (Trail)',
  PD_POC_FADE_LONG_TRAIL:     'PD POC Fade ↑ (Trail)',
  FLOOR_S1_FADE_LONG_TRAIL:   'Floor S1 Fade ↑ (Trail)',
  DAILY_OPEN_FADE_LONG_TRAIL: 'Daily Open Fade ↑ (Trail)',
  CAM_S2_FADE_LONG_TRAIL:     'Cam S2 Fade ↑ (Trail)',
  STACK_VOL_BREAK_LIVE_LONG:  'Stack Vol Break ↑',
  STACK_VOL_BREAK_LIVE_SHORT: 'Stack Vol Break ↓',
  VWAP_RECLAIM_SHORT:         'VWAP Reclaim ↓',
  POC_ROTATION_JOIN_LONG:     'POC Rotation Join ↑',
  POC_ROTATION_JOIN_SHORT:    'POC Rotation Join ↓',
};

// Outcome display for a resolved/expired active_setups row (or a live price-vs-level
// resolution for a card not yet written back to the DB).
export const SETUP_RESOLUTION_TEXT = {
  TARGET_HIT:    { label: 'TARGET HIT',    color: '#22c55e', desc: 'Price reached T1 — target achieved. Nothing left to manage.' },
  STOP_HIT:      { label: 'STOP HIT',      color: '#ef4444', desc: 'Price hit the stop — setup is over. Nothing left to manage.' },
  TIME_EXPIRED:  { label: 'EXPIRED',       color: '#94a3b8', desc: 'Setup window closed without resolution.' },
  INVALIDATED:   { label: 'INVALIDATED',   color: '#f59e0b', desc: 'Price structure invalidated this setup before/after it triggered.' },
  SESSION_CLOSED:{ label: 'SESSION CLOSED',color: '#94a3b8', desc: 'Session ended with this setup unresolved.' },
  PREMISE_BROKEN:{ label: 'PREMISE BROKEN',color: '#ef4444', desc: 'Trade premise invalidated — price broke OR Low (for long) or OR High (for short).' },
  JUICE_EXHAUSTED:{ label: 'JUICE EXHAUSTED',color: '#94a3b8', desc: 'Morning drive exhausted — remaining profit potential is too low.' },
  TRAIL_EXIT:    { label: 'TRAIL EXIT',     color: '#22c55e', desc: 'Target reached, stop moved to breakeven and trailed — exited on the trail (breakeven or better).' },
};

export const CAL_SETUP_SHORT_LABELS = {
  BRACKET_BREAKOUT_LONG:        'BB LONG',
  BRACKET_BREAKOUT_SHORT:       'BB SHORT',
  OPEN_TEST_DRIVE_LONG:         'OTD LONG',
  OPEN_TEST_DRIVE_SHORT:        'OTD SHORT',
  OPEN_DRIVE_LONG:              'OD LONG',
  OPEN_DRIVE_SHORT:             'OD SHORT',
  OPENING_DRIVE_15MIN_LONG:     'OD15 LONG',
  OPENING_DRIVE_15MIN_SHORT:    'OD15 SHORT',
  IB_BULLISH:                   'IB BULL',
  IB_BEARISH:                   'IB BEAR',
  TRT_LONG:                     'TRT LONG',
  TRT_SHORT:                    'TRT SHORT',
  TRT_LONG_V2:                  'TRT2 L',
  TRT_SHORT_V2:                 'TRT2 S',
  TRT_MAH_LONG:                 'MAH LONG',
  TRT_MAH_SHORT:                'MAH SHORT',
  C_STANDALONE_UP:              'C UP',
  C_STANDALONE_DOWN:            'C DOWN',
  FAILED_AUCTION_LONG:          'FA LONG',
  FAILED_AUCTION_SHORT:         'FA SHORT',
  VALUE_AREA_RESPONSIVE_LONG:   'VAR LONG',
  VALUE_AREA_RESPONSIVE_SHORT:  'VAR SHORT',
  GAP_FILL_LONG:                'GAP LONG',
  GAP_FILL_SHORT:                'GAP SHORT',
};

// Direction: teal = LONG, coral = SHORT. NOT green-for-everything.
export const LR_TEAL  = '#2dd4bf';
export const LR_CORAL = '#fb923c';
export const LR_AMBER = '#f59e0b';
export const LR_SLATE = '#94a3b8';

export const dirClr = (dir) => dir === 'LONG' ? LR_TEAL : dir === 'SHORT' ? LR_CORAL : dir === 'NO ACD' ? '#fbbf24' : LR_SLATE;
