// load_nq_bars_from_scid_csv.mjs -- load 1-minute NQ bars rebuilt from raw Sierra Chart tick (.scid) files into price_bars, so every backtest that reads
// price_bars_primary can use years of REAL 1-minute history instead of one month per old contract.
//
// Why (2026-10-19): price_bars held only the last ~30 days of each pre-2025 contract (the *.scid_BarData.txt exports are ~29,000 rows each) plus one daily placeholder row per
// day from the *.dly_BarData.txt exports (KNOWN_ISSUES item 17). The tick files go back to 2023-02-24 and scripts/tick_microstructure/build_1m_bars_from_scid.py turns them into
// 1-minute bars that match Sierra's own bars exactly (validated twice: Sep-Nov 2025 repair on 4,545 minutes; NQM24 May-Jun 2024 on 29,025 minutes, OHLC and volume/bid/ask identical).
//
// Input: a directory of CSVs named <SierraContract>.csv, e.g. NQM3.csv (Sierra single-digit year) produced by build_1m_bars_from_scid.py (ET minute timestamps). The DB contract
// name uses a 2-digit year (NQM3 -> NQM23) to match the existing rows. Reuse: rebuild any contract's CSV the same way and point this at the folder; it is idempotent (upsert on (contract, ts)).
//
// Safety, in the order it happens:
//   1. DRY RUN by default. Prints per contract: rows, date range, overlap with existing bars and how many overlapping minutes are identical (OHLC and volume/bid/ask). It REFUSES to write if
//      any contract with >= 1,000 overlapping minutes differs on more than 1% of them (a sign the CSV is the wrong contract/time zone).
//   2. Placeholder rows: price_bars days with <= 5 rows in total whose rows sit at 00:00:00 are the daily placeholders; inside the loaded date range they are DELETED (a daily bar posing as a
//      1-minute bar would corrupt intraday highs/lows and could win the contract calendar). Counted in the dry run.
//   3. Backup table price_bars_nq_history_rebuild_backup_20261019 = every row that will be deleted or overwritten with different values (fails if it already exists; never overwrites a backup).
//   4. One transaction: delete placeholders, upsert bars in batches, verify per-contract counts. 5. reconcileContractCalendar over the loaded range. 6. REFRESH MATERIALIZED VIEW CONCURRENTLY.
//   Refuses to write during RTH (09:30-16:15 ET weekdays) and during the nightly calibration window (20:00-21:30 ET).
//
// Usage: node scripts/load_nq_bars_from_scid_csv.mjs <dir> [--write]
import fs from 'fs';
import path from 'path';
import { getClient, query } from '../server/db.js';
import { reconcileContractCalendar } from '../server/services/priceBarService.js';

const DIR = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!DIR) { console.error('usage: node scripts/load_nq_bars_from_scid_csv.mjs <dir of NQxx.csv> [--write]'); process.exit(1); }
const BACKUP = 'price_bars_nq_history_rebuild_backup_20261019';
const BATCH = 1500;
const dbContract = (name) => { const m = /^NQ([HMUZ])(\d)$/.exec(name); if (!m) throw new Error(`unexpected contract file name ${name}`); const yr = 2020 + Number(m[2]); return `NQ${m[1]}${String(yr).slice(2)}`; };  // single digit year -> 2020s

const files = fs.readdirSync(DIR).filter(f => /^NQ[HMUZ]\d\.csv$/.test(f)).sort();
if (!files.length) { console.error('no NQxx.csv files in', DIR); process.exit(1); }

