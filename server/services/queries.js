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

/**
 * RTH-session-bar-derived rolling VWAP distance — the RTH sibling of
 * getTrailingRthVwapDists's Globex cousin (getTrailing24hrVwapDists above), built
 * 2026-09-01 to resolve OPEN_DECISION globex_vs_rth_vwap_magnet_divergence_unexplained's
 * named confound: getTrailingVwapStd() (used live by RTH VWAP_MAGNET) reads
 * session_analysis.close_vs_vwap, which only goes back to 2026-03-25 (~109 real days,
 * confirmed live 2026-09-01) — nowhere near price_bars_primary's real ~3.9yr NQ history
 * (back to 2022-12-14) that the Globex sibling's calibration draws from. This function
 * computes the same quantity (RTH session close minus RTH session VWAP, matching
 * patternScannerService.js's scanSession() BETWEEN 570 AND 959 window and HLC/3 volume
 * weighting exactly) directly from price_bars_primary, so a longer, non-session_analysis-
 * limited RTH reconstruction can be built and compared against the existing short one —
 * NOT wired into any live path, this is a backtest/reconstruction-only helper. Does not
 * replace getTrailingVwapStd's live threshold (still deliberately session_analysis-backed,
 * unchanged) — this is for reconstructing history further back than that table allows.
 */
export async function getTrailingRthVwapDists(date, days = 30) {
  const ck = `mb:rthVwapDists:${date}:${days}`;
  const cached = cacheGet(ck);
  if (cached) return cached;
  const DAY_CACHE_TTL = 12 * 60 * 60 * 1000;
  const bulkRes = await query(`
    SELECT ts::date::text as d, high::float, low::float, close::float,
           volume::bigint as vol
    FROM price_bars_primary WHERE symbol='NQ'
      AND ts::date >= $1::date - $2::int AND ts::date < $1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts`, [date, days]).catch(() => ({ rows: [] }));
  const byDay = new Map();
  for (const b of bulkRes.rows) {
    if (!byDay.has(b.d)) byDay.set(b.d, []);
    byDay.get(b.d).push(b);
  }
  const dists = [];
  for (const [, dayBars] of byDay) {
    if (dayBars.length < 30) continue; // matches scanSession()'s own thin-day guard
    let pv = 0, v = 0;
    for (const b of dayBars) { pv += (b.high + b.low + b.close) / 3 * Number(b.vol || 1); v += Number(b.vol || 1); }
    const vwap = pv / v;
    const closePrice = dayBars[dayBars.length - 1].close;
    dists.push(closePrice - vwap);
  }
  return cacheSet(ck, dists, DAY_CACHE_TTL);
}

/**
 * Rolling RTH VWAP-distance std over the FULL price_bars_primary history — see
 * getTrailingRthVwapDists's header. Same threshold formula (max(50, std*sigmaMult)) as
 * getTrailingVwapStd/getTrailing24hrVwapStd for direct comparability.
 */
export async function getTrailingRthVwapStdFullHistory(date, days = 30, sigmaMult = 1.5) {
  const vals = await getTrailingRthVwapDists(date, days);
  if (vals.length < 20) return { std: 130, mean: 0, n: vals.length, threshold: Math.max(50, Math.round(130 * sigmaMult)) };
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
  return { std, mean, n: vals.length, threshold: Math.max(50, Math.round(std * sigmaMult)) };
}

