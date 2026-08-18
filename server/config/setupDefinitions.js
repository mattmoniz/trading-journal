/**
 * setupDefinitions.js — single source of truth for what each setup FAMILY *is*: its
 * entry criteria, its detection window, and its data provenance. Not live performance
 * data (that's SETUP_STATUS/OPTIMAL_STOP, always live-queried, never hand-typed here).
 *
 * WHY THIS EXISTS:
 * A 2026-07-20 session spent real time re-explaining the same handful of facts about
 * this system's setups — which window each one fires in, why OR/IB differ from prior-
 * period levels, which 4 setups can fire outside RTH, why ONH/ONL can't. None of that
 * lived anywhere a person could read it; it only existed as scattered code comments and
 * this session's own conversation. This file is the fix: one place, keyed by the same
 * base level names already used in server/config/setupTypes.js and
 * scripts/backtest_unified.js's fadeLevels.
 *
 * WHAT BELONGS HERE vs NOT:
 * - Criteria, window, formation gate, family: belongs here (structural, rarely changes).
 * - N, WR, EV, live status, stop/target: does NOT belong here — always read from
 *   SETUP_STATUS/OPTIMAL_STOP live (server/routes/acd.js's /api/setups/reference joins
 *   this file against those tables). Hand-typing a performance number here would be the
 *   exact "never hand-type a WR%/N/$ literal" anti-pattern CLAUDE.md has caught 7 times.
 *
 * ADDING A NEW LEVEL-FADE FAMILY: add one entry to LEVEL_FADE_DEFINITIONS below, pick
 * the right WINDOW_RULES category. If it's genuinely a new category (not prior-period,
 * not same-day-forming, not day-type-conditional), add a new WINDOW_RULES entry first
 * and explain why — don't reuse an existing category for a level that doesn't fit it.
 */

// ── Window rule categories — the shared behavior every level in a category follows ──
export const WINDOW_RULES = {
  PRIOR_PERIOD: {
    label: 'Prior-period level',
    windowDescription: 'RTH-only today (9:30 AM–4:00 PM ET) — the level itself is fully known before today\'s session even opens, so there is no formation-timing constraint on WHEN it can be tested. RTH-only is the current live scope; a 2026-07-20 backtest found ~26% of these families change EV sign under a wider (24hr) window — see docs/WIDER_WINDOW_BACKTEST_20260720.md, not yet implemented live.',
    formationGate: 570, // 9:30 AM ET — RTH open, not a real constraint, just where scanning starts
  },
  SAME_DAY_FORMING: {
    label: 'Same-day-forming level',
    windowDescription: 'Valid from its own formation until the NEXT occurrence of that same formation event supersedes it (e.g. today\'s Initial Balance is tradeable from 10:30 AM today through 10:30 AM tomorrow, at which point it becomes PD_IB_HIGH/LOW — a separate, already-covered prior-period level). Currently only tested at this width in a 2026-07-20 backtest (docs/WIDER_WINDOW_BACKTEST_20260720.md); live detection is still RTH-only pending that decision.',
  },
  OVERNIGHT_RANGE: {
    label: 'Overnight range (special case — do not treat like other same-day levels)',
    windowDescription: 'RTH-only (9:30 AM–4:00 PM ET), and genuinely bound to that window, unlike OR/IB. Defined as "Globex 18:00 prior ET → 09:29 current ET" (scripts/compute_levels.js) — not finalized until 9:29 AM, and a NEW overnight range starts forming the moment the next Globex session opens at 18:00 the same evening, so there is no sensible wider-window extension the way OR/IB have one. A 2026-07-20 backtest attempt that tested this incorrectly (activated the level at 18:00, before it finalized) produced a catastrophic false-negative EV flip that was a lookahead artifact, not a real finding — see docs/WIDER_WINDOW_BACKTEST_20260720.md\'s caveat section.',
    formationGate: 570,
  },
  GLOBEX_CAPABLE: {
    label: 'Globex-capable (fires 24 hours)',
    windowDescription: 'The ONLY level-fade family with a genuine live 24-hour firing path — detectGlobexSetup() (server/routes/acd.js) fires these during the 6 PM–8:30 AM ET Globex window, separately from the main RTH keepLevelsAll candidates array. KNOWN GAP: its stop/target is read from UNIFIED_BACKTEST rows computed exclusively from RTH touches (detectLevelFades() never analyzes overnight bars) — so the one path that fires 24 hours is sized off data that only describes daytime touch behavior. Flagged as OPEN_DECISION globex_pd_level_stops_calibrated_on_rth_only_data (MEDIUM).',
    formationGate: 570,
  },
  DAY_TYPE_CONDITIONAL: {
    label: 'Day-type conditional',
    windowDescription: 'Fires during RTH but is managed per-day-type (TREND/BALANCE/TURBULENT), not by the standard blended SUPPRESS/ACTIVE gate — blended EV mixes a genuinely strong day-type with a genuinely weak one. See DAY_TYPE_ALPHA in performance_audit for the real per-day-type breakdown before trusting the blended number.',
    formationGate: 630, // IB must close before day-type is classified
  },
  MOMENTUM_PATTERN: {
    label: 'Momentum/pattern signal (not a level fade)',
    windowDescription: 'Detected via bar-window statistical conditions (momentum, absorption, stop-sweep shape), not a touch of a specific price level. Window varies by signal — check the detecting script directly (minuteBarSignalDetector.js or the relevant backtest_*.mjs) rather than assuming RTH-only.',
  },
};

