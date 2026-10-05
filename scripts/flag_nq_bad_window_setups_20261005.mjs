// scripts/flag_nq_bad_window_setups_20261005.mjs
//
// Flags the synthetic active_setups rows whose entry prices and outcomes were built from the
// contaminated NQH26 back-month bars for Sep 28 - Nov 19 2025 (KNOWN_ISSUES item 16; the bar repair is
// scripts/repair_nq_front_month_bars_sep_nov2025_20261005.mjs). Audit 2026-10-05: 1,333 rows fired in
// the window (1,221 BACKFILL + 112 UNKNOWN, zero ACTIVE/SHADOW); entries sit about +249 pts above the
// corrected bar at fired_at.
//
// Chosen over re-simulation (per the 2026-10-05 decision): re-simulating needs the level-fade
// detection logic extracted from scripts/repair_backfill_duplicate_bars.mjs, which is not importable
// and deletes every BACKFILL row globally. Flagging keeps every row and its history, is reversible,
// and follows the existing *_basis convention (stale_entry_price_basis, late_fill_past_expiry_basis).
//
// Adds active_setups.bad_bars_basis (boolean, NULL = not flagged). Wired into REAL_TRADE_FILTER and the
// all-origin blended aggregates in scripts/backtest_setup_status.mjs in the same change.
//
// Usage: node scripts/flag_nq_bad_window_setups_20261005.mjs            # dry run
//        node scripts/flag_nq_bad_window_setups_20261005.mjs --write    # backup, add column, flag
import { query } from '../server/db.js';

const WRITE = process.argv.includes('--write');
const WIN_START = '2025-09-28 18:00:00';
const WIN_END = '2025-11-19 16:15:00';
const BACKUP = 'active_setups_badbars_flag_backup_20261005';
const WHERE = `fired_at >= $1 AND fired_at < $2`;

const pop = await query(
  `SELECT origin_status, count(*)::int n FROM active_setups WHERE ${WHERE} GROUP BY 1 ORDER BY 1`, [WIN_START, WIN_END]);
const hasCol = await query(
  `SELECT 1 FROM information_schema.columns WHERE table_name='active_setups' AND column_name='bad_bars_basis'`);
const already = hasCol.rows.length
  ? (await query(`SELECT count(*)::int n FROM active_setups WHERE ${WHERE} AND bad_bars_basis IS TRUE`, [WIN_START, WIN_END])).rows[0].n
  : 0;
const backupExists = (await query(`SELECT to_regclass($1) t`, [BACKUP])).rows[0].t;

console.log('--- PLAN ---');
console.log('window fired_at:', WIN_START, '..', WIN_END, '(exclusive)');
console.log('population by origin_status:', pop.rows);
console.log('column bad_bars_basis exists:', hasCol.rows.length > 0, '| already flagged:', already);
console.log('backup table exists (must be false):', backupExists !== null);
if (!WRITE) { console.log('\nDry run only. Re-run with --write to apply.'); process.exit(0); }
if (backupExists !== null) throw new Error(`${BACKUP} exists -- refusing to overwrite`);

await query(`CREATE TABLE ${BACKUP} AS SELECT id, origin_status, fired_at FROM active_setups WHERE ${WHERE}`, [WIN_START, WIN_END]);
const b = (await query(`SELECT count(*)::int n FROM ${BACKUP}`)).rows[0].n;
console.log(`backup: ${b} rows -> ${BACKUP}`);

await query(`ALTER TABLE active_setups ADD COLUMN IF NOT EXISTS bad_bars_basis boolean`);
const up = await query(`UPDATE active_setups SET bad_bars_basis = true, updated_at = NOW() WHERE ${WHERE}`, [WIN_START, WIN_END]);
console.log(`flagged ${up.rowCount} rows bad_bars_basis=true`);

const v = await query(`SELECT origin_status, count(*)::int n FROM active_setups WHERE bad_bars_basis IS TRUE GROUP BY 1 ORDER BY 1`);
console.log('verify flagged by origin_status:', v.rows);
const outside = (await query(`SELECT count(*)::int n FROM active_setups WHERE bad_bars_basis IS TRUE AND NOT (${WHERE})`, [WIN_START, WIN_END])).rows[0].n;
console.log('flagged rows outside the window (must be 0):', outside);
process.exit(0);
