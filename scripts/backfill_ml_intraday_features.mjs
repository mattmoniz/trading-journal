// Backfills active_setups.ml_intraday_features (added 2026-09-21, built WITH the user
// watching, not unsupervised -- see docs/OPEN_THREADS.md's 2026-09-21 entry for why this
// half was deliberately held back the night before). Same-session developing POC/VAH/VAL/
// VWAP distances + cumulative delta, per mlFeatureSnapshot.js's computeDevelopingValueFeatures().
//
// THE lookahead-safety boundary lives entirely in this script's own bar query, not in the
// pure function it calls (which has no awareness of "fired_at" at all -- see that
// function's own header). Two explicit bounds enforce it:
//   1. ts < $1::timestamp (fired_at) -- the candidate's own entry bar and everything after
//      it is excluded. Mirrors the extended-label walker's `ts > fired_at` exactly, just
//      the opposite side of the same instant.
//   2. The session-open boundary bar lookup is itself bounded `ts < $1` too (not `<=`), so
//      a trade firing in the FIRST bar of a session correctly gets bars.length===0 (handled
//      as "not enough data yet, leave null") rather than accidentally reaching back into the
//      PRIOR session.
//
// Per this codebase's DB_MIGRATION_PROTOCOL.md: dry-run first (default), --apply to write.
import { query } from '../server/db.js';
import { POOLED_TRADE_FILTER } from './backtest_setup_status.mjs';
import { computeDevelopingValueFeatures } from '../server/services/mlFeatureSnapshot.js';

const APPLY = process.argv.includes('--apply');
const RTH_OPEN_MOD = 570;    // 9:30 ET
const GLOBEX_OPEN_MOD = 1080; // 18:00 ET

async function main() {
  const candidates = await query(`
    SELECT id, fired_at::text AS fired_at, is_rth,
      entry_zone_low::float AS entry_zone_low, entry_zone_high::float AS entry_zone_high
    FROM active_setups
    WHERE ${POOLED_TRADE_FILTER}
      AND ml_intraday_features IS NULL
      AND (entry_zone_low IS NOT NULL OR entry_zone_high IS NOT NULL)
    ORDER BY fired_at ASC
  `);

  console.log(`Candidates (real, pooled, unlabeled): ${candidates.rows.length}`);

  let written = 0, noBarsYet = 0;
  const toWrite = [];

  for (const row of candidates.rows) {
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const boundaryMod = row.is_rth ? RTH_OPEN_MOD : GLOBEX_OPEN_MOD;

    // Session-open boundary bar, strictly before fired_at, bounded to the last 20 hours
    // (same bound as this codebase's own getSessionBarsSinceOpen() -- a session is at most
    // ~15h, so a missing boundary bar correctly yields zero rows rather than silently
    // reaching into a prior session).
    const barsQ = await query(`
      SELECT high::float AS high, low::float AS low, close::float AS close,
        bid_volume::float AS bid_volume, ask_volume::float AS ask_volume
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= (
        SELECT ts FROM price_bars_primary
        WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int = $2
          AND ts < $1::timestamp AND ts >= $1::timestamp - INTERVAL '20 hours'
        ORDER BY ts DESC LIMIT 1
      ) AND ts < $1::timestamp
      ORDER BY ts ASC
    `, [row.fired_at, boundaryMod]);

    const features = computeDevelopingValueFeatures(barsQ.rows, entry);
    if (!features) { noBarsYet++; continue; }

    written++;
    toWrite.push({ id: row.id, features: { ...features, isRth: row.is_rth, boundaryMod } });
  }

  console.log(`\nDry-run summary:`);
  console.log(`  Would write:              ${written}`);
  console.log(`  No bars yet (skip):       ${noBarsYet}`);
  console.log(`  Total candidates:         ${candidates.rows.length}`);
  const accountedFor = written + noBarsYet;
  console.log(`  Accounted for:            ${accountedFor} (${accountedFor === candidates.rows.length ? 'matches total, OK' : 'MISMATCH -- investigate before --apply'})`);

  if (!APPLY) {
    console.log(`\nDry run only -- pass --apply to write ${toWrite.length} rows.`);
    return;
  }

  console.log(`\nApplying ${toWrite.length} writes...`);
  for (const { id, features } of toWrite) {
    await query(`UPDATE active_setups SET ml_intraday_features=$1 WHERE id=$2 AND ml_intraday_features IS NULL`, [JSON.stringify(features), id]);
  }
  console.log('Done.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
