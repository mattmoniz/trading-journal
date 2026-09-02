/**
 * Walkforward of REAL (origin_status IN ACTIVE/SHADOW, non-BACKFILL) trade history, comparing
 * WITHOUT today's 2 live changes (the stored, as-fired actual_pnl) vs WITH them applied
 * retroactively -- the sibling-reversal gate (isPostWinOppositeFamilyBlocked) and the
 * IB_HIGH/IB_LOW/PD_IB_HIGH/PD_IB_LOW invalidation-boundary fix.
 *
 * Scoped correctly this session (earlier attempt mixed this into the mostly-BACKFILL 1-year
 * prop-challenge window, where the account blew up in Oct 2025 on synthetic data nearly a year
 * before either fix's real trade population even begins -- see chat history): real, non-BACKFILL
 * trade history in this system only goes back to 2026-07-09 (~8 weeks as of this run), so that's
 * the only window either fix can meaningfully be evaluated against.
 *
 * Reuses:
 *   - computeFlaggedReversalIds() (backtest_post_win_opposite_family_reversal.mjs) -- the real
 *     identification logic, not reimplemented.
 *   - performance_audit's persisted IB_INVALIDATION_BOUNDARY_FIX changed_trades list -- the
 *     real walk-forward re-simulation already run and DeepSeek-reviewed for that fix.
 *
 * Chronological, single-path (no resampling), includes both RTH and GLOBEX session real
 * trades. Reports cumulative P&L trajectory day-by-day for both arms so the actual dollar
 * impact and its timing are both visible, not just an end-of-window total.
 *
 * Run: node scripts/walkforward_real_trades_todays_fixes.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { computeFlaggedReversalIds } from './backtest_post_win_opposite_family_reversal.mjs';

async function run() {
  console.log('Loading real (ACTIVE/SHADOW) decisive trade history...');
  const { rows: allTrades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           resolved_at::text as resolved_at, resolution, actual_pnl::float as actual_pnl,
           size_multiplier::float as size_multiplier, origin_status, session
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `);
  console.log(`N=${allTrades.length} real decisive trades, ${allTrades[0].trade_date} to ${allTrades[allTrades.length - 1].trade_date}`);

  const flaggedIds = computeFlaggedReversalIds(allTrades);
  console.log(`Sibling-reversal gate: ${flaggedIds.size} trades would have been forced to SHADOW (excluded from the WITH-fixes arm)`);

  const ibFixRow = await query(`
    SELECT notes::jsonb->'changed_trades' as ct FROM performance_audit
    WHERE signal_type='IB_INVALIDATION_BOUNDARY_FIX' ORDER BY run_date DESC LIMIT 1
  `);
  const ibFixMap = new Map();
  for (const t of (ibFixRow.rows[0]?.ct || [])) ibFixMap.set(t.id, t.new_pnl);
  const ibFixInWindow = allTrades.filter(t => ibFixMap.has(t.id));
  console.log(`IB invalidation-boundary fix: ${ibFixInWindow.length} of ${ibFixMap.size} corrected trades fall within this real-trade window`);

  let withoutTotal = 0, withTotal = 0;
  let withoutTrades = 0, withTrades = 0;
  const byDate = new Map(); // date -> { without, with }
  const changedTrades = [];

  for (const t of allTrades) {
    const sized = (raw) => raw * (t.size_multiplier || 1.0);
    const oldPnl = sized(t.actual_pnl);
    withoutTotal += oldPnl;
    withoutTrades++;

    const isFlagged = flaggedIds.has(t.id);
    const correctedRaw = ibFixMap.has(t.id) ? ibFixMap.get(t.id) : t.actual_pnl;
    const newPnl = isFlagged ? 0 : sized(correctedRaw);
    if (!isFlagged) { withTotal += newPnl; withTrades++; }

    if (!byDate.has(t.trade_date)) byDate.set(t.trade_date, { without: 0, with: 0 });
    byDate.get(t.trade_date).without += oldPnl;
    byDate.get(t.trade_date).with += newPnl;

    if (isFlagged || ibFixMap.has(t.id)) {
      changedTrades.push({
        id: t.id, date: t.trade_date, setup_type: t.setup_type, origin_status: t.origin_status,
        reason: isFlagged ? 'SIBLING_REVERSAL_EXCLUDED' : 'IB_FIX_CORRECTED',
        old_pnl: +oldPnl.toFixed(2), new_pnl: +newPnl.toFixed(2), delta: +(newPnl - oldPnl).toFixed(2),
      });
    }
  }

  console.log(`\n=== TOTALS (${allTrades[0].trade_date} to ${allTrades[allTrades.length - 1].trade_date}) ===`);
  console.log(`WITHOUT today's fixes (as actually stored/fired): $${withoutTotal.toFixed(2)} across ${withoutTrades} trades`);
  console.log(`WITH today's fixes applied retroactively:         $${withTotal.toFixed(2)} across ${withTrades} trades`);
  console.log(`DELTA: $${(withTotal - withoutTotal).toFixed(2)} (${withoutTrades - withTrades} trades excluded by the sibling-reversal gate)`);

  console.log(`\n=== CUMULATIVE TRAJECTORY BY DATE (both arms) ===`);
  let cumWithout = 0, cumWith = 0;
  const dates = [...byDate.keys()].sort();
  for (const d of dates) {
    const day = byDate.get(d);
    cumWithout += day.without;
    cumWith += day.with;
    console.log(`  ${d}  without=$${cumWithout.toFixed(2).padStart(9)}  with=$${cumWith.toFixed(2).padStart(9)}  delta=$${(cumWith - cumWithout).toFixed(2)}`);
  }

  console.log(`\n=== CHANGED/EXCLUDED TRADES (${changedTrades.length}) ===`);
  for (const c of changedTrades) {
    console.log(`  id=${c.id} ${c.date} ${c.setup_type.padEnd(28)} ${c.origin_status.padEnd(7)} ${c.reason.padEnd(24)} old=$${c.old_pnl} new=$${c.new_pnl} delta=$${c.delta}`);
  }

  await pool.end();
}

run().catch(e => { console.error('[walkforward_real_trades_todays_fixes] ERROR:', e.message, e.stack); process.exit(1); });
