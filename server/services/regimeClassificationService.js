// Shared point-in-time regime classification — Regime A (directional trend),
// Regime B (price-stretch / mean-reversion), Regime C (trend persistence), plus the
// related post-rotation-day flag, vol-regime lookup, and the conditioned sizing
// multiplier that combines all three. Extracted 2026-07-18 after being hand-copied
// 3x in one night (scratch/analyze_regimes.js, then
// scratch/backtest_prop_1yr_regime_conditioned.mjs, then a 3rd copy for Gemini's
// factorial ablation dispatch) — see OPEN_DECISION
// regime_classification_logic_duplicated_needs_shared_service.
//
// IMPORTANT: this module deduplicates the CODE. The METHODOLOGY was tested the same
// day and FAILED. Non-overlapping-window re-testing found Regime A/B's trend/stretch
// buckets underpowered on this codebase's ~410-day history; a 200-permutation placebo
// test found Regime C's persistence-decay pattern statistically indistinguishable from
// a shuffled null (very likely a generic run-length artifact, not a real signal); an
// independent PELT changepoint ground truth on raw NQ price data found Regime A's
// label transitions align with real structural breaks WORSE than chance on the
// best-tested configuration. Do NOT build live sizing/suppression logic on these
// labels as currently constructed — see docs/REGIME_DETECTION_SPEC.md Section 8.1 for
// the full account and `node scripts/flag_decision.mjs --list-all` for the resolved
// `regime_detection_methodology_needs_validation` decision.
//
// Accepts a queryFn(sql, params) => { rows } so it works with either a raw pg.Client
// or server/db.js's query() wrapper (same convention as
// developingValueService.js's computeVolumeProfileForRange).

export function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

export function std(arr, m) {
  if (arr.length < 2) return 0;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx), w = idx - lo;
  return hi >= sorted.length ? sorted[lo] : sorted[lo] * (1 - w) + sorted[hi] * w;
}

// Regime A: 30-day NL30 (daily_score) sum, z-scored vs its own 120-day rolling
//   distribution. BULLISH_TREND if z>+1.0, BEARISH_TREND if z<-1.0, else NEUTRAL.
// Regime B: daily close, z-scored vs its own 20-day rolling mean, then percentile-
//   ranked against a 252-day trailing window of those z-scores. STRETCHED_HIGH if
//   >80th pctile, STRETCHED_LOW if <20th, else NORMAL.
// Regime C: run-length (consecutive days) of the current Regime A label, tercile-
//   ranked against a 252-day trailing history of completed run-lengths. 'fresh'
//   (<=33rd pctile) / 'established' (<=66th) / 'extended' (>66th).
// All three are strictly point-in-time: day D's label uses only data through D-1,
// so a setup firing on day D can be safely conditioned on it with no lookahead.
//
// Returns Map<dateStr, { A, B, C }>.
export async function buildRegimeMap(queryFn) {
  const dailyQ = await queryFn(`SELECT trade_date, daily_score, session_close FROM acd_daily_log ORDER BY trade_date ASC`);
  const closesQ = await queryFn(`
    SELECT (date(ts AT TIME ZONE 'America/New_York'))::text as tdate, (array_agg(close ORDER BY ts DESC))[1] as last_close
    FROM price_bars_primary WHERE symbol='NQ' GROUP BY tdate ORDER BY tdate ASC
  `);
  const closeMap = new Map();
  for (const r of closesQ.rows) closeMap.set(r.tdate, parseFloat(r.last_close));

  const days = dailyQ.rows.map(r => {
    const d = typeof r.trade_date === 'string' ? r.trade_date : r.trade_date.toISOString().split('T')[0];
    return { date: d, daily_score: parseInt(r.daily_score) || 0, close: closeMap.get(d) || parseFloat(r.session_close) };
  }).sort((a, b) => a.date.localeCompare(b.date));

  const dailyScores = days.map(d => d.daily_score);
  const closes = days.map(d => d.close);
  const regimes = new Map();
  const bZScores = [];
  const runLengths = [];
  let currentRegimeA = null, currentRunLength = 0;

  for (let i = 0; i < days.length; i++) {
    const date = days[i].date;
    if (i < 150) { regimes.set(date, { A: 'NEUTRAL', B: 'NORMAL', C: 'fresh' }); continue; }

    const getSum30 = (endIdx) => {
      let sum = 0;
      for (let j = Math.max(0, endIdx - 29); j <= endIdx; j++) sum += dailyScores[j];
      return sum;
    };
    const nl30Sums = [];
    for (let j = i - 120; j <= i - 1; j++) nl30Sums.push(getSum30(j));
    const m120 = mean(nl30Sums), s120 = std(nl30Sums, m120);
    const currentSum = nl30Sums[nl30Sums.length - 1];
    let zA = s120 !== 0 ? (currentSum - m120) / s120 : 0;
    let labelA = 'NEUTRAL';
    if (zA > 1.0) labelA = 'BULLISH_TREND'; else if (zA < -1.0) labelA = 'BEARISH_TREND';

    if (labelA === currentRegimeA) currentRunLength++;
    else { if (currentRegimeA !== null) runLengths.push(currentRunLength); currentRegimeA = labelA; currentRunLength = 1; }

    let labelC = 'fresh';
    if (runLengths.length >= 20) {
      const historyC = runLengths.slice(-252);
      const p33 = percentile(historyC, 0.33), p66 = percentile(historyC, 0.66);
      if (currentRunLength <= p33) labelC = 'fresh'; else if (currentRunLength <= p66) labelC = 'established'; else labelC = 'extended';
    }

    const window20 = closes.slice(i - 20, i);
    const m20 = mean(window20), s20 = std(window20, m20);
    const currentClose = closes[i - 1];
    let zB = s20 !== 0 ? (currentClose - m20) / s20 : 0;
    bZScores.push(zB);
    let labelB = 'NORMAL';
    if (bZScores.length >= 50) {
      const historyB = bZScores.slice(-252);
      const p20 = percentile(historyB, 0.20), p80 = percentile(historyB, 0.80);
      if (zB > p80) labelB = 'STRETCHED_HIGH'; else if (zB < p20) labelB = 'STRETCHED_LOW';
    }
    regimes.set(date, { A: labelA, B: labelB, C: labelC });
  }

  return regimes;
}

