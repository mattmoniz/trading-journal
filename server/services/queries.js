/**
 * Shared SQL query helpers — single source of truth for common patterns.
 * All callers should import from here to prevent drift between implementations.
 */

import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';

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

// getValueArea() and getPriorMonthValueArea() removed 2026-07-16 (dead-ends audit) --
// both exported, zero callers anywhere in the repo (grep-verified). git history has
// them if ever needed again -- e.g. for a real PM VAH/VAL reference level feature.

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
    FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
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
    FROM price_bars_primary WHERE symbol='NQ'
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
    FROM price_bars_primary
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
    FROM price_bars_primary WHERE symbol='NQ'
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
  // All level types below are now produced live by getStructuralLevels()
  // (server/services/phaseChangeDetector.js) and backtested by runPhaseChangeBacktest()
  // (server/services/phaseChangeBacktest.js) — no hardcoded fallback needed or used.
  const entry = (key) => {
    if (!raw[key]) return null;
    return { rate: raw[key].reversalRate, stars: toStars(raw[key].reversalRate), n: raw[key].n, avgMag: raw[key].avgMag };
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
    overnight_low:   entry('OVERNIGHT_LOW'),
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

// nl30ToBucket()/nl30ToTrend() removed 2026-07-16 (dead-ends audit) -- both exported,
// zero callers anywhere in the repo (grep-verified). Superseded by the live NL30
// bucketing in acd.js's sizeMultiplier IIFE (_lfNl30Bucket: MILD_BULL/STRONG_BULL/
// MILD_BEAR/STRONG_BEAR/NEUTRAL), a different scheme with different bucket names --
// these two used static 9/15 literal thresholds, also a "no static thresholds" hard-
// rule violation, moot now that they're gone. git history has them if ever needed.

/**
 * Rolling VWAP distance std — single source of truth for VWAP_MAGNET threshold.
 * Returns { std, mean, n, threshold } where threshold = max(50, std * sigmaMult).
 * Callers: acd.js (VWAP_MAGNET), morningBrief.js (scalp-recap + trade-alerts), antigravityEdges.js.
 */
export async function getTrailingVwapStd(date, days = 30, sigmaMult = 1.5) {
  const res = await query(
    `SELECT close_vs_vwap FROM session_analysis
     WHERE trade_date >= $1::date - $2::int AND trade_date < $1
     AND close_vs_vwap IS NOT NULL ORDER BY trade_date DESC`,
    [date, days]
  ).catch(() => ({ rows: [] }));
  const vals = res.rows.map(r => r.close_vs_vwap);
  if (vals.length < 20) return { std: 130, mean: 0, n: vals.length, threshold: Math.max(50, Math.round(130 * sigmaMult)) };
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
  return { std, mean, n: vals.length, threshold: Math.max(50, Math.round(std * sigmaMult)) };
}

/**
 * Bars for the "24hr VWAP" window — 6PM ET the prior day through 4:59PM ET the given
 * date (spans the full Globex+RTH combined trading day, NOT the pre-RTH-only window
 * scripts/calibrate_delta_confirmation.mjs's getGlobexBars uses for a different purpose).
 * Same window already hand-written 2x in server/routes/morningBrief.js — factored out here
 * 2026-07-28 as the third consumer (GLOBEX_VWAP_MAGNET, server/routes/acd.js) arrived,
 * rather than hand-copying a 3rd/4th time. Shape matches computeRunningVwapSeries()'s
 * expected input directly ({ high, low, close, volume }), plus bid_volume/ask_volume for
 * any consumer needing order-flow (cumulative delta) — added 2026-07-28 after this
 * function's original VWAP-only column list silently broke a same-day delta-confirmation
 * test: every bar's ask_volume/bid_volume read as `undefined`, so cumulative delta was
 * exactly 0 for every touch, collapsing the p25 threshold to 0 and producing a fully
 * degenerate split (100% "CONFIRMATION", zero PRICE_ONLY_CONTROL) that looked like "Globex
 * has no delta signal" but was actually just missing columns.
 */
export async function getGlobex24hrBars(date) {
  const r = await query(`
    SELECT ts, high::float, low::float, close::float, volume::bigint as volume,
      COALESCE(bid_volume,0)::int as bid_volume, COALESCE(ask_volume,0)::int as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' AND (
      (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
      (ts::date = $1 AND EXTRACT(hour FROM ts) < 17)
    ) ORDER BY ts`, [date]).catch(() => ({ rows: [] }));
  return r.rows;
}

/**
 * Trailing 24hr-VWAP (Globex-spanning) distances — moved here from
 * server/routes/morningBrief.js 2026-07-28 (was a private, unexported helper) so the new
 * GLOBEX_VWAP_MAGNET live setup and its historical backfill script (scripts/
 * backtest_globex_vwap_magnet.mjs) can both call the exact same no-lookahead
 * implementation instead of re-deriving the Globex-session-bucketing logic — that logic
 * has real subtlety (a bar with hour>=18 belongs to the NEXT calendar day's session, not
 * its own) that this codebase has gotten wrong before on reimplementation. Pure relocation,
 * zero logic change (verified: same query, same bulk-fetch-then-bucket structure, same
 * cache key/TTL) — server/routes/morningBrief.js now imports this instead of defining it.
 * Returns an array of (session_close - vwap24) distances, one per historical session with
 * >50 Globex bars, for sessions strictly before `date`.
 */
export async function getTrailing24hrVwapDists(date, days = 30) {
  const ck = `mb:24hrVwapDists:${date}:${days}`;
  const cached = cacheGet(ck);
  if (cached) return cached;
  const DAY_CACHE_TTL = 12 * 60 * 60 * 1000;
  const result = await query(`
    WITH day_list AS (
      SELECT DISTINCT ts::date as d FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date >= $1::date - $2::int AND ts::date < $1
      ORDER BY d
    )
    SELECT d::text, (array_agg(close ORDER BY ts DESC))[1]::float as close_price
    FROM price_bars_primary pb
    JOIN day_list dl ON pb.ts::date = dl.d
    WHERE symbol='NQ' AND EXTRACT(hour FROM pb.ts)*60+EXTRACT(minute FROM pb.ts) BETWEEN 570 AND 959
    GROUP BY d
    ORDER BY d`, [date, days]).catch(() => ({ rows: [] }));
  if (result.rows.length < 5) return cacheSet(ck, [], DAY_CACHE_TTL);

  const days_arr = result.rows.map(r => r.d);
  const minD = days_arr[0], maxD = days_arr[days_arr.length - 1];
  const bulkRes = await query(`
    SELECT ts::date::text as d, EXTRACT(hour FROM ts)::int as hr,
           high::float, low::float, close::float, volume::bigint as vol
    FROM price_bars_primary WHERE symbol='NQ'
      AND ts::date >= $1::date - 1 AND ts::date <= $2::date
      AND (EXTRACT(hour FROM ts) >= 18 OR EXTRACT(hour FROM ts) < 17)
  `, [minD, maxD]).catch(() => ({ rows: [] }));
  const bySession = new Map();
  for (const b of bulkRes.rows) {
    let sessDate;
    if (b.hr >= 18) {
      const dt = new Date(b.d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() + 1);
      sessDate = dt.toISOString().slice(0, 10);
    } else {
      sessDate = b.d;
    }
    if (!bySession.has(sessDate)) bySession.set(sessDate, []);
    bySession.get(sessDate).push(b);
  }

  const dists = [];
  for (const row of result.rows) {
    const globexBars = bySession.get(row.d) || [];
    if (globexBars.length > 50) {
      let pv = 0, v = 0;
      for (const b of globexBars) { pv += (b.high + b.low + b.close) / 3 * Number(b.vol || 1); v += Number(b.vol || 1); }
      const vwap24 = pv / v;
      dists.push(row.close_price - vwap24);
    }
  }
  return cacheSet(ck, dists, DAY_CACHE_TTL);
}

/**
 * Rolling 24hr-VWAP distance std — the Globex-spanning sibling of getTrailingVwapStd()
 * above, same shape/threshold formula (max(50, std*sigmaMult)), for GLOBEX_VWAP_MAGNET.
 */
export async function getTrailing24hrVwapStd(date, days = 30, sigmaMult = 1.5) {
  const vals = await getTrailing24hrVwapDists(date, days);
  if (vals.length < 20) return { std: 130, mean: 0, n: vals.length, threshold: Math.max(50, Math.round(130 * sigmaMult)) };
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
  return { std, mean, n: vals.length, threshold: Math.max(50, Math.round(std * sigmaMult)) };
}
