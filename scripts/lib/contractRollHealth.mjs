// Shared NQ contract-roll health check, extracted 2026-09-15 so it can run both weekly
// (as data_sanity_audit.mjs's check [6], alongside its other checks) and daily (as its own
// standalone script, scripts/check_contract_roll_health.mjs, wired into
// run_daily_calibration.sh) without duplicating the queries.
//
// Built after a real incident: the September quarterly roll produced a wrong
// price_bars_contract_calendar entry that made a real trading day's bars silently vanish
// from price_bars_primary, causing two real STOP_HIT losses against a fictitious price (see
// OPEN_DECISION contract_calendar_roll_race_stale_price_20260915, fixed same day) and
// OPUS_AUDIT_PROMPT_13's strategic review of that fix (scratch/opus_audit_13_results.md).
// data_sanity_audit.mjs's existing gap check ([5]) could NOT have caught this -- its cutoff
// floor (120h) is deliberately calibrated to ignore normal weekend/holiday closures, and a
// single vanished trading day produces a gap of only ~24-48h, structurally below that floor.
//
// Daily cadence matters here specifically -- a roll's real overlap window can span 12+ days
// (confirmed in the September incident), so a WEEKLY-only check could still let several days
// of wrong-calendar corruption accumulate before catching it. The other data_sanity_audit.mjs
// checks (ES-symbol contamination, historical multi-month gaps, MAE/MFE outliers) don't need
// daily granularity and already trip on known, documented, unresolved historical issues --
// running the WHOLE script daily would cause exactly the kind of alert fatigue CLAUDE.md's
// Stop-hook incident already warns against, so this check is standalone, not "run the whole
// audit daily."
//
// The 100/0.10/5 figures below are plumbing parameters for a data-integrity check, not
// trading thresholds -- same deliberate exception this codebase already carries for
// FRESHNESS_MINUTES (priceRetrieval.js) and GLOBEX_REFIRE_MIN_TRADE_DURATION_MINUTES (acd.js).
import { query } from '../../server/db.js';

// Returns { flagged: [{message}], info: [{message}] }. `flagged` entries are real anomalies
// (a caller should treat these as failures); `info` entries (the dual-contract-overlap
// report) are expected/informational during a real roll and should never be counted as
// anomalies on their own.
export async function checkContractRollHealth(symbol = 'NQ', lookbackDays = 45) {
  const flagged = [];
  const info = [];

  // Vanished day: real raw bars exist but almost none survive into price_bars_primary --
  // the exact "vanished day" signature of the incident this check exists to catch.
  const vanished = await query(`
    SELECT r.d::text as d, r.raw_bars, COALESCE(p.prim_bars, 0) as prim_bars
    FROM (SELECT ts::date d, count(*) raw_bars FROM price_bars
          WHERE symbol=$1 AND ts::date >= CURRENT_DATE - $2::int GROUP BY 1) r
    LEFT JOIN (SELECT ts::date d, count(*) prim_bars FROM price_bars_primary
               WHERE symbol=$1 AND ts::date >= CURRENT_DATE - $2::int GROUP BY 1) p USING (d)
    WHERE r.raw_bars > 100 AND COALESCE(p.prim_bars, 0) < r.raw_bars * 0.10
    ORDER BY r.d
  `, [symbol, lookbackDays]);
  for (const row of vanished.rows) {
    flagged.push({ message: `${row.d}: ${row.raw_bars} raw ${symbol} bars exist but only ${row.prim_bars} survive into price_bars_primary -- this date's contract-calendar entry likely points at the wrong contract, silently dropping its real data from every live query` });
  }

  // Calendar disagrees with real volume leader -- the direct precondition of the incident,
  // would fire on day 1 of a real overlap rather than after real losses accumulate.
  const disagree = await query(`
    WITH v AS (
      SELECT symbol, ts::date as d, contract, SUM(volume) as vol,
             ROW_NUMBER() OVER (PARTITION BY symbol, ts::date ORDER BY SUM(volume) DESC) as rn
      FROM price_bars WHERE symbol=$1 AND ts::date >= CURRENT_DATE - $2::int
      GROUP BY 1, 2, 3
    )
    SELECT v.d::text as d, cc.contract as calendar_pick, v.contract as volume_leader, v.vol
    FROM v JOIN price_bars_contract_calendar cc ON cc.symbol = v.symbol AND cc.trade_date = v.d
    WHERE v.rn = 1 AND cc.contract IS DISTINCT FROM v.contract
    ORDER BY v.d
  `, [symbol, lookbackDays]);
  for (const row of disagree.rows) {
    flagged.push({ message: `${row.d}: calendar says ${row.calendar_pick}, but ${row.volume_leader} actually has the most real volume (${row.vol}) -- the calendar is stale/wrong for this date` });
  }

  // Dual-contract overlap report -- informational only, never an anomaly. "A roll is
  // underway" should be a watched, expected event, not a surprise discovered after the fact.
  const overlap = await query(`
    WITH per_contract AS (
      SELECT ts::date as d, contract, SUM(volume) as vol
      FROM price_bars WHERE symbol=$1 AND ts::date >= CURRENT_DATE - $2::int
      GROUP BY 1, 2 HAVING SUM(volume) > 0
    ),
    per_day AS (
      SELECT d, SUM(vol) as day_total FROM per_contract GROUP BY d
    )
    SELECT pc.d::text as d, pc.contract, pc.vol, pc.vol * 100.0 / pd.day_total as pct
    FROM per_contract pc JOIN per_day pd USING (d)
    ORDER BY d DESC, vol DESC
  `, [symbol, lookbackDays]);
  const byDate = {};
  for (const row of overlap.rows) (byDate[row.d] ??= []).push(row);
  for (const [d, rows] of Object.entries(byDate)) {
    const majorContracts = rows.filter(r => Number(r.pct) > 5);
    if (majorContracts.length >= 2) {
      const parts = majorContracts.map(r => `${r.contract}=${Number(r.pct).toFixed(1)}%`).join(', ');
      info.push({ message: `${d}: dual-contract overlap in progress (${parts}) -- expected during a quarterly roll, not itself an anomaly` });
    }
  }

  return { flagged, info };
}
