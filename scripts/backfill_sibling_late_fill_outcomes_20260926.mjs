// Follow-up to scripts/repair_sibling_phantom_fills_20260926.mjs, same day, user request:
// "go bar by bar... backfill the pnl with more accurate pnl given this new info." Those 327
// rows are currently resolution='NOT_FILLED'/actual_pnl=NULL. This script re-derives what
// ACTUALLY happened at each one's real entry price with no time limit (does it ever get
// touched, and if so what happens next using its own original stop/target) and writes that
// back as the honest historical record.
//
// Deliberately NOT treated as a normal real trade for calibration purposes: the live system
// marks a sibling NOT_FILLED the moment its own expires_at passes without a fill -- these 327
// only resolve to something because this script searches with NO time limit (median 60min,
// up to 8088min/5.6 days past the original expiry). Writing that back as an ordinary
// TARGET_HIT/STOP_HIT would silently let these count as real N/EV in backtest_setup_status.mjs
// even though the live system would never have kept the order open that long. Flagged via a
// new active_setups.late_fill_past_expiry_basis boolean column (same pattern as the existing
// stale_entry_price_basis/ib_window_stale_basis columns) and wired into REAL_TRADE_FILTER's
// exclusion list -- preserves the honest historical record without corrupting live calibration.
//
// Usage: node scripts/backfill_sibling_late_fill_outcomes_20260926.mjs         (dry run)
//        node scripts/backfill_sibling_late_fill_outcomes_20260926.mjs --write (adds the column, backs up, writes)

import pg from 'pg';
import { config } from 'dotenv';
import { resolveDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
config();

const WRITE = process.argv.includes('--write');
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const BACKUP_TABLE = 'active_setups_sibling_notfilled_prelatefill_backup_20260926';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal', user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

async function main() {
  // These are the 327 rows the 2026-09-26 repair set to NOT_FILLED. Original entry/stop/target
  // are unchanged on the live row itself (only resolution/actual_pnl/resolution_method were
  // touched by that repair), so no need to re-read the backup table here.
  const { rows: candidates } = await pool.query(`
    SELECT id, setup_type, fired_at::text as fired_at, expires_at::text as expires_at,
           resolved_at::text as resolved_at, entry_zone_low, entry_zone_high,
           stop_level, t1_level
    FROM active_setups
    WHERE is_cluster_primary = false AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution = 'NOT_FILLED' AND resolution_method = 'SIBLING_UNFILLED'
    ORDER BY fired_at
  `);
  console.log(`NOT_FILLED sibling rows from the 2026-09-26 repair: ${candidates.length}`);

  const toUpdate = []; // { id, resolution, actual_pnl, resolved_at, priceAtResolution }
  let neverTouched = 0, ambiguous = 0, unresolved = 0;

  for (const row of candidates) {
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    if (entry == null) continue;
    const dir = resolveDirection(row);
    if (dir == null) continue;
    const long = dir === 'LONG';
    const originalBound = row.resolved_at || row.expires_at;
    const stop = row.stop_level, t1 = row.t1_level;

    const { rows: bars } = await pool.query(`
      SELECT ts::text as ts, high, low FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1 ORDER BY ts LIMIT 5000
    `, [originalBound]);

    const touchIdx = bars.findIndex(b => (long ? b.low <= entry : b.high >= entry));
    if (touchIdx < 0) { neverTouched++; continue; } // stays NOT_FILLED, correctly

    if (stop == null || t1 == null) { unresolved++; continue; }
    let done = false;
    for (let i = touchIdx; i < bars.length; i++) {
      const b = bars[i];
      const stopHit = long ? b.low <= stop : b.high >= stop;
      const targetHit = long ? b.high >= t1 : b.low <= t1;
      if (stopHit && targetHit) { ambiguous++; done = true; break; }
      if (stopHit) {
        const pnl = (long ? (stop - entry) : (entry - stop)) * PNL_PER_POINT - COMMISSION;
        toUpdate.push({ id: row.id, resolution: 'STOP_HIT', actual_pnl: Math.round(pnl * 100) / 100, resolved_at: b.ts, price_at_resolution: stop });
        done = true; break;
      }
      if (targetHit) {
        const pnl = (long ? (t1 - entry) : (entry - t1)) * PNL_PER_POINT - COMMISSION;
        toUpdate.push({ id: row.id, resolution: 'TARGET_HIT', actual_pnl: Math.round(pnl * 100) / 100, resolved_at: b.ts, price_at_resolution: t1 });
        done = true; break;
      }
    }
    if (!done) unresolved++;
  }

  const wins = toUpdate.filter(u => u.resolution === 'TARGET_HIT');
  const losses = toUpdate.filter(u => u.resolution === 'STOP_HIT');
  console.log(`\nNever touched (stays NOT_FILLED, no change): ${neverTouched}`);
  console.log(`Ambiguous same-bar stop+target (stays NOT_FILLED, can't determine cleanly): ${ambiguous}`);
  console.log(`Unresolved within the search window (stays NOT_FILLED): ${unresolved}`);
  console.log(`Resolving to a real backfilled outcome: ${toUpdate.length} (wins=${wins.length} sum=$${wins.reduce((s,u)=>s+u.actual_pnl,0).toFixed(2)}, losses=${losses.length} sum=$${losses.reduce((s,u)=>s+u.actual_pnl,0).toFixed(2)})`);
  console.log(`Net: $${toUpdate.reduce((s,u)=>s+u.actual_pnl,0).toFixed(2)}`);

  if (!WRITE) {
    console.log('\nDry run only. Re-run with --write to apply.');
    await pool.end();
    return;
  }
  if (toUpdate.length === 0) { console.log('\nNothing to backfill.'); await pool.end(); return; }

  console.log(`\n--write passed. Adding late_fill_past_expiry_basis column (if missing), backing up ${toUpdate.length} rows, then backfilling.`);
  await pool.query(`ALTER TABLE active_setups ADD COLUMN IF NOT EXISTS late_fill_past_expiry_basis boolean`);

  const ids = toUpdate.map(u => u.id);
  await pool.query(`CREATE TABLE ${BACKUP_TABLE} AS SELECT * FROM active_setups WHERE id = ANY($1::int[])`, [ids]);
  const { rows: backupCount } = await pool.query(`SELECT COUNT(*) FROM ${BACKUP_TABLE}`);
  console.log(`Backup row count: ${backupCount[0].count} (expected ${ids.length})`);
  if (+backupCount[0].count !== ids.length) throw new Error('Backup row count mismatch -- aborting.');

  for (const u of toUpdate) {
    await pool.query(`
      UPDATE active_setups
      SET resolution=$2, resolution_method='SIBLING_LATE_FILL', actual_outcome=$2,
          actual_pnl=$3, resolved_at=$4::timestamp, price_at_resolution=$5,
          late_fill_past_expiry_basis=true, updated_at=NOW()
      WHERE id=$1
    `, [u.id, u.resolution, u.actual_pnl, u.resolved_at, u.price_at_resolution]);
  }

  const { rows: verify } = await pool.query(`
    SELECT COUNT(*) FROM active_setups WHERE id = ANY($1::int[]) AND (late_fill_past_expiry_basis IS NOT TRUE OR resolution = 'NOT_FILLED')
  `, [ids]);
  console.log(`Rows updated: ${toUpdate.length}. Post-update rows NOT correctly flagged (should be 0): ${verify[0].count}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
