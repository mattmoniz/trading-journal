#!/usr/bin/env node
/**
 * Setup Outcome Backtest — standalone CLI runner
 *
 * Replays every setup in active_setups and determines what WOULD have
 * happened if traded with the standard bracket (T1 level, stop level)
 * using price_bars data.
 *
 * Run: node scripts/backtest_setups.js
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { runSetupBacktest, getBacktestEdge } from '../server/services/setupBacktestService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

// Keep raw timestamp strings — same format as fired_at stored values
pg.types.setTypeParser(1114, (val) => val ?? null);
pg.types.setTypeParser(1082, (val) => val);

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

// Wrap pool.query so the service can call db.query(sql, params)
const db = { query: (sql, params) => pool.query(sql, params) };

console.log('\nRunning setup outcome backtest...\n');
const { processed, skipped, errors } = await runSetupBacktest(db, { verbose: true });
console.log(`\nBacktest complete: ${processed} processed, ${skipped} skipped, ${errors} errors`);

// Print results
const rows = await getBacktestEdge(db, { minSamples: 1 });

console.log('\n' + '='.repeat(80));
console.log('VALIDATED EDGE — Setup + Level + Condition Combinations (min 1 sample)');
console.log('='.repeat(80));
for (const r of rows) {
  const measured = Number(r.sample_size) >= 10 ? ' *** MEASURED ***' : '';
  console.log(
    `  ${r.setup_type.padEnd(30)} | ${String(r.level_at_entry).padEnd(10)} | ` +
    `${String(r.structural_state).padEnd(20)} | ${r.nl_regime.padEnd(7)} | ` +
    `n=${String(r.sample_size).padStart(3)} | WR=${r.win_rate_pct}% | ` +
    `MFE=${r.avg_mfe} MAE=${r.avg_mae} | ` +
    `W=${r.wins}/L=${r.losses}/NE=${r.no_exit}${measured}`
  );
}

// Summary by setup type
const { rows: summary } = await pool.query(`
  SELECT
    setup_type,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE hit_t1_first) as wins,
    COUNT(*) FILTER (WHERE hit_stop AND NOT COALESCE(hit_t1_first,false)) as losses,
    COUNT(*) FILTER (WHERE NOT COALESCE(hit_t1,false) AND NOT COALESCE(hit_stop,false)) as no_exit,
    ROUND(
      COUNT(*) FILTER (WHERE hit_t1_first)::numeric /
      NULLIF(COUNT(*) FILTER (WHERE hit_t1_first OR (hit_stop AND NOT COALESCE(hit_t1_first,false))), 0) * 100, 1
    ) as resolved_win_rate_pct,
    ROUND(AVG(mfe_points), 1) as avg_mfe,
    ROUND(AVG(mae_points), 1) as avg_mae,
    ROUND(SUM(computed_pnl_1contract), 2) as total_pnl
  FROM setup_outcome_backtest
  GROUP BY setup_type
  ORDER BY total DESC
`);

console.log('\n' + '='.repeat(80));
console.log('SUMMARY BY SETUP TYPE');
console.log('='.repeat(80));
for (const r of summary) {
  console.log(
    `  ${r.setup_type.padEnd(30)} | total=${r.total} | ` +
    `W=${r.wins} L=${r.losses} NE=${r.no_exit} | ` +
    `resolved_WR=${r.resolved_win_rate_pct ?? 'N/A'}% | ` +
    `MFE=${r.avg_mfe} MAE=${r.avg_mae} | totalP&L=$${r.total_pnl ?? 0}`
  );
}

// Flag data issues (T1 on wrong side)
const { rows: issues } = await pool.query(`
  SELECT id, trade_date, setup_type, entry_zone_high, stop_level, t1_level
  FROM active_setups
  WHERE (
    (setup_type LIKE '%LONG%' OR setup_type LIKE '%BULLISH%' OR setup_type LIKE '%_UP')
    AND t1_level IS NOT NULL AND entry_zone_high IS NOT NULL
    AND t1_level <= entry_zone_high
  ) OR (
    (setup_type NOT LIKE '%LONG%' AND setup_type NOT LIKE '%BULLISH%' AND setup_type NOT LIKE '%_UP')
    AND t1_level IS NOT NULL AND entry_zone_high IS NOT NULL
    AND t1_level >= entry_zone_high
  )
`);

if (issues.length) {
  console.log('\n' + '='.repeat(80));
  console.log('DATA ISSUES — T1 on wrong side of entry (skipped in backtest):');
  for (const r of issues) {
    console.log(`  id=${r.id} ${r.setup_type} ${r.trade_date} entry=${r.entry_zone_high} t1=${r.t1_level}`);
  }
}

await pool.end();
