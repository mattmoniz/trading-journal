// One-off repair: re-tag trades.level_proximity for every currently-tagged trade
// after fixing the volume-area bucket-by-low bug (docs/OPEN_THREADS.md, 2026-07-17).
//
// level_prices' PW_VAH/PW_VAL/PW_POC, PM_VAH/PM_VAL/PM_POC, 3M_VAH/3M_VAL/3M_POC were
// recomputed with the corrected spread-volume method (scripts/compute_levels.js
// --backfill). Every trade's nearest-level ranking (levelProximityService.js) was
// computed against the OLD buggy values, and a wrong VA level could have displaced a
// correct level from a trade's top3/nearest even when the final tag wasn't itself a VA
// level — so ALL currently-tagged trades are re-ranked from scratch here, not just the
// ones whose stored nearest_level happens to be one of the 9 affected level_names.
//
// Backup taken first: trades_level_proximity_backup_20260717 (id, level_proximity).

import { query } from '../server/db.js';
import { tagTradeProximity } from '../server/services/levelProximityService.js';

const rows = await query(`
  SELECT id, log_date::text as log_date, entry_price::float as entry_price
  FROM trades WHERE level_proximity IS NOT NULL
  ORDER BY id
`);

console.log(`Re-tagging ${rows.rows.length} trades...`);
let done = 0, changed = 0, skipped = 0;
const backupR = await query(`SELECT id, level_proximity FROM trades_level_proximity_backup_20260717`);
const before = new Map(backupR.rows.map(r => [r.id, r.level_proximity]));

for (const row of rows.rows) {
  const result = await tagTradeProximity(row.id, row.log_date, row.entry_price);
  if (!result) { skipped++; continue; }
  const prior = before.get(row.id);
  if (!prior || prior.nearest_level !== result.nearest_level || prior.tag !== result.tag) changed++;
  done++;
  if (done % 1000 === 0) console.log(`  ${done}/${rows.rows.length}`);
}

console.log(`Done. ${done} re-tagged, ${changed} changed nearest_level/tag vs. the pre-fix backup, ${skipped} skipped (no level_prices for that date).`);
process.exit(0);
