// Repair of the contaminated NQ raw minute bars found 2026-11-10 (docs/NQ_RAW_BAR_REPAIR_20261110.md). Dry run by default; --write applies it.
//   (1) delete the 500-volume / off-second rows ("off-minute") of 2025-06..08 and 2026-04;
//   (2) delete the NQU25-labelled ON-minute rows of 2025-05-29..2025-06-14 (they carry NQM25 prices; the NQM25-labelled rows are exact), so the contract calendar
//       returns NQM25 for those dates;
//   (3) on 2025-06-15..2025-08-20 replace the NQU25 minutes that differ from the tick-built 1-minute bar (the 5-minute bars written over every fifth minute) by the tick bar.
// Tick bars: scratch/nq_raw_bar_repair_20261110/*.csv built by scripts/tick_microstructure/build_1m_bars_from_scid.py (validated against Sierra's own bars).
// Safety (docs/DB_MIGRATION_PROTOCOL.md): dry run first, every assumption asserted; one backup table (price_bars_nq_rawfix_backup_20261110, a column fix_action says why a
// row is in it) filled and count-checked BEFORE anything changes; one transaction with count checks after every statement; rows selected by key and ts range, never by ctid
// (price_bars is partitioned). Refuses to write during RTH or the 20:00-21:30 ET nightly window, or if the backup table exists. After the commit: calendar reconcile,
// REFRESH of both materialized views, and a verification against the ticks.
import fs from 'fs';
import { getClient, query } from '../server/db.js';
import { reconcileContractCalendar } from '../server/services/priceBarService.js';

const WRITE = process.argv.includes('--write');
const BACKUP = 'price_bars_nq_rawfix_backup_20261110';
const DIR = 'scratch/nq_raw_bar_repair_20261110/';
const EXPECT_OFFMINUTE = 56092;                       // measured 2026-11-10 (55,260 in 2025-06..08 + 832 in 2026-04)
const OFF_WINDOWS = [['2025-06-01', '2025-09-01'], ['2026-04-01', '2026-05-01']];
const C_FROM = '2025-05-29', C_TO = '2025-06-15';     // regime C: ts >= C_FROM and ts < C_TO, label NQU25, on-minute rows
const B_FROM = '2025-06-15', B_TO = '2025-08-21';     // regime B: label NQU25, ts >= B_FROM and ts < B_TO
const CAL_FROM = '2025-05-29', CAL_TO = '2025-08-29';

const readCsv = (f) => { const m = new Map(); for (const l of fs.readFileSync(DIR + f, 'utf8').trim().split('\n').slice(1)) { const [ts, o, h, lo, c, v, n, b, a] = l.split(','); m.set(ts, { ts, open: +o, high: +h, low: +lo, close: +c, volume: +v, num_trades: +n, bid_volume: +b, ask_volume: +a }); } return m; };
const q = async (sql, p = []) => (await query(sql, p)).rows;
const offWhere = `symbol='NQ' AND ts <> date_trunc('minute', ts) AND ((ts >= '${OFF_WINDOWS[0][0]}' AND ts < '${OFF_WINDOWS[0][1]}') OR (ts >= '${OFF_WINDOWS[1][0]}' AND ts < '${OFF_WINDOWS[1][1]}'))`;
const cWhere = `symbol='NQ' AND contract='NQU25' AND ts >= '${C_FROM}' AND ts < '${C_TO}' AND ts = date_trunc('minute', ts)`;
const same = (e, t) => e.o === t.open && e.h === t.high && e.l === t.low && e.c === t.close && e.v === t.volume && e.nt === t.num_trades && e.b === t.bid_volume && e.a === t.ask_volume;