// ── Level-fade families (keyed by the base name used in fadeLevels/CONDITIONAL_VARIANTS) ──
// levelDesc is intentionally short (a phrase, not a paragraph) — the full criteria
// sentence is assembled from the category template + this phrase, so a description
// change here doesn't require touching prose in N places.
export const LEVEL_FADE_DEFINITIONS = {
  // Prior day
  PD_POC:           { rule: 'PRIOR_PERIOD', displayName: 'Prior Day POC', levelDesc: "prior trading day's volume point of control" },
  PD_VAH:           { rule: 'PRIOR_PERIOD', displayName: 'Prior Day VAH', levelDesc: "prior trading day's value area high" },
  PD_VAL:           { rule: 'PRIOR_PERIOD', displayName: 'Prior Day VAL', levelDesc: "prior trading day's value area low" },
  PD_HIGH:          { rule: 'PRIOR_PERIOD', displayName: 'Prior Day High', levelDesc: "prior trading day's session high" },
  PD_LOW:           { rule: 'PRIOR_PERIOD', displayName: 'Prior Day Low', levelDesc: "prior trading day's session low" },
  PD_CLOSE:         { rule: 'PRIOR_PERIOD', displayName: 'Prior Day Close', levelDesc: "prior trading day's close" },
  PD_IB_HIGH:       { rule: 'PRIOR_PERIOD', displayName: 'Prior Day IB High', levelDesc: "prior trading day's Initial Balance high" },
  PD_IB_LOW:        { rule: 'PRIOR_PERIOD', displayName: 'Prior Day IB Low', levelDesc: "prior trading day's Initial Balance low" },
  PD_IB_MID:        { rule: 'PRIOR_PERIOD', displayName: 'Prior Day IB Mid', levelDesc: "midpoint of prior trading day's Initial Balance" },
  PD_OR_MID:        { rule: 'PRIOR_PERIOD', displayName: 'Prior Day OR Mid', levelDesc: "midpoint of prior trading day's Opening Range" },
  PD_SESSION_MID:   { rule: 'PRIOR_PERIOD', displayName: 'Prior Day Session Mid', levelDesc: "midpoint of prior trading day's high/low" },
  // Floor pivots (from prior day H/L/C)
  FLOOR_PIVOT:      { rule: 'PRIOR_PERIOD', displayName: 'Floor Pivot', levelDesc: 'standard floor pivot from prior day H/L/C' },
  FLOOR_R1:         { rule: 'PRIOR_PERIOD', displayName: 'Floor R1', levelDesc: 'first floor resistance pivot' },
  FLOOR_R2:         { rule: 'PRIOR_PERIOD', displayName: 'Floor R2', levelDesc: 'second floor resistance pivot' },
  FLOOR_R3:         { rule: 'PRIOR_PERIOD', displayName: 'Floor R3', levelDesc: 'third floor resistance pivot' },
  FLOOR_S1:         { rule: 'PRIOR_PERIOD', displayName: 'Floor S1', levelDesc: 'first floor support pivot' },
  FLOOR_S2:         { rule: 'PRIOR_PERIOD', displayName: 'Floor S2', levelDesc: 'second floor support pivot' },
  FLOOR_S3:         { rule: 'PRIOR_PERIOD', displayName: 'Floor S3', levelDesc: 'third floor support pivot' },
  // Camarilla pivots
  CAM_R1: { rule: 'PRIOR_PERIOD', displayName: 'Camarilla R1', levelDesc: 'Camarilla R1 pivot' },
  CAM_R2: { rule: 'PRIOR_PERIOD', displayName: 'Camarilla R2', levelDesc: 'Camarilla R2 pivot' },
  CAM_R3: { rule: 'PRIOR_PERIOD', displayName: 'Camarilla R3', levelDesc: 'Camarilla R3 pivot' },
  CAM_R4: { rule: 'PRIOR_PERIOD', displayName: 'Camarilla R4', levelDesc: 'Camarilla R4 pivot (breakout-tier)' },
  CAM_S1: { rule: 'PRIOR_PERIOD', displayName: 'Camarilla S1', levelDesc: 'Camarilla S1 pivot' },
  CAM_S2: { rule: 'PRIOR_PERIOD', displayName: 'Camarilla S2', levelDesc: 'Camarilla S2 pivot' },
  CAM_S3: { rule: 'PRIOR_PERIOD', displayName: 'Camarilla S3', levelDesc: 'Camarilla S3 pivot' },
  CAM_S4: { rule: 'PRIOR_PERIOD', displayName: 'Camarilla S4', levelDesc: 'Camarilla S4 pivot (breakout-tier)' },
  // Opens
  DAILY_OPEN:   { rule: 'PRIOR_PERIOD', displayName: "Today's Open", levelDesc: "today's 9:30 AM opening price (known instantly at session start)" },
  WEEKLY_OPEN:  { rule: 'PRIOR_PERIOD', displayName: 'Weekly Open', levelDesc: "this week's Monday opening price" },
  MONTHLY_OPEN: { rule: 'PRIOR_PERIOD', displayName: 'Monthly Open', levelDesc: "this month's first trading day opening price" },
  // VWAP
  WEEKLY_VWAP:  { rule: 'PRIOR_PERIOD', displayName: 'Weekly VWAP', levelDesc: 'week-to-date volume-weighted average price' },
  MONTHLY_VWAP: { rule: 'PRIOR_PERIOD', displayName: 'Monthly VWAP', levelDesc: 'month-to-date volume-weighted average price' },
  // Ordinary close-range touch of the running (developing) RTH VWAP -- distinct from
  // VWAP_MAGNET_LONG/SHORT (OTHER_SETUP_DEFINITIONS below), which only fires on a rare
  // sigma-distance departure. This is the same 15pt-proximity mechanism every other level
  // here uses, just applied to a moving rather than fixed level. Added 2026-07-28.
  RTH_VWAP:     { rule: 'PRIOR_PERIOD', displayName: 'RTH VWAP', levelDesc: 'running (developing) RTH volume-weighted average price' },
  // Rolling composites (all strictly prior-days, verified against their own build functions)
  '5D_OR_MID':  { rule: 'PRIOR_PERIOD', displayName: '5-Day OR Mid', levelDesc: "rolling 5-prior-day average Opening Range midpoint" },
  '10D_IB_MID': { rule: 'PRIOR_PERIOD', displayName: '10-Day IB Mid', levelDesc: "rolling 10-prior-day average Initial Balance midpoint" },
  '2D_POC':     { rule: 'PRIOR_PERIOD', displayName: '2-Day POC', levelDesc: 'volume POC of the prior 2 trading days combined' },
  PD2_VAH:      { rule: 'PRIOR_PERIOD', displayName: '2-Days-Ago VAH', levelDesc: "value area high from 2 trading days ago" },
  PD2_VAL:      { rule: 'PRIOR_PERIOD', displayName: '2-Days-Ago VAL', levelDesc: "value area low from 2 trading days ago" },
  // Prior week / month / quarter
  PW_HIGH: { rule: 'PRIOR_PERIOD', displayName: 'Prior Week High', levelDesc: "prior calendar week's high" },
  PW_LOW:  { rule: 'PRIOR_PERIOD', displayName: 'Prior Week Low', levelDesc: "prior calendar week's low" },
  PW_VAH:  { rule: 'PRIOR_PERIOD', displayName: 'Prior Week VAH', levelDesc: "prior calendar week's value area high" },
  PW_VAL:  { rule: 'PRIOR_PERIOD', displayName: 'Prior Week VAL', levelDesc: "prior calendar week's value area low" },
  PW_POC:  { rule: 'PRIOR_PERIOD', displayName: 'Prior Week POC', levelDesc: "prior calendar week's volume POC" },
  PM_VAH:  { rule: 'PRIOR_PERIOD', displayName: 'Prior Month VAH', levelDesc: "prior calendar month's value area high" },
  PM_VAL:  { rule: 'PRIOR_PERIOD', displayName: 'Prior Month VAL', levelDesc: "prior calendar month's value area low" },
  PM_HIGH: { rule: 'PRIOR_PERIOD', displayName: 'Prior Month High', levelDesc: "prior calendar month's high" },
  PM_LOW:  { rule: 'PRIOR_PERIOD', displayName: 'Prior Month Low', levelDesc: "prior calendar month's low" },
  PM_POC:  { rule: 'PRIOR_PERIOD', displayName: 'Prior Month POC', levelDesc: "prior calendar month's volume POC" },
  '3M_VAH': { rule: 'PRIOR_PERIOD', displayName: 'Prior Quarter VAH', levelDesc: "prior 3-month rolling value area high" },
  '3M_VAL': { rule: 'PRIOR_PERIOD', displayName: 'Prior Quarter VAL', levelDesc: "prior 3-month rolling value area low" },
  '3M_POC': { rule: 'PRIOR_PERIOD', displayName: 'Prior Quarter POC', levelDesc: "prior 3-month rolling volume POC" },
  M1_VAH: { rule: 'PRIOR_PERIOD', displayName: 'Rolling 1M VAH', levelDesc: 'rolling 30-day value area high (excludes today)' },
  M1_VAL: { rule: 'PRIOR_PERIOD', displayName: 'Rolling 1M VAL', levelDesc: 'rolling 30-day value area low (excludes today)' },
  M3_VAH: { rule: 'PRIOR_PERIOD', displayName: 'Rolling 3M VAH', levelDesc: 'rolling 90-day value area high (excludes today)' },
  M3_VAL: { rule: 'PRIOR_PERIOD', displayName: 'Rolling 3M VAL', levelDesc: 'rolling 90-day value area low (excludes today)' },
  // Weekly / monthly floor pivots
  WPP: { rule: 'PRIOR_PERIOD', displayName: 'Weekly Pivot', levelDesc: 'weekly floor pivot' },
  WR1: { rule: 'PRIOR_PERIOD', displayName: 'Weekly R1', levelDesc: 'weekly floor resistance 1' },
  WR2: { rule: 'PRIOR_PERIOD', displayName: 'Weekly R2', levelDesc: 'weekly floor resistance 2' },
  WS1: { rule: 'PRIOR_PERIOD', displayName: 'Weekly S1', levelDesc: 'weekly floor support 1' },
  WS2: { rule: 'PRIOR_PERIOD', displayName: 'Weekly S2', levelDesc: 'weekly floor support 2' },
  MPP: { rule: 'PRIOR_PERIOD', displayName: 'Monthly Pivot', levelDesc: 'monthly floor pivot' },
  MR1: { rule: 'PRIOR_PERIOD', displayName: 'Monthly R1', levelDesc: 'monthly floor resistance 1' },
  MR2: { rule: 'PRIOR_PERIOD', displayName: 'Monthly R2', levelDesc: 'monthly floor resistance 2' },
  MS1: { rule: 'PRIOR_PERIOD', displayName: 'Monthly S1', levelDesc: 'monthly floor support 1' },
  MS2: { rule: 'PRIOR_PERIOD', displayName: 'Monthly S2', levelDesc: 'monthly floor support 2' },
  // Overnight range — special case, NOT same-day-forming rule (see WINDOW_RULES.OVERNIGHT_RANGE)
  ONH: { rule: 'OVERNIGHT_RANGE', displayName: 'Overnight High', levelDesc: "prior Globex session's high (18:00 ET prior day → 09:29 ET today)" },
  ONL: { rule: 'OVERNIGHT_RANGE', displayName: 'Overnight Low', levelDesc: "prior Globex session's low (18:00 ET prior day → 09:29 ET today)" },
  // Same-day-forming
  OR5_HIGH: { rule: 'SAME_DAY_FORMING', displayName: '5-Min Opening Range High', levelDesc: "today's 5-minute opening range high (9:30-9:35 AM ET)", formationGate: 575 },
  OR5_LOW:  { rule: 'SAME_DAY_FORMING', displayName: '5-Min Opening Range Low', levelDesc: "today's 5-minute opening range low (9:30-9:35 AM ET)", formationGate: 575 },
  IB_HIGH: { rule: 'SAME_DAY_FORMING', displayName: 'Initial Balance High', levelDesc: "today's Initial Balance high (9:30-10:30 AM ET)", formationGate: 630 },
  IB_LOW:  { rule: 'SAME_DAY_FORMING', displayName: 'Initial Balance Low', levelDesc: "today's Initial Balance low (9:30-10:30 AM ET)", formationGate: 630 },
  IB_MID_SCALP:    { rule: 'SAME_DAY_FORMING', displayName: 'IB Mid Scalp', levelDesc: "midpoint of today's Initial Balance, tight scalp stop/target", formationGate: 630 },
  // Renamed OR_MID_AFTER_IB -> OR5_MID 2026-08-12, folded into the new OR{N}_HIGH/LOW/MID
  // naming family (docs/OR_LENGTH_SEASONALITY_SPEC.md). The old name had been a stale,
  // misleading artifact since 2026-07-16, when the setup's actual IB-wait gate was removed
  // from server/routes/acd.js but the name itself was never updated to match (the
  // 2026-07-31 fix above corrected the formationGate/description but explicitly left the
  // key itself as a documented "legacy setup_type name" — this rename is the completion of
  // that fix, not a new decision). Full active_setups/performance_audit/level_prices
  // history renamed in place (backup: *_or_rename_backup_20260812).
  OR5_MID: { rule: 'SAME_DAY_FORMING', displayName: '5-Min Opening Range Mid', levelDesc: "midpoint of today's 5-minute opening range (9:30-9:35 AM ET) — tradeable as soon as the OR completes", formationGate: 575 },
  // OR10/15/30 — added 2026-08-12 alongside the OR5 rename, Phase 1 bar-history backtest
  // in progress/complete per docs/OR_LENGTH_SEASONALITY_SPEC.md. THIN_N-seeded (see
  // scripts/seed_or_length_thin_n_placeholders.mjs) so none of these can ever fire
  // unsuppressed ACTIVE before real N accumulates — SHADOW-only until then.
  OR10_HIGH: { rule: 'SAME_DAY_FORMING', displayName: '10-Min Opening Range High', levelDesc: "today's 10-minute opening range high (9:30-9:40 AM ET)", formationGate: 580 },
  OR10_LOW:  { rule: 'SAME_DAY_FORMING', displayName: '10-Min Opening Range Low', levelDesc: "today's 10-minute opening range low (9:30-9:40 AM ET)", formationGate: 580 },
  OR10_MID:  { rule: 'SAME_DAY_FORMING', displayName: '10-Min Opening Range Mid', levelDesc: "midpoint of today's 10-minute opening range (9:30-9:40 AM ET)", formationGate: 580 },
  OR15_HIGH: { rule: 'SAME_DAY_FORMING', displayName: '15-Min Opening Range High', levelDesc: "today's 15-minute opening range high (9:30-9:45 AM ET)", formationGate: 585 },
  OR15_LOW:  { rule: 'SAME_DAY_FORMING', displayName: '15-Min Opening Range Low', levelDesc: "today's 15-minute opening range low (9:30-9:45 AM ET)", formationGate: 585 },
  OR15_MID:  { rule: 'SAME_DAY_FORMING', displayName: '15-Min Opening Range Mid', levelDesc: "midpoint of today's 15-minute opening range (9:30-9:45 AM ET)", formationGate: 585 },
  OR30_HIGH: { rule: 'SAME_DAY_FORMING', displayName: '30-Min Opening Range High', levelDesc: "today's 30-minute opening range high (9:30-10:00 AM ET)", formationGate: 600 },
  OR30_LOW:  { rule: 'SAME_DAY_FORMING', displayName: '30-Min Opening Range Low', levelDesc: "today's 30-minute opening range low (9:30-10:00 AM ET)", formationGate: 600 },
  OR30_MID:  { rule: 'SAME_DAY_FORMING', displayName: '30-Min Opening Range Mid', levelDesc: "midpoint of today's 30-minute opening range (9:30-10:00 AM ET)", formationGate: 600 },
  // Prior-year value area — added 2026-07-19 (see CLAUDE.md). Deliberately the safe
  // prior-COMPLETE-year convention (like PW/PM), not a rolling window.
  PY_VAH: { rule: 'PRIOR_PERIOD', displayName: 'Prior Year VAH', levelDesc: "prior complete calendar year's value area high" },
  PY_VAL: { rule: 'PRIOR_PERIOD', displayName: 'Prior Year VAL', levelDesc: "prior complete calendar year's value area low" },
  PY_POC: { rule: 'PRIOR_PERIOD', displayName: 'Prior Year POC', levelDesc: "prior complete calendar year's volume POC" },
};

