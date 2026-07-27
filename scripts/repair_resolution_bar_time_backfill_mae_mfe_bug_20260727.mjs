// scripts/repair_resolution_bar_time_backfill_mae_mfe_bug_20260727.mjs
// Follow-up to backfill_mae_mfe_new_date_round_trip_bug. That script (still actively
// scheduled in the daily cron until fixed this session) writes resolution_bar_time from
// a raw JS Date object (bar.ts, selected without ::text before the fix) whenever it
// backfills a row's mae_points -- corrupting resolution_bar_time by the same ~4h
// ambient-timezone shift as the resolved_at bug fixed earlier today, but WITHOUT
// touching resolved_at itself (that script never sets that column).
//
// resolveSetupsByPrice() always writes resolved_at and resolution_bar_time from the
// SAME value in one UPDATE (`resolved_at=$6, ..., resolution_bar_time=$6`) -- so for
// any row where they now differ, resolved_at (already independently verified sane --
// always shortly after fired_at) is the trustworthy source, and resolution_bar_time can
// simply be set equal to it. No bar-walk needed -- this is a pure decoupling repair, not
// a re-derivation. Deliberately excludes resolution_method IN ('BACKFILL',
// 'EARLY_TOUCH_BACKFILL') -- that population comes from a different, older, archived
// script with its own separate history, not backfill_mae_mfe.mjs, and needs its own
// investigation rather than being swept into this fix.
import { query } from '../server/db.js';

const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  console.log(DRY_RUN ? '[DRY RUN]' : '[APPLYING FIX]');

  const rows = (await query(`
    SELECT id, setup_type, origin_status, resolution_method,
           fired_at::text as fired_at, resolved_at::text as resolved_at,
           resolution_bar_time::text as resolution_bar_time_old
    FROM active_setups
    WHERE resolved_at IS NOT NULL AND resolution_bar_time IS NOT NULL
      AND resolved_at != resolution_bar_time
      AND resolution_method IS DISTINCT FROM 'BACKFILL'
      AND resolution_method IS DISTINCT FROM 'EARLY_TOUCH_BACKFILL'
    ORDER BY fired_at
  `)).rows;

  console.log(`Rows to fix: ${rows.length}`);
  const byMethod = {};
  for (const r of rows) byMethod[r.resolution_method ?? 'NULL'] = (byMethod[r.resolution_method ?? 'NULL'] || 0) + 1;
  console.log('By resolution_method:', JSON.stringify(byMethod));

  // Sanity gate: resolved_at should always be >= fired_at (already independently verified
  // as the trustworthy column) -- if any row fails this, stop and look rather than trust
  // blindly.
  const badResolvedAt = rows.filter(r => r.resolved_at < r.fired_at);
  if (badResolvedAt.length) {
    console.log(`\n⚠️  ${badResolvedAt.length} rows have resolved_at < fired_at too -- NOT safe to trust as the correction source. Aborting.`);
    console.log(JSON.stringify(badResolvedAt.slice(0, 10), null, 2));
    process.exit(1);
  }
  console.log('✓ All rows have a sane resolved_at (>= fired_at) to correct from.');

  if (DRY_RUN) {
    console.log('\nSample of corrections:');
    for (const r of rows.slice(0, 10)) {
      console.log(`  id=${r.id} ${r.setup_type} [${r.origin_status}/${r.resolution_method}] resolution_bar_time: ${r.resolution_bar_time_old} -> ${r.resolved_at}`);
    }
    console.log('\nDry run only -- no changes made. Re-run with --apply to write.');
    process.exit(0);
  }

  if (rows.length === 0) { console.log('Nothing to fix.'); process.exit(0); }

  const ids = rows.map(r => r.id);
  // is_rth is a GENERATED column -- `SELECT *` includes it, but a plain INSERT can't
  // write to it directly ("cannot insert a non-DEFAULT value into column"). Use an
  // explicit column list (every real column except the generated one) on both sides.
  const colsRes = await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='active_setups' AND is_generated = 'NEVER'
    ORDER BY ordinal_position
  `);
  const cols = colsRes.rows.map(r => `"${r.column_name}"`).join(', ');
  await query(`CREATE TABLE IF NOT EXISTS active_setups_resolution_bar_time_backup_20260727 (LIKE active_setups INCLUDING ALL EXCLUDING GENERATED)`);
  await query(`
    INSERT INTO active_setups_resolution_bar_time_backup_20260727 (${cols})
    SELECT ${cols} FROM active_setups WHERE id = ANY($1)
    ON CONFLICT (id) DO NOTHING
  `, [ids]);
  console.log(`Backed up ${ids.length} rows to active_setups_resolution_bar_time_backup_20260727`);

  await query(`
    UPDATE active_setups SET resolution_bar_time = resolved_at, updated_at = NOW()
    WHERE id = ANY($1)
  `, [ids]);
  console.log(`Corrected ${ids.length} rows (resolution_bar_time = resolved_at).`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
