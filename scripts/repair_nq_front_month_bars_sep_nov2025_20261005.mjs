// scripts/repair_nq_front_month_bars_sep_nov2025_20261005.mjs
//
// Repairs the Sep 28 - Nov 19 2025 NQ bar window (KNOWN_ISSUES item 16, OPEN_THREADS 2026-10-05).
//
// Root cause: price_bars holds this window only as contract NQH26 (a back-month contract, ~2
// contracts per minute) because the front month (NQZ25, ~215/min) never reached the DB for
// these dates -- the NQZ5 text export starts 2025-11-19 16:15. The front-month bars were rebuilt
// directly from the raw Sierra Chart tick file (NQZ5.CME.scid) by
// scripts/tick_microstructure/build_1m_bars_from_scid.py, which was validated against Sierra's
// own 1-minute export on 4,545 overlapping minutes (OHLC exact on all; volume/bid/ask/trades
// exact on all but 2 minutes).
//
// Usage:
//   node scripts/repair_nq_front_month_bars_sep_nov2025_20261005.mjs <rebuilt.csv>           # dry run
//   node scripts/repair_nq_front_month_bars_sep_nov2025_20261005.mjs <rebuilt.csv> --write   # apply
//
// Write path (one transaction for the row changes, then calendar + matview refresh):
//   1. Backup: CREATE TABLE price_bars_nqh26_sep_nov2025_backup_20261005 AS <rows being removed>
//      (fails if the backup table already exists -- never overwrites a prior backup)
//   2. DELETE the NQH26 rows in the window
//   3. INSERT the rebuilt NQZ25 rows (idempotent via ON CONFLICT on (contract, ts))
//   4. reconcileContractCalendar('NQ', ...) so the view picks NQZ25 as the daily front
//   5. REFRESH MATERIALIZED VIEW CONCURRENTLY price_bars_dedup_hist (non-blocking for readers)
import fs from 'fs';
import { getClient, query } from '../server/db.js';
import { reconcileContractCalendar } from '../server/services/priceBarService.js';

const CSV = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!CSV) { console.error('usage: node ... <rebuilt.csv> [--write]'); process.exit(1); }

const WIN_START = '2025-09-28 18:00:00';   // first bar of the degraded NQH26 window
const WIN_END = '2025-11-19 16:15:00';     // exclusive: NQZ25 export already covers from here
const DEL_CONTRACT = 'NQH26';
const INS_CONTRACT = 'NQZ25';
const BACKUP = 'price_bars_nqh26_sep_nov2025_backup_20261005';
const BATCH = 400;

// ---------- load rebuilt bars ----------
const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n');
lines.shift(); // header
const rebuilt = [];
for (const line of lines) {
  const [ts, o, h, l, c, v, n, b, a] = line.split(',');
  if (ts < WIN_START || ts >= WIN_END) continue;
  rebuilt.push({ ts, open: +o, high: +h, low: +l, close: +c, volume: +v, num_trades: +n, bid_volume: +b, ask_volume: +a });
}
const seen = new Set(rebuilt.map(r => r.ts));
if (seen.size !== rebuilt.length) throw new Error('duplicate timestamps in rebuilt CSV -- refusing');

// ---------- dry-run measurements ----------
const toDelete = await query(
  `SELECT count(*)::int n, min(ts)::text mn, max(ts)::text mx, coalesce(sum(volume),0)::bigint vol
   FROM price_bars WHERE symbol='NQ' AND contract=$1 AND ts >= $2 AND ts < $3`,
  [DEL_CONTRACT, WIN_START, WIN_END]);
const existingNq = await query(
  `SELECT count(*)::int n FROM price_bars WHERE symbol='NQ' AND contract=$1 AND ts >= $2 AND ts < $3`,
  [INS_CONTRACT, WIN_START, WIN_END]);
const backupExists = await query(`SELECT to_regclass($1) AS t`, [BACKUP]);

// open vs previous close sanity on the rebuilt series
let maxGap = 0, gapOver50 = 0;
for (let i = 1; i < rebuilt.length; i++) {
  const g = Math.abs(rebuilt[i].open - rebuilt[i - 1].close);
  if (g > maxGap) maxGap = g;
  if (g > 50) gapOver50++;
}
const minVol = Math.min(...rebuilt.map(r => r.volume));
const totalVol = rebuilt.reduce((s, r) => s + r.volume, 0);

