// Re-simulates the 64 real historical trades across all 7 CONDITIONAL_VARIANTS _TRAIL setup
// types using the CORRECT calibrated stop/target (base type's real OPTIMAL_STOP), instead of
// the wrong wide ~85-91pt stop every one of them actually used (getOptStopForType() bug, fixed
// 2026-09-08 -- see server/services/acdShared.js and CLAUDE.md's Breakeven-then-trail entry).
//
// Read-only, research-only -- does NOT touch active_setups. Reuses the exact same touch-
// detection + same-bar tie-break convention as the real live resolver (server/services/
// resolveSetups.js's plain branch, ~line 736-759: "conservative, assume stop hit first on a
// same-bar conflict") so this resimulation can't structurally favor a better-looking outcome
// than what the real system would have produced. No lookahead: walks real price_bars_primary
// bars strictly after each trade's own fired_at, in chronological order, stopping at the first
// bar where either level is touched.
//
// Usage: node scripts/resim_trail_variant_correct_stop_20260908.mjs

import { writeFileSync } from 'fs';
import { query } from '../server/db.js';
import { CONDITIONAL_VARIANTS } from '../server/config/setupTypes.js';

const COMMISSION = 2; // MNQ $2/pt, $2 round-trip -- server/config/instruments.js

async function main() {
  const trailTypes = Object.keys(CONDITIONAL_VARIANTS).filter(k => CONDITIONAL_VARIANTS[k].trailSignalName != null);

  const results = [];
  for (const type of trailTypes) {
    const baseType = CONDITIONAL_VARIANTS[type].baseType;
    const optQ = await query(`
      SELECT optimal_stop::float as stop, optimal_target::float as target
      FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND signal_name=$1
      ORDER BY run_date DESC LIMIT 1
    `, [baseType]);
    const correctStop = optQ.rows[0]?.stop;
    const correctTarget = optQ.rows[0]?.target;
    if (correctStop == null || correctTarget == null) {
      console.log(`${type}: no OPTIMAL_STOP row for base type ${baseType} -- skipping`);
      continue;
    }

    const tradesQ = await query(`
      SELECT id, trade_date::text as trade_date, entry_zone_low::float as entry,
        fired_at::text as fired_at, actual_pnl::float as original_pnl, resolution as original_resolution
      FROM active_setups
      WHERE setup_type=$1 AND entry_zone_low IS NOT NULL AND actual_pnl IS NOT NULL
      ORDER BY fired_at
    `, [type]);

    const long = CONDITIONAL_VARIANTS[type].direction === 'LONG';

    for (const t of tradesQ.rows) {
      const stopLevel = long ? t.entry - correctStop : t.entry + correctStop;
      const t1Level = long ? t.entry + correctTarget : t.entry - correctTarget;

      // Session-end cap: same trade_date's RTH close (16:00 ET) -- these are all RTH-fired
      // fade types (floor pivots/PD levels/CAM/opening-related), no overnight variant exists
      // for any of the 7. Naive-timestamp DATE-to-string comparison, matches this codebase's
      // own "prefer pure SQL date comparisons" migration-protocol guidance.
      const barsQ = await query(`
        SELECT ts::text as ts, high::float as high, low::float as low
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts > $1 AND ts <= ($2::date || ' 16:00:00')::timestamp
        ORDER BY ts ASC
      `, [t.fired_at, t.trade_date]);

      let resolution = null, priceAtRes = null, barsToResolve = 0;
      for (const bar of barsQ.rows) {
        barsToResolve++;
        const stopHit = long ? bar.low <= stopLevel : bar.high >= stopLevel;
        const t1Hit = long ? bar.high >= t1Level : bar.low <= t1Level;
        if (stopHit && t1Hit) { resolution = 'STOP_HIT'; priceAtRes = stopLevel; break; } // conservative tie-break
        if (stopHit) { resolution = 'STOP_HIT'; priceAtRes = stopLevel; break; }
        if (t1Hit) { resolution = 'TARGET_HIT'; priceAtRes = t1Level; break; }
      }
      if (!resolution) {
        // Ran out of bars before either level hit -- mark-to-market at the last available
        // close, matching this codebase's TIME_EXPIRED/MARK_TO_MARKET convention (never leave
        // actual_pnl null for a real trade that had real price data available).
        const lastBar = barsQ.rows[barsQ.rows.length - 1];
        resolution = 'TIME_EXPIRED';
        priceAtRes = lastBar ? (long ? lastBar.low : lastBar.high) : t.entry; // conservative if truly no data
      }

      const pts = long ? priceAtRes - t.entry : t.entry - priceAtRes;
      const correctedPnl = Math.round((pts * 2 - COMMISSION) * 100) / 100;

      results.push({
        type, id: t.id, trade_date: t.trade_date, original_pnl: t.original_pnl,
        original_resolution: t.original_resolution, corrected_resolution: resolution,
        corrected_pnl: correctedPnl, correctStop, correctTarget,
      });
    }
  }

  console.log(`Re-simulated ${results.length} trades\n`);
  const byType = {};
  for (const r of results) (byType[r.type] ??= []).push(r);

  let totalOrig = 0, totalCorrected = 0;
  for (const [type, rows] of Object.entries(byType)) {
    const origSum = rows.reduce((s, r) => s + r.original_pnl, 0);
    const corrSum = rows.reduce((s, r) => s + r.corrected_pnl, 0);
    const origWins = rows.filter(r => r.original_pnl > 0).length;
    const corrWins = rows.filter(r => r.corrected_pnl > 0).length;
    totalOrig += origSum; totalCorrected += corrSum;
    console.log(`${type} (N=${rows.length}, correct stop=${rows[0].correctStop}pt/target=${rows[0].correctTarget}pt)`);
    console.log(`  ORIGINAL (wrong stop):   WR=${(100 * origWins / rows.length).toFixed(1)}%  total=$${origSum.toFixed(2)}`);
    console.log(`  CORRECTED (real stop):   WR=${(100 * corrWins / rows.length).toFixed(1)}%  total=$${corrSum.toFixed(2)}`);
    console.log(`  delta: $${(corrSum - origSum).toFixed(2)}\n`);
  }

  console.log('='.repeat(60));
  console.log(`TOTAL ORIGINAL (wrong stop):  $${totalOrig.toFixed(2)}`);
  console.log(`TOTAL CORRECTED (real stop):  $${totalCorrected.toFixed(2)}`);
  console.log(`DELTA:                        $${(totalCorrected - totalOrig).toFixed(2)}`);

  writeFileSync('/tmp/trail_resim_results.json', JSON.stringify(results, null, 2));
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
