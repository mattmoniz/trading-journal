// One-off repair: re-tag trades.level_proximity for every currently-tagged trade after
// replacing levelProximityService.js's flat 5pt/15pt AT_LEVEL/LATE/CHASING cutoff with a
// volatility-scaled one (2% / 10% of rolling ATR20) — see that file's header comment and
// docs/OPEN_THREADS.md for scripts/research_level_proximity_thresholds.mjs's full findings.
//
// Backup taken first: trades_level_proximity_backup_20260717_pre_atr_scale (id,
// level_proximity) — captures the post-VA-fix, pre-ATR-scaling state (a separate, earlier
// backup from the same day, trades_level_proximity_backup_20260717, already captures the
// original pre-VA-fix state, so both rollback points exist).
import { query } from '../server/db.js';
import { tagTradeProximity } from '../server/services/levelProximityService.js';

const rows = await query(`
  SELECT id, log_date::text as log_date, entry_price::float as entry_price
  FROM trades WHERE level_proximity IS NOT NULL
  ORDER BY id
`);

console.log(`Backing up current state for ${rows.rows.length} trades...`);
await query(`
  CREATE TABLE IF NOT EXISTS trades_level_proximity_backup_20260717_pre_atr_scale AS
  SELECT id, level_proximity FROM trades WHERE level_proximity IS NOT NULL
`);
const backupCount = await query(`SELECT COUNT(*) as n FROM trades_level_proximity_backup_20260717_pre_atr_scale`);
console.log(`Backup table has ${backupCount.rows[0].n} rows.`);

const before = new Map();
for (const row of rows.rows) before.set(row.id, null); // filled below from the backup we just took
const backupR = await query(`SELECT id, level_proximity FROM trades_level_proximity_backup_20260717_pre_atr_scale`);
for (const r of backupR.rows) before.set(r.id, r.level_proximity);

console.log(`Re-tagging ${rows.rows.length} trades with the ATR-scaled method...`);
let done = 0, changed = 0, skipped = 0;
const tagCounts = { before: {}, after: {} };

for (const row of rows.rows) {
  const prior = before.get(row.id);
  if (prior?.tag) tagCounts.before[prior.tag] = (tagCounts.before[prior.tag] || 0) + 1;

  const result = await tagTradeProximity(row.id, row.log_date, row.entry_price);
  if (!result) { skipped++; continue; }
  tagCounts.after[result.tag] = (tagCounts.after[result.tag] || 0) + 1;
  if (!prior || prior.tag !== result.tag) changed++;
  done++;
  if (done % 1000 === 0) console.log(`  ${done}/${rows.rows.length}`);
}

console.log(`\nDone. ${done} re-tagged, ${changed} changed tag vs. the pre-ATR-scale backup, ${skipped} skipped (no level_prices for that date).`);
console.log('Tag distribution BEFORE:', JSON.stringify(tagCounts.before));
console.log('Tag distribution AFTER: ', JSON.stringify(tagCounts.after));
process.exit(0);
