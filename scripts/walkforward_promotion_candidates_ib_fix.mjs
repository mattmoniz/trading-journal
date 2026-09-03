/**
 * Answers directly: under today's changes, which currently-THIN_N or SUPPRESS setup_types would
 * newly clear the real_n>=20 / real_ev>=-$5 promotion bar that they don't clear today?
 *
 * IMPORTANT CORRECTION (found mid-session): the sibling-reversal gate and cross-direction-fast-
 * flip gate do NOT affect this question at all. SETUP_STATUS's REAL_TRADE_FILTER
 * (scripts/backtest_setup_status.mjs) pools origin_status IN ('ACTIVE','SHADOW') together as
 * "real" -- both count equally toward real_n/real_ev. Those 2 gates only decide whether a trade
 * risks real CAPITAL (ACTIVE) or not (SHADOW); they don't change the trade's actual, already-
 * resolved outcome. So reclassifying a trade from ACTIVE to SHADOW doesn't remove it from the
 * real population SETUP_STATUS counts -- it's still there with the same real actual_pnl.
 *
 * The ONLY one of today's fixes that can move a setup_type's real_ev is the IB invalidation-
 * boundary fix, because it genuinely changes 147 real trades' RECORDED outcome (via a real
 * walk-forward re-simulation of a corrected invalidation boundary) -- not just their origin_status
 * label. Only IB_HIGH/IB_LOW/PD_IB_HIGH/PD_IB_LOW setup_types are eligible to move at all.
 *
 * Uses the same REAL_TRADE_FILTER semantics as backtest_setup_status.mjs (origin_status IN
 * ACTIVE/SHADOW; excludes MARK_TO_MARKET/RECOVERY_MTM resolution_method and ib_window_stale_basis
 * rows, matching that script's own real_n/real_ev definition) so the before/after comparison is
 * apples-to-apples with what SETUP_STATUS itself would compute.
 *
 * Run: node scripts/walkforward_promotion_candidates_ib_fix.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';

async function run() {
  console.log('Loading real trades for the 8 IB-family setup_types...');
  const { rows: allTrades } = await query(`
    SELECT id, setup_type, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE ${REAL_TRADE_FILTER}
      AND setup_type IN ('IB_HIGH_FADE_LONG','IB_HIGH_FADE_SHORT','IB_LOW_FADE_LONG','IB_LOW_FADE_SHORT',
                          'PD_IB_HIGH_FADE_LONG','PD_IB_HIGH_FADE_SHORT','PD_IB_LOW_FADE_LONG','PD_IB_LOW_FADE_SHORT')
  `);
  console.log(`N=${allTrades.length} real trades across the 8 IB-family setup_types`);

  const ibFixRow = await query(`
    SELECT notes::jsonb->'changed_trades' as ct FROM performance_audit
    WHERE signal_type='IB_INVALIDATION_BOUNDARY_FIX' ORDER BY run_date DESC LIMIT 1
  `);
  const ibFixMap = new Map();
  for (const t of (ibFixRow.rows[0]?.ct || [])) ibFixMap.set(t.id, t.new_pnl);
  console.log(`IB fix: ${ibFixMap.size} corrected trades on file\n`);

  const byType = new Map();
  for (const t of allTrades) {
    if (!byType.has(t.setup_type)) byType.set(t.setup_type, []);
    byType.get(t.setup_type).push(t);
  }

  // Current SETUP_STATUS recommendation for each, for before/after comparison.
  const { rows: statusRows } = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation
    FROM performance_audit WHERE signal_type='SETUP_STATUS'
    ORDER BY signal_name, run_date DESC
  `);
  const currentStatus = Object.fromEntries(statusRows.map(r => [r.signal_name, r.recommendation]));

  console.log('=== BEFORE vs AFTER (IB fix applied) ===');
  let anyNewlyEligible = false;
  for (const [type, trades] of byType) {
    const oldN = trades.length;
    const oldEv = trades.reduce((s, t) => s + t.actual_pnl, 0) / oldN;
    const newTotal = trades.reduce((s, t) => s + (ibFixMap.has(t.id) ? ibFixMap.get(t.id) : t.actual_pnl), 0);
    const newEv = newTotal / oldN; // N unchanged -- IB fix reprices, doesn't add/remove trades
    const oldEligible = oldN >= 20 && oldEv >= -5;
    const newEligible = oldN >= 20 && newEv >= -5;
    const flipped = !oldEligible && newEligible;
    if (flipped) anyNewlyEligible = true;
    console.log(`  ${type.padEnd(24)} N=${oldN}  current SETUP_STATUS=${(currentStatus[type] || 'n/a').padEnd(10)} oldEv=$${oldEv.toFixed(2).padStart(8)} newEv=$${newEv.toFixed(2).padStart(8)}  eligible: ${oldEligible} -> ${newEligible}${flipped ? '  <-- NEWLY ELIGIBLE' : ''}`);
  }

  if (!anyNewlyEligible) {
    console.log('\nNo setup_type crosses the N>=20/EV>=-$5 bar as a NEW result of the IB fix -- either');
    console.log('they were already eligible before the fix, or the fix does not move them enough.');
  }

  console.log('\n=== For completeness: the 2 gates that do NOT affect promotion odds ===');
  console.log('Sibling-reversal gate + cross-direction-fast-flip gate only change ACTIVE-vs-SHADOW');
  console.log('classification, not the recorded outcome -- real_n/real_ev for every OTHER setup_type');
  console.log('in the roster is completely unaffected by those two fixes. Only the 8 IB-family types');
  console.log('above can move at all from today\'s changes.');

  await pool.end();
}

run().catch(e => { console.error('[walkforward_promotion_candidates_ib_fix] ERROR:', e.message, e.stack); process.exit(1); });