// ── Globex-capable overrides — these 4 ALSO fire outside RTH via detectGlobexSetup() ──
// Same underlying level as their PRIOR_PERIOD entry above (PD_VAH/PD_VAL/PD_POC) but with
// a second, real live firing path — flagged separately so the reference page can show both
// the RTH-firing behavior (via keepLevelsAll) AND the Globex-firing behavior (via
// detectGlobexSetup()) for the exact same underlying level.
export const GLOBEX_CAPABLE_TYPES = new Set([
  'PD_VAH_FADE_SHORT', 'PD_VAL_FADE_LONG', 'PD_POC_FADE_SHORT', 'PD_POC_FADE_LONG',
]);

// ── Non-level-fade setup families ──
export const OTHER_SETUP_DEFINITIONS = {
  IB_BULLISH: { rule: 'DAY_TYPE_CONDITIONAL', displayName: 'IB Bullish', criteria: 'Initial Balance breaks bullish (price closes above IB high within the IB window). Managed per-day-type: strong on TREND days, marginal-to-negative on BALANCE days — read the DAY_TYPE_ALPHA breakdown, not the blended EV.' },
  IB_BEARISH: { rule: 'DAY_TYPE_CONDITIONAL', displayName: 'IB Bearish', criteria: 'Initial Balance breaks bearish (price closes below IB low within the IB window). Managed per-day-type: strong on TURBULENT days, marginal on others — read the DAY_TYPE_ALPHA breakdown, not the blended EV.' },
  MOMENTUM_60m_60m_BALANCE_FADE: { rule: 'MOMENTUM_PATTERN', displayName: '60m Momentum Fade (Balance)', criteria: 'Extreme 60-minute momentum reading on a BALANCE day-type — fades the move. Detected by minuteBarSignalDetector.js, not a level touch.' },
  MOMENTUM_60m_60m_TREND: { rule: 'MOMENTUM_PATTERN', displayName: '60m Momentum (Trend)', criteria: 'Extreme 60-minute momentum reading on a TREND day-type — trades with the move, not against it. Detected by minuteBarSignalDetector.js, not a level touch.' },
  WPP_FADE_SHORT_GAP_UP: { rule: 'PRIOR_PERIOD', displayName: 'Weekly Pivot Fade (Gap-Up Only)', criteria: 'Conditional variant of WPP_FADE_SHORT — only fires when the 9:30 open is below WPP (gap brought price up into resistance). See CONDITIONAL_VARIANTS in server/config/setupTypes.js.' },
  OR5_LOW_FADE_LONG_GAP_DOWN: { rule: 'PRIOR_PERIOD', displayName: 'OR5 Low Fade (Gap-Down Only)', criteria: 'Conditional variant of OR5_LOW_FADE_LONG — only fires when the 9:30 open is below the prior session\'s RTH close (gap brought price down into the OR5 low). SHADOW-only pending real forward validation (backtest N=147, EV=$7.77/trade as of 2026-08-18) — see CONDITIONAL_VARIANTS in server/config/setupTypes.js.' },
  FLOOR_R1_FADE_SHORT_TRAIL: { rule: 'PRIOR_PERIOD', displayName: 'Floor R1 Fade Short (Breakeven Trail)', criteria: 'Same entry as FLOOR_R1_FADE_SHORT, different exit mechanism — stays on the normal stop until the calibrated target is reached, then snaps to breakeven and trails forward instead of taking a fixed second target. See docs/SCALEOUT_RUNNER_SPEC.md.' },
  // Auction-theory session-structure patterns (not level touches) — verified against
  // server/routes/acd.js directly, not guessed. Several are known-thin or suppressed;
  // criteria text describes the trigger condition, not a live-tradability claim.
  C_STANDALONE_UP:   { rule: 'MOMENTUM_PATTERN', displayName: 'C Standalone Up', criteria: 'Standalone bullish "C" auction-structure read (caseEngine.js conviction classification), independent of the main session-read pipeline. Fires at most once per day.' },
  C_STANDALONE_DOWN: { rule: 'MOMENTUM_PATTERN', displayName: 'C Standalone Down', criteria: 'Standalone bearish "C" auction-structure read (caseEngine.js conviction classification), independent of the main session-read pipeline. Fires at most once per day.' },
  OPEN_TEST_DRIVE_LONG:  { rule: 'MOMENTUM_PATTERN', displayName: 'Open Test-Drive Long', criteria: 'Opening classification (opening_call_type) where price tests then rejects the open, driving up. Suppressed live since 2026-07-05 (LONG WR=31.8% N=44 EV=-$100) — check current SETUP_STATUS before assuming it fires.' },
  OPEN_TEST_DRIVE_SHORT: { rule: 'MOMENTUM_PATTERN', displayName: 'Open Test-Drive Short', criteria: 'Opening classification (opening_call_type) where price tests then rejects the open, driving down. Suppressed live since 2026-07-05 (SHORT WR=26.7% N=45 EV=-$74) — check current SETUP_STATUS before assuming it fires.' },
  OPEN_DRIVE_LONG:  { rule: 'MOMENTUM_PATTERN', displayName: 'Open Drive Long', criteria: 'Opening classification where price drives directionally away from the open with no test — bullish variant.' },
  OPEN_DRIVE_SHORT: { rule: 'MOMENTUM_PATTERN', displayName: 'Open Drive Short', criteria: 'Opening classification where price drives directionally away from the open with no test — bearish variant.' },
  BRACKET_BREAKOUT_LONG:  { rule: 'MOMENTUM_PATTERN', displayName: 'Bracket Breakout Long', criteria: 'Price exceeds the 5-session bracket (consolidation range) top with sufficient NL30 momentum. Prior bracket top becomes support — buys pullbacks to that boundary, not the breakout bar itself.' },
  BRACKET_BREAKOUT_SHORT: { rule: 'MOMENTUM_PATTERN', displayName: 'Bracket Breakout Short', criteria: 'Price breaks the 5-session bracket (consolidation range) bottom with sufficient NL30 momentum. Prior bracket bottom becomes resistance — shorts rallies to that boundary, not the breakdown bar itself.' },
  VALUE_AREA_RESPONSIVE_LONG:  { rule: 'MOMENTUM_PATTERN', displayName: 'Value Area Responsive Long', criteria: 'Price responds to (fades back into) the developing value area from outside it — bullish variant. Counter-trend classification (grouped with TRT/TRT_MAH as counter-trend setups in server/routes/setups.js).' },
  VALUE_AREA_RESPONSIVE_SHORT: { rule: 'MOMENTUM_PATTERN', displayName: 'Value Area Responsive Short', criteria: 'Price responds to (fades back into) the developing value area from outside it — bearish variant. Counter-trend classification (grouped with TRT/TRT_MAH as counter-trend setups in server/routes/setups.js).' },
  // VWAP_MAGNET is the FAR-AWAY (sigma-distance) VWAP fade — one of two VWAP fade families
  // now built (2026-07-28). Originally documented here as "THE RTH-VWAP fade" before the
  // second family (RTH_VWAP_FADE_LONG/SHORT, LEVEL_FADE_DEFINITIONS above) existed — kept
  // separate on purpose, not merged, since they're genuinely different trigger conditions:
  // this one only fires on a rare extreme departure from VWAP; RTH_VWAP_FADE_LONG/SHORT
  // fires on an ordinary close-range (15pt) touch, the far more common case, added directly
  // per user pushback ("what about fades off the vwap? those are trades too"). Criteria
  // verified directly against server/routes/acd.js ~line 5310-5338 (vwapMagnetSetup).
  VWAP_MAGNET_LONG:  { rule: 'MOMENTUM_PATTERN', displayName: 'VWAP Magnet Long', criteria: 'Fires when price is ≥1.5σ BELOW the running RTH VWAP (σ = rolling 30-session std of session_close − RTH_VWAP) — a mean-reversion long back toward VWAP. T1/stop are data-derived (OPTIMAL_STOP, since 2026-08-02; fallback 20pt/30pt if uncalibrated) (resolves as a plain single-target trade — the description text mentions a scale-out/runner, but the live insert never sets a trail/extend mechanism, so it always resolves flat). See RTH_VWAP_FADE_LONG for the ordinary close-range VWAP touch, a separate, more common trigger.' },
  VWAP_MAGNET_SHORT: { rule: 'MOMENTUM_PATTERN', displayName: 'VWAP Magnet Short', criteria: 'Fires when price is ≥1.5σ ABOVE the running RTH VWAP (σ = rolling 30-session std of session_close − RTH_VWAP) — a mean-reversion short back toward VWAP. T1/stop are data-derived (OPTIMAL_STOP, since 2026-08-02; fallback 20pt/30pt if uncalibrated) (resolves as a plain single-target trade — the description text mentions a scale-out/runner, but the live insert never sets a trail/extend mechanism, so it always resolves flat). See RTH_VWAP_FADE_SHORT for the ordinary close-range VWAP touch, a separate, more common trigger.' },
  // The Globex sibling of VWAP_MAGNET — built 2026-07-28 directly from a user request that
  // the 24hr/Globex-spanning VWAP be tracked as a real, historical setup like every other
  // level, not just the passive text alert (morningBrief.js's "24HR VWAP" alert) it was
  // before. See server/routes/acd.js's detectGlobexSetup() for the live detection code.
  GLOBEX_VWAP_MAGNET_LONG:  { rule: 'MOMENTUM_PATTERN', displayName: 'Globex VWAP Magnet Long', globexOnly: true, criteria: 'Fires when price is ≥1.5σ BELOW the running 24hr VWAP (Globex 6PM ET open through now; σ = rolling 30-session std of session_close − 24hr-VWAP) — a mean-reversion long back toward the 24hr VWAP. T1/stop are data-derived (OPTIMAL_STOP once N≥20; fallback 20pt/30pt matching VWAP_MAGNET\'s own live values until then). See GLOBEX_VWAP_FADE_LONG for the ordinary close-range touch, a separate, more common trigger.' },
  GLOBEX_VWAP_MAGNET_SHORT: { rule: 'MOMENTUM_PATTERN', displayName: 'Globex VWAP Magnet Short', globexOnly: true, criteria: 'Fires when price is ≥1.5σ ABOVE the running 24hr VWAP (Globex 6PM ET open through now; σ = rolling 30-session std of session_close − 24hr-VWAP) — a mean-reversion short back toward the 24hr VWAP. T1/stop are data-derived (OPTIMAL_STOP once N≥20; fallback 20pt/30pt matching VWAP_MAGNET\'s own live values until then). See GLOBEX_VWAP_FADE_SHORT for the ordinary close-range touch, a separate, more common trigger.' },
  // Globex sibling of RTH_VWAP_FADE_LONG/SHORT (LEVEL_FADE_DEFINITIONS above) — ordinary
  // close-range (15pt) touch of the running 24hr VWAP, distinct from GLOBEX_VWAP_MAGNET's
  // far-away sigma trigger. Kept in OTHER_SETUP_DEFINITIONS (not LEVEL_FADE_DEFINITIONS)
  // since its rule/window text needs to say "Globex-only," not reuse GLOBEX_CAPABLE's
  // wording (that rule's text is specific to the PD_VAH/VAL/POC RTH-calibrated-stop gap,
  // which doesn't apply here — this setup is calibrated on its own real Globex data).
  GLOBEX_VWAP_FADE_LONG:  { rule: 'MOMENTUM_PATTERN', displayName: 'Globex VWAP Fade Long', globexOnly: true, criteria: 'Fires on an ordinary touch (within 15pt) of the running 24hr VWAP (Globex 6PM ET open through now) while price is currently below it — direction is dynamic from current price side (like PD_POC), not a fixed per-level bias. Globex-only, no RTH sibling by this exact name (see RTH_VWAP_FADE_LONG for the RTH version).' },
  GLOBEX_VWAP_FADE_SHORT: { rule: 'MOMENTUM_PATTERN', displayName: 'Globex VWAP Fade Short', globexOnly: true, criteria: 'Fires on an ordinary touch (within 15pt) of the running 24hr VWAP (Globex 6PM ET open through now) while price is currently above it — direction is dynamic from current price side (like PD_POC), not a fixed per-level bias. Globex-only, no RTH sibling by this exact name (see RTH_VWAP_FADE_SHORT for the RTH version).' },
};

