/**
 * SUPERSEDED 2026-09-02 (DeepSeek review of the later OR-length-pooling fix): after this script
 * was written, isCrossDirectionFastFlip() was extended again to broaden its opposite-lookup
 * across OR5/OR10/OR15/OR30 lengths of the same HIGH/LOW/MID type (while on the _POOLED_ALL
 * fallback path). This script still groups by BARE per-length family only, so it now
 * UNDERCOUNTS real cross-length overlaps -- use scripts/walkforward_all_changes_combined.mjs
 * instead, which matches the current acd.js logic exactly. Kept for reference/history, not
 * accurate for a fresh run.
 *
 * Walkforward of the cross-direction fast-flip gate fix (2026-09-02): isCrossDirectionFastFlip
 * was just extended to the 2 sites it was missing from (STACK_VOL_BREAK_LIVE, shadowCandidates),
 * mirroring the sibling-reversal gate's earlier fix. This asks the follow-up question directly:
 * did it actually improve real historical results?
 *
 * Same real (ACTIVE/SHADOW, non-BACKFILL) trade population and window as
 * walkforward_real_trades_todays_fixes.mjs (2026-07-09 to today -- the only window with real
 * data at all). No calibration existed for this gate before today (verified: a single
 * performance_audit row, run_date=today, for every signal_name under CROSS_DIRECTION_FLIP_CALIB)
 * -- so this gate has never actually blocked anything anywhere, at any of the 4 sites, until
 * today's fix + today's fresh calibration together. This script identifies every real historical
 * trade that WOULD have been excluded (forced to SHADOW) under today's calibration + full 4-site
 * wiring, and reports the P&L delta.
 *
 * Reuses the exact same family-derivation and open-opposite logic as
 * scripts/backtest_cross_direction_fast_flip.mjs (bare `_(LONG|SHORT)$` strip, not the fuller
 * postWinFamilyOf() stripping the sibling-reversal gate uses -- confirmed correct for THIS gate
 * specifically since isCrossDirectionFastFlip()'s own opposite-match lookup uses the same bare
 * strip, for every family EXCEPT the OR-length pooling case added later, see the SUPERSEDED note
 * above) and the same family-specific-row-first-else-pooled-fallback precedence acd.js's
 * isCrossDirectionFastFlip() itself uses.
 *
 * Run: node scripts/walkforward_cross_direction_fast_flip_fix.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';

function isLong(setupType) { return setupType.endsWith('_LONG'); }
function levelBaseOf(setupType) { return setupType.replace(/_(LONG|SHORT)$/, ''); }

async function run() {
  console.log('Loading real (ACTIVE/SHADOW) decisive trade history...');
  const { rows: allTrades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           resolved_at::text as resolved_at, resolution, actual_pnl::float as actual_pnl,
           size_multiplier::float as size_multiplier, origin_status
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND fired_at IS NOT NULL AND resolved_at IS NOT NULL
      AND (setup_type LIKE '%_LONG' OR setup_type LIKE '%_SHORT')
    ORDER BY fired_at ASC
  `);
  console.log(`N=${allTrades.length} real decisive directional trades, ${allTrades[0].trade_date} to ${allTrades[allTrades.length - 1].trade_date}`);

  const { rows: calibRows } = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation, notes
    FROM performance_audit WHERE signal_type='CROSS_DIRECTION_FLIP_CALIB'
    ORDER BY signal_name, run_date DESC
  `);
  const calib = {};
  for (const r of calibRows) {
    if (r.recommendation !== 'GATE') continue;
    try { calib[r.signal_name] = JSON.parse(r.notes).cooldownMinutes; } catch (_) {}
  }
  console.log(`Calibration: ${Object.keys(calib).length} GATE-justified rows (family-specific + _POOLED_ALL fallback)`);

  // Group by levelBase for the open-opposite lookup (mirrors the calibration script's own logic).
  const byBase = new Map();
  for (const t of allTrades) {
    const base = levelBaseOf(t.setup_type);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(t);
  }

  let withoutTotal = 0, withTotal = 0, excludedCount = 0;
  const excludedTrades = [];

  for (const t of allTrades) {
    const sized = t.actual_pnl * (t.size_multiplier || 1.0);
    withoutTotal += sized;

    const base = levelBaseOf(t.setup_type);
    const cooldownMin = calib[base] ?? calib['_POOLED_ALL'];
    let blocked = false;
    if (cooldownMin) {
      const list = byBase.get(base) || [];
      const tFiredMs = new Date(t.fired_at.replace(' ', 'T') + 'Z').getTime();
      for (const cand of list) {
        if (cand === t) continue;
        if (isLong(cand.setup_type) === isLong(t.setup_type)) continue; // same direction, not a flip
        const candFiredMs = new Date(cand.fired_at.replace(' ', 'T') + 'Z').getTime();
        const candResolvedMs = new Date(cand.resolved_at.replace(' ', 'T') + 'Z').getTime();
        // Opposite direction, was open (fired before/at t, resolved after t fired), and within cooldown.
        if (candFiredMs <= tFiredMs && candResolvedMs > tFiredMs) {
          const minsSince = (tFiredMs - candFiredMs) / 60000;
          if (minsSince <= cooldownMin) { blocked = true; break; }
        }
      }
    }

    if (blocked) {
      excludedCount++;
      excludedTrades.push({ id: t.id, date: t.trade_date, setup_type: t.setup_type, origin_status: t.origin_status, pnl: +sized.toFixed(2) });
    } else {
      withTotal += sized;
    }
  }

  console.log(`\n=== TOTALS (${allTrades[0].trade_date} to ${allTrades[allTrades.length - 1].trade_date}) ===`);
  console.log(`WITHOUT the cross-direction-flip fix (as actually happened): $${withoutTotal.toFixed(2)} across ${allTrades.length} trades`);
  console.log(`WITH the fix applied retroactively (full calibration + 4-site wiring): $${withTotal.toFixed(2)} across ${allTrades.length - excludedCount} trades`);
  console.log(`DELTA: $${(withTotal - withoutTotal).toFixed(2)} (${excludedCount} trades would have been excluded/forced-SHADOW)`);

  const activeExcluded = excludedTrades.filter(t => t.origin_status === 'ACTIVE');
  const activeWithout = allTrades.filter(t => t.origin_status === 'ACTIVE').reduce((s, t) => s + t.actual_pnl * (t.size_multiplier || 1.0), 0);
  const activeExcludedPnl = activeExcluded.reduce((s, t) => s + t.pnl, 0);
  console.log(`\n=== ACTIVE (real capital) only ===`);
  console.log(`WITHOUT: $${activeWithout.toFixed(2)}  |  ${activeExcluded.length} real ACTIVE trades would be excluded, sum $${activeExcludedPnl.toFixed(2)}`);
  console.log(`WITH: $${(activeWithout - activeExcludedPnl).toFixed(2)}  |  delta=$${(-activeExcludedPnl).toFixed(2)}`);

  console.log(`\n=== EXCLUDED TRADES (${excludedTrades.length}) ===`);
  for (const t of excludedTrades) {
    console.log(`  id=${t.id} ${t.date} ${t.setup_type.padEnd(24)} ${t.origin_status.padEnd(7)} pnl=$${t.pnl}`);
  }

  await pool.end();
}

run().catch(e => { console.error('[walkforward_cross_direction_fast_flip_fix] ERROR:', e.message, e.stack); process.exit(1); });
