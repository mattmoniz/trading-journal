// levelProximityService.js
// Tags BP fill entry prices against level_prices for their session date.
// Proximity tags: AT_LEVEL / LATE / CHASING, boundary = distance as a fraction of that
// day's own rolling 20-day RTH range (ATR20) -- AT_LEVEL <= 2% ATR20, LATE <= 10% ATR20,
// else CHASING. Stores top-3 nearest levels in trades.level_proximity JSONB.
//
// Was a flat 5pt/15pt point cutoff until 2026-07-17 (OPEN_DECISION
// level_proximity_static_pt_thresholds — CLAUDE.md's "No static thresholds" rule).
// scripts/research_level_proximity_thresholds.mjs ran the real backtest first (not a
// design decision made without data): the flat cutoff turned out to represent only
// ~1.8%/5.5% of the dataset's median ATR20 (273.5pt) -- almost certainly stale relative to
// today's much wider ranges. A sweep across candidate %ATR boundaries (N>=20/bucket gated,
// scored on outcome separation between AT_LEVEL and CHASING via real account-day P&L from
// the standard CumPL-diff method) found 2%/10% ATR both cleaner (bigger separation, still
// monotonic AT_LEVEL > LATE > CHASING) and chronologically stable specifically for the
// CHASING-is-worse direction (computeRigor: not day-clustered, negative across all 3
// chronological thirds) -- see docs/OPEN_THREADS.md for the full numbers. Existing tagged
// trades were re-tagged with the new method in the same session (retag_level_proximity
// script, backed up first per DB_MIGRATION_PROTOCOL.md).
import { query } from '../db.js';

const AT_LEVEL_ATR_FRAC = 0.02;
const LATE_ATR_FRAC = 0.10;
const ATR_WINDOW_DAYS = 20;
// Flat-point fallback ONLY for dates with fewer than ATR_WINDOW_DAYS of prior RTH data to
// average (effectively the first ~20 trading days of price_bars_primary history) -- avoids
// leaving a tag null/undefined for genuinely unrecoverable early history rather than
// guessing at a volatility figure that isn't there yet (DB_MIGRATION_PROTOCOL.md's "never
// guess at genuinely unrecoverable historical data" rule).
const FALLBACK_AT_LEVEL_PT = 5;
const FALLBACK_LATE_PT = 15;

export async function getRollingATR(logDate) {
  const { rows } = await query(`
    SELECT AVG(range)::float as atr, COUNT(*)::int as n FROM (
      SELECT ts::date as d, (MAX(high) - MIN(low)) as range
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date < $1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      GROUP BY ts::date
      ORDER BY d DESC LIMIT ${ATR_WINDOW_DAYS}
    ) recent
  `, [logDate]);
  const { atr, n } = rows[0] || {};
  return (atr != null && n >= ATR_WINDOW_DAYS) ? atr : null;
}

export async function tagTradeProximity(tradeId, logDate, entryPrice) {
  if (entryPrice == null) return null;

  const levelsRes = await query(
    `SELECT level_name, price::float, category FROM level_prices WHERE trade_date = $1 AND price IS NOT NULL`,
    [logDate]
  );

  if (!levelsRes.rows.length) return null;

  const entry = parseFloat(entryPrice);
  const ranked = levelsRes.rows
    .map(l => ({ level: l.level_name, price: l.price, category: l.category, dist: Math.abs(entry - l.price) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5);

  const nearest = ranked[0];
  const atr = await getRollingATR(logDate);
  const tag = atr != null
    ? (nearest.dist <= AT_LEVEL_ATR_FRAC * atr ? 'AT_LEVEL' : nearest.dist <= LATE_ATR_FRAC * atr ? 'LATE' : 'CHASING')
    : (nearest.dist <= FALLBACK_AT_LEVEL_PT ? 'AT_LEVEL' : nearest.dist <= FALLBACK_LATE_PT ? 'LATE' : 'CHASING');

  const proximity = {
    tag,
    nearest_level: nearest.level,
    nearest_price: nearest.price,
    nearest_dist:  Math.round(nearest.dist * 4) / 4,
    atr20: atr != null ? Math.round(atr * 10) / 10 : null,
    tag_method: atr != null ? 'ATR_SCALED' : 'FLAT_FALLBACK',
    top3: ranked.slice(0, 3).map(l => ({
      level: l.level,
      price: l.price,
      dist:  Math.round(l.dist * 4) / 4,
      category: l.category,
    })),
  };

  await query(
    `UPDATE trades SET level_proximity = $1 WHERE id = $2`,
    [JSON.stringify(proximity), tradeId]
  );

  return proximity;
}

// Tag all untagged BP fills for a given date (or all history if no date)
export async function tagTradesForDate(logDate) {
  const fills = await query(
    `SELECT id, entry_price::float
     FROM trades
     WHERE log_date = $1
       AND custom_fields->'sierra_data'->>'Entry DateTime' LIKE '% BP'
       AND level_proximity IS NULL
       AND entry_price IS NOT NULL`,
    [logDate]
  );

  let tagged = 0;
  for (const row of fills.rows) {
    const r = await tagTradeProximity(row.id, logDate, row.entry_price);
    if (r) tagged++;
  }
  return tagged;
}

// tagAllHistorical() removed 2026-07-16 (dead-ends audit) -- exported, zero callers
// anywhere in the repo, no scripts/ CLI entry point either (grep-verified) -- unlike
// e.g. replay_all_setups.js/populate_setup_daytype_winrates.js (a genuine deliberate
// manual-backfill pair, kept), this one has no driver at all. git history has it if a
// real bulk-retag-historical-trades need comes up.