// Level-family "Group" labels — matches the Key Levels table's grouping convention
// (BacktestView.jsx's KL_LEVEL_GROUPS: Initial Balance / Prior Week / Prior Day Value
// Area / Overnight / RTH VWAP / Opening Reference), extended to cover every base level
// name this codebase tracks (Key Levels only covers 6 groups / ~16 levels; Setup
// Reference spans ~70). Added 2026-07-28 per direct user request to add a Group column
// to Setup Reference matching the Key Levels table's format.
const LEVEL_GROUP_MAP = {
  PD_POC: 'Prior Day', PD_VAH: 'Prior Day', PD_VAL: 'Prior Day', PD_HIGH: 'Prior Day',
  PD_LOW: 'Prior Day', PD_CLOSE: 'Prior Day', PD_SESSION_MID: 'Prior Day',
  PD_IB_HIGH: 'Prior Day Initial Balance', PD_IB_LOW: 'Prior Day Initial Balance', PD_IB_MID: 'Prior Day Initial Balance',
  PD_OR_MID: 'Prior Day Opening Range',
  PD2_VAH: '2 Days Ago', PD2_VAL: '2 Days Ago', '2D_POC': '2 Days Ago',
  FLOOR_PIVOT: 'Floor Pivots', FLOOR_R1: 'Floor Pivots', FLOOR_R2: 'Floor Pivots', FLOOR_R3: 'Floor Pivots',
  FLOOR_S1: 'Floor Pivots', FLOOR_S2: 'Floor Pivots', FLOOR_S3: 'Floor Pivots',
  CAM_R1: 'Camarilla', CAM_R2: 'Camarilla', CAM_R3: 'Camarilla', CAM_R4: 'Camarilla',
  CAM_S1: 'Camarilla', CAM_S2: 'Camarilla', CAM_S3: 'Camarilla', CAM_S4: 'Camarilla',
  DAILY_OPEN: "Today's Open",
  WEEKLY_OPEN: 'Prior Week', WEEKLY_VWAP: 'Weekly VWAP',
  MONTHLY_OPEN: 'Prior Month', MONTHLY_VWAP: 'Monthly VWAP',
  RTH_VWAP: 'RTH VWAP', GLOBEX_VWAP: 'Globex 24hr VWAP',
  PW_HIGH: 'Prior Week', PW_LOW: 'Prior Week', PW_VAH: 'Prior Week', PW_VAL: 'Prior Week', PW_POC: 'Prior Week',
  PM_HIGH: 'Prior Month', PM_LOW: 'Prior Month', PM_VAH: 'Prior Month', PM_VAL: 'Prior Month', PM_POC: 'Prior Month',
  M1_VAH: 'Rolling 1-Month', M1_VAL: 'Rolling 1-Month',
  M3_VAH: 'Rolling 3-Month', M3_VAL: 'Rolling 3-Month', '3M_VAL': 'Rolling 3-Month', '3M_POC': 'Rolling 3-Month',
  WPP: 'Weekly Pivots', WR1: 'Weekly Pivots', WR2: 'Weekly Pivots', WS1: 'Weekly Pivots', WS2: 'Weekly Pivots',
  MPP: 'Monthly Pivots', MR1: 'Monthly Pivots', MR2: 'Monthly Pivots', MS1: 'Monthly Pivots', MS2: 'Monthly Pivots',
  ONH: 'Overnight', ONL: 'Overnight',
  OR5_HIGH: 'Opening Range', OR5_LOW: 'Opening Range', OR5_MID: 'Opening Range',
  OR10_HIGH: 'Opening Range', OR10_LOW: 'Opening Range', OR10_MID: 'Opening Range',
  OR15_HIGH: 'Opening Range', OR15_LOW: 'Opening Range', OR15_MID: 'Opening Range',
  OR30_HIGH: 'Opening Range', OR30_LOW: 'Opening Range', OR30_MID: 'Opening Range',
  IB_HIGH: 'Initial Balance', IB_LOW: 'Initial Balance', IB_MID_SCALP: 'Initial Balance',
  '5D_OR_MID': 'Opening Range (5-Day)', '10D_IB_MID': 'Initial Balance (10-Day)',
  PY_VAH: 'Prior Year', PY_VAL: 'Prior Year', PY_POC: 'Prior Year',
  MPP_OVERNIGHT: 'Monthly Pivots', WR1_OVERNIGHT: 'Weekly Pivots', WS1_OVERNIGHT: 'Weekly Pivots',
  MONTHLY_OPEN_OVERNIGHT: 'Prior Month', '10D_IB_MID_OVERNIGHT': 'Initial Balance (10-Day)',
  '3M_VAL_OVERNIGHT': 'Rolling 3-Month', '3M_POC_OVERNIGHT': 'Rolling 3-Month', PM_POC_OVERNIGHT: 'Prior Month',
};
// Non-level-fade / pattern setup_types — grouped by trigger family, not a level.
const OTHER_GROUP_MAP = {
  IB_BULLISH: 'Initial Balance', IB_BEARISH: 'Initial Balance',
  MOMENTUM_60m_60m_BALANCE_FADE: 'Momentum/Pattern', MOMENTUM_60m_60m_TREND: 'Momentum/Pattern',
  C_STANDALONE_UP: 'Auction Structure', C_STANDALONE_DOWN: 'Auction Structure',
  C_PAIRED_LONG: 'Auction Structure', C_PAIRED_SHORT: 'Auction Structure',
  A_UP_STRONG: 'Auction Structure', A_UP_WEAK: 'Auction Structure', A_DOWN_STRONG: 'Auction Structure', A_DOWN_WEAK: 'Auction Structure',
  OPEN_TEST_DRIVE_LONG: 'Opening Classification', OPEN_TEST_DRIVE_SHORT: 'Opening Classification',
  OPEN_DRIVE_LONG: 'Opening Classification', OPEN_DRIVE_SHORT: 'Opening Classification',
  BRACKET_BREAKOUT_LONG: 'Bracket Breakout', BRACKET_BREAKOUT_SHORT: 'Bracket Breakout',
  VALUE_AREA_RESPONSIVE_LONG: 'Value Area Responsive', VALUE_AREA_RESPONSIVE_SHORT: 'Value Area Responsive',
  TRT_LONG: 'Trend Reversal Test', TRT_SHORT: 'Trend Reversal Test',
  TRT_MAH_LONG: 'Trend Reversal Test', TRT_MAH_SHORT: 'Trend Reversal Test',
  FAILED_AUCTION_LONG: 'Auction Structure', FAILED_AUCTION_SHORT: 'Auction Structure',
  GAP_FILL_LONG: 'Gap Fill', GAP_FILL_SHORT: 'Gap Fill',
  STOP_SWEEP_LONG: 'Stop Sweep', STOP_SWEEP_SHORT: 'Stop Sweep',
  VWAP_MAGNET_LONG: 'RTH VWAP', VWAP_MAGNET_SHORT: 'RTH VWAP',
  GLOBEX_VWAP_MAGNET_LONG: 'Globex 24hr VWAP', GLOBEX_VWAP_MAGNET_SHORT: 'Globex 24hr VWAP',
  ZONE_EDGE_FADE: 'Confluence Zone',
  STACK_VOL_BREAK_LIVE_LONG: 'Volume/Level Break', STACK_VOL_BREAK_LIVE_SHORT: 'Volume/Level Break',
};

