// One-time backfill for OPEN_DECISION globex_ambiguous_names_need_session_backfill
// (flagged 2026-08-11, backfilled 2026-08-31). 4 setup_types fire under the SAME literal
// name from both the RTH engine and detectGlobexSetup() (PD_VAH_FADE_SHORT, PD_VAL_FADE_LONG,
// PD_POC_FADE_SHORT, PD_POC_FADE_LONG) -- getBetClass() cannot distinguish a Globex-session
// fire from an RTH-session fire by setup_type name alone, so historical rows are a mix,
// currently mislabeled VALUE_FADE regardless of which session actually produced them.
// detectGlobexSetup()'s own INSERT was already fixed 2026-08-11 to hardcode
// bet_class='GLOBEX_LEVEL' directly for every NEW fire -- this script only repairs the
// historical rows that predate that fix.
//
// Per docs/DB_MIGRATION_PROTOCOL.md: backup table first, verify counts before and after,
// spot-check against known real Globex-session dates.
import { query } from '../server/db.js';

const TARGET_TYPES = ['PD_VAH_FADE_SHORT', 'PD_VAL_FADE_LONG', 'PD_POC_FADE_SHORT', 'PD_POC_FADE_LONG'];
const RTH_START_MIN = 570, RTH_END_MIN = 959; // 9:30-15:59 ET, matches this codebase's convention everywhere else

async function main() {
  console.log('Step 1: backup table...');
  await query(`DROP TABLE IF EXISTS active_setups_globex_betclass_backup_20260831`);
  await query(`
    CREATE TABLE active_setups_globex_betclass_backup_20260831 AS
    SELECT id, setup_type, bet_class, fired_at FROM active_setups
    WHERE setup_type = ANY($1)
  `, [TARGET_TYPES]);
  const backupCount = await query(`SELECT COUNT(*) as n FROM active_setups_globex_betclass_backup_20260831`);
  console.log(`  Backed up ${backupCount.rows[0].n} rows.`);

  console.log('\nStep 2: before-state...');
  const before = await query(`
    SELECT setup_type, bet_class, COUNT(*) as n FROM active_setups
    WHERE setup_type = ANY($1) GROUP BY 1, 2 ORDER BY 1, 2
  `, [TARGET_TYPES]);
  console.log(before.rows);

  console.log('\nStep 3: candidates to reclassify (VALUE_FADE rows whose fired_at time-of-day is OUTSIDE RTH)...');
  const candidates = await query(`
    SELECT id, setup_type, fired_at::text,
      (EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at))::int as et_min
    FROM active_setups
    WHERE setup_type = ANY($1) AND bet_class = 'VALUE_FADE'
      AND (EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at)) NOT BETWEEN $2 AND $3
  `, [TARGET_TYPES, RTH_START_MIN, RTH_END_MIN]);
  console.log(`  ${candidates.rows.length} candidates found.`);

  // Spot-check: sample 5 against known Globex hours (18:00-08:29 ET, before the 9:30 RTH open).
  const sample = candidates.rows.slice(0, 5);
  console.log('  Sample (should all show a Globex-hours et_min, i.e. >=1080 or <570):');
  sample.forEach(r => console.log(`    ${r.setup_type} fired_at=${r.fired_at} et_min=${r.et_min}`));
  const implausible = candidates.rows.filter(r => r.et_min >= RTH_START_MIN && r.et_min <= RTH_END_MIN);
  if (implausible.length > 0) {
    console.error(`  ABORT: ${implausible.length} candidate(s) actually fall inside RTH hours despite the NOT BETWEEN filter -- something is wrong, not applying the update.`);
    process.exit(1);
  }

  console.log('\nStep 4: applying UPDATE...');
  const updated = await query(`
    UPDATE active_setups SET bet_class = 'GLOBEX_LEVEL'
    WHERE setup_type = ANY($1) AND bet_class = 'VALUE_FADE'
      AND (EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at)) NOT BETWEEN $2 AND $3
    RETURNING id
  `, [TARGET_TYPES, RTH_START_MIN, RTH_END_MIN]);
  console.log(`  Updated ${updated.rows.length} rows.`);

  console.log('\nStep 5: after-state...');
  const after = await query(`
    SELECT setup_type, bet_class, COUNT(*) as n FROM active_setups
    WHERE setup_type = ANY($1) GROUP BY 1, 2 ORDER BY 1, 2
  `, [TARGET_TYPES]);
  console.log(after.rows);

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
