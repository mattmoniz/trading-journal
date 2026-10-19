// Completed NQ RTH sessions (09:30-15:59 ET, minute-of-day 570-959) served from the daily_rth_stats table instead of re-aggregating price_bars_primary.
// 2026-10-19, docs/PRICE_BARS_AND_STARTUP_SPEED_SPEC.md Part B1 (independent DeepSeek design review applied). Replaces ~300-500 ms view scans that ran ~170 times
// after every restart (ATR) and again on every detection pass (gap fill) with a 20-40 row indexed read.
//
// Contract (live detection and sizing read these, so the rules are strict):
//  * Same values and same window as the queries this replaces; scripts/test_daily_rth_stats.mjs proves equality and is the standing recheck.
//  * Only COMPLETED sessions: `trade_date < beforeDate`. Callers that also want today's partial session compute it themselves.
//  * Fail soft, never silent: if the table is empty, or an RTH session exists in the raw bars that the table does not have (stale table), or the read throws,
//    the ORIGINAL view query runs instead and the fallback is logged (at most once per 10 min). The fallback also starts a throttled repair of the table.
//  * getRollingRthRange keeps getRollingATR's contract: the 20 most recent sessions inside the 90-day window; the caller still decides n < 20 means "no value".
import { query } from '../db.js';

const RTH_MOD = `(EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959`;
let maxCache = { at: 0, v: null };
let lastWarn = 0, lastHeal = 0, healing = false;

function warn(msg) { if (Date.now() - lastWarn > 600000) { lastWarn = Date.now(); console.error(`[dailyRthStats] ${msg} -- falling back to the price_bars_primary query`); } }

async function healSoon() {
  if (healing || Date.now() - lastHeal < 600000) return;
  healing = true; lastHeal = Date.now();
  try { const { buildDailyRthStats } = await import('../../scripts/build_daily_rth_stats.mjs'); await buildDailyRthStats({ days: 30 }); maxCache = { at: 0, v: null }; }
  catch (e) { console.error('[dailyRthStats] repair failed:', e.message); }
  finally { healing = false; }
}

async function storedMax() {
  if (Date.now() - maxCache.at < 60000) return maxCache.v;
  const v = (await query(`SELECT max(trade_date)::text d FROM daily_rth_stats`)).rows[0].d;
  maxCache = { at: Date.now(), v };
  return v;
}

// true when daily_rth_stats can answer "completed sessions before beforeDate": it has rows, and the raw bars hold no RTH session newer than its latest row.
async function tableIsCurrent(beforeDate) {
  const mx = await storedMax();
  if (!mx) return false;
  if (mx >= beforeDate) return true; // history request entirely inside what is stored (rows are rebuilt nightly)
  const newer = await query(`SELECT 1 FROM price_bars WHERE symbol='NQ' AND ts >= $1::date + 1 AND ts < $2::date AND ${RTH_MOD} LIMIT 1`, [mx, beforeDate]);
  return newer.rowCount === 0;
}

// [{ d:'YYYY-MM-DD', rth_low, rth_high }] oldest first -- the `limit` newest completed sessions strictly before beforeDate.
export async function getCompletedSessions({ beforeDate, limit }) {
  try {
    if (await tableIsCurrent(beforeDate)) {
      const r = await query(`SELECT d, rth_low, rth_high FROM (SELECT trade_date::text AS d, rth_low::float AS rth_low, rth_high::float AS rth_high
          FROM daily_rth_stats WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT $2) s ORDER BY d ASC`, [beforeDate, limit]);
      if (r.rowCount >= limit) return r.rows; // fewer than asked for = the table may not reach back far enough (it holds ~400 days): use the view
    }
    warn(`daily_rth_stats cannot serve sessions before ${beforeDate}`);
  } catch (e) { warn(`daily_rth_stats read failed (${e.message})`); }
  healSoon();
  return (await query(`SELECT d, rth_low, rth_high FROM (SELECT ts::date::text AS d, MIN(low)::float AS rth_low, MAX(high)::float AS rth_high FROM price_bars_primary
      WHERE symbol='NQ' AND ${RTH_MOD} AND ts::date < $1 GROUP BY ts::date ORDER BY ts::date DESC LIMIT $2) sub ORDER BY d ASC`, [beforeDate, limit])).rows;
}

// { atr, n }: mean RTH range of the `count` newest completed sessions inside the `windowDays` window before beforeDate (getRollingATR's exact definition).
export async function getRollingRthRange({ beforeDate, windowDays = 90, count = 20 }) {
  try {
    if (await tableIsCurrent(beforeDate)) {
      const r = await query(`SELECT AVG(rth_range)::float AS atr, COUNT(*)::int AS n FROM (SELECT rth_range FROM daily_rth_stats
          WHERE trade_date < $1 AND trade_date >= $1::date - ($2::int * INTERVAL '1 day') ORDER BY trade_date DESC LIMIT $3) recent`, [beforeDate, windowDays, count]);
      if (r.rows[0].n >= count) return r.rows[0]; // fewer than `count` = the table may not reach back far enough (or a genuine short window): let the view decide
    }
    warn(`daily_rth_stats cannot serve the rolling range before ${beforeDate}`);
  } catch (e) { warn(`daily_rth_stats read failed (${e.message})`); }
  healSoon();
  return (await query(`SELECT AVG(range)::float AS atr, COUNT(*)::int AS n FROM (SELECT ts::date AS d, (MAX(high) - MIN(low)) AS range FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date < $1 AND ts::date >= $1::date - ($2::int * INTERVAL '1 day') AND ${RTH_MOD}
      GROUP BY ts::date ORDER BY d DESC LIMIT $3) recent`, [beforeDate, windowDays, count])).rows[0] || {};
}
