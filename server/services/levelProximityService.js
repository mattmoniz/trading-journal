// levelProximityService.js
// Tags BP fill entry prices against level_prices for their session date.
// Proximity tags: AT_LEVEL (≤5pt), LATE (5-15pt), CHASING (>15pt).
// Stores top-3 nearest levels in trades.level_proximity JSONB.

import { query } from '../db.js';

const AT_LEVEL_PT = 5;
const LATE_PT = 15;

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
  const tag = nearest.dist <= AT_LEVEL_PT ? 'AT_LEVEL'
            : nearest.dist <= LATE_PT     ? 'LATE'
            : 'CHASING';

  const proximity = {
    tag,
    nearest_level: nearest.level,
    nearest_price: nearest.price,
    nearest_dist:  Math.round(nearest.dist * 4) / 4,
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
