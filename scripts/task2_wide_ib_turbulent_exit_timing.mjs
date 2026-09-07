// Original one-off analysis for RESEARCH_CLAIM wide_ib_turbulent_hold_longer_exit_timing_20260906.
// Core computation extracted 2026-09-07 into scripts/lib/wideIbTurbulentExit.mjs so
// scripts/verify_wide_ib_turbulent_exit_timing_recheck.mjs's periodic recheck can reuse it
// instead of duplicating it.
import { Client } from 'pg';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { computeWideIbTurbulentExitDeltas } from './lib/wideIbTurbulentExit.mjs';

const client = new Client({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'gemini_readonly', password: 'gemini_ro_2026' });

async function run() {
  await client.connect();
  const results = await computeWideIbTurbulentExitDeltas((sql, params) => client.query(sql, params));

  console.log(`\n--- Task 2 Results ---`);
  console.log(`Valid setups: ${results.length}`);
  if (results.length > 0) {
    const meanDelta = results.reduce((s, r) => s + r.delta, 0) / results.length;
    console.log(`Mean P&L delta (hold-longer - status-quo) = $${meanDelta.toFixed(2)}`);
    const rCheck = computeRigor(results, { dateField: 'trade_date', pnlFn: x => x.delta });
    console.log('Rigor:', JSON.stringify(rCheck, null, 2));
  }
  await client.end();
}
run().catch(console.error);
