// scripts/refresh_price_bars_dedup_hist.mjs
// Nightly refresh for price_bars_dedup_hist (see scripts/materialize_price_bars_historical.mjs
// for the full design). Run daily after market close so "today" (now closed) becomes
// eligible for the indexed historical store, keeping the live UNION ALL branch in
// price_bars_primary small regardless of how long ago the last refresh ran.
import { query } from '../server/db.js';
import { reconcileContractCalendar } from '../server/services/priceBarService.js';

// Tier 2 of the 2026-09-15 contract-calendar fix (OPEN_DECISION
// contract_calendar_roll_race_stale_price_20260915), per DeepSeek's own recommendation: the
// matview freezes whatever price_bars_contract_calendar says AT REFRESH TIME, so the real
// invariant to protect is "the calendar is correct right before it gets frozen" -- re-running
// the same guard-free, ingestion-order-independent ranking here (not a separate mechanism)
// closes the gap where the matview and the live branch could otherwise disagree about which
// contract a boundary date belongs to for up to a full day, worst-case during a roll. 45 days
// is deliberately generous -- the real 2026-09 roll showed dual-contract overlap starting at
// least 12 days before the code's own naive roll-week estimate, so a tight window sized to
// "just the roll week" would have missed exactly the case this exists to catch.
const RECONCILE_WINDOW_DAYS = 45;

async function main() {
  const t0 = Date.now();
  const { rows } = await query(`SELECT (CURRENT_DATE - $1::int)::text as from_date, (CURRENT_DATE - 1)::text as to_date`, [RECONCILE_WINDOW_DAYS]);
  await reconcileContractCalendar('NQ', rows[0].from_date, rows[0].to_date);
  console.log(`Reconciled price_bars_contract_calendar for NQ (${rows[0].from_date} to ${rows[0].to_date}) in ${Date.now() - t0}ms`);

  const t1 = Date.now();
  await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY price_bars_dedup_hist`);
  console.log(`Refreshed price_bars_dedup_hist in ${Date.now() - t1}ms`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