// Map<dateStr, boolean> — was the PRIOR calendar day (full 18:00-17:00 ET Globex
// session) a 500+pt rotation day. Already point-in-time by construction (only looks
// backward), so day D's flag is known at the start of day D.
export async function buildPostRotationFlagMap(queryFn) {
  const rangeQ = await queryFn(`
    SELECT trade_date, MAX(high)-MIN(low) as session_range FROM
      (SELECT CASE WHEN EXTRACT(hour FROM ts) >= 18 THEN (ts + interval '1 day')::date ELSE ts::date END as trade_date, high, low
       FROM price_bars_primary WHERE symbol='NQ') y
    GROUP BY trade_date ORDER BY trade_date
  `);
  const rotationDayMap = new Map();
  for (const r of rangeQ.rows) {
    const d = typeof r.trade_date === 'string' ? r.trade_date : r.trade_date.toISOString().split('T')[0];
    rotationDayMap.set(d, parseFloat(r.session_range) >= 500);
  }
  const sortedRotDates = [...rotationDayMap.keys()].sort();
  const postRotationFlag = new Map();
  for (let i = 1; i < sortedRotDates.length; i++) {
    postRotationFlag.set(sortedRotDates[i], rotationDayMap.get(sortedRotDates[i - 1]));
  }
  return postRotationFlag;
}

// Map<dateStr, regimeString> — read directly from the already-point-in-time
// VOL_REGIME_HIST rows (computed live from 9:30-10:30 ET only, known well before the
// rest of the day plays out — see volatilityRegimeService.js).
export async function buildVolRegimeMap(queryFn) {
  const volQ = await queryFn(`
    SELECT DISTINCT ON (signal_name) signal_name::date::text as trade_date, notes::jsonb->>'regime' as regime
    FROM performance_audit WHERE signal_type='VOL_REGIME_HIST' ORDER BY signal_name, run_date DESC
  `);
  return new Map(volQ.rows.map(r => [r.trade_date, r.regime]));
}

// The specific stable findings from the 2026-07-18 regime-conditioning research
// session (recorded as RESEARCH_CLAIMs — see docs/OPEN_THREADS.md), encoded as a
// sizing multiplier. `enable` lets a caller (e.g. a factorial ablation test) toggle
// each factor group independently; defaults to all-on for callers that just want
// the combined effect. Combined result is capped to [0.3, 1.5].
export function conditionedMultiplier(setupType, date, regimes, postRotationFlag, volRegimeMap, enable = {}) {
  const { regime = true, rotation = true, vol = true } = enable;
  let mult = 1.0;

  if (regime) {
    const r = regimes.get(date);
    if (r) {
      if (setupType === 'FLOOR_R1_FADE_SHORT' && r.A === 'BULLISH_TREND') mult *= 0.5;
      if (setupType === 'IB_MID_SCALP_FADE_LONG' && r.B === 'STRETCHED_LOW') mult *= 0.5;
      if (setupType === 'OR_HIGH_FADE_SHORT' && r.C === 'established') mult *= 1.3;
    }
  }

  if (rotation) {
    const isPostRotation = postRotationFlag.get(date) === true;
    if (isPostRotation) {
      if (setupType === 'IB_BULLISH') mult *= 0.5;
      if (setupType === 'OR_HIGH_FADE_SHORT') mult *= 1.3;
    }
  }

  if (vol) {
    const volRegime = volRegimeMap.get(date);
    if (volRegime && setupType.includes('FADE')) {
      if (volRegime === 'HIGH-VOL-CHOP') mult *= 1.2;
      if (volRegime === 'HIGH-VOL-DIRECTIONAL') mult *= 0.5;
    }
  }

  return Math.max(0.3, Math.min(1.5, mult));
}
