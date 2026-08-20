// scripts/repair_3_es_era_resolved_at_20260820.mjs
// ═══════════════════════════════════════════════════════════════════════
// Resolves OPEN_DECISION 3_es_contamination_era_resolved_at_impossible_rows.
//
// ROOT CAUSE, confirmed via re-derivation: these 3 rows (ids 21001, 21065, 21083, all
// PD_POC_FADE_SHORT, trade_date 2023-11-17/12-01/12-06) were originally excluded from
// scripts/repair_resolved_at_timezone_bug_20260727.mjs's dry run because their
// updated_at (2026-07-17 05:27:43) postdates that script's FIX_DEPLOY_TIME cutoff
// (2026-07-15 14:00:59) -- but that updated_at bump came from an UNRELATED same-window
// event: commit 78420cd's MAE/MFE ES-symbol-contamination repair (backfill_mae_mfe.mjs),
// which touched updated_at on 371 rows that morning but NEVER writes resolved_at (only
// mae_points/mfe_points/bars_to_resolution/resolution_bar_time/replay_resolution --
// confirmed by reading the script). So the updated_at timing was a red herring; these 3
// rows' resolved_at was actually corrupted by the SAME root cause as the other 163
// (a naive TIMESTAMP-WITHOUT-TIME-ZONE column auto-parsed as a JS Date and shifted by
// the machine's local UTC offset) -- just landing in EST (UTC-5, Nov/Dec, DST already
// ended) instead of the original fix's EDT (UTC-4, summer) months, hence a 5-hour offset
// instead of ~4. Re-walking NQ-symbol-filtered bars (matching this script's own approach,
// same cross-check discipline) found an exact match for all 3: same resolution type
// (STOP_HIT/STOP_HIT/TARGET_HIT) and exact price_at_resolution match, with the found bar
// timestamp exactly 5 hours later than the stored resolved_at in every case.
//
// These 3 dates (2023-11-17/12-01/12-06) sit inside the documented ES-contamination
// window (2023-11-15 to 2023-12-15) where price_bars_primary holds both ES and NQ rows --
// confirmed this script's bar query is symbol='NQ'-filtered throughout, so no ES
// contamination risk here despite the coincidental date overlap with that other bug.
//
// Appends to the SAME backup table the original repair used (append-only, ON CONFLICT DO
// NOTHING -- same convention, this is the same conceptual bug/fix, just 3 rows the
// original WHERE clause missed).
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';

const DRY_RUN = !process.argv.includes('--apply');
const TARGET_IDS = [21001, 21065, 21083];