/** Derive a Key-Levels-style family Group label from a setup_type string. */
export function getSetupGroup(setupType) {
  if (OTHER_GROUP_MAP[setupType]) return OTHER_GROUP_MAP[setupType];
  // Strip conditional-variant/exit-mechanism/session suffixes to reach the base level name.
  const base = setupType
    .replace(/_FADE_(LONG|SHORT)(_TRAIL)?(_GAP_(UP|DOWN))?(_OVERNIGHT)?$/, '')
    .replace(/_OVERNIGHT$/, '');
  if (LEVEL_GROUP_MAP[base]) return LEVEL_GROUP_MAP[base];
  if (LEVEL_GROUP_MAP[setupType]) return LEVEL_GROUP_MAP[setupType];
  return null;
}

/** Look up a level-fade family's full definition (window rule merged in). */
export function getLevelFadeDefinition(levelName) {
  const def = LEVEL_FADE_DEFINITIONS[levelName];
  if (!def) return null;
  const rule = WINDOW_RULES[def.rule];
  return {
    ...def,
    ruleLabel: rule.label,
    windowDescription: rule.windowDescription,
    formationGate: def.formationGate ?? rule.formationGate ?? null,
    criteria: `Fades price within 15pt of the ${def.displayName.toLowerCase()} (${def.levelDesc}). Direction from approach side (from above = SHORT, from below = LONG).`,
  };
}
