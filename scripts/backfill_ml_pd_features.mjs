// Backfills active_setups.ml_pd_features (added 2026-09-21) -- prior-day reference-level
// distances for the DeepSeek meta-labeling spec's feature snapshot (Section 3). Per this
// codebase's own DB_MIGRATION_PROTOCOL.md: dry-run first (default), --apply to write.
//
// Zero lookahead risk by construction -- every developing_value_log row joined here has
// trade_date STRICTLY BEFORE the candidate's own trade_date, the exact same query shape
// acd.js's own live PD-level reads already use. See mlFeatureSnapshot.js's own header for
// why this is scoped to prior-day-only features tonight, not the full ~35-feature spec.
//
// Population: same REAL_TRADE_FILTER as backfill_ml_extended_label.mjs (real,
// non-BACKFILL trades, individual-level -- see that file's header for the 2026-09-21
// correction from POOLED_TRADE_FILTER) -- these two backfills are independent (different
// columns, no shared state) and can run in either order.
import { query } from '../server/db.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';
import { computePriorDayLevelFeatures } from '../server/services/mlFeatureSnapshot.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  const candidates = await query(`
    SELECT id, trade_date::text AS trade_date, entry_zone_low::float AS entry_zone_low,
      entry_zone_high::float AS entry_zone_high
    FROM active_setups
    WHERE ${REAL_TRADE_FILTER}
      AND ml_pd_features IS NULL
      AND (entry_zone_low IS NOT NULL OR entry_zone_high IS NOT NULL)
    ORDER BY trade_date ASC
  `);

  console.log(`Candidates (real, all individual touches, unlabeled): ${candidates.rows.length}`);

  let written = 0, noPriorDayData = 0;
  const toWrite = [];

  for (const row of candidates.rows) {
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const pdQ = await query(`
      SELECT trade_date::text AS trade_date, poc, vah, val, session_high, session_low,
        session_close, poc_delta_vs_prior, migration_dir_vs_prior, va_overlap_pct_vs_prior
      FROM developing_value_log
      WHERE trade_date < $1::date
      ORDER BY trade_date DESC LIMIT 1
    `, [row.trade_date]);

    const features = computePriorDayLevelFeatures(entry, pdQ.rows[0] ?? null);
    if (!features) { noPriorDayData++; continue; }

    written++;
    toWrite.push({ id: row.id, features });
  }

  console.log(`\nDry-run summary:`);
  console.log(`  Would write:              ${written}`);
  console.log(`  No prior-day data yet:    ${noPriorDayData}`);
  console.log(`  Total candidates:         ${candidates.rows.length}`);
  const accountedFor = written + noPriorDayData;
  console.log(`  Accounted for:            ${accountedFor} (${accountedFor === candidates.rows.length ? 'matches total, OK' : 'MISMATCH -- investigate before --apply'})`);

  if (!APPLY) {
    console.log(`\nDry run only -- pass --apply to write ${toWrite.length} rows.`);
    return;
  }

  console.log(`\nApplying ${toWrite.length} writes...`);
  for (const { id, features } of toWrite) {
    await query(`UPDATE active_setups SET ml_pd_features=$1 WHERE id=$2 AND ml_pd_features IS NULL`, [JSON.stringify(features), id]);
  }
  console.log('Done.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
