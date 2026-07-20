// One-time repair: 341 active_setups rows (18 setup_types, all shadowCandidates-style
// non-level-fade setups: TRT/TRT_MAH, IB_BULLISH/BEARISH, BRACKET_BREAKOUT,
// OPEN_TEST_DRIVE, C_STANDALONE, VALUE_AREA_RESPONSIVE, OPEN_DRIVE, FAILED_AUCTION) were
// found 2026-07-20 with status='RESOLVED', resolution='EXPIRED', actual_pnl=NULL,
// resolved_at=NULL -- real historical trade attempts whose outcome was never computed.
// Root cause: all 341 share the exact same created_at timestamp (2026-06-15
// 22:19:04.589173), meaning they were bulk-inserted by a script that no longer exists in
// git history (exhaustive search across all commits/patches found nothing -- very likely
// an uncommitted one-off). The resolution logic that DOES survive in the repo,
// scripts/replay_all_setups.js, shares the exact same bug shape as a close analog: `let
// resolution = 'EXPIRED', pnl = null` with no fallback branch computing pnl when neither
// target nor stop is hit within the window -- almost certainly the same author/session's
// logic, just never wired to write to the DB in the surviving copy.
//
// Fix: real bar-walk using the SAME conservative same-bar-stop-first tie-break as
// resolveSetupsByPrice() (server/routes/acd.js), the real $2/pt MNQ commission-inclusive
// formula (not replay_all_setups.js's wrong `* 5 - 5`), and a genuine TIME_EXPIRED
// mark-to-market fallback (last bar's close within the window) instead of leaving pnl
// null. Backed up first: active_setups_null_pnl_recovery_backup_20260720 (341 rows).
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const DRY_RUN = process.argv.includes('--dry-run');
// Batch 2 (2026-07-20): the 46 rows still null after batch 1 -- NOT the same 2026-06-15
// bulk-insert bug, these are ongoing casualties of expireStaleSetups() never computing
// actual_pnl (root cause fixed the same day in server/routes/acd.js). Point this same
// bar-walk logic at the batch-2 backup table instead of writing a near-duplicate script.
const SOURCE_TABLE = process.argv.includes('--batch2')
  ? 'active_setups_null_pnl_recovery_backup_20260720_batch2'
  : 'active_setups_null_pnl_recovery_backup_20260720';

async function main() {
  const rows = (await query(`
    SELECT id, setup_type, entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
           stop_level::float as stop_level, t1_level::float as t1_level,
           fired_at::text as fired_at, expires_at::text as expires_at
    FROM ${SOURCE_TABLE}
    ORDER BY fired_at
  `)).rows;

  console.log(`Repairing ${rows.length} rows${DRY_RUN ? ' (DRY RUN)' : ''}...`);

  const tally = { TARGET_HIT: 0, STOP_HIT: 0, TIME_EXPIRED: 0, NO_BAR_DATA: 0 };
  const byType = {};

  for (const row of rows) {
    const long = inferDirection(row.setup_type) === 'LONG';
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const { stop_level: stop, t1_level: t1 } = row;

    const bars = (await query(`
      SELECT ts::text as ts, high::float as high, low::float as low, close::float as close
      FROM price_bars_primary WHERE symbol='NQ' AND ts > $1 AND ts <= $2
      ORDER BY ts
    `, [row.fired_at, row.expires_at])).rows;

    if (bars.length === 0) {
      tally.NO_BAR_DATA++;
      continue;
    }

    let resolution = null, method = null, priceAtRes = null, resolvedAt = null;
    let runMfe = 0, runMae = 0, barCount = 0;
    for (const bar of bars) {
      barCount++;
      const favorable = long ? bar.high - entry : entry - bar.low;
      const adverse   = long ? entry - bar.low  : bar.high - entry;
      runMfe = Math.max(runMfe, favorable);
      runMae = Math.max(runMae, adverse);

      const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (t1Hit && stopHit) {
        resolution = 'STOP_HIT'; method = 'SAME_BAR_STOP_FIRST'; priceAtRes = stop; resolvedAt = bar.ts; break;
      } else if (t1Hit) {
        resolution = 'TARGET_HIT'; method = 'PRICE_CLEAN'; priceAtRes = t1; resolvedAt = bar.ts; break;
      } else if (stopHit) {
        resolution = 'STOP_HIT'; method = 'PRICE_CLEAN'; priceAtRes = stop; resolvedAt = bar.ts; break;
      }
    }
    if (!resolution) {
      // Genuinely never hit either level within the window — real mark-to-market outcome
      // at the last available bar's close, not a null.
      const last = bars[bars.length - 1];
      resolution = 'TIME_EXPIRED'; method = 'RECOVERY_MTM'; priceAtRes = last.close; resolvedAt = last.ts;
    }

    const pnl = (long ? (priceAtRes - entry) : (entry - priceAtRes)) * PNL_PER_POINT - COMMISSION;
    tally[resolution] = (tally[resolution] || 0) + 1;
    (byType[row.setup_type] ||= { TARGET_HIT: 0, STOP_HIT: 0, TIME_EXPIRED: 0, pnlSum: 0 });
    byType[row.setup_type][resolution] = (byType[row.setup_type][resolution] || 0) + 1;
    byType[row.setup_type].pnlSum += pnl;

    if (!DRY_RUN) {
      await query(`
        UPDATE active_setups
        SET resolution=$2, resolution_method=$3, actual_outcome=$2, actual_pnl=$4,
            price_at_resolution=$5, resolved_at=$6, updated_at=NOW(),
            mae_points=$7, mfe_points=$8, bars_to_resolution=$9,
            resolution_bar_time=$6, replay_resolution=$2
        WHERE id=$1
      `, [row.id, resolution, method, Math.round(pnl * 100) / 100, priceAtRes, resolvedAt,
          Math.round(runMae * 100) / 100, Math.round(runMfe * 100) / 100, barCount]);
    }
  }

  console.log('\nOverall tally:', JSON.stringify(tally));
  console.log('\nBy setup_type:');
  for (const [type, t] of Object.entries(byType)) {
    const n = t.TARGET_HIT + t.STOP_HIT + t.TIME_EXPIRED;
    console.log(`  ${type.padEnd(30)} TARGET_HIT=${t.TARGET_HIT} STOP_HIT=${t.STOP_HIT} TIME_EXPIRED=${t.TIME_EXPIRED}  avg_pnl=$${(t.pnlSum / n).toFixed(2)}`);
  }
  console.log(`\n${DRY_RUN ? 'DRY RUN complete, no writes made.' : 'Repair complete.'}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
