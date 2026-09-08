// Repairs historically-contaminated active_setups rows for the 30 SAME_DAY_FORMING setup_types
// (OR5/10/15/30 HIGH/LOW/MID x LONG/SHORT, IB_HIGH/IB_LOW/IB_MID_SCALP x LONG/SHORT) --
// 2026-09-08, user-caught live bug (a dashboard screenshot showing OR10_LOW_FADE_LONG "touched"
// at 9:34am, before the 10-minute opening range that defines it even finishes forming at 9:40am).
//
// Two now-separately-fixed root causes contributed contaminated rows, both confirmed no longer
// reproducible as of this script's writing:
//   1. The early-touch-backfill loop in acd.js (~line 7924) had no formation-gate check at all
//      -- fixed same day (see git log, "Fix formation-gate bug in early-touch backfill"). This
//      produced SHADOW/UNKNOWN/BACKFILL-origin contaminated rows.
//   2. An older bug in how the 5-minute OR (acd_daily_log.or_high/or_low) got computed and
//      cached, since fixed -- both live call sites (server/index.js:213,
//      server/routes/priceBars.js:84) are already correctly gated to wait until 9:35am ET.
//      This produced the 23 ACTIVE-origin (real) contaminated rows, all dated 2026-07-09
//      through 2026-08-25 -- none since, confirming this is historical residue, not an
//      ongoing issue.
//
// Contamination test: for these 30 types, ANY row (any origin_status, any resolution_method --
// resolution_method is NOT a reliable marker since it gets overwritten once a trade resolves)
// whose fired_at ET time-of-day is before that level's own formationGate
// (getLevelFadeDefinition(), server/config/setupDefinitions.js) is physically impossible: the
// bar defining a level's own high/low will always trivially "touch" itself.
//
// Usage:
//   node scripts/repair_same_day_forming_formation_gate_20260908.mjs            # dry run
//   node scripts/repair_same_day_forming_formation_gate_20260908.mjs --apply    # backup + delete

import { query } from '../server/db.js';
import { getLevelFadeDefinition } from '../server/config/setupDefinitions.js';

const APPLY = process.argv.includes('--apply');

const BASES = [
  'OR5_HIGH', 'OR5_LOW', 'OR5_MID',
  'OR10_HIGH', 'OR10_LOW', 'OR10_MID',
  'OR15_HIGH', 'OR15_LOW', 'OR15_MID',
  'OR30_HIGH', 'OR30_LOW', 'OR30_MID',
  'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP',
];

async function main() {
  const typeGates = [];
  for (const base of BASES) {
    const gate = getLevelFadeDefinition(base)?.formationGate;
    if (gate == null) throw new Error(`No formationGate found for ${base} -- aborting, don't guess.`);
    typeGates.push([`${base}_FADE_LONG`, gate], [`${base}_FADE_SHORT`, gate]);
  }

  const contaminated = [];
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} -- scanning ${typeGates.length} setup_types\n`);
  for (const [type, gate] of typeGates) {
    const { rows } = await query(`
      SELECT id, origin_status, resolution, resolution_method, actual_pnl::float as actual_pnl,
        trade_date::text as trade_date, fired_at::text as fired_at
      FROM active_setups
      WHERE setup_type = $1
        AND (EXTRACT(hour FROM fired_at) * 60 + EXTRACT(minute FROM fired_at)) < $2
    `, [type, gate]);
    if (rows.length) {
      console.log(`  ${type.padEnd(25)} formationGate=${gate}  contaminated=${rows.length}`);
      contaminated.push(...rows.map(r => ({ ...r, setup_type: type })));
    }
  }

  const byOrigin = {};
  for (const r of contaminated) byOrigin[r.origin_status] = (byOrigin[r.origin_status] || 0) + 1;
  console.log(`\nTotal contaminated rows: ${contaminated.length}`);
  console.log('By origin_status:', byOrigin);

  if (contaminated.length === 0) {
    console.log('\nNothing to repair.');
    return;
  }

  const ids = contaminated.map(r => r.id);
  const ttQ = await query('SELECT count(*)::int as n FROM trade_timeline_events WHERE setup_id = ANY($1)', [ids]);
  const tfQ = await query('SELECT count(*)::int as n FROM trade_feedback WHERE setup_id = ANY($1)', [ids]);
  const sobQ = await query('SELECT count(*)::int as n FROM setup_outcome_backtest WHERE setup_id = ANY($1)', [ids]);
  console.log(`\nReferencing rows -- trade_timeline_events: ${ttQ.rows[0].n} | trade_feedback: ${tfQ.rows[0].n} | setup_outcome_backtest (ON DELETE CASCADE): ${sobQ.rows[0].n}`);

  if (tfQ.rows[0].n > 0) {
    console.log('\ntrade_feedback rows exist for contaminated setups -- these carry user-authored');
    console.log('coaching notes. ABORTING rather than silently deleting them. Review manually.');
    return;
  }

  if (!APPLY) {
    console.log('\nDry run only -- re-run with --apply to back up and delete.');
    return;
  }

  console.log('\n--- APPLYING ---');

  // Backups first, matching docs/DB_MIGRATION_PROTOCOL.md -- one table per affected table, not
  // just the primary one, since trade_timeline_events rows are about to be deleted too (#2a).
  await query(`
    CREATE TABLE active_setups_formation_gate_repair_backup_20260908 AS
    SELECT * FROM active_setups WHERE id = ANY($1)
  `, [ids]);
  await query(`
    CREATE TABLE trade_timeline_events_formation_gate_repair_backup_20260908 AS
    SELECT * FROM trade_timeline_events WHERE setup_id = ANY($1)
  `, [ids]);
  console.log('Backed up to active_setups_formation_gate_repair_backup_20260908 and trade_timeline_events_formation_gate_repair_backup_20260908');

  const delTt = await query('DELETE FROM trade_timeline_events WHERE setup_id = ANY($1)', [ids]);
  console.log(`Deleted ${delTt.rowCount} trade_timeline_events rows`);

  const delAs = await query('DELETE FROM active_setups WHERE id = ANY($1)', [ids]);
  console.log(`Deleted ${delAs.rowCount} active_setups rows`);

  // Verify
  const check = await query(`
    SELECT count(*)::int as n FROM active_setups WHERE id = ANY($1)
  `, [ids]);
  console.log(`\nVerify: ${check.rows[0].n} contaminated rows remain (expect 0)`);

  console.log('\nDone. Re-run scripts/backtest_setup_status.mjs and scripts/update_optimal_stops.mjs');
  console.log('to recalibrate the 30 affected setup_types against the now-clean sample.');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
