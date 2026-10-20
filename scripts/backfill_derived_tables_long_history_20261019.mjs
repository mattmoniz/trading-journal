// backfill_derived_tables_long_history_20261019.mjs -- create the DERIVED rows (developing_value_log, acd_daily_log OR/A levels, level_prices) for every NQ RTH session that now has real
// 1-minute bars but no derived row, so roster-wide backtests (scripts/backtest_unified.js and anything reading level_prices / developing_value_log / acd_daily_log) can replay 3.5 years
// instead of only the old dense months. Follows docs/KNOWN_ISSUES.md item 17 and OPEN_DECISION nq_long_history_derived_tables_20261019.
//
// Every row is written by the REAL live producers (never reimplemented): developingValueService.computeAndPersistSession(), acdService.computeORLevelsOnly(), and scripts/compute_levels.js.
// INSERT-ONLY for missing dates: a date that already has a developing_value_log row is skipped entirely, so no existing row is overwritten (existing dense-month rows stay exactly as they were).
// Order matters: sessions are processed ascending because each session's migration fields read the prior session's row; level_prices runs after ALL value-area rows exist (it reads them).
// Limits worth knowing: acd_daily_log gets OR/A levels only (a_up_fired / c_up_confirmed / day_type / daily_score need the live ACD engine and stay empty for these dates), so any setup that
// needs an A/C signal or a day-type is NOT replayable on these dates; PY_* and 3M_* levels need prior-year / prior-quarter history that does not exist for the earliest dates.
// Reversibility: the list of dates created is written to scratch/longhist_derived_created_dates.json; to undo, delete those dates from the three tables.
//
// Usage: node scripts/backfill_derived_tables_long_history_20261019.mjs [--from 2023-03-03] [--to 2025-05-26]            # dry run
//        node scripts/backfill_derived_tables_long_history_20261019.mjs --write [--from ..] [--to ..] [--parallel 4]
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../server/db.js';
import { computeAndPersistSession } from '../server/services/developingValueService.js';
import { computeORLevelsOnly, getBestACDParams } from '../server/services/acdService.js';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const WRITE = args.includes('--write');
const FROM = arg('--from', '2023-03-03'), TO = arg('--to', '2025-05-26'), PAR = Number(arg('--parallel', 4));
const here = path.dirname(fileURLToPath(import.meta.url)), repoRoot = path.resolve(here, '..');
const LOG = path.join(repoRoot, 'scratch', 'longhist_derived_created_dates.json');

const sessions = (await query(`
  SELECT d::text d FROM (SELECT ts::date d, COUNT(*) n FROM price_bars_primary WHERE symbol='NQ' AND ts::date BETWEEN $1::date AND $2::date
    AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 GROUP BY 1) z WHERE n > 300 ORDER BY d`, [FROM, TO])).rows.map(r => r.d.slice(0, 10));
const haveDvl = new Set((await query(`SELECT trade_date::text d FROM developing_value_log WHERE trade_date BETWEEN $1::date AND $2::date`, [FROM, TO])).rows.map(r => r.d.slice(0, 10)));
const haveAcd = new Set((await query(`SELECT trade_date::text d FROM acd_daily_log WHERE trade_date BETWEEN $1::date AND $2::date`, [FROM, TO])).rows.map(r => r.d.slice(0, 10)));
const haveLvl = new Set((await query(`SELECT DISTINCT trade_date::text d FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date`, [FROM, TO])).rows.map(r => r.d.slice(0, 10)));
const todo = sessions.filter(d => !haveDvl.has(d));
const { aMult } = await getBestACDParams();
console.log('--- PLAN ---');
console.log(`window ${FROM} .. ${TO}: ${sessions.length} RTH sessions with real bars; already have developing_value_log ${sessions.length - todo.length}; to create ${todo.length} (${todo[0]} .. ${todo[todo.length - 1]})`);
console.log(`  existing acd_daily_log rows in window ${haveAcd.size}, level_prices dates ${haveLvl.size}; ACD aMult in use ${aMult}`);
if (!WRITE) { console.log('\nDry run only. Re-run with --write to create the rows.'); process.exit(0); }

