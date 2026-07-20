// One-time backfill: mark-to-market actual_pnl for existing POST_ENTRY INVALIDATED
// active_setups rows that predate the live fix in server/routes/acd.js's
// structurallyInvalidateSetups() (2026-07-20). User-confirmed design decision:
// PRE_ENTRY invalidations and SESSION_CLOSED rows are NOT touched by this script --
// only POST_ENTRY INVALIDATED rows with a real entry price and a null actual_pnl.
// See OPEN_DECISION invalidated_session_closed_setups_never_get_actual_pnl.
//
// Uses the nearest known price_bars_primary close at/before each row's resolved_at as
// the mark-to-market exit price (the live fix uses the live current price at the moment
// of invalidation; for historical rows, the closest real bar to resolved_at is the
// equivalent). Backs up the touched rows first per docs/DB_MIGRATION_PROTOCOL.md.
//
// Run: node scripts/repair_invalidated_post_entry_pnl_20260720.mjs [--dry-run]
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const rowsRes = await query(`
    SELECT id, setup_type, entry_zone_low::float, entry_zone_high::float, resolved_at
    FROM active_setups
    WHERE resolution='INVALIDATED' AND invalidation_timing='POST_ENTRY' AND actual_pnl IS NULL
    ORDER BY resolved_at
  `);
  console.log(`${rowsRes.rows.length} POST_ENTRY INVALIDATED rows with null actual_pnl.`);
  if (!rowsRes.rows.length) { process.exit(0); }

  if (!DRY_RUN) {
    await query(`
      CREATE TABLE IF NOT EXISTS active_setups_invalidated_pnl_backup_20260720 AS
      SELECT * FROM active_setups WHERE id = ANY($1)
    `, [rowsRes.rows.map(r => r.id)]);
    console.log('Backed up to active_setups_invalidated_pnl_backup_20260720.');
  }

  let updated = 0, skipped = 0;
  for (const row of rowsRes.rows) {
    const direction = inferDirection(row.setup_type);
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    if (!direction || entry == null) { skipped++; continue; }

    const barRes = await query(`
      SELECT close::float as close FROM price_bars_primary
      WHERE symbol='NQ' AND ts <= $1 ORDER BY ts DESC LIMIT 1
    `, [row.resolved_at]);
    const exitPx = barRes.rows[0]?.close;
    if (exitPx == null) { skipped++; continue; }

    const long = direction === 'LONG';
    const pnl = Math.round(((long ? (exitPx - entry) : (entry - exitPx))
      * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip) * 100) / 100;

    console.log(`  id=${row.id} ${row.setup_type} entry=${entry} exit=${exitPx} pnl=${pnl}`);
    if (!DRY_RUN) {
      await query(`
        UPDATE active_setups
        SET actual_pnl=$2, price_at_resolution=$3, resolution_method='MARK_TO_MARKET', actual_outcome='INVALIDATED'
        WHERE id=$1
      `, [row.id, pnl, exitPx]);
    }
    updated++;
  }
  console.log(`\n${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} ${updated} rows, skipped ${skipped} (no direction/entry/price available).`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
