// All tooltip content in one place.
// Components import from here — no tooltip text hardcoded in component files.
// Max 80 words per tooltip per spec. Source attribution required.

export const TOOLTIPS = {

  // ── Confluence Score ────────────────────────────────────────────────────────
  CONFLUENCE_SCORE: {
    text: 'Counts how many independent frameworks agree with the current directional bias. Higher scores mean more structural support. Based on Dalton\'s Market Profile, Fisher\'s ACD Number Line, and session opening conditions. Not a signal — a measure of structural alignment.',
    source: 'Dalton, Fisher, Steidlmayer',
  },
  C1_NL30: {
    text: 'The 30-day ACD Number Line rolling sum. Fisher defines a confirmed trend as above +9 (bullish) or below -9 (bearish). Between these thresholds the market has no sustained OTF conviction.',
    source: 'Fisher — The Logical Trader',
  },
  C2_NL10: {
    text: 'Compares the 10-day rolling sum to the 30-day. When both point the same direction, short-term momentum confirms the longer-term trend. When they diverge — 30-day bullish but 10-day falling — trend momentum is weakening. Early warning, not a reversal signal.',
    source: 'Fisher — The Logical Trader',
  },
  C3_OPEN_VS_VALUE: {
    text: 'Where today\'s open sits relative to yesterday\'s value area (70% of volume). Opening above value advertises higher prices. Opening below advertises lower. Opening inside means balance expected.',
    source: 'Dalton — Markets in Profile',
  },
  C4_OVERNIGHT_INVENTORY: {
    text: 'Whether overnight participants are trapped in a losing position. Short-trapped means overnight sellers may be forced to cover if price moves up — that covering fuel can accelerate a bullish open. Neutral means no forced activity.',
    source: 'Dalton — Mind Over Markets',
  },
  C5_MARKET_STATE: {
    text: 'Whether the environment favors initiative (trending) or responsive (balanced) strategy. Inefficient markets have vertical profiles and migrating value — go with extensions. Efficient markets have horizontal profiles — fade extremes.',
    source: 'Steidlmayer — Markets in Profile',
  },
  C6_MONTHLY_PIVOT: {
    text: 'Whether price is above or below the monthly pivot (prior month H+L+C / 3). Fisher\'s highest timeframe filter. Above = monthly auction favors buyers. Below = favors sellers.',
    source: 'Fisher — The Logical Trader',
  },
  C7_VALUE_MIGRATION: {
    text: 'Whether the value area has been moving consistently in the bias direction over the last 5 sessions. Value migrating higher = market accepting higher prices over multiple days. Price moving without value migration is weak and likely to revert.',
    source: 'Dalton — Markets in Profile',
  },
  C8_OR_CONDITION: {
    text: 'Quality of the Opening Range in the first 5 minutes. Narrow ORs indicate compression before expansion — best quality for A signal breakouts. Wide or emotional ORs tend to produce rotation, not trend.',
    source: 'Fisher — The Logical Trader',
  },
  C9_OPENING_CALL: {
    text: 'How the market opened. Open Drive = immediate directional move, highest OTF conviction. Open Test Drive = tested one direction, found no business, drove the other way. Both are high-conviction opens.',
    source: 'Fisher — The Logical Trader',
  },
  C10_A_SIGNAL_ALIGNED: {
    text: 'Whether the ACD A signal fired in the same direction as the structural bias. An A Up in a NL30 bullish environment has 30 sessions of OTF buyer backing. Counter-trend A signals score 0 — still valid intraday but lacking structural support.',
    source: 'Fisher — The Logical Trader',
  },
  C11_A_SIGNAL_QUALITY: {
    text: 'How the A signal fired. Strong = immediate drive, held above A level without returning to OR. Weak = slow grind, overlapping bars, marginal hold. Failed = trap, potential reversal setup.',
    source: 'Fisher — The Logical Trader',
  },
  C12_C_SIGNAL: {
    text: 'C fires when price closes a bar above OR High (C Up) or below OR Low (C Down) after a pullback from the A level. A + C means buyers or sellers showed up twice — at A and again after a pullback. Fisher\'s highest quality daily signal.',
    source: 'Fisher — The Logical Trader',
  },

  // ── Big Picture ─────────────────────────────────────────────────────────────
  BIG_PICTURE_COMPONENTS_ALIGNED: {
    text: 'Counts structural components aligned in the same direction: NL30, value migration, bracket state, value migration rate, monthly pivot, profile sequence. Not a trade signal. Higher alignment = more multi-timeframe structural support.',
  },
  BIG_PICTURE_BULLISH_STRUCTURE: {
    text: 'Structural context only — not a trade signal. Means the majority of longer-term indicators align bullish. A bearish intraday session is normal and valid within a bullish structural backdrop.',
  },
  BIG_PICTURE_BRACKET_TILTING: {
    text: 'A bracket is overlapping value areas — market in balance. Tilting bullish means value is slowly migrating higher within the bracket. The bracket itself is still intact — breakouts have not yet been confirmed by a full session of value above the bracket boundary.',
    source: 'Dalton — Markets in Profile',
  },
  BIG_PICTURE_TRANSITIONAL: {
    text: 'The last 5 sessions show different behavior from the last 10. The most dangerous condition — prior setups stop working before the new direction confirms. Reduce size significantly until 5-day and 10-day re-align.',
    source: 'Steidlmayer — Markets in Profile',
  },

  // ── Structure Tab — ACD Number Line ─────────────────────────────────────────
  NL30_DISPLAY: {
    text: 'Rolling 30-session sum of daily ACD scores. Each day: +4 (A and C confirmed), +1 (A only), 0 (no signal), -1 (A Down only), -4 (A and C Down). Above +9 = confirmed bullish trend. Below -9 = confirmed bearish. Between = ranging.',
    source: 'Fisher — The Logical Trader',
  },
  NL10_DISPLAY: {
    text: 'Rolling 10-session sum. Detects momentum divergence within the 30-day trend. When 10-day falls while 30-day stays high, short-term conviction is weakening — trail stops tighter, reduce new position sizing.',
    source: 'Fisher — The Logical Trader',
  },
  NL5_DISPLAY: {
    text: 'Rolling 5-session sum. Most sensitive to recent activity. Directional lean only — too short for reliable trend classification.',
    source: 'Fisher — The Logical Trader',
  },

  // ── Structure Tab — Value Area Migration ────────────────────────────────────
  VA_MIGRATION_CHART: {
    text: 'Each bar = one session\'s value area (70% of volume). Green = migrated higher than prior session. Red = migrated lower. Gray = overlapping — market in balance. POC tick = highest volume price. Value migration is the most reliable confirmation of a sustained trend.',
    source: 'Dalton — Markets in Profile',
  },
  VA_MIGRATION_HIGHER: {
    text: 'Value consistently moving upward across recent sessions. Market is accepting higher prices over time — not just trading there temporarily. Price moving without value migration is weak and likely to revert.',
  },

  // ── Structure Tab — Bracket/Trend State ─────────────────────────────────────
  BRACKET_STATE: {
    text: 'Consecutive value areas are overlapping — market in balance. Neither side has sustained control. Occurs approximately 75% of the time per Dalton. Strategy: fade the extremes, buy VAL, sell VAH. Do not expect breakouts to hold until a full session of value closes outside the bracket.',
    source: 'Dalton — Markets in Profile',
  },
  BRACKET_CONFIDENCE_HIGH: {
    text: 'Based on how many of the last 5 sessions have overlapping value areas. High = 4 or 5 of 5 overlapping. Moderate = 3 of 5. Low = 2 of 5.',
  },

  // ── Structure Tab — Volume Effort vs Result ─────────────────────────────────
  EFFORT_ABSORPTION: {
    text: 'High volume relative to 20-day average but narrow resulting price range. Heavy effort without proportional result — someone is absorbing the activity. In an uptrend, signals sellers meeting every rally. Two+ consecutive absorption sessions after an extended trend is a significant warning sign.',
    source: 'Weis — Trades About to Happen',
  },
  EFFORT_EASE: {
    text: 'Wide price range with lighter than average volume. Price moved without resistance. Confirms directional bias has structural support at the daily timeframe.',
    source: 'Weis — Trades About to Happen',
  },

  // ── Auction Read — Phase 1 field tooltips ───────────────────────────────────
  OVERNIGHT_INVENTORY: {
    text: 'Were overnight Globex traders mostly long or short coming into RTH? Short-trapped = overnight sellers may be forced to cover if price moves higher, adding fuel to a bullish open. Not about predicting direction — about identifying potential forced activity.',
    source: 'Dalton — Mind Over Markets',
  },
  OPEN_VS_PRIOR_VALUE: {
    text: 'Today\'s opening price vs yesterday\'s value area. Above value = bullish advertising. Inside = balanced day expected. Below = bearish advertising.',
    source: 'Dalton — Markets in Profile',
  },
  PRIOR_DAY_PROFILE: {
    text: 'Yesterday\'s Market Profile shape. Trend = strong directional conviction. Normal Variation = moderate OTF participation. Normal = limited range. Neutral = both sides tested. Running Neutral = neutral structure but closed near extreme — precedes directional follow-through. Nontrend = narrow range, awaiting catalyst.',
    source: 'Dalton + Steidlmayer',
  },
  MONTHLY_PIVOT_FIELD: {
    text: 'Whether price is above, inside, or below the monthly pivot (prior month H+L+C / 3). Fisher\'s highest timeframe filter for directional bias.',
    source: 'Fisher — The Logical Trader',
  },

  // ── Playbook tab ─────────────────────────────────────────────────────────────
  PLAYBOOK_BLOWN_OUT: {
    text: 'The most common behavior pattern that causes losses in this specific structural environment. Understanding what kills traders here is as important as knowing the edge.',
  },
  PLAYBOOK_EDGE: {
    text: 'The specific setup with highest probability in this structural environment. Only works if executed consistently — do not evaluate on a single trade.',
  },

  // ── Composite TPO Profile ───────────────────────────────────────────────────
  TPO_PROFILE: {
    text: 'Counts every 1-minute bar\'s contribution to each price level. Purely time-based — shows where the market spent the most time, independent of volume spikes. POC = price with most time spent (strongest magnet). Value area = 70% of time spent.',
  },
  TPO_HVN: {
    text: 'High Volume Node — a local peak in the time distribution. Price slows and rotates here. Strong support or resistance because the market has demonstrated willingness to transact heavily at this level.',
  },
  TPO_LVN: {
    text: 'Low Volume Node — a thin area where price barely spent time. Price moves fast through these. Expect breakouts and quick moves, not consolidation. Often gaps or fast moves in bar charts.',
  },
};