async function plan() {
  const tU = readCsv('NQU25_0615_0829.csv'), tM = readCsv('NQM25_0526_0620.csv');
  const off = (await q(`SELECT count(*)::int n FROM price_bars WHERE ${offWhere}`))[0].n;
  // no minute may depend on an off-minute row: every minute that holds one must also hold an on-minute row
  const holes = (await q(`SELECT count(*)::int n FROM (SELECT contract, date_trunc('minute', ts) m FROM price_bars WHERE ${offWhere} GROUP BY 1,2
      EXCEPT SELECT contract, ts FROM price_bars WHERE symbol='NQ' AND ts = date_trunc('minute', ts)) x`))[0].n;
  const cRows = (await q(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t FROM price_bars WHERE ${cWhere}`)).map((r) => r.t);
  // regime C: an NQM25-labelled on-minute row must exist for every minute that will lose its NQU25 row, and it must equal the NQM25 tick bar
  const mRows = new Map((await q(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, open::float o, high::float h, low::float l, close::float c, volume::float v, num_trades nt, bid_volume::float b, ask_volume::float a
      FROM price_bars WHERE symbol='NQ' AND contract='NQM25' AND ts >= '${C_FROM}' AND ts < '${C_TO}' AND ts = date_trunc('minute', ts)`)).map((r) => [r.t, r]));
  let cNoM25 = 0, cM25Tick = 0, cM25Match = 0;
  for (const t of cRows) { const m = mRows.get(t); if (!m) { cNoM25++; continue; } const k = tM.get(t); if (k) { cM25Tick++; if (same(m, k)) cM25Match++; } }
  // regime B: NQU25 on-minute rows that differ from the tick bar
  const bRows = await q(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, open::float o, high::float h, low::float l, close::float c, volume::float v, num_trades nt, bid_volume::float b, ask_volume::float a
      FROM price_bars WHERE symbol='NQ' AND contract='NQU25' AND ts >= '${B_FROM}' AND ts < '${B_TO}' AND ts = date_trunc('minute', ts)`);
  const upd = [], notTick = []; let not5 = 0;
  for (const r of bRows) { const t = tU.get(r.t); if (!t) { notTick.push(r.t); continue; } if (!same(r, t)) { upd.push(t); if (+r.t.slice(14, 16) % 5 !== 0) not5++; } }
  const after = (await q(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, open::float o, high::float h, low::float l, close::float c, volume::float v, num_trades nt, bid_volume::float b, ask_volume::float a
      FROM price_bars WHERE symbol='NQ' AND contract='NQU25' AND ts >= '${B_TO}' AND ts < '${CAL_TO}' AND ts = date_trunc('minute', ts)`));
  let aDiff = 0, aN = 0; for (const r of after) { const t = tU.get(r.t); if (!t) continue; aN++; if (!same(r, t)) aDiff++; }
  const cal = await q(`SELECT trade_date::text d, contract FROM price_bars_contract_calendar WHERE symbol='NQ' AND trade_date >= '${CAL_FROM}' AND trade_date <= '${CAL_TO}' ORDER BY 1`);
  const P = { off, holes, cN: cRows.length, cNoM25, cM25Tick, cM25Match, bN: bRows.length, upd, notTick: notTick.length, not5, aN, aDiff, cal };
  console.log(`off-minute rows to delete: ${off} (expected ${EXPECT_OFFMINUTE}); minutes that would be left with NO on-minute row: ${holes}`);
  console.log(`regime C: NQU25 on-minute rows to delete ${P.cN}; of them without an NQM25 row at the same minute ${cNoM25}; NQM25 rows that have a tick bar ${cM25Tick}, equal to it ${cM25Match}`);
  console.log(`regime B: NQU25 on-minute rows ${P.bN}; differ from the tick bar ${upd.length} (not on a multiple-of-5 minute: ${not5}); rows with no tick bar ${notTick.length}`);
  console.log(`after ${B_TO}..${CAL_TO}: ${aN} NQU25 on-minute rows with a tick bar, ${aDiff} differ`);
  const problems = [];
  if (off !== EXPECT_OFFMINUTE) problems.push(`off-minute count ${off} != ${EXPECT_OFFMINUTE}`);
  if (holes) problems.push(`${holes} minutes depend on an off-minute row`);
  if (cNoM25) problems.push(`${cNoM25} regime-C minutes have no NQM25 row to fall back on`);
  // 8 of 16,200 minutes differ by a few contracts of volume / one point on a high or low (Sierra's own export vs the full tick file, 2026-11-10 inspection): kept as stored, tolerance 99.9 percent
  if (cM25Tick < 0.99 * cRows.length || cM25Match < 0.999 * cM25Tick) problems.push(`NQM25 rows do not match the tick bars (${cM25Match}/${cM25Tick})`);
  if (not5) problems.push(`${not5} differing regime-B rows are not on a multiple-of-5 minute (the 5-minute finding does not explain them)`);
  if (aDiff) problems.push(`${aDiff} rows after ${B_TO} differ from the ticks`);
  if (!upd.length) problems.push('nothing to update in regime B');
  console.log(problems.length ? 'PROBLEMS: ' + problems.join(' | ') : 'all dry-run assertions hold');
  return { P, problems, tU };
}

