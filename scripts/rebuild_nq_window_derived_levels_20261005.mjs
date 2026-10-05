// scripts/rebuild_nq_window_derived_levels_20261005.mjs
//
// Rebuilds the DERIVED tables for the Sep 29 - Nov 21 2025 window after the NQ bar repair
// (scripts/repair_nq_front_month_bars_sep_nov2025_20261005.mjs). Those tables were computed from the
// old NQH26 back-month prices, which ran about +250 pts high. Chain, in dependency order:
//   price_bars_primary -> developing_value_log (value area, session H/L/C)
//                      -> acd_daily_log        (opening range + A levels)
//                      -> level_prices         (scripts/compute_levels.js, per date)
//
// Every write goes through the REAL live functions (computeAndPersistSession, computeORLevelsOnly,
// compute_levels.js), never a reimplementation. Dates are processed in ascending order, since each
// session's migration fields read the prior session's row.
//
// Reversibility: each of the three tables is backed up first (CREATE TABLE ..., fails if the backup
// already exists, so a prior backup is never overwritten). Catalogued in docs/DB_BACKUP_CATALOG.md.
//
// Usage: node scripts/rebuild_nq_window_derived_levels_20261005.mjs            # dry run: counts + plan only
//        node scripts/rebuild_nq_window_derived_levels_20261005.mjs --write     # back up, then rebuild
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../server/db.js';
import { computeAndPersistSession } from '../server/services/developingValueService.js';
import { computeORLevelsOnly, getBestACDParams } from '../server/services/acdService.js';

const WRITE = process.argv.includes('--write');
const FROM = '2025-09-26';   // backup window starts before the first rebuilt session on purpose
const TO = '2025-11-21';
const REBUILD_FROM = '2025-09-29';
const SUFFIX = '_nqbad_backup_20261005';
const TABLES = ['developing_value_log', 'acd_daily_log', 'level_prices'];
const DATE_COL = 'trade_date';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// ---------- dry-run measurements ----------
const counts = {};
for (const t of TABLES) {
  const r = await query(`SELECT count(*)::int n FROM ${t} WHERE ${DATE_COL} BETWEEN $1 AND $2`, [FROM, TO]);
  counts[t] = r.rows[0].n;
}
const dates = (await query(
  `SELECT trade_date::text d FROM developing_value_log WHERE trade_date BETWEEN $1 AND $2 ORDER BY trade_date`,
  [REBUILD_FROM, TO])).rows.map(r => r.d.slice(0, 10));
const acdDates = new Set((await query(
  `SELECT trade_date::text d FROM acd_daily_log WHERE trade_date BETWEEN $1 AND $2`, [REBUILD_FROM, TO])).rows.map(r => r.d.slice(0, 10)));
const existingBackups = [];
for (const t of TABLES) {
  const r = await query(`SELECT to_regclass($1) t`, [`${t}${SUFFIX}`]);
  if (r.rows[0].t) existingBackups.push(`${t}${SUFFIX}`);
}
const { aMult } = await getBestACDParams();

console.log('--- PLAN ---');
console.log(`backup window: ${FROM} .. ${TO}`);
for (const t of TABLES) console.log(`  ${t}: ${counts[t]} rows in window -> ${t}${SUFFIX}`);
console.log(`rebuild dates (developing_value_log): ${dates.length}  (${dates[0]} .. ${dates[dates.length - 1]})`);
console.log(`  of which have an acd_daily_log row (OR/A rebuilt in place): ${dates.filter(d => acdDates.has(d)).length}`);
console.log(`  ACD aMult in use: ${aMult}`);
console.log(`existing backup tables (must be empty): ${existingBackups.length ? existingBackups.join(', ') : 'none'}`);

if (!WRITE) { console.log('\nDry run only. Re-run with --write to back up and rebuild.'); process.exit(0); }
if (existingBackups.length) { console.error('refusing: backup table(s) already exist'); process.exit(1); }

// ---------- backups ----------
for (const t of TABLES) {
  await query(`CREATE TABLE ${t}${SUFFIX} AS SELECT * FROM ${t} WHERE ${DATE_COL} BETWEEN $1 AND $2`, [FROM, TO]);
  const b = await query(`SELECT count(*)::int n FROM ${t}${SUFFIX}`);
  if (b.rows[0].n !== counts[t]) throw new Error(`backup count mismatch for ${t}: ${b.rows[0].n} vs ${counts[t]}`);
  console.log(`backed up ${b.rows[0].n} rows -> ${t}${SUFFIX}`);
}

// ---------- 1. developing_value_log (chronological, each reads prior row) ----------
let dvOk = 0, dvNull = 0;
for (const d of dates) {
  const r = await computeAndPersistSession(d);
  if (r) dvOk++; else dvNull++;
}
console.log(`developing_value_log: recomputed ${dvOk}, skipped (too few bars) ${dvNull}`);

// ---------- 2. acd_daily_log OR/A levels (overwrite only existing rows) ----------
let acdOk = 0, acdNull = 0;
for (const d of dates) {
  if (!acdDates.has(d)) continue;
  const r = await computeORLevelsOnly(d, aMult, { overwrite: true });
  if (r) acdOk++; else acdNull++;
}
console.log(`acd_daily_log: recomputed ${acdOk}, no OR bars ${acdNull}`);

// ---------- 3. level_prices via the real compute_levels.js, one date at a time ----------
let lvOk = 0, lvFail = 0;
for (const d of dates) {
  const res = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'compute_levels.js'), d],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120000 });
  if (res.status === 0) lvOk++;
  else { lvFail++; console.error(`compute_levels failed for ${d}: ${(res.stderr || res.stdout || '').slice(-300)}`); }
}
console.log(`level_prices: recomputed ${lvOk} dates, failed ${lvFail}`);

// ---------- verify against the corrected bars ----------
const chk = await query(`
  with rth as (select ts::date d, max(high) hi, (array_agg(close order by ts desc) filter (where ts::time <= '15:59'))[1] cl from price_bars_primary
               where symbol='NQ' and ts::time between '09:30' and '15:59' and ts>='2025-09-15' and ts<'2025-12-05' group by 1),
  lp as (select trade_date d, max(case when level_name='PD_HIGH' then price end) pdh, max(case when level_name='PD_CLOSE' then price end) pdc
         from level_prices where trade_date between $1 and $2 group by 1),
  pairs as (select lp.d, lp.pdh, lp.pdc, (select max(d) from rth where rth.d < lp.d) pd from lp)
  select count(*)::int n,
         count(*) filter (where abs(p.pdh - r.hi) > 2)::int bad_hi,
         count(*) filter (where abs(p.pdc - r.cl) > 2)::int bad_cl,
         round(max(abs(p.pdh - r.hi))::numeric,2) max_hi_diff
  from pairs p join rth r on r.d = p.pd`, [REBUILD_FROM, TO]);
console.log('verify PD_HIGH/PD_CLOSE vs corrected prior-session bars:', chk.rows[0]);
const dvChk = await query(`
  select count(*)::int n, count(*) filter (where abs(dv.session_high - r.hi) > 2)::int bad_hi
  from developing_value_log dv join (select ts::date d, max(high) hi from price_bars_primary where symbol='NQ' and ts::time between '09:30' and '15:59' and ts>='2025-09-15' and ts<'2025-12-05' group by 1) r on r.d = dv.trade_date
  where dv.trade_date between $1 and $2`, [REBUILD_FROM, TO]);
console.log('verify developing_value_log.session_high vs corrected bars:', dvChk.rows[0]);
process.exit(0);
