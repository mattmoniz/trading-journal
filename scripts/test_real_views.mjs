// F34/F12 (Fable audit 2026-11-10): the shared views equal the hand-written filters they replace. Read-only. Run: node scripts/test_real_views.mjs
import assert from 'node:assert/strict';
import { query } from '../server/db.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';
const n = async (sql) => Number((await query(sql)).rows[0].n);
const direct = await n(`SELECT count(*) n FROM active_setups WHERE ${REAL_TRADE_FILTER}`);
assert.equal(await n(`SELECT count(*) n FROM real_setups`), direct, 'real_setups == REAL_TRADE_FILTER');
assert.equal(await n(`SELECT count(*) n FROM real_primary_setups`), await n(`SELECT count(*) n FROM active_setups WHERE ${REAL_TRADE_FILTER} AND is_cluster_primary IS TRUE`), 'real_primary_setups == filter + is_cluster_primary');
assert.equal(await n(`SELECT count(*) n FROM real_setups WHERE id IN (SELECT id FROM active_setups WHERE NOT (${REAL_TRADE_FILTER}))`), 0, 'no excluded row leaks in');
// hr-009: latest row per (type, name) equals the hand-written DISTINCT ON for a real signal type
for (const t of ['SETUP_STATUS', 'OPTIMAL_STOP', 'LIVE_ROSTER']) {
  const a = (await query(`SELECT signal_name, id FROM performance_audit_latest WHERE signal_type = $1 ORDER BY signal_name`, [t])).rows;
  const b = (await query(`SELECT DISTINCT ON (signal_name) signal_name, id FROM performance_audit WHERE signal_type = $1 ORDER BY signal_name, run_date DESC, id DESC`, [t])).rows;
  assert.deepEqual(a, b, `performance_audit_latest ${t}`);
}
console.log(`shared views equal their hand-written filters (real_setups ${direct} rows)`); process.exit(0);
