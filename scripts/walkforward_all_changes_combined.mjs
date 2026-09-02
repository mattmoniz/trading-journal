/**
 * Combined walkforward of ALL live-gate changes made this session, applied retroactively to
 * real (ACTIVE/SHADOW, non-BACKFILL) trade history -- the only ~8-week window with real data:
 *   1. Sibling-reversal gate (isPostWinOppositeFamilyBlocked) -- wired into all 4 sites, live.
 *   2. IB_HIGH/IB_LOW/PD_IB_HIGH/PD_IB_LOW invalidation-boundary fix -- shipped, live.
 *   3. Cross-direction-fast-flip gate (isCrossDirectionFastFlip) -- extended to the 2 sites it
 *      was missing from (STACK_VOL_BREAK_LIVE, shadowCandidates) -- implemented, not yet
 *      committed/deployed as of this run.
 *   4. OR-length pooled opposite-lookup (OR5/OR10/OR15/OR30 HIGH/LOW/MID share a boundary that's
 *      frequently the same real price) -- implemented, not yet committed/deployed as of this run.
 *
 * Reuses computeFlaggedReversalIds() (#1) and performance_audit's IB_INVALIDATION_BOUNDARY_FIX
 * changed_trades (#2) exactly as walkforward_real_trades_todays_fixes.mjs already did. #3/#4 are
 * re-derived here matching the ACTUAL current acd.js logic (bare-family match for normal
 * families, OR-length-pooled regex match for OR5/10/15/30_{HIGH,LOW,MID}_FADE) rather than the
 * narrower bare-only version walkforward_cross_direction_fast_flip_fix.mjs used before the
 * OR-pooling fix existed.
 *
 * A trade excluded by EITHER #1 or #3/#4 contributes $0 (would have been forced to SHADOW);
 * a trade not excluded uses its IB-fix-corrected pnl if #2 applies, else its real stored pnl.
 * No double-counting: exclusion is a single boolean per trade regardless of how many gates would
 * have caught it.
 *
 * Run: node scripts/walkforward_all_changes_combined.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { computeFlaggedReversalIds } from './backtest_post_win_opposite_family_reversal.mjs';

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
    ORDER BY fired_at ASC
  `);
  console.log(`N=${allTrades.length} real decisive trades, ${allTrades[0].trade_date} to ${allTrades[allTrades.length - 1].trade_date}`);

  // #1: sibling-reversal gate
  const siblingFlaggedIds = computeFlaggedReversalIds(allTrades);
  console.log(`#1 sibling-reversal: ${siblingFlaggedIds.size} trades excluded`);

  // #2: IB invalidation-boundary fix
  const ibFixRow = await query(`
    SELECT notes::jsonb->'changed_trades' as ct FROM performance_audit
    WHERE signal_type='IB_INVALIDATION_BOUNDARY_FIX' ORDER BY run_date DESC LIMIT 1
  `);
  const ibFixMap = new Map();
  for (const t of (ibFixRow.rows[0]?.ct || [])) ibFixMap.set(t.id, t.new_pnl);
  console.log(`#2 IB fix: ${ibFixMap.size} trades corrected`);

  // #3/#4: cross-direction-fast-flip (bare family + OR-length-pooled), only directional _LONG/_SHORT
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
  const directional = allTrades.filter(t => t.setup_type.endsWith('_LONG') || t.setup_type.endsWith('_SHORT'));
  const byBase = new Map();
  for (const t of directional) {
    const base = levelBaseOf(t.setup_type);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(t);
  }
  const crossFlipExcluded = new Set();
  for (const t of directional) {
    const base = levelBaseOf(t.setup_type);
    const cooldownMin = calib[base] ?? calib['_POOLED_ALL'];
    if (!cooldownMin) continue;
    const orMatch = base.match(/^OR\d+_(HIGH|LOW|MID)_FADE$/);
    const tFiredMs = new Date(t.fired_at.replace(' ', 'T') + 'Z').getTime();
    // Candidate pool: same base (bare match) OR, for OR-length families, any OR-length sibling
    // of the same HIGH/LOW/MID type (mirrors the new regex-based lookup in acd.js).
    const candidatePool = orMatch
      ? directional.filter(c => {
          const cBase = levelBaseOf(c.setup_type);
          const cMatch = cBase.match(/^OR\d+_(HIGH|LOW|MID)_FADE$/);
          return cMatch && cMatch[1] === orMatch[1];
        })
      : (byBase.get(base) || []);
    for (const cand of candidatePool) {
      if (cand === t) continue;
      if (isLong(cand.setup_type) === isLong(t.setup_type)) continue;
      const candFiredMs = new Date(cand.fired_at.replace(' ', 'T') + 'Z').getTime();
      const candResolvedMs = new Date(cand.resolved_at.replace(' ', 'T') + 'Z').getTime();
      if (candFiredMs <= tFiredMs && candResolvedMs > tFiredMs) {
        const minsSince = (tFiredMs - candFiredMs) / 60000;
        if (minsSince <= cooldownMin) { crossFlipExcluded.add(t.id); break; }
      }
    }
  }
  console.log(`#3/#4 cross-direction-fast-flip (with OR-length pooling): ${crossFlipExcluded.size} trades excluded`);

  const bothExcluded = [...siblingFlaggedIds].filter(id => crossFlipExcluded.has(id));
  console.log(`(${bothExcluded.length} trades flagged by both #1 and #3/#4 -- not double-counted)\n`);

  let withoutTotal = 0, withTotal = 0, excludedCount = 0;
  const byDate = new Map();

  for (const t of allTrades) {
    const sized = (raw) => raw * (t.size_multiplier || 1.0);
    const oldPnl = sized(t.actual_pnl);
    withoutTotal += oldPnl;

    const excluded = siblingFlaggedIds.has(t.id) || crossFlipExcluded.has(t.id);
    const correctedRaw = ibFixMap.has(t.id) ? ibFixMap.get(t.id) : t.actual_pnl;
    const newPnl = excluded ? 0 : sized(correctedRaw);
    if (excluded) excludedCount++; else withTotal += newPnl;

    if (!byDate.has(t.trade_date)) byDate.set(t.trade_date, { without: 0, with: 0 });
    byDate.get(t.trade_date).without += oldPnl;
    byDate.get(t.trade_date).with += newPnl;
  }

  console.log(`=== TOTALS, ALL 4 CHANGES COMBINED (${allTrades[0].trade_date} to ${allTrades[allTrades.length - 1].trade_date}) ===`);
  console.log(`WITHOUT any of today's changes (as actually happened): $${withoutTotal.toFixed(2)} across ${allTrades.length} trades`);
  console.log(`WITH all 4 changes applied retroactively: $${withTotal.toFixed(2)} across ${allTrades.length - excludedCount} trades`);
  console.log(`DELTA: $${(withTotal - withoutTotal).toFixed(2)} (${excludedCount} trades excluded total)`);

  for (const status of ['ACTIVE', 'SHADOW']) {
    const rows = allTrades.filter(t => t.origin_status === status);
    let wo = 0, w = 0, exN = 0;
    for (const t of rows) {
      const sized = (raw) => raw * (t.size_multiplier || 1.0);
      wo += sized(t.actual_pnl);
      const excluded = siblingFlaggedIds.has(t.id) || crossFlipExcluded.has(t.id);
      if (excluded) { exN++; continue; }
      const correctedRaw = ibFixMap.has(t.id) ? ibFixMap.get(t.id) : t.actual_pnl;
      w += sized(correctedRaw);
    }
    console.log(`  ${status}: N=${rows.length} WITHOUT=$${wo.toFixed(2)} WITH=$${w.toFixed(2)} (${exN} excluded) delta=$${(w - wo).toFixed(2)}`);
  }

  console.log(`\n=== CUMULATIVE TRAJECTORY BY DATE (last 15 days) ===`);
  let cumWithout = 0, cumWith = 0;
  const dates = [...byDate.keys()].sort();
  for (const d of dates) {
    const day = byDate.get(d);
    cumWithout += day.without;
    cumWith += day.with;
  }
  const last15 = dates.slice(-15);
  let runWithout = 0, runWith = 0;
  for (const d of dates) {
    const day = byDate.get(d);
    runWithout += day.without;
    runWith += day.with;
    if (last15.includes(d)) {
      console.log(`  ${d}  without=$${runWithout.toFixed(2).padStart(9)}  with=$${runWith.toFixed(2).padStart(9)}  delta=$${(runWith - runWithout).toFixed(2)}`);
    }
  }

  await pool.end();
}

run().catch(e => { console.error('[walkforward_all_changes_combined] ERROR:', e.message, e.stack); process.exit(1); });
