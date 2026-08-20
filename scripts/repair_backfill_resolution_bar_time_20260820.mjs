// scripts/repair_backfill_resolution_bar_time_20260820.mjs
// ═══════════════════════════════════════════════════════════════════════
// Resolves OPEN_DECISION backfill_origin_resolution_bar_time_mismatch_8837_rows.
//
// POPULATION: 6,044 active_setups rows (resolution_method IN ('BACKFILL',
// 'EARLY_TOUCH_BACKFILL'), all origin_status='BACKFILL' -- synthetic historical
// backfill data, not real trades) where resolved_at != resolution_bar_time. Written by
// the older, archived scripts/archive/backfill_level_fades.js and its repair_*.mjs
// descendants from 2026-07-14 -- a completely different, earlier code path than
// backfill_mae_mfe.mjs (the current pipeline), never previously audited for this bug.
//
// ROOT CAUSE, verified this session (2026-08-20) across the FULL population before
// trusting resolved_at over resolution_bar_time, not assumed:
//   - resolved_at is >= fired_at for ALL 6,044 rows (zero violations) -- plausible.
//   - resolution_bar_time is < fired_at for 5,990/6,044 (99.1%) -- implausible on its own.
//   - The offset (resolved_at - resolution_bar_time) clusters overwhelmingly at exactly
//     4.0 or 5.0 hours (5,062/6,044), the EXACT same EDT/EST naive-Date-object timezone
//     shift signature as the already-fixed 2026-07-27 bug (repair_resolved_at_timezone_bug
//     _20260727.mjs) and the 2026-08-20 3-ES-row fix -- just a different source column
//     corrupted by the same underlying bug class in this older archived script.
//   - A further 74 rows show offset 5.17-5.22h -- checked individually, these are FAST
//     resolutions (resolved within minutes of firing) where resolution_bar_time =
//     fired_at - 5h exactly (not resolved_at - 5h) -- same bug, applied to a
//     near-identical source bar in the old script's fast-resolution branch.
//   - 3 rows (ids 18554/18555/18556) are resolution='SESSION_CLOSED' with sub-second
//     resolved_at precision (a real NOW()-based force-close timestamp, not a bar-derived
//     one) -- resolved_at is trustworthy here for a different, simpler reason.
//   - Independent cross-check: bars_to_resolution (written by a separate mechanism) is
//     within 2 minutes of (resolved_at - fired_at) for 5,144/6,044 (85%) -- corroborates
//     resolved_at's accuracy without relying on the offset pattern alone.
//   - Duration (resolved_at - fired_at) across the population: min 1min, max ~24.4h (the
//     3 SESSION_CLOSED rows), avg 30.2min -- all plausible for an intraday fade.
//
// SCOPE WIDENED during verification: the original decision's own count (8,837, now 6,044)
// used a bare `!=` comparison, which silently drops any row where EITHER side is NULL (SQL
// NULL semantics). Using IS DISTINCT FROM instead surfaces 3 real buckets:
//   - 6,044 both populated, differing -- the originally-scoped population, verified above.
//   - 6,597 resolution_bar_time NULL, resolved_at populated (resolution TARGET_HIT/STOP_HIT)
//     -- same underlying defect (resolution_bar_time never populated by the old archived
//     script), resolved_at independently verified reliable (0 implausible, duration 1-1286
//     min, all plausible) -- folded into this fix.
//   - 329 resolution_bar_time populated, resolved_at NULL, ALL resolution='TIME_EXPIRED' with
//     actual_pnl=0 -- a DIFFERENT, older situation (a $0-pnl TIME_EXPIRED artifact, adjacent
//     to but distinct from this bug), where resolution_bar_time itself may ALSO be corrupted
//     (spot-checked: 3/5 sampled rows show resolution_bar_time < fired_at, the same
//     implausibility signature) -- EXCLUDED from this fix, flagged separately as
//     backfill_time_expired_null_resolved_at_329_rows rather than blindly resolved here.
//   - 249 both NULL -- correctly excluded by IS DISTINCT FROM's NULL-vs-NULL semantics,
//     nothing to fix (never resolved / no price data, consistent with other documented
//     null-is-deliberate cases elsewhere in this table).
//
// FIX: resolution_bar_time = resolved_at for the 6,044 + 6,597 = 12,641 rows where
// resolved_at is populated and independently verified reliable -- matches this codebase's
// own current-pipeline convention that these two columns carry the identical value (see
// backfill_mae_mfe.mjs / repair_resolved_at_timezone_bug_20260727.mjs, both set resolved_at
// and resolution_bar_time from the same value). Does NOT touch resolution/price_at_resolution
// /actual_pnl -- unrelated to this bug, already correct. Pure TIMESTAMP-to-TIMESTAMP SQL, no
// JS-side date parsing (sidesteps the whole naive-timestamp bug class per
// docs/DB_MIGRATION_PROTOCOL.md).
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

const DRY_RUN = !process.argv.includes('--apply');
const WHERE_CLAUSE = `resolution_method IN ('BACKFILL','EARLY_TOUCH_BACKFILL') AND resolved_at IS NOT NULL AND resolved_at IS DISTINCT FROM resolution_bar_time`;

async function main() {
  console.log(DRY_RUN ? '[DRY RUN]' : '[APPLYING FIX]');

  const countRes = await query(`SELECT COUNT(*) FROM active_setups WHERE ${WHERE_CLAUSE}`);
  const total = parseInt(countRes.rows[0].count);
  console.log(`Rows to fix: ${total}`);

  if (total === 0) { console.log('Nothing to do.'); process.exit(0); }

  if (DRY_RUN) {
    console.log('\nDry run only -- no changes made. Re-run with --apply to write.');
    process.exit(0);
  }

  await query(`
    CREATE TABLE IF NOT EXISTS active_setups_backfill_resolution_bar_time_backup_20260820 (LIKE active_setups INCLUDING ALL)
  `);
  // active_setups has a generated column (is_rth) -- LIKE ... INCLUDING ALL copies its
  // definition into the backup table, but a bare `SELECT * / INSERT` then tries to write
  // an explicit value into it, which Postgres rejects. Exclude generated columns explicitly.
  const colsRes = await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'active_setups' AND is_generated = 'NEVER'
    ORDER BY ordinal_position
  `);
  const colList = colsRes.rows.map(r => `"${r.column_name}"`).join(', ');
  await query(`
    INSERT INTO active_setups_backfill_resolution_bar_time_backup_20260820 (${colList})
    SELECT ${colList} FROM active_setups WHERE ${WHERE_CLAUSE}
    ON CONFLICT (id) DO NOTHING
  `);
  const backupCount = (await query(`SELECT COUNT(*) FROM active_setups_backfill_resolution_bar_time_backup_20260820`)).rows[0].count;
  console.log(`Backed up (table now has ${backupCount} rows total).`);

  const updRes = await query(`
    UPDATE active_setups SET resolution_bar_time = resolved_at, updated_at = NOW()
    WHERE ${WHERE_CLAUSE}
  `);
  console.log(`Updated ${updRes.rowCount} rows.`);

  const verifyRes = await query(`SELECT COUNT(*) FROM active_setups WHERE ${WHERE_CLAUSE}`);
  console.log(`Remaining mismatches: ${verifyRes.rows[0].count} (expect 0)`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
