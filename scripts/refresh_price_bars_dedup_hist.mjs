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

  // price_bars_dedup_hist_v2 (the fail-soft historical view, OPEN_DECISION
  // contract_calendar_failsoft_join_20260915 / "T3-b") -- built 2026-09-15, not yet cut over
  // live. FIXED same day per DeepSeek code review (scratch/deepseek_response.md): the migration
  // script's own header used to claim v2 was "refreshed" with no ongoing mechanism actually
  // doing so -- refreshing it here, alongside v1, means it stays ready for the eventual weekend
  // cutover instead of silently going stale. Harmless no-op cost today (v2 isn't read by
  // anything live yet); becomes load-bearing the moment cutover_price_bars_failsoft_join_
  // 20260915.mjs actually runs. Uses `IF EXISTS`-style safety via a catch, not a hard
  // dependency -- if v2 is ever dropped (e.g. after a decision NOT to cut over), this shouldn't
  // break the nightly cron for v1.
  try {
    const t2 = Date.now();
    await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY price_bars_dedup_hist_v2`);
    console.log(`Refreshed price_bars_dedup_hist_v2 in ${Date.now() - t2}ms`);
  } catch (e) {
    console.log(`price_bars_dedup_hist_v2 refresh skipped (${e.message}) -- not yet built or already dropped, not fatal to this cron.`);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