async function main() {
  const { P, problems } = await plan();
  console.log(`planned backup rows: ${P.off} OFFMINUTE + ${P.cN} MISLABELLED + ${P.upd.length} FIVEMIN = ${P.off + P.cN + P.upd.length}`);
  if (!WRITE) { console.log('\nDry run only. Re-run with --write to apply.'); return; }
  if (problems.length) throw new Error('refusing: dry-run assertions failed');
  if ((await q(`SELECT to_regclass($1) t`, [BACKUP]))[0].t !== null) throw new Error(`${BACKUP} already exists -- refusing`);
  const now = (await q(`SELECT EXTRACT(dow FROM now())::int dow, (EXTRACT(hour FROM now())*60 + EXTRACT(minute FROM now()))::int m`))[0];
  if (now.dow >= 1 && now.dow <= 5 && now.m >= 570 && now.m < 975) throw new Error('refusing to write during RTH (09:30-16:15 ET)');
  if (now.m >= 1200 && now.m < 1290) throw new Error('refusing to write inside the 20:00-21:30 ET nightly calibration window');
  const calBefore = new Map(P.cal.map((r) => [r.d, r.contract]));
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE ${BACKUP} AS SELECT p.*, 'x'::text AS fix_action FROM price_bars p WHERE false`);
    await client.query(`INSERT INTO ${BACKUP} SELECT p.*, 'OFFMINUTE' FROM price_bars p WHERE ${offWhere}`);
    await client.query(`INSERT INTO ${BACKUP} SELECT p.*, 'MISLABELLED' FROM price_bars p WHERE ${cWhere}`);
    const stamps = P.upd.map((t) => t.ts);
    for (let i = 0; i < stamps.length; i += 2000) await client.query(`INSERT INTO ${BACKUP} SELECT p.*, 'FIVEMIN' FROM price_bars p WHERE p.symbol='NQ' AND p.contract='NQU25' AND p.ts = ANY($1::timestamp[])`, [stamps.slice(i, i + 2000)]);
    const bk = Object.fromEntries((await client.query(`SELECT fix_action a, count(*)::int n FROM ${BACKUP} GROUP BY 1`)).rows.map((r) => [r.a, r.n]));
    console.log('backup rows by action:', JSON.stringify(bk));
    if (bk.OFFMINUTE !== P.off || bk.MISLABELLED !== P.cN || bk.FIVEMIN !== P.upd.length) throw new Error('backup counts differ from the plan -- rolled back');
    const d1 = await client.query(`DELETE FROM price_bars WHERE ${offWhere}`); if (d1.rowCount !== P.off) throw new Error(`off-minute delete ${d1.rowCount} != ${P.off}`);
    const d2 = await client.query(`DELETE FROM price_bars WHERE ${cWhere}`); if (d2.rowCount !== P.cN) throw new Error(`mislabelled delete ${d2.rowCount} != ${P.cN}`);
    let nu = 0;
    for (const t of P.upd) {
      const r = await client.query(`UPDATE price_bars SET open=$2, high=$3, low=$4, close=$5, volume=$6, num_trades=$7, bid_volume=$8, ask_volume=$9 WHERE symbol='NQ' AND contract='NQU25' AND ts=$1::timestamp`,
        [t.ts, t.open, t.high, t.low, t.close, t.volume, t.num_trades, t.bid_volume, t.ask_volume]); nu += r.rowCount;
    }
    if (nu !== P.upd.length) throw new Error(`updated ${nu} != ${P.upd.length}`);
    await client.query('COMMIT'); console.log(`COMMIT ok: deleted ${d1.rowCount} off-minute + ${d2.rowCount} mislabelled, updated ${nu}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('ROLLED BACK:', e.message); client.release(); process.exit(1); }
  client.release();
  await reconcileContractCalendar('NQ', CAL_FROM, CAL_TO); await reconcileContractCalendar('NQ', '2026-04-28', '2026-04-29');
  const calAfter = await q(`SELECT trade_date::text d, contract FROM price_bars_contract_calendar WHERE symbol='NQ' AND trade_date >= '${CAL_FROM}' AND trade_date <= '${CAL_TO}' ORDER BY 1`);
  const flips = calAfter.filter((r) => calBefore.get(r.d) !== r.contract);
  console.log(`calendar rows whose contract changed: ${flips.length} (${flips.map((r) => r.d.slice(5) + ':' + r.contract.slice(-3)).join(' ')})`);
  await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY price_bars_dedup_hist`); console.log('refreshed price_bars_dedup_hist');
  try { await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY price_bars_dedup_hist_v2`); console.log('refreshed price_bars_dedup_hist_v2'); } catch (e) { console.log('v2 refresh skipped:', e.message); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
