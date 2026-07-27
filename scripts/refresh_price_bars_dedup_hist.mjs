// scripts/refresh_price_bars_dedup_hist.mjs
// Nightly refresh for price_bars_dedup_hist (see scripts/materialize_price_bars_historical.mjs
// for the full design). Run daily after market close so "today" (now closed) becomes
// eligible for the indexed historical store, keeping the live UNION ALL branch in
// price_bars_primary small regardless of how long ago the last refresh ran.
import { query } from '../server/db.js';

async function main() {
  const t0 = Date.now();
  await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY price_bars_dedup_hist`);
  console.log(`Refreshed price_bars_dedup_hist in ${Date.now() - t0}ms`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
