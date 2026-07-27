// scripts/repair_resolved_at_timezone_bug_20260727.mjs
// ═══════════════════════════════════════════════════════════════════════
// Resolves OPEN_DECISION active_setups_resolved_at_timezone_bug.
//
// ROOT CAUSE, confirmed via git archaeology: resolveSetupsByPrice()'s per-row bars query
// (server/routes/acd.js), present since the very first commit (2026-06-01, c242c24)
// through 2026-07-15 (33179b7, "Fix real render/loading slowness..."), selected
// `SELECT ts, ...` WITHOUT a ::text cast -- node-postgres auto-parsed that TIMESTAMP
// WITHOUT TIME ZONE column into a JS Date object (per server/db.js's own documented
// pg-node quirk: "node-postgres treats it as local time by default, which shifts times
// by the UTC offset"). `resolvedAt = bar.ts` (that Date object) was then passed directly
// as the resolved_at/resolution_bar_time UPDATE parameter (both set from the same $6 in
// one query), corrupting both columns by a consistent ~4-hour shift (matches EDT UTC-4)
// for the ENTIRE 6-week window this bug was live. Confirmed on real rows: resolved_at
// exactly equals resolution_bar_time for every corrupted row, and 37/38
// originally-flagged "impossible" rows (resolved_at < fired_at) cluster tightly at
// 3.7-4.0 hours early -- a systematic offset, not scattered noise. 33179b7 fixed it
// INCIDENTALLY (added ::text as part of an unrelated performance optimization batching
// the bars query) -- nobody realized at the time this also fixed a live timezone bug,
// so the historical damage was never backfilled.
//
// Per the OPEN_DECISION's own prior finding: entry/stop/target levels, price_at_resolution,
// resolution, and actual_pnl are already CORRECT for these rows -- only resolved_at (and
// its coupled twin resolution_bar_time, set from the same corrupted value) is wrong. This
// script therefore does NOT re-derive resolution/price/pnl from scratch (that would
// duplicate already-correct logic and risk a NEW discrepancy from a subtly different
// bar-walk) -- it re-walks bars fresh (safely, ::text throughout) purely to find the
// timestamp of the bar matching the ALREADY-STORED price_at_resolution, and cross-checks
// that the freshly-found resolution type matches the stored one before trusting anything.
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';

const FIX_DEPLOY_TIME = '2026-07-15 14:00:59-04:00'; // commit 33179b7
const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  console.log(DRY_RUN ? '[DRY RUN]' : '[APPLYING FIX]');

  const rows = (await query(`
    SELECT id, setup_type, origin_status, trade_date::text, fired_at::text as fired_at_str,
           resolved_at::text as resolved_at_old, resolution_bar_time::text as resolution_bar_time_old,
           price_at_resolution::float as price_at_resolution_old,
           resolution as resolution_old,
           entry_zone_low::float, entry_zone_high::float, stop_level::float, t1_level::float
    FROM active_setups
    WHERE resolution_method='PRICE_CLEAN'
      AND resolved_at IS NOT NULL
      AND updated_at < $1::timestamptz
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND fired_at IS NOT NULL
    ORDER BY fired_at
  `, [FIX_DEPLOY_TIME])).rows;

  console.log(`Candidates (PRICE_CLEAN, resolved before the 2026-07-15 fix deploy): ${rows.length}`);

  const toFix = [];
  const suspicious = [];
  for (const row of rows) {
    const hi = row.entry_zone_high ?? row.entry_zone_low;
    const entry = (row.entry_zone_low + hi) / 2;
    const direction = directionFromType(row.setup_type);
    const isLong = direction === 'LONG';

    const barsRes = await query(`
      SELECT ts::text as ts, high::float as high, low::float as low, close::float as close
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1::timestamp
      ORDER BY ts LIMIT 500
    `, [row.fired_at_str]);
    const bars = barsRes.rows;
    if (!bars.length) { console.log(`  SKIP id=${row.id}: no bar data`); continue; }

    // Find the FIRST bar whose high/low crosses stop_level or t1_level -- the real,
    // order-aware resolution moment. Same conservative same-bar-stop-first tie-break as
    // resolveSetupsByPrice() itself.
    let found = null;
    for (const b of bars) {
      const t1Hit = isLong ? b.high >= row.t1_level : b.low <= row.t1_level;
      const stopHit = isLong ? b.low <= row.stop_level : b.high >= row.stop_level;
      if (t1Hit && stopHit) { found = { resolution: 'STOP_HIT', price: row.stop_level, ts: b.ts }; break; }
      if (t1Hit) { found = { resolution: 'TARGET_HIT', price: row.t1_level, ts: b.ts }; break; }
      if (stopHit) { found = { resolution: 'STOP_HIT', price: row.stop_level, ts: b.ts }; break; }
    }
    if (!found) { console.log(`  SKIP id=${row.id}: fresh walk found no clean stop/target hit`); continue; }

    // Cross-check against the ALREADY-VALIDATED stored resolution/price before trusting
    // the new resolved_at -- if these don't match, something else is going on and this
    // row needs a human look, not an automatic fix.
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
  const byOrigin = {};
  for (const f of toFix) byOrigin[f.origin_status] = (byOrigin[f.origin_status] || 0) + 1;
  console.log(`By origin_status: ${JSON.stringify(byOrigin)}`);
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

  // Append-only backup, never DROP+recreate -- a first run (origin_status='ACTIVE' only,
  // 38 rows) and this later broadened run (all origin_status, 125 more rows) both target
  // this same table name. An earlier version of this script used DROP TABLE IF EXISTS +
  // CREATE, which silently destroyed the first run's backup snapshot when the second run
  // executed -- caught only because the actual data fix had already been independently
  // verified correct before either write, not because the backup loss itself was noticed
  // in time. CREATE TABLE IF NOT EXISTS + INSERT to no-longer-clobber a prior run's backup.
  const ids = toFix.map(f => f.id);
  await query(`CREATE TABLE IF NOT EXISTS active_setups_resolved_at_tz_bug_backup_20260727 (LIKE active_setups INCLUDING ALL)`);
  await query(`
    INSERT INTO active_setups_resolved_at_tz_bug_backup_20260727
    SELECT * FROM active_setups WHERE id = ANY($1)
    ON CONFLICT (id) DO NOTHING
  `, [ids]);
  console.log(`\nBacked up ${ids.length} rows to active_setups_resolved_at_tz_bug_backup_20260727 (append-only)`);

  for (const f of toFix) {
    await query(`
      UPDATE active_setups SET resolved_at=$2, resolution_bar_time=$2, updated_at=NOW() WHERE id=$1
    `, [f.id, f.new_resolved_at]);
  }
  console.log(`\nCorrected ${toFix.length} rows (resolved_at + resolution_bar_time only -- resolution/price_at_resolution/actual_pnl left untouched, already validated correct).`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
