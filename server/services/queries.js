/**
 * Shared SQL query helpers — single source of truth for common patterns.
 * All callers should import from here to prevent drift between implementations.
 */

import { query } from '../db.js';

// ── NL30 / NL10 rolling sums ────────────────────────────────────────────────

/**
 * Get current NL30 and NL10 for today.
 * Uses the 30-session window ending at (but not including) the given date.
 */
export async function getNL({ asOf = null } = {}) {
  const dateClause = asOf
    ? `AND trade_date < ($1::text)::date AND trade_date >= ($1::text)::date - INTERVAL '30 days'`
    : `AND trade_date <= CURRENT_DATE AND trade_date >= CURRENT_DATE - INTERVAL '30 days'`;
  const params = asOf ? [asOf] : [];
  const r = await query(`
    SELECT
      SUM(daily_score) as nl30,
      SUM(CASE WHEN trade_date >= ${asOf ? "($1::text)::date - INTERVAL '10 days'" : "CURRENT_DATE - INTERVAL '10 days'"} THEN daily_score ELSE 0 END) as nl10
    FROM acd_daily_log
    WHERE daily_score IS NOT NULL ${dateClause}
  `, params);
  const nl30 = parseInt(r.rows[0]?.nl30) || 0;
  const nl10 = parseInt(r.rows[0]?.nl10) || 0;
  return { nl30, nl10, trend: nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING' };
}

// ── Value area (VAH / VAL / POC) from price bars ────────────────────────────

/**
 * Compute VAH, VAL, POC for a single RTH session date.
 * Uses standard 70% value area (35% each side of POC).
 */
export async function getValueArea(date) {
  const r = await query(`
    WITH vp AS (
      SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
        AND EXTRACT(hour FROM ts) < 16
      GROUP BY ROUND(low/0.25)*0.25
    ), total AS (SELECT SUM(vol) as t FROM vp),
    poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
    SELECT p.poc_px::float as poc,
      (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x
        WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
      (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x
        WHERE cv<=(SELECT t*0.35 FROM total))::float as val
    FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
  `, [date]);
  const row = r.rows[0];
  return row ? { poc: row.poc, vah: row.vah, val: row.val } : null;
}

/**
 * Compute prior month's value area (VAH/VAL/POC).
 * Used for PM VAH/VAL reference levels.
 */
export async function getPriorMonthValueArea(forDate) {
  const [yr, mo] = forDate.split('-').map(Number);
  const pmStart = new Date(Date.UTC(yr, mo - 2, 1)).toISOString().split('T')[0];
  const pmEnd   = new Date(Date.UTC(yr, mo - 1, 1)).toISOString().split('T')[0];
  const r = await query(`
    WITH vp AS (
      SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
      FROM price_bars WHERE symbol='NQ'
        AND ts >= $1::date AND ts < $2::date
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
        AND EXTRACT(hour FROM ts) < 16
      GROUP BY ROUND(low/0.25)*0.25
    ), total AS (SELECT SUM(vol) as t FROM vp),
    poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
    SELECT p.poc_px::float as poc,
      (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x
        WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
      (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x
        WHERE cv<=(SELECT t*0.35 FROM total))::float as val
    FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
  `, [pmStart, pmEnd]);
  const row = r.rows[0];
  return row ? { poc: row.poc, vah: row.vah, val: row.val } : null;
}

// ── RTH bar query helper ─────────────────────────────────────────────────────

/**
 * Fetch RTH price bars for a date (9:35–16:00 by default, post-OR period).
 * @param {string} date - YYYY-MM-DD
 * @param {number} startMin - minutes from midnight (default 575 = 9:35)
 * @param {number} endMin   - minutes from midnight (default 960 = 16:00)
 */
export async function getRTHBars(date, startMin = 575, endMin = 960) {
  const r = await query(`
    SELECT ts, high::float, low::float, close::float, open::float,
           volume::bigint,
           EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as bar_min
    FROM price_bars WHERE symbol='NQ' AND ts::date=$1
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN $2 AND $3
    ORDER BY ts
  `, [date, startMin, endMin]);
  return r.rows;
}

// ── G-Line (weekly open) ─────────────────────────────────────────────────────

/**
 * Get the G-Line (CME weekly open) for the week containing `date`.
 * Sierra Chart defines WK-Op as the first bar of the Sunday 18:00 ET CME session,
 * NOT the Monday 9:30 RTH open. The CME NQ week opens Sunday at 18:00 ET.
 * Sunday = date_trunc('week', date) - 1 day.
 */
export async function getGLine(date) {
  const r = await query(`
    SELECT (array_agg(open ORDER BY ts ASC))[1]::float as g_line
    FROM price_bars WHERE symbol='NQ'
      AND ts::date = date_trunc('week', ($1::text)::date) - INTERVAL '1 day'
      AND EXTRACT(hour FROM ts) >= 18
  `, [date]);
  return r.rows[0]?.g_line || null;
}

// ── G-Line days held this week ───────────────────────────────────────────────

/**
 * Count RTH sessions this week where the closing price held above the G-Line.
 * Also returns the current G-Line status relative to the latest price.
 * @param {string} date  - YYYY-MM-DD (today)
 * @param {number} gLine - G-Line price (weekly open)
 * @param {number} [currentPrice] - Latest price for status computation
 */
export async function getGLineDaysHeld(date, gLine, currentPrice = null) {
  if (!gLine) return { daysHeld: 0, direction: null, gLineStatus: null };
  const r = await query(`
    SELECT ts::date as session_date,
           (array_agg(close ORDER BY ts DESC))[1]::float as session_close
    FROM price_bars
    WHERE symbol='NQ'
      AND ts::date >= date_trunc('week', ($1::text)::date)
      AND ts::date < ($1::text)::date
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 960
    GROUP BY ts::date ORDER BY ts::date ASC
  `, [date]);
  let aboveCount = 0;
  for (const s of r.rows) {
    if (s.session_close > gLine) aboveCount++;
  }
  const totalSessions = r.rows.length;
  const direction = aboveCount >= totalSessions - aboveCount ? 'above' : 'below';
  const daysHeld = direction === 'above' ? aboveCount : totalSessions - aboveCount;

  let gLineStatus = null;
  if (currentPrice != null) {
    const TESTING_THRESHOLD = 15;
    if (Math.abs(currentPrice - gLine) <= TESTING_THRESHOLD) gLineStatus = 'testing';
    else if (currentPrice > gLine) gLineStatus = 'held';
    else gLineStatus = 'broken';
  }

  return { daysHeld, direction, gLineStatus };
}

// ── Prior week high/low ──────────────────────────────────────────────────────

export async function getPriorWeekRange(date) {
  const r = await query(`
    SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low
    FROM price_bars WHERE symbol='NQ'
      AND ts::date >= date_trunc('week', ($1::text)::date) - INTERVAL '7 days'
      AND ts::date <  date_trunc('week', ($1::text)::date)
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
      AND EXTRACT(hour FROM ts) < 16
  `, [date]);
  return { pwHigh: r.rows[0]?.pw_high || null, pwLow: r.rows[0]?.pw_low || null };
}

// ── Structural state derivation ──────────────────────────────────────────────

// ── Conviction ratings from phase_change_backtest_results ────────────────────

/**
 * Return star ratings (0–3) per key level based on historical reversal rates.
 * ≥60% = 3★, 50–59% = 2★, 40–49% = 1★, <40% = 0★
 */
export async function getConvictionData() {
  const r = await query(
    `SELECT results_by_level FROM phase_change_backtest_results ORDER BY run_date DESC LIMIT 1`
  );
  const raw = r.rows[0]?.results_by_level || {};
  const toStars = (rate) => {
    if (rate == null) return null;
    if (rate >= 0.58) return 3;
    if (rate >= 0.48) return 2;
    if (rate >= 0.38) return 1;
    return 0;
  };
  const HARDCODED = {
    IB_HIGH:        { rate: 0.445, stars: 2, n: 742,  avgMag: null },
    IB_LOW:         { rate: 0.381, stars: 1, n: 239,  avgMag: null },
    OVERNIGHT_HIGH: { rate: 0.416, stars: 2, n: 666,  avgMag: null },
    PRIOR_WEEK_HIGH:{ rate: 0.759, stars: 2, n: 364,  avgMag: null },
    PRIOR_WEEK_LOW: { rate: 0.648, stars: 2, n: 327,  avgMag: null },
  };
  const entry = (key) => {
    if (raw[key]) return { rate: raw[key].reversalRate, stars: toStars(raw[key].reversalRate), n: raw[key].n, avgMag: raw[key].avgMag };
    if (HARDCODED[key]) return HARDCODED[key];
    return null;
  };
  return {
    composite_vah:   entry('COMPOSITE_VAH'),
    composite_poc:   entry('COMPOSITE_POC'),
    composite_val:   entry('COMPOSITE_VAL'),
    prior_day_vah:   entry('PRIOR_DAY_VAH'),
    prior_day_poc:   entry('PRIOR_DAY_POC'),
    prior_day_val:   entry('PRIOR_DAY_VAL'),
    bracket_high:    entry('BRACKET_HIGH'),
    bracket_low:     entry('BRACKET_LOW'),
    ib_high:         entry('IB_HIGH'),
    ib_low:          entry('IB_LOW'),
    overnight_high:  entry('OVERNIGHT_HIGH'),
    prior_week_high: entry('PRIOR_WEEK_HIGH'),
    prior_week_low:  entry('PRIOR_WEEK_LOW'),
  };
}

/**
 * Adjust a conviction entry's star rating based on NL30 trend alignment
 * and structural state. Returns augmented entry with dynamic.stars and breakdown.
 * @param {object} base - entry from getConvictionData (has .rate, .stars, .n)
 * @param {string} levelKey - e.g. 'ib_high', 'composite_val'
 * @param {object} ctx - { nl30: number, structuralState: string }
 */
export function computeDynamicConviction(base, levelKey, { nl30 = 0, structuralState = null } = {}) {
  if (!base) return null;
  const k = levelKey.toLowerCase();
  const isSupport    = k.includes('val') || k.includes('_low') || k === 'bracket_low';
  const isResistance = k.includes('vah') || k.includes('_high') || k === 'bracket_high';

  let modifier = 1.0;
  const breakdown = [];

  if (isSupport && nl30 > 9) {
    modifier += 0.10; breakdown.push('NL30 bullish + support: +10%');
  } else if (isResistance && nl30 < -9) {
    modifier += 0.10; breakdown.push('NL30 bearish + resistance: +10%');
  } else if (isSupport && nl30 < -9) {
    modifier -= 0.10; breakdown.push('NL30 bearish vs support: −10%');
  } else if (isResistance && nl30 > 9) {
    modifier -= 0.10; breakdown.push('NL30 bullish vs resistance: −10%');
  }

  const isBracket = ['BRACKET','BRACKET_TILTING_UP','BRACKET_TILTING_DOWN','BALANCE'].includes(structuralState);
  const isTrend   = ['TRENDING_UP','TRENDING_DOWN'].includes(structuralState);
  if (isBracket) { modifier += 0.05; breakdown.push('Bracket/balance structure: +5%'); }
  else if (isTrend) { modifier -= 0.05; breakdown.push('Trending structure: −5%'); }

  const adjustedRate = Math.max(0, base.rate * modifier);
  const toStars = (r) => r >= 0.58 ? 3 : r >= 0.48 ? 2 : r >= 0.38 ? 1 : 0;

  return {
    baseRate: base.rate,
    adjustedRate,
    stars: toStars(adjustedRate),
    n: base.n,
    breakdown,
  };
}

/**
 * Derive NL30 bucket used by condition_memory keys.
 */
export function nl30ToBucket(nl30) {
  return nl30 > 15 ? 'STRONG_BULL' : nl30 > 9 ? 'BULL' : nl30 < -15 ? 'STRONG_BEAR' : nl30 < -9 ? 'BEAR' : 'RANGING';
}

/**
 * Derive NL30 trend label.
 */
export function nl30ToTrend(nl30) {
  return nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING';
}
