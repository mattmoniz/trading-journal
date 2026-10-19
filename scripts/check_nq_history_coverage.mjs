#!/usr/bin/env node
// Standing check that price_bars_primary (what every backtest reads) has REAL 1-minute NQ history, month by month. Added 2026-10-19 after the long-history rebuild
// (docs/KNOWN_ISSUES.md item 17): for years the table held one daily placeholder row per day or one month per contract, and nothing flagged it -- any backtest quietly ran on
// a fraction of its nominal window. Flags every month since COVERAGE_START that averages fewer than 800 bars per trading day (a normal full day is ~1,100-1,400).
// Exit code 1 when a month is flagged (informational in the weekly run, like data_sanity_audit.mjs). Persists one performance_audit row (signal_type='NQ_HISTORY_COVERAGE')
// so the latest result is queryable. To repair a flagged month: rebuild the contract's 1-minute bars from its Sierra tick (.scid) file with
// scripts/tick_microstructure/build_1m_bars_from_scid.py and load them with scripts/load_nq_bars_from_scid_csv.mjs (dry run first; see its header).
// Usage: node scripts/check_nq_history_coverage.mjs
import { query } from '../server/db.js';
const COVERAGE_START = '2023-03-01';   // first month with a complete rebuilt history (no NQH3 tick file exists for earlier months)
const MIN_BARS_PER_DAY = 800;
const rows = (await query(`SELECT to_char(date_trunc('month', ts),'YYYY-MM') m, count(*)::int bars, count(DISTINCT ts::date)::int days
  FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < date_trunc('month', CURRENT_DATE) GROUP BY 1 ORDER BY 1`, [COVERAGE_START])).rows;
const flagged = rows.filter(r => r.bars / r.days < MIN_BARS_PER_DAY);
const missingMonths = [];
{ const have = new Set(rows.map(r => r.m)); const curMonth = (await query(`SELECT to_char(CURRENT_DATE,'YYYY-MM') m`)).rows[0].m;   // month key from SQL CURRENT_DATE, never JS toISOString (CLAUDE.md)
  const d = new Date(COVERAGE_START + 'T12:00:00Z');
  for (let k = d.toISOString().slice(0, 7); k < curMonth; d.setUTCMonth(d.getUTCMonth() + 1), k = d.toISOString().slice(0, 7)) if (!have.has(k)) missingMonths.push(k); }
console.log(`NQ 1-minute coverage ${COVERAGE_START}..last complete month: ${rows.length} months checked, ${flagged.length} thin (< ${MIN_BARS_PER_DAY} bars/day), ${missingMonths.length} with no bars at all`);
for (const r of flagged) console.log(`  THIN  ${r.m}: ${Math.round(r.bars / r.days)} bars/day over ${r.days} days`);
for (const m of missingMonths) console.log(`  EMPTY ${m}`);
const summary = { checkedMonths: rows.length, thinMonths: flagged.map(r => r.m), emptyMonths: missingMonths, minBarsPerDay: MIN_BARS_PER_DAY };
await query(`INSERT INTO performance_audit (run_date, signal_type, signal_name, recommendation, sample_size, window_days, notes)
  VALUES (CURRENT_DATE, 'NQ_HISTORY_COVERAGE', 'LATEST', $1, $2, 0, $3::jsonb)`, [flagged.length || missingMonths.length ? 'GAPS' : 'OK', rows.length, JSON.stringify(summary)]).catch(e => console.error('persist failed:', e.message));
process.exit(flagged.length || missingMonths.length ? 1 : 0);
