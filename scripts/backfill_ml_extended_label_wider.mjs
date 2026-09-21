// Backfills active_setups.ml_extended_label_5x / ml_extended_label_10x (2026-09-21,
// user request: "Can we also test the model on 5x targets and 10x targets as well as the
// 2.5x? Just to see" -- following the diagnosis that the model's HIGH-confidence bucket
// underperforms because a 2.5x-extended-target label doesn't track the real trade's own
// tighter stop well: the model learns "this setup eventually swings big" more than "this
// setup wins on its own real exit," and a bigger swing also means a bigger chance of
// getting stopped out on the way there).
//
// Reuses computeExtendedLabel() (mlExtendedLabelWalker.js) unmodified -- extendedTarget/
// maxHoldBars are already caller-supplied params, so no core change was needed, just wider
// inputs. Same REAL_TRADE_FILTER population, same tie-break/TIME-barrier correctness logic
// as backfill_ml_extended_label.mjs (the 2.5x script, left untouched -- this is exploratory,
// not a change to the production label).
//
// maxHoldBars scaled PROPORTIONALLY to the target multiple (60 bars * mult/2.5) -- a bigger
// target needs more real time to reach; using the SAME 60-bar window for 5x/10x would make
// label=1 nearly impossible regardless of real quality, a degenerate/meaningless test. Bar-
// fetch window scaled the same ratio as the 2.5x script's own 6hr-for-60-bars margin.
//
// Per this codebase's own DB_MIGRATION_PROTOCOL.md: dry-run first (default), --apply to write.
import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';
import { computeExtendedLabel, DEFAULT_MAX_HOLD_BARS } from '../server/services/mlExtendedLabelWalker.js';

const APPLY = process.argv.includes('--apply');
const BASE_MULT = 2.5; // matches mlExtendedLabelWalker.js's EXTENDED_TARGET_MULT

const VARIANTS = [
  { mult: 5, column: 'ml_extended_label_5x' },
  { mult: 10, column: 'ml_extended_label_10x' },
];

async function backfillVariant({ mult, column }) {
  const maxHoldBars = Math.round(DEFAULT_MAX_HOLD_BARS * (mult / BASE_MULT));
  const fetchHours = Math.round(6 * (mult / BASE_MULT)); // same ratio as the 2.5x script's own 6hr-for-60-bars margin

  const candidates = await query(`
    SELECT id, setup_type, fired_at::text AS fired_at, stop_level::float AS stop_level,
      t1_level::float AS t1_level, entry_zone_low::float AS entry_zone_low,
      entry_zone_high::float AS entry_zone_high
    FROM active_setups
    WHERE ${REAL_TRADE_FILTER}
      AND status = 'RESOLVED'
      AND ${column} IS NULL
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND (entry_zone_low IS NOT NULL OR entry_zone_high IS NOT NULL)
    ORDER BY fired_at ASC
  `);

  console.log(`\n=== ${mult}x (maxHoldBars=${maxHoldBars}, fetchWindow=${fetchHours}h) ===`);
  console.log(`Candidates (real, all individual touches, unlabeled for ${column}): ${candidates.rows.length}`);

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
      ? entry + mult * (row.t1_level - entry)
      : entry - mult * (entry - row.t1_level);

    const barsQ = await query(`
      SELECT high::float AS high, low::float AS low, close::float AS close
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1::timestamp AND ts <= $1::timestamp + INTERVAL '${fetchHours} hours' AND ts <= NOW()
      ORDER BY ts ASC
      LIMIT ${maxHoldBars}
    `, [row.fired_at]);

    if (barsQ.rows.length === 0) { noBars++; continue; }

    const result = computeExtendedLabel(barsQ.rows, { entry, stop, extendedTarget, long, maxHoldBars });
    if (!result) { noBars++; continue; }

    if (result.exitReason === 'TIME' && barsQ.rows.length < maxHoldBars) {
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
        extendedTargetMult: mult,
        maxHoldBars,
        computedAt: new Date().toISOString(),
      },
    });
  }

  console.log(`  Would label:              ${labeled} (TARGET=${byExitReason.TARGET}, STOP=${byExitReason.STOP}, TIME=${byExitReason.TIME})`);
  console.log(`  Too recent (skip, retry): ${tooRecent}`);
  console.log(`  Direction unresolvable:   ${directionUnresolvable}`);
  console.log(`  No bars at all:           ${noBars}`);
  const accountedFor = labeled + tooRecent + directionUnresolvable + noBars;
  console.log(`  Accounted for:            ${accountedFor} (${accountedFor === candidates.rows.length ? 'matches total, OK' : 'MISMATCH -- investigate before --apply'})`);

  if (!APPLY) {
    console.log(`  Dry run only -- pass --apply to write ${toWrite.length} rows.`);
    return;
  }
  console.log(`  Applying ${toWrite.length} writes...`);
  for (const { id, payload } of toWrite) {
    await query(`UPDATE active_setups SET ${column}=$1 WHERE id=$2 AND ${column} IS NULL`, [JSON.stringify(payload), id]);
  }
  console.log('  Done.');
}

async function main() {
  for (const variant of VARIANTS) {
    await backfillVariant(variant);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