console.log('--- DRY RUN ---');
console.log(`window: ${WIN_START} .. ${WIN_END} (exclusive)`);
console.log(`remove  ${DEL_CONTRACT}: ${toDelete.rows[0].n} rows (${toDelete.rows[0].mn} .. ${toDelete.rows[0].mx}), volume ${toDelete.rows[0].vol}`);
console.log(`insert  ${INS_CONTRACT}: ${rebuilt.length} rows, volume ${totalVol}, min volume/bar ${minVol}`);
console.log(`existing ${INS_CONTRACT} rows already in window: ${existingNq.rows[0].n} (must be 0 to be a clean replace)`);
console.log(`backup table ${BACKUP} exists: ${backupExists.rows[0].t !== null} (must be false)`);
console.log(`rebuilt open-vs-prev-close: max gap ${maxGap.toFixed(2)}, gaps >50pt: ${gapOver50} (expect only weekend gaps)`);

if (!WRITE) { console.log('\nDry run only. Re-run with --write to apply.'); process.exit(0); }

if (existingNq.rows[0].n !== 0) throw new Error(`${INS_CONTRACT} rows already exist in window -- refusing to write`);
if (backupExists.rows[0].t !== null) throw new Error(`${BACKUP} already exists -- refusing to overwrite a prior backup`);

// ---------- write ----------
const client = await getClient();
try {
  await client.query('BEGIN');

  await client.query(
    `CREATE TABLE ${BACKUP} AS SELECT * FROM price_bars WHERE symbol='NQ' AND contract=$1 AND ts >= $2 AND ts < $3`,
    [DEL_CONTRACT, WIN_START, WIN_END]);
  const backedUp = await client.query(`SELECT count(*)::int n FROM ${BACKUP}`);
  if (backedUp.rows[0].n !== toDelete.rows[0].n) throw new Error(`backup count ${backedUp.rows[0].n} != expected ${toDelete.rows[0].n}`);
  console.log(`backup: ${backedUp.rows[0].n} rows -> ${BACKUP}`);

  const del = await client.query(
    `DELETE FROM price_bars WHERE symbol='NQ' AND contract=$1 AND ts >= $2 AND ts < $3`,
    [DEL_CONTRACT, WIN_START, WIN_END]);
  console.log(`deleted ${del.rowCount} ${DEL_CONTRACT} rows`);

  let inserted = 0;
  for (let i = 0; i < rebuilt.length; i += BATCH) {
    const chunk = rebuilt.slice(i, i + BATCH);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * 11;
      values.push('NQ', INS_CONTRACT, r.ts, r.open, r.high, r.low, r.close, r.volume, r.num_trades, r.bid_volume, r.ask_volume);
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`;
    });
    const res = await client.query(
      `INSERT INTO price_bars (symbol, contract, ts, open, high, low, close, volume, num_trades, bid_volume, ask_volume)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (contract, ts) DO UPDATE SET
         open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close,
         volume=EXCLUDED.volume, num_trades=EXCLUDED.num_trades,
         bid_volume=EXCLUDED.bid_volume, ask_volume=EXCLUDED.ask_volume`,
      values);
    inserted += res.rowCount;
  }
  console.log(`inserted/upserted ${inserted} ${INS_CONTRACT} rows`);

  const after = await client.query(
    `SELECT count(*)::int n, coalesce(sum(volume),0)::bigint vol FROM price_bars WHERE symbol='NQ' AND contract=$1 AND ts >= $2 AND ts < $3`,
    [INS_CONTRACT, WIN_START, WIN_END]);
  if (after.rows[0].n !== rebuilt.length || Number(after.rows[0].vol) !== totalVol) {
    throw new Error(`post-insert verify failed: ${after.rows[0].n} rows / vol ${after.rows[0].vol} vs expected ${rebuilt.length} / ${totalVol}`);
  }
  console.log(`verified in-txn: ${after.rows[0].n} rows, volume ${after.rows[0].vol}`);

  await client.query('COMMIT');
  console.log('COMMIT ok');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('ROLLED BACK:', e.message);
  client.release();
  process.exit(1);
}
client.release();

await reconcileContractCalendar('NQ', '2025-09-28', '2025-11-19');
console.log('reconciled price_bars_contract_calendar for 2025-09-28..2025-11-19');
await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY price_bars_dedup_hist`);
console.log('refreshed price_bars_dedup_hist');
process.exit(0);