// ── Trading-day-array gap guard ──────────────────────────────────────────────
// Added 2026-08-31 (OPEN_DECISION price_bars_primary_systemic_quarterly_data_gap). Root cause
// confirmed by direct query: price_bars_dedup_hist (the historical branch price_bars_primary's
// view unions in -- essentially ALL historical data, since the view's other, calendar-JOIN
// branch only ever applies to ts > dedup_hist's own max(ts), which is always very recent) has
// real, permanent gaps of ~63-70 days each at ALL 6 consecutive NQ contract rollovers from
// Dec2023 through Mar2025 inclusive -- 2023-12-14->2024-02-15, 2024-03-14->2024-05-23,
// 2024-06-20->2024-08-22, 2024-09-19->2024-11-21, 2024-12-19->2025-02-20, 2025-03-20->2025-05-22.
// In each case the OLD contract's data stops dead at its own expiration (e.g. NQU24's last bar is
// a partial day exactly on its 3rd-Friday expiration) and the NEW contract's data doesn't begin
// until ~2 months later (e.g. NQZ24 starts 2024-11-21, not shortly after NQU24 expired) --
// consistent with a chart/feed manually re-pointed to each new front-month contract roughly one
// full rollover cycle late, for 6 consecutive quarters running, before the process was fixed (no
// multi-week gaps found after 2025-05-22; one much smaller ~2-month window of THIN, not absent,
// data around the 2025-09 rollover was found while investigating this and is a DIFFERENT,
// NOT-yet-root-caused issue, flagged separately as OPEN_DECISION
// price_bars_nqh26_contract_thin_and_early_20260928). This data cannot be recovered (it was
// apparently never captured), so this is a standing guard against silently trusting it, not a
// fix to the data itself.
//
// A script that builds `const dates = [...]` from DISTINCT trading days and then indexes it
// positionally (dates[i], dates[i+1], a fixed windowSize slice, etc.) to mean "the next N
// trading days" will silently produce a corrupted multi-month window disguised as a short one
// whenever that window straddles one of these gaps -- confirmed to have actually happened in
// scripts/backtest_turn_of_month_effect.mjs (22% of its sample) and (in a different, less
// exposed way) scripts/backtest_range_boundary_rejection_traversal.mjs before this fix. 4 more
// scripts with the same dates[i-1]/dates[i+1] pattern found via grep but not yet audited/fixed --
// tracked as OPEN_DECISION audit_remaining_positional_dategap_scripts_20260831.
//
// findTradingDayGaps() is the low-level primitive (for a caller that wants to split its own
// index into contiguous segments rather than fail outright); assertNoTradingDayGaps() is the
// simple default -- throws loudly rather than silently producing a corrupted window, matching
// this codebase's fail-loud convention elsewhere (the OPTIMAL_STOP circuit breaker,
// record_claim.mjs's VARCHAR guards). 5-day default maxGapDays comfortably covers real trading
// closures (a 3-4 day holiday weekend) while still catching anything resembling the 61-day
// contract-rollover gaps above.

/**
 * Returns every gap > maxGapDays between consecutive entries of a SORTED array of
 * 'YYYY-MM-DD' trading-day date strings.
 *
 * IMPORTANT for a caller using its own raw `pg.Client` instead of this codebase's shared
 * `query()` (server/db.js): importing this function is NOT side-effect-free (DeepSeek code
 * review round 5, finding T4) -- this whole module imports `query` from `../db.js` at the top,
 * and db.js calls `pg.types.setTypeParser(...)` at MODULE LOAD, a process-wide mutation of pg's
 * shared type registry (affects every pg.Client/Pool in the process, not just server/db.js's
 * own). A raw pg.Client that expected `date` columns as JS `Date` objects will silently start
 * getting plain strings instead the moment anything in the same process imports this file --
 * exactly what broke scripts/backtest_turn_of_month_effect.mjs's `.toISOString()` calls when it
 * first imported this helper. Safest fix if this bites again: migrate the caller onto `query()`
 * (matches this codebase's own convention anyway), not work around the type-parser change.
 */
export function findTradingDayGaps(sortedDateStrings, maxGapDays = 5) {
  const gaps = [];
  for (let i = 1; i < sortedDateStrings.length; i++) {
    const prev = new Date(sortedDateStrings[i - 1] + 'T00:00:00Z');
    const curr = new Date(sortedDateStrings[i] + 'T00:00:00Z');
    const gapDays = Math.round((curr - prev) / 86400000);
    // Guard added 2026-08-31 (DeepSeek code review round 5, finding T3): a malformed date
    // string produces gapDays=NaN, and NaN > maxGapDays is false -- silently NOT flagged as a
    // gap, the opposite of this function's whole purpose. No current caller feeds malformed
    // dates, but fail loud rather than silently pass a bad input through as "no gap found."
    if (Number.isNaN(gapDays)) {
      throw new Error(`findTradingDayGaps: could not parse a date pair as YYYY-MM-DD ('${sortedDateStrings[i - 1]}', '${sortedDateStrings[i]}') -- gapDays computed as NaN`);
    }
    if (gapDays > maxGapDays) {
      gaps.push({ fromIndex: i - 1, toIndex: i, fromDate: sortedDateStrings[i - 1], toDate: sortedDateStrings[i], gapDays });
    }
  }
  return gaps;
}