// 1. developing_value_log, ascending
let dvOk = 0, dvNull = 0; const created = [];
for (const d of todo) { const r = await computeAndPersistSession(d); if (r) { dvOk++; created.push(d); } else dvNull++; }
console.log(`developing_value_log: created ${dvOk}, skipped (too few bars) ${dvNull}`);
// 2. acd_daily_log OR/A levels (insert missing only; overwrite:false)
let acdOk = 0, acdNull = 0;
for (const d of created) { if (haveAcd.has(d)) continue; const r = await computeORLevelsOnly(d, aMult, { overwrite: false }); if (r) acdOk++; else acdNull++; }
console.log(`acd_daily_log: created ${acdOk} OR/A rows, no OR bars ${acdNull}`);
fs.writeFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), from: FROM, to: TO, created }, null, 1));
// 3. level_prices via the real compute_levels.js, PAR dates at a time (each date is independent once every value-area row exists)
let lvOk = 0, lvFail = 0; const queue = [...created];
const runOne = (d) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'compute_levels.js'), d], { cwd: repoRoot });
  let err = ''; p.stderr.on('data', c => { err += c; }); p.stdout.on('data', () => {});
  const t = setTimeout(() => p.kill(), 180000);
  p.on('close', (code) => { clearTimeout(t); if (code === 0) lvOk++; else { lvFail++; console.error(`compute_levels failed for ${d}: ${err.slice(-200)}`); } resolve(); });
});
await Promise.all(Array.from({ length: PAR }, async () => { while (queue.length) { const d = queue.shift(); await runOne(d); if ((lvOk + lvFail) % 100 === 0) console.log(`  level_prices ${lvOk + lvFail}/${created.length}`); } }));
console.log(`level_prices: computed ${lvOk} dates, failed ${lvFail}`);

// verification: prior-day levels must equal the prior session's own bars; value-area session H/L must equal the bars
const v1 = await query(`
  WITH rth AS (SELECT ts::date d, max(high) hi, (array_agg(close ORDER BY ts DESC) FILTER (WHERE ts::time <= '15:59'))[1] cl FROM price_bars_primary WHERE symbol='NQ' AND ts::time BETWEEN '09:30' AND '15:59' AND ts::date BETWEEN $1::date - 8 AND $2::date GROUP BY 1),
  lp AS (SELECT trade_date d, max(CASE WHEN level_name='PD_HIGH' THEN price END) pdh, max(CASE WHEN level_name='PD_CLOSE' THEN price END) pdc FROM level_prices WHERE trade_date = ANY($3::date[]) GROUP BY 1),
  pairs AS (SELECT lp.d, lp.pdh, lp.pdc, (SELECT max(d) FROM rth WHERE rth.d < lp.d) pd FROM lp)
  SELECT count(*)::int n, count(*) FILTER (WHERE abs(p.pdh - r.hi) > 2)::int bad_hi, count(*) FILTER (WHERE abs(p.pdc - r.cl) > 2)::int bad_cl FROM pairs p JOIN rth r ON r.d = p.pd`, [FROM, TO, created]);
console.log('verify PD_HIGH / PD_CLOSE vs the prior session\'s own bars:', JSON.stringify(v1.rows[0]));
const v2 = await query(`SELECT count(*)::int n, count(*) FILTER (WHERE abs(dv.session_high - r.hi) > 2)::int bad_hi FROM developing_value_log dv JOIN (SELECT ts::date d, max(high) hi FROM price_bars_primary WHERE symbol='NQ' AND ts::time BETWEEN '09:30' AND '15:59' GROUP BY 1) r ON r.d = dv.trade_date WHERE dv.trade_date = ANY($1::date[])`, [created]);
console.log('verify developing_value_log.session_high vs bars:', JSON.stringify(v2.rows[0]));
process.exit(0);
