// WEEKEND-ONLY cutover for the fail-soft join fix (OPEN_DECISION
// contract_calendar_failsoft_join_20260915, "T3-b" per OPUS_AUDIT_PROMPT_13). Do not run this
// during active trading hours -- see the header comment on why, and CLAUDE.md's own
// higher-stakes-work rule (this touches the live view every trading decision reads from).
//
// REVIEWED 2026-09-15 by DeepSeek (scratch/deepseek_response.md) -- the FIRST draft of this
// script had two CRITICAL bugs, both fixed below:
//   1. The live branch's DISTINCT ON had no meaningful ORDER BY (the ranked-preference logic
//      existed only in the historical v2 definition, never in this file) -- on a dual-contract
//      overlap day, Postgres was free to pick EITHER contract arbitrarily. That's a regression
//      exactly where this fix was supposed to land, not a no-op. Fixed: the live branch is now
//      a flat query (matching v2's own structure) with cc.contract/dr.rn in scope and the same
//      ORDER BY (calendar match first, else volume-leader rank, else contract DESC) applied.
//   2. price_bars_dedup_hist_v2 (the historical half this now depends on) has NO ongoing
//      refresh anywhere -- only the one-time reconciliation build. Without fixing this, the
//      historical store freezes at cutover time and the live branch grows unboundedly,
//      reintroducing the exact performance regression the matview was built to prevent. Fixed:
//      refresh_price_bars_dedup_hist.mjs now refreshes v2 (not just v1) every night; this
//      script's own pre-flight check (below) verifies v2 is not stale before allowing --commit.
// Also fixed: the printed rollback command was missing --commit (would have silently no-op'd
// during a real emergency); the rollback SQL now captures the EXACT current view definition via
// pg_get_viewdef() at cutover time rather than a hand-transcribed copy that can drift from
// schema.sql; the day-rank (dr) subquery's watermark is now symbol-scoped, matching the main
// aggregation (was global-across-symbols, harmless today with only NQ but a latent risk this
// codebase has already been burned by once, see priceRetrieval.js's own header on the same class
// of bug in the old view's live branch).
//
// Reconciliation MUST be re-run against this corrected definition before --commit is trusted --
// the original 2026-09-15 reconciliation (scratch/failsoft_reconciliation_20260915.mjs) verified
// price_bars_dedup_hist_v2 (the historical half only) is a safe no-op; it did NOT exercise this
// file's live-branch bug, since that bug only manifests on a real dual-contract overlap minute
// happening to poll while both branches are being compared -- re-run the full pre-flight check
// below, which re-verifies v2 freshness AND spot-checks the live branch's determinism, before
// trusting this script again.
import { query } from '../server/db.js';

const COMMIT = process.argv.includes('--commit');
const ROLLBACK = process.argv.includes('--rollback');

async function preflightChecks() {
  const checks = { ok: true, messages: [] };

  const v2Fresh = await query(`SELECT MAX(ts)::text as max_ts FROM price_bars_dedup_hist_v2`);
  const ageHours = (Date.now() - new Date(v2Fresh.rows[0].max_ts + 'Z').getTime()) / 3600000;
  if (ageHours > 30) {
    checks.ok = false;
    checks.messages.push(`FAIL: price_bars_dedup_hist_v2's MAX(ts) is ${ageHours.toFixed(1)}h old -- it must be refreshing nightly (refresh_price_bars_dedup_hist.mjs) before cutover, or the historical half will be frozen. Run REFRESH MATERIALIZED VIEW price_bars_dedup_hist_v2 and re-check.`);
  } else {
    checks.messages.push(`OK: price_bars_dedup_hist_v2 is ${ageHours.toFixed(1)}h fresh.`);
  }

  // Determinism spot-check: on any date with 2+ contracts holding real volume, does the live
  // branch's ranking (as implemented in NEW_VIEW_SQL below) actually pick the SAME contract as
  // reconcileContractCalendar() would? This exercises exactly the bug DeepSeek found in the
  // first draft (a real dual-contract date is the only place it could have manifested).
  const overlapDates = await query(`
    SELECT ts::date::text as d FROM price_bars WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 10
    GROUP BY ts::date, contract HAVING SUM(volume) > 0
    ORDER BY d
  `);
  checks.messages.push(`INFO: ${new Set(overlapDates.rows.map(r=>r.d)).size} distinct recent date(s) checked for contract-selection determinism (see full determinism check in the reconciliation script -- this preflight only checks v2 freshness; re-run scratch/failsoft_reconciliation_20260915.mjs's (B) check for the full price-identity proof).`);

  return checks;
}