/**
 * Throws if a SORTED array of 'YYYY-MM-DD' trading-day date strings has any gap wider than
 * maxGapDays -- call this immediately after building any positionally-indexed trading-day array
 * from price_bars_primary (or anything derived from it) and BEFORE treating dates[i+1] as "the
 * next trading day." `context` is prepended to the error for a faster trace back to the caller.
 */
export function assertNoTradingDayGaps(sortedDateStrings, { maxGapDays = 5, context = '' } = {}) {
  const gaps = findTradingDayGaps(sortedDateStrings, maxGapDays);
  if (gaps.length > 0) {
    const detail = gaps.map(g => `${g.fromDate} -> ${g.toDate} (${g.gapDays}d)`).join(', ');
    throw new Error(
      `assertNoTradingDayGaps${context ? ` (${context})` : ''}: ${gaps.length} gap(s) > ${maxGapDays} day(s) found in a ` +
      `positionally-indexed trading-day array of ${sortedDateStrings.length} entries -- indexing dates[i]/dates[i+1] as ` +
      `adjacent days will silently corrupt any window straddling one of these into a much-longer-than-intended one: ${detail}. ` +
      `Known, root-caused source: real quarterly NQ contract-rollover gaps in price_bars_dedup_hist, 2024-09 through 2025-05 ` +
      `(OPEN_DECISION price_bars_primary_systemic_quarterly_data_gap). Either exclude the affected date range from your ` +
      `query, or split your positional index at each gap boundary (findTradingDayGaps()) instead of treating it as continuous.`
    );
  }
}

// Companion guard to the gap functions above, but for a DIFFERENT failure mode (2026-08-31,
// OPEN_DECISION price_bars_nqh26_contract_thin_and_early_20260928): this window has NO missing
// dates (findTradingDayGaps() would not flag it -- every date has SOME row), but real
// front-month volume is missing anyway. NQZ25 (Dec2025) should have been front-month for
// essentially all of 2025-09-20 through 2025-12-19, but price_bars_dedup_hist only has its
// genuine front-month volume (400k-990k/day) for 2025-11-19 through 2025-12-12 -- outside
// that, the table has only NQH26's thin (~1-2% of real volume) background-contract data for
// the same calendar dates. PRICE-only reads are largely unaffected (NQH26 tracks NQZ25's
// price closely even on thin volume, not independently verified); VOLUME-based measures
// (rolling volume baselines, ATR-by-volume, order-flow imbalance, anything from
// touchQuality.js's getVolumeBaseline()) computed over a window touching these dates are
// silently using the wrong contract's volume.
export const THIN_VOLUME_WINDOWS = [
  { from: '2025-09-20', to: '2025-11-18', reason: 'NQZ25 missing its own first ~2 months; price_bars_dedup_hist has only NQH26 thin background-contract volume for these dates' },
];

// True if [fromDate, toDate] (inclusive, 'YYYY-MM-DD' strings) overlaps any known thin-volume
// window. Call this before trusting a VOLUME-based (not price-only) rolling measure whose
// window could reach back into 2025-09/2025-11 -- most live callers use a short trailing
// lookback relative to today and will never overlap this as time moves forward, but any
// full-history backtest or a lookback long enough to reach back that far should check.
export function overlapsThinVolumeWindow(fromDate, toDate) {
  return THIN_VOLUME_WINDOWS.some(w => fromDate <= w.to && toDate >= w.from);
}