async function main() {
  console.log(DRY_RUN ? '[DRY RUN]' : '[APPLYING FIX]');

  const rows = (await query(`
    SELECT id, setup_type, origin_status, trade_date::text, fired_at::text as fired_at_str,
           resolved_at::text as resolved_at_old, resolution_bar_time::text as resolution_bar_time_old,
           price_at_resolution::float as price_at_resolution_old,
           resolution as resolution_old,
           entry_zone_low::float, entry_zone_high::float, stop_level::float, t1_level::float
    FROM active_setups
    WHERE id = ANY($1)
    ORDER BY id
  `, [TARGET_IDS])).rows;

  console.log(`Candidates: ${rows.length}`);

  const toFix = [];
  const suspicious = [];
  for (const row of rows) {
    const direction = directionFromType(row.setup_type);
    const isLong = direction === 'LONG';

    const barsRes = await query(`
      SELECT ts::text as ts, high::float as high, low::float as low, close::float as close
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1::timestamp
      ORDER BY ts LIMIT 500
    `, [row.fired_at_str]);
    const bars = barsRes.rows;

    let found = null;
    for (const b of bars) {
      const t1Hit = isLong ? b.high >= row.t1_level : b.low <= row.t1_level;
      const stopHit = isLong ? b.low <= row.stop_level : b.high >= row.stop_level;
      if (t1Hit && stopHit) { found = { resolution: 'STOP_HIT', price: row.stop_level, ts: b.ts }; break; }
      if (t1Hit) { found = { resolution: 'TARGET_HIT', price: row.t1_level, ts: b.ts }; break; }
      if (stopHit) { found = { resolution: 'STOP_HIT', price: row.stop_level, ts: b.ts }; break; }
    }
    if (!found) { console.log(`  SKIP id=${row.id}: fresh walk found no clean stop/target hit`); continue; }

    const resolutionMatches = found.resolution === row.resolution_old;
    const priceMatches = Math.abs(found.price - (row.price_at_resolution_old ?? NaN)) < 0.01;
    if (!resolutionMatches || !priceMatches) {
      suspicious.push({ id: row.id, setup_type: row.setup_type, stored: { resolution: row.resolution_old, price: row.price_at_resolution_old }, fresh: found });
      continue;
    }

    if (found.ts === row.resolved_at_old) continue; // already correct, nothing to do

    toFix.push({ id: row.id, setup_type: row.setup_type, origin_status: row.origin_status, fired_at: row.fired_at_str, old_resolved_at: row.resolved_at_old, new_resolved_at: found.ts });
  }

  console.log(`\nRows needing resolved_at correction: ${toFix.length}`);
  for (const f of toFix) console.log(`  id=${f.id} ${f.setup_type} [${f.origin_status}] fired=${f.fired_at} OLD resolved_at=${f.old_resolved_at} -> NEW resolved_at=${f.new_resolved_at}`);

  if (suspicious.length) {
    console.log(`\n⚠️  ${suspicious.length} rows where fresh resolution/price does NOT match stored -- left untouched, needs a human look:`);
    for (const s of suspicious) console.log(`  id=${s.id} ${s.setup_type} stored=${JSON.stringify(s.stored)} fresh=${JSON.stringify(s.fresh)}`);
  }

  if (DRY_RUN) {
    console.log('\nDry run only -- no changes made. Re-run with --apply to write.');
    process.exit(0);
  }

  if (toFix.length === 0) { console.log('\nNothing to fix.'); process.exit(0); }

  const ids = toFix.map(f => f.id);
  await query(`CREATE TABLE IF NOT EXISTS active_setups_resolved_at_tz_bug_backup_20260727 (LIKE active_setups INCLUDING ALL)`);
  // Found 2026-08-20: this backup table (already existed from the 2026-07-27 repair) has
  // NO primary key or unique constraint at all despite `LIKE active_setups INCLUDING ALL`
  // -- likely lost across the DROP+CREATE-then-fixed-to-CREATE-IF-NOT-EXISTS history this
  // script's own header describes. All 125 existing ids are genuinely distinct (verified
  // before this fix), so adding the PK now is safe and closes a real integrity gap rather
  // than working around it with a NOT EXISTS check.
  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'active_setups_resolved_at_tz_bug_backup_20260727'::regclass AND contype = 'p') THEN
        ALTER TABLE active_setups_resolved_at_tz_bug_backup_20260727 ADD PRIMARY KEY (id);
      END IF;
    END $$;
  `);
  // Schema drift fix (2026-08-20): the backup table was snapshotted 2026-07-27 and
  // active_setups has gained columns since (confluence tracking, regime tagging, bar6
  // checkpoint, size-factor fields, etc.) -- a bare `SELECT *` now has more columns than
  // the frozen backup table accepts. Insert only the column intersection explicitly.
  const colsRes = await query(`
    SELECT a.column_name FROM information_schema.columns a
    JOIN information_schema.columns b ON a.column_name = b.column_name
    WHERE a.table_name = 'active_setups' AND b.table_name = 'active_setups_resolved_at_tz_bug_backup_20260727'
    ORDER BY a.ordinal_position
  `);
  const colList = colsRes.rows.map(r => `"${r.column_name}"`).join(', ');
  await query(`
    INSERT INTO active_setups_resolved_at_tz_bug_backup_20260727 (${colList})
    SELECT ${colList} FROM active_setups WHERE id = ANY($1)
    ON CONFLICT (id) DO NOTHING
  `, [ids]);
  console.log(`\nBacked up ${ids.length} rows to active_setups_resolved_at_tz_bug_backup_20260727 (append-only, same table as the original 2026-07-27 repair)`);

  for (const f of toFix) {
    await query(`
      UPDATE active_setups SET resolved_at=$2, resolution_bar_time=$2, updated_at=NOW() WHERE id=$1
    `, [f.id, f.new_resolved_at]);
  }
  console.log(`\nCorrected ${toFix.length} rows (resolved_at + resolution_bar_time only -- resolution/price_at_resolution/actual_pnl left untouched, already validated correct).`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