const loaded = [];
for (const f of files) {
  const name = f.replace('.csv', ''), contract = dbContract(name);
  const lines = fs.readFileSync(path.join(DIR, f), 'utf8').trim().split('\n'); lines.shift();
  const rows = [];
  for (const line of lines) { const [ts, o, h, l, c, v, n, b, a] = line.split(','); rows.push({ ts, open: +o, high: +h, low: +l, close: +c, volume: +v, num_trades: +n, bid_volume: +b, ask_volume: +a }); }
  if (new Set(rows.map(r => r.ts)).size !== rows.length) throw new Error(`${f}: duplicate timestamps`);
  const first = rows[0].ts, last = rows[rows.length - 1].ts;
  const ex = (await query(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, open::float o, high::float h, low::float l, close::float c, volume::float v, bid_volume::float b, ask_volume::float a FROM price_bars WHERE symbol='NQ' AND contract=$1 AND ts >= $2 AND ts <= $3`, [contract, first, last])).rows;
  // The daily placeholder rows (00:00:00 on days with <= 5 rows in total) are exactly what this load REPLACES, so they are not "existing 1-minute bars" and must not count as disagreements.
  const stubDays = new Set((await query(`SELECT ts::date::text d FROM price_bars WHERE symbol='NQ' AND ts::date >= $1::date AND ts::date <= $2::date GROUP BY 1 HAVING count(*) <= 5`, [first.slice(0, 10), last.slice(0, 10)])).rows.map(r => r.d));
  const exReal = ex.filter(r => !(r.t.endsWith(' 00:00:00') && stubDays.has(r.t.slice(0, 10))));
  const exMap = new Map(exReal.map(r => [r.t, r]));
  let overlap = 0, same = 0; const diffTs = [];
  for (const r of rows) { const e = exMap.get(r.ts); if (!e) continue; overlap++; if (e.o === r.open && e.h === r.high && e.l === r.low && e.c === r.close && e.v === r.volume && e.b === r.bid_volume && e.a === r.ask_volume) same++; else diffTs.push(r.ts); }
  const badFrac = overlap ? (overlap - same) / overlap : 0;
  console.log(`${name} -> ${contract}: ${rows.length} rows ${first} .. ${last}; existing real 1-minute rows in range ${exReal.length} (excluding ${ex.length - exReal.length} daily placeholders); overlapping minutes ${overlap}, identical ${same}${overlap ? ` (${(100 * same / overlap).toFixed(2)}%)` : ''}`);
  if (overlap >= 1000 && badFrac > 0.01) throw new Error(`${name}: ${(100 * badFrac).toFixed(1)}% of ${overlap} overlapping minutes differ from the existing bars -- refusing (wrong contract or time zone?)`);
  loaded.push({ name, contract, rows, first, last, diffTs, volume: rows.reduce((s, r) => s + r.volume, 0) });
}
const rangeStart = loaded.map(x => x.first).sort()[0].slice(0, 10), rangeEnd = loaded.map(x => x.last).sort().slice(-1)[0].slice(0, 10);
// Placeholder rows are selected by KEY (symbol, date, time), never by ctid: price_bars is a PARTITIONED table, and a ctid is only unique inside one partition, so a
// `ctid IN (...)` delete removes unrelated rows in other partitions (found 2026-10-19: the dry run counted 451 rows, the delete reported 4,300; the transaction rolled back).
const STUB_DAYS = `WITH sd AS (SELECT ts::date d FROM price_bars WHERE symbol='NQ' AND ts::date >= $1::date AND ts::date <= $2::date GROUP BY 1 HAVING count(*) <= 5)`;
const STUB_WHERE = `p.symbol='NQ' AND p.ts::date = sd.d AND p.ts::time = '00:00:00'`;
const stubs = (await query(`${STUB_DAYS} SELECT p.contract, p.ts FROM price_bars p JOIN sd ON p.ts::date = sd.d WHERE p.symbol='NQ' AND p.ts::time = '00:00:00'`, [rangeStart, rangeEnd])).rowCount;
const backupExists = (await query(`SELECT to_regclass($1) AS t`, [BACKUP])).rows[0].t !== null;
const pre = (await query(`SELECT count(*)::int n, count(DISTINCT ts::date)::int days FROM price_bars WHERE symbol='NQ' AND ts::date >= $1::date AND ts::date <= $2::date`, [rangeStart, rangeEnd])).rows[0];
console.log(`\n--- DRY RUN SUMMARY ---\nrange ${rangeStart} .. ${rangeEnd}; total rows to upsert ${loaded.reduce((s, x) => s + x.rows.length, 0)}; placeholder (daily stub) rows to delete in range: ${stubs}; existing NQ rows in range: ${pre.n} on ${pre.days} days; backup table exists: ${backupExists} (must be false)`);
if (!WRITE) { console.log('\nDry run only. Re-run with --write to apply.'); process.exit(0); }

if (backupExists) throw new Error(`${BACKUP} already exists -- refusing to overwrite a prior backup`);
const nowEt = (await query(`SELECT EXTRACT(dow FROM now())::int dow, (EXTRACT(hour FROM now())*60 + EXTRACT(minute FROM now()))::int m`)).rows[0];
if (nowEt.dow >= 1 && nowEt.dow <= 5 && nowEt.m >= 570 && nowEt.m < 975) throw new Error('refusing to write during RTH (09:30-16:15 ET)');
if (nowEt.m >= 1200 && nowEt.m < 1290) throw new Error('refusing to write inside the 20:00-21:30 ET nightly calibration window');

const client = await getClient();
try {
  await client.query('BEGIN');
  await client.query(`CREATE TABLE ${BACKUP} AS SELECT * FROM price_bars WHERE false`);
  await client.query(`${STUB_DAYS} INSERT INTO ${BACKUP} SELECT p.* FROM price_bars p JOIN sd ON p.ts::date = sd.d WHERE p.symbol='NQ' AND p.ts::time = '00:00:00'`, [rangeStart, rangeEnd]);
  const stubsBackedUp = (await client.query(`SELECT count(*)::int n FROM ${BACKUP}`)).rows[0].n;
  if (stubsBackedUp !== stubs) throw new Error(`placeholder backup has ${stubsBackedUp} rows but the dry run counted ${stubs} -- refusing`);
  for (const x of loaded) if (x.diffTs.length) await client.query(`INSERT INTO ${BACKUP} SELECT * FROM price_bars WHERE symbol='NQ' AND contract=$1 AND ts = ANY($2::timestamp[])`, [x.contract, x.diffTs]);
  const backedUp = (await client.query(`SELECT count(*)::int n FROM ${BACKUP}`)).rows[0].n;
  console.log(`backup: ${backedUp} rows -> ${BACKUP}`);
  const del = await client.query(`${STUB_DAYS} DELETE FROM price_bars p USING sd WHERE ${STUB_WHERE}`, [rangeStart, rangeEnd]);
  if (del.rowCount !== stubs) throw new Error(`deleted ${del.rowCount} placeholder rows but the dry run counted ${stubs} -- refusing (rolled back)`);
  console.log(`deleted ${del.rowCount} placeholder rows (matches the dry run)`);
  for (const x of loaded) {
    let up = 0;
    for (let i = 0; i < x.rows.length; i += BATCH) {
      const chunk = x.rows.slice(i, i + BATCH), values = [];
      const ph = chunk.map((r, j) => { const b = j * 11; values.push('NQ', x.contract, r.ts, r.open, r.high, r.low, r.close, r.volume, r.num_trades, r.bid_volume, r.ask_volume); return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`; });
      const res = await client.query(`INSERT INTO price_bars (symbol, contract, ts, open, high, low, close, volume, num_trades, bid_volume, ask_volume) VALUES ${ph.join(',')}
        ON CONFLICT (contract, ts) DO UPDATE SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close, volume=EXCLUDED.volume, num_trades=EXCLUDED.num_trades, bid_volume=EXCLUDED.bid_volume, ask_volume=EXCLUDED.ask_volume`, values);
      up += res.rowCount;
    }
    const v = (await client.query(`SELECT count(*)::int n, coalesce(sum(volume),0)::bigint vol FROM price_bars WHERE symbol='NQ' AND contract=$1 AND ts = ANY($2::timestamp[])`, [x.contract, x.rows.map(r => r.ts)])).rows[0];
    if (v.n !== x.rows.length || Number(v.vol) !== x.volume) throw new Error(`${x.contract}: post-insert verify failed (${v.n} rows / vol ${v.vol} vs ${x.rows.length} / ${x.volume})`);
    console.log(`${x.contract}: upserted ${up}, verified ${v.n} rows, volume ${v.vol}`);
  }
  await client.query('COMMIT'); console.log('COMMIT ok');
} catch (e) { await client.query('ROLLBACK'); console.error('ROLLED BACK:', e.message); client.release(); process.exit(1); }
client.release();
await reconcileContractCalendar('NQ', rangeStart, rangeEnd);
console.log(`reconciled price_bars_contract_calendar ${rangeStart}..${rangeEnd}`);
await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY price_bars_dedup_hist`);
console.log('refreshed price_bars_dedup_hist');
process.exit(0);
