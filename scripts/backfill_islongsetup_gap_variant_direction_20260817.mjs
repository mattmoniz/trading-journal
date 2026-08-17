// One-off backfill for OPEN_DECISION islongsetup_gap_variant_direction_bug (fixed 2026-08-17,
// see server/routes/acd.js's resolveDirection()). Corrects actual_pnl on the historical rows
// where the OLD isLongSetup()-based direction disagreed with the price-derived direction
// (t1_level > stop_level -- the same signal resolveDirection() uses as its fallback/cross-check).
//
// Scope, measured directly before writing this script: 20 total historical rows affected
// (setup_type='ZONE_EDGE_FADE' OR '%_GAP_UP'/'%_GAP_DOWN'), all origin_status IN
// ('SHADOW','UNKNOWN') -- zero ACTIVE (real-capital) rows. Of those 20, only 6 actually need
// correction (the other 14 had a direction that happened to already match, e.g. a genuinely
// SHORT ZONE_EDGE_FADE row that isLongSetup's default-SHORT guess got right by coincidence).
// All 6 affected rows resolved via TIME_EXPIRED/MARK_TO_MARKET (the expireStaleSetups()
// backstop path) -- mae_points/mfe_points were never computed for these rows (that path
// doesn't set them), confirmed via a direct SELECT before writing this script, so this
// backfill only needs to touch actual_pnl, not a bar-replay MAE/MFE recompute.
//
// The 1 UNKNOWN-origin row (pre-2026-07-09, unrecoverable per this codebase's own convention)
// is left untouched -- correcting it would misrepresent it as recoverable when the rest of
// this codebase treats UNKNOWN as structurally unrecoverable.
//
// Run: node scripts/backfill_islongsetup_gap_variant_direction_20260817.mjs

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const PPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

async function main() {
  const affected = await query(`
    SELECT id, setup_type, origin_status, entry_zone_low, entry_zone_high, stop_level, t1_level,
           price_at_resolution, actual_pnl, mae_points, mfe_points
    FROM active_setups
    WHERE (setup_type='ZONE_EDGE_FADE' OR setup_type LIKE '%_GAP_UP' OR setup_type LIKE '%_GAP_DOWN')
      AND resolution IS NOT NULL
      AND origin_status IN ('ACTIVE','SHADOW')
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND price_at_resolution IS NOT NULL
    ORDER BY id
  `);

  const needsFix = [];
  for (const row of affected.rows) {
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    if (entry == null) continue;
    const oldLong = row.setup_type.includes('LONG') || row.setup_type.includes('BULLISH') || row.setup_type.includes('_UP');
    const newLong = +row.t1_level > +row.stop_level;
    if (oldLong === newLong) continue; // already correct, coincidentally
    if (row.mae_points != null || row.mfe_points != null) {
      console.error(`SKIP id=${row.id}: has non-null mae/mfe_points -- this script does not recompute those (bar-replay required), out of its scope. Handle separately.`);
      continue;
    }
    const correctedPnl = Math.round(((newLong ? (+row.price_at_resolution - +entry) : (+entry - +row.price_at_resolution))
      * PPP - COMMISSION) * 100) / 100;
    needsFix.push({ ...row, entry, newLong, correctedPnl });
  }

  console.log(`${affected.rows.length} candidate rows scanned, ${needsFix.length} need actual_pnl correction.`);
  if (!needsFix.length) { console.log('Nothing to do.'); return; }

  for (const r of needsFix) {
    console.log(`  id=${r.id} ${r.setup_type} (${r.origin_status}): old_pnl=${r.actual_pnl} -> new_pnl=${r.correctedPnl} (direction: ${r.newLong ? 'LONG' : 'SHORT'})`);
  }

  // Backup first, per docs/DB_MIGRATION_PROTOCOL.md.
  const ids = needsFix.map(r => r.id);
  await query(`DROP TABLE IF EXISTS active_setups_islongsetup_gapvariant_backfill_backup_20260817`);
  await query(`
    CREATE TABLE active_setups_islongsetup_gapvariant_backfill_backup_20260817 AS
    SELECT * FROM active_setups WHERE id = ANY($1)
  `, [ids]);
  const backupCount = (await query(`SELECT COUNT(*) as n FROM active_setups_islongsetup_gapvariant_backfill_backup_20260817`)).rows[0].n;
  console.log(`Backed up ${backupCount} rows to active_setups_islongsetup_gapvariant_backfill_backup_20260817.`);
  if (+backupCount !== needsFix.length) {
    console.error('Backup row count mismatch -- aborting without writing.');
    process.exit(1);
  }

  let updated = 0;
  for (const r of needsFix) {
    const res = await query(`UPDATE active_setups SET actual_pnl=$2, updated_at=NOW() WHERE id=$1`, [r.id, r.correctedPnl]);
    updated += res.rowCount;
  }
  console.log(`Updated ${updated} rows.`);

  // Self-check: re-read and confirm.
  const verify = await query(`SELECT id, actual_pnl FROM active_setups WHERE id = ANY($1) ORDER BY id`, [ids]);
  for (const row of verify.rows) {
    const expected = needsFix.find(r => r.id === row.id).correctedPnl;
    if (+row.actual_pnl !== expected) {
      console.error(`SELF-CHECK FAILED: id=${row.id} expected ${expected}, got ${row.actual_pnl}`);
      process.exit(1);
    }
  }
  console.log('Self-check passed: all updated rows read back with the expected corrected actual_pnl.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