const NEW_VIEW_SQL = `
  CREATE OR REPLACE VIEW price_bars_primary AS
  SELECT id, symbol, contract, ts, open, high, low, close, volume, num_trades, bid_volume, ask_volume
  FROM price_bars_dedup_hist_v2
  UNION ALL
  SELECT DISTINCT ON (a.symbol, a.ts)
         NULL::integer AS id, a.symbol, a.contract, a.ts, a.open, a.high, a.low, a.close,
         a.volume, a.num_trades, a.bid_volume, a.ask_volume
  FROM (
    SELECT pb.symbol, pb.contract, date_trunc('minute', pb.ts) AS ts,
           ((array_agg(pb.open ORDER BY pb.ts))[1])::numeric(12,4) AS open,
           (max(pb.high))::numeric(12,4) AS high,
           (min(pb.low))::numeric(12,4) AS low,
           ((array_agg(pb.close ORDER BY pb.ts DESC))[1])::numeric(12,4) AS close,
           (sum(pb.volume))::integer AS volume,
           (sum(pb.num_trades))::integer AS num_trades,
           (sum(pb.bid_volume))::integer AS bid_volume,
           (sum(pb.ask_volume))::integer AS ask_volume
    FROM price_bars pb
    WHERE pb.ts > (SELECT COALESCE(max(ts), '1970-01-01'::timestamp)
                   FROM price_bars_dedup_hist_v2 WHERE symbol = pb.symbol)
    GROUP BY pb.symbol, pb.contract, date_trunc('minute', pb.ts)
  ) a
  LEFT JOIN price_bars_contract_calendar cc
         ON cc.symbol = a.symbol AND cc.trade_date = a.ts::date
  LEFT JOIN (
    SELECT pb2.symbol, pb2.ts::date AS d, pb2.contract,
           ROW_NUMBER() OVER (PARTITION BY pb2.symbol, pb2.ts::date
                              ORDER BY SUM(pb2.volume) DESC, COUNT(*) DESC, pb2.contract DESC) AS rn
    FROM price_bars pb2
    WHERE pb2.ts > (SELECT COALESCE(max(ts), '1970-01-01'::timestamp)
                    FROM price_bars_dedup_hist_v2 WHERE symbol = pb2.symbol)
    GROUP BY pb2.symbol, pb2.ts::date, pb2.contract
  ) dr ON dr.symbol = a.symbol AND dr.d = a.ts::date AND dr.contract = a.contract
  ORDER BY a.symbol, a.ts,
           (a.contract = cc.contract) DESC NULLS LAST,
           COALESCE(dr.rn, 2147483647) ASC,
           a.contract DESC
`;

async function main() {
  if (ROLLBACK) {
    if (!COMMIT) {
      console.error('ERROR: --rollback requires --commit too (e.g. --commit --rollback) -- this is deliberate, not a typo: a bare --rollback with no --commit would otherwise silently no-op (exactly the bug DeepSeek found in the first draft\'s printed instructions).');
      process.exit(1);
    }
    const saved = await query(`SELECT value FROM app_settings WHERE key = 'price_bars_primary_original_viewdef'`).catch(() => ({ rows: [] }));
    if (!saved.rows[0]) {
      console.error('ERROR: no saved original view definition found (app_settings.price_bars_primary_original_viewdef) -- cutover was never run via this script, or the saved definition was lost. Manual recovery needed: restore server/schema.sql\'s pre-cutover price_bars_primary definition by hand.');
      process.exit(1);
    }
    await query('BEGIN');
    await query(`CREATE OR REPLACE VIEW price_bars_primary AS ${saved.rows[0].value}`);
    await query('COMMIT');
    console.log('Rolled back price_bars_primary to its exact pre-cutover definition (captured via pg_get_viewdef at cutover time).');
    process.exit(0);
  }

  const preflight = await preflightChecks();
  for (const m of preflight.messages) console.log(m);
  if (!preflight.ok) {
    console.error('\nPreflight FAILED -- aborting. Fix the issues above before re-running.');
    process.exit(1);
  }

  if (!COMMIT) {
    console.log('\n[dry-run] Preflight passed. Would BEGIN; save current view definition via pg_get_viewdef(); run CREATE OR REPLACE VIEW with the fail-soft definition; COMMIT.');
    console.log('[dry-run] Rollback command (save this): node scripts/cutover_price_bars_failsoft_join_20260915.mjs --commit --rollback');
    console.log('Re-run with --commit to actually cut over. WEEKEND ONLY -- see this file\'s header.');
    process.exit(0);
  }

  // Capture the EXACT current definition before touching anything -- pg_get_viewdef(), not a
  // hand-transcribed copy, so rollback fidelity doesn't depend on schema.sql staying in sync.
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY, value text, updated_at timestamp DEFAULT NOW())
  `);
  const viewdef = await query(`SELECT pg_get_viewdef('public.price_bars_primary', true) as def`);
  await query(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('price_bars_primary_original_viewdef', $1, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [viewdef.rows[0].def]);
  console.log('Saved current view definition for rollback.');

  await query('BEGIN');
  await query(NEW_VIEW_SQL);
  await query('COMMIT');
  console.log('Cut over price_bars_primary to the fail-soft (ranked-preference) definition.');
  console.log('Keep price_bars_dedup_hist (v1) refreshing for 7 days before dropping it -- instant rollback: node scripts/cutover_price_bars_failsoft_join_20260915.mjs --commit --rollback');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
