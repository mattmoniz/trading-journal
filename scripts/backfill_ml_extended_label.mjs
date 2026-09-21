// Backfills active_setups.ml_extended_label (added 2026-09-21, see the ALTER TABLE in
// docs/OPEN_THREADS.md's same-day entry) -- the DeepSeek meta-labeling spec's own
// EXTENDED triple-barrier label, computed by an independent forward replay of
// price_bars_primary past each real trade's own resolution point. Per this codebase's own
// DB_MIGRATION_PROTOCOL.md: dry-run first (default), --apply to actually write.
//
// Population: POOLED_TRADE_FILTER (real, non-BACKFILL, cluster-deduped trades -- reused
// from scripts/backtest_setup_status.mjs per this codebase's own "export the real function"
// rule, not hand-rolled) with a real stop_level/t1_level/entry price. Idempotent --
// only ever touches rows where ml_extended_label IS NULL, safe to re-run daily.
//
// The subtle correctness point this script exists to get right: computeExtendedLabel()
// returning exitReason='TIME' is only a REAL time-barrier result if at least
// DEFAULT_MAX_HOLD_BARS real bars were actually available after fired_at -- if fewer are
// available (the trade fired too recently for a full 60-bar window to have happened yet),
// a naive read of that TIME result would be a false "resolved" label. This script checks
// bars.length >= maxHoldBars before accepting a TIME result; short-of-that rows are left
// NULL and picked up on a later run once more real bars exist. STOP/TARGET hits are always
// accepted regardless of total bar count, since those are genuine early resolutions.
import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { POOLED_TRADE_FILTER } from './backtest_setup_status.mjs';
import { computeExtendedLabel, EXTENDED_TARGET_MULT, DEFAULT_MAX_HOLD_BARS } from '../server/services/mlExtendedLabelWalker.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  const candidates = await query(`
    SELECT id, setup_type, fired_at::text AS fired_at, stop_level::float AS stop_level,
      t1_level::float AS t1_level, entry_zone_low::float AS entry_zone_low,
      entry_zone_high::float AS entry_zone_high
    FROM active_setups
    WHERE ${POOLED_TRADE_FILTER}
      AND status = 'RESOLVED'
      AND ml_extended_label IS NULL
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND (entry_zone_low IS NOT NULL OR entry_zone_high IS NOT NULL)
    ORDER BY fired_at ASC
  `);

  console.log(`Candidates (real, pooled, unlabeled, resolved): ${candidates.rows.length}`);

  let labeled = 0, tooRecent = 0, directionUnresolvable = 0, noBars = 0;
  const byExitReason = { STOP: 0, TARGET: 0, TIME: 0 };
  const toWrite = [];

  for (const row of candidates.rows) {
    const direction = resolveDirection(row);
    if (!direction) { directionUnresolvable++; continue; }
    const long = direction === 'LONG';
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const stop = row.stop_level;
    const extendedTarget = long
      ? entry + EXTENDED_TARGET_MULT * (row.t1_level - entry)
      : entry - EXTENDED_TARGET_MULT * (entry - row.t1_level);

    // Bounded upper end (price_bars_primary convention -- this codebase's own Conventions
    // rule requires an explicit upper bound on any lower-bound-only query against this
    // view). DEFAULT_MAX_HOLD_BARS=60 one-minute bars is at most ~1hr of real market time;
    // 6 hours covers it generously even across a maintenance-window gap or thin-bar stretch.
    const barsQ = await query(`
      SELECT high::float AS high, low::float AS low, close::float AS close
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1::timestamp AND ts <= $1::timestamp + INTERVAL '6 hours' AND ts <= NOW()
      ORDER BY ts ASC
      LIMIT ${DEFAULT_MAX_HOLD_BARS}
    `, [row.fired_at]);

    if (barsQ.rows.length === 0) { noBars++; continue; }

    const result = computeExtendedLabel(barsQ.rows, { entry, stop, extendedTarget, long });
    if (!result) { noBars++; continue; }

    if (result.exitReason === 'TIME' && barsQ.rows.length < DEFAULT_MAX_HOLD_BARS) {
      // Not a real time-barrier result -- ran out of REAL bars, not the intended 60-bar
      // window. Leave NULL, will be picked up once more real time has passed.
      tooRecent++;
      continue;
    }

    labeled++;
    byExitReason[result.exitReason]++;
    toWrite.push({
      id: row.id,
      payload: {
        ...result,
        entry, stop, extendedTarget,
        direction,
        extendedTargetMult: EXTENDED_TARGET_MULT,
        maxHoldBars: DEFAULT_MAX_HOLD_BARS,
        computedAt: new Date().toISOString(),
      },
    });
  }

  console.log(`\nDry-run summary:`);
  console.log(`  Would label:              ${labeled}`);
  console.log(`    exitReason=TARGET:      ${byExitReason.TARGET}`);
  console.log(`    exitReason=STOP:        ${byExitReason.STOP}`);
  console.log(`    exitReason=TIME:        ${byExitReason.TIME}`);
  console.log(`  Too recent (skip, retry): ${tooRecent}`);
  console.log(`  Direction unresolvable:   ${directionUnresolvable}`);
  console.log(`  No bars at all:           ${noBars}`);
  console.log(`  Total candidates:         ${candidates.rows.length}`);
  const accountedFor = labeled + tooRecent + directionUnresolvable + noBars;
  console.log(`  Accounted for:            ${accountedFor} (${accountedFor === candidates.rows.length ? 'matches total, OK' : 'MISMATCH -- investigate before --apply'})`);

  if (!APPLY) {
    console.log(`\nDry run only -- pass --apply to write ${toWrite.length} rows.`);
    return;
  }

  console.log(`\nApplying ${toWrite.length} writes...`);
  for (const { id, payload } of toWrite) {
    await query(`UPDATE active_setups SET ml_extended_label=$1 WHERE id=$2 AND ml_extended_label IS NULL`, [JSON.stringify(payload), id]);
  }
  console.log('Done.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
