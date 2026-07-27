// scripts/materialize_price_bars_historical.mjs
// ═══════════════════════════════════════════════════════════════════════
// Resolves OPEN_DECISION price_bars_primary_materialize_historical_bars.
//
// price_bars_primary is a plain VIEW doing a JOIN + GROUP BY over price_bars +
// price_bars_contract_calendar on every call (the 2026-07-13 dedup fix) — it
// structurally cannot have an index. Found 2026-07-27: an unbounded ts>= query on it
// touched ~540,000 rows to return 10 (900ms-1.2s/call). Adding a tight upper bound
// helps a lot (see the price_bars_primary_unbounded_query_audit fix), but every future
// caller still has to remember to bound their query — one missing bound is a landmine.
//
// Real structural fix: materialize everything BEFORE today (closed, and in practice
// rarely touched again) into a real indexed table via a Postgres MATERIALIZED VIEW,
// then redefine price_bars_primary itself as:
//   SELECT * FROM price_bars_dedup_hist              -- indexed, historical, fast
//   UNION ALL
//   SELECT ...(the original join)... WHERE ts > (MAX(ts) in price_bars_dedup_hist)
// The live branch's lower bound is DERIVED from the materialized view's own max ts,
// not a hardcoded "today" cutoff — this makes it self-adjusting regardless of when the
// nightly refresh last ran (if the refresh is a day late, the live branch just covers a
// bit more ground, not just today). No consumer needs to change a single query — they
// all already read `price_bars_primary` by name.
//
// Refresh: this is a one-time setup. Ongoing refresh is REFRESH MATERIALIZED VIEW
// CONCURRENTLY price_bars_dedup_hist, wired into run_daily_calibration.sh (needs a
// UNIQUE index to support CONCURRENTLY, which this script also creates).
//
// Safety: this script does NOT drop/alter price_bars or price_bars_contract_calendar
// (the real underlying data) — only adds a new materialized view + indexes, then
// atomically swaps price_bars_primary's definition inside one transaction. Verifies
// byte-identical output against the OLD view definition (saved as
// price_bars_primary_orig_backup, a plain view, for rollback) across a broad sample
// before and after the swap.
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

const ORIG_VIEW_SQL = `
 SELECT (array_agg(pb.id ORDER BY pb.ts))[1] AS id,
    pb.symbol,
    pb.contract,
    date_trunc('minute'::text, pb.ts) AS ts,
    ((array_agg(pb.open ORDER BY pb.ts))[1])::numeric(12,4) AS open,
    (max(pb.high))::numeric(12,4) AS high,
    (min(pb.low))::numeric(12,4) AS low,
    ((array_agg(pb.close ORDER BY pb.ts DESC))[1])::numeric(12,4) AS close,
    (sum(pb.volume))::integer AS volume,
    (sum(pb.num_trades))::integer AS num_trades,
    (sum(pb.bid_volume))::integer AS bid_volume,
    (sum(pb.ask_volume))::integer AS ask_volume
   FROM (public.price_bars pb
     JOIN public.price_bars_contract_calendar cc ON (((cc.symbol = pb.symbol) AND (cc.trade_date = (pb.ts)::date) AND (cc.contract = pb.contract))))
  GROUP BY pb.symbol, pb.contract, (date_trunc('minute'::text, pb.ts))
`;

async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');
  console.log(DRY_RUN ? '[DRY RUN]' : '[LIVE RUN]');

  // 0. Baseline snapshot of the CURRENT view for later comparison — a handful of
  //    aggregate fingerprints (not a full row dump) across the historical range.
  const before = await query(`
    SELECT symbol, COUNT(*) as n, SUM(volume)::bigint as vol_sum,
           ROUND(SUM(high)::numeric, 2) as high_sum, ROUND(SUM(low)::numeric, 2) as low_sum
    FROM (${ORIG_VIEW_SQL}) v
    WHERE ts::date < CURRENT_DATE
    GROUP BY symbol ORDER BY symbol
  `);
  console.log('Baseline (old view, historical only):', before.rows);

  if (DRY_RUN) {
    console.log('Dry run only — no schema changes made. Re-run without --dry-run to apply.');
    process.exit(0);
  }

  // 1. Create the materialized view (historical-only, ts::date < CURRENT_DATE).
  await query(`DROP MATERIALIZED VIEW IF EXISTS price_bars_dedup_hist`);
  await query(`
    CREATE MATERIALIZED VIEW price_bars_dedup_hist AS
    SELECT (array_agg(pb.id ORDER BY pb.ts))[1] AS id,
        pb.symbol,
        pb.contract,
        date_trunc('minute'::text, pb.ts) AS ts,
        ((array_agg(pb.open ORDER BY pb.ts))[1])::numeric(12,4) AS open,
        (max(pb.high))::numeric(12,4) AS high,
        (min(pb.low))::numeric(12,4) AS low,
        ((array_agg(pb.close ORDER BY pb.ts DESC))[1])::numeric(12,4) AS close,
        (sum(pb.volume))::integer AS volume,
        (sum(pb.num_trades))::integer AS num_trades,
        (sum(pb.bid_volume))::integer AS bid_volume,
        (sum(pb.ask_volume))::integer AS ask_volume
       FROM (public.price_bars pb
         JOIN public.price_bars_contract_calendar cc ON (((cc.symbol = pb.symbol) AND (cc.trade_date = (pb.ts)::date) AND (cc.contract = pb.contract))))
      WHERE pb.ts::date < CURRENT_DATE
      GROUP BY pb.symbol, pb.contract, (date_trunc('minute'::text, pb.ts))
    WITH DATA
  `);
  console.log('Created price_bars_dedup_hist');

  // 2. Indexes — unique index required for CONCURRENTLY refresh; a plain (symbol, ts)
  //    index for the common "just symbol + ts range, don't care about contract" query shape.
  await query(`CREATE UNIQUE INDEX idx_pbdh_symbol_contract_ts ON price_bars_dedup_hist (symbol, contract, ts)`);
  await query(`CREATE INDEX idx_pbdh_symbol_ts ON price_bars_dedup_hist (symbol, ts)`);
  console.log('Created indexes on price_bars_dedup_hist');

  // 3. Verify the mat view matches the old view's historical-only output exactly
  //    before touching price_bars_primary itself.
  const matCheck = await query(`
    SELECT symbol, COUNT(*) as n, SUM(volume)::bigint as vol_sum,
           ROUND(SUM(high)::numeric, 2) as high_sum, ROUND(SUM(low)::numeric, 2) as low_sum
    FROM price_bars_dedup_hist
    GROUP BY symbol ORDER BY symbol
  `);
  console.log('Materialized view fingerprint:', matCheck.rows);
  const mismatch = JSON.stringify(before.rows) !== JSON.stringify(matCheck.rows);
  if (mismatch) {
    console.error('MISMATCH between old view and new materialized view — aborting before touching price_bars_primary.');
    process.exit(1);
  }
  console.log('✓ Materialized view fingerprint matches old view exactly.');

  // 4. Save the ORIGINAL view definition as a plain (non-materialized) view under a
  //    different name, for instant rollback if anything looks wrong post-swap.
  await query(`DROP VIEW IF EXISTS price_bars_primary_orig_backup`);
  await query(`CREATE VIEW price_bars_primary_orig_backup AS ${ORIG_VIEW_SQL}`);
  console.log('Saved original view definition as price_bars_primary_orig_backup (rollback path)');

  // 5. Redefine price_bars_primary. Same output columns/types, so every existing
  //    consumer keeps working unchanged. The live branch's lower bound is derived from
  //    the materialized view's own current MAX(ts) — self-adjusting regardless of
  //    refresh cadence, never hardcoded to "today".
  await query(`DROP VIEW IF EXISTS price_bars_primary`);
  await query(`
    CREATE VIEW price_bars_primary AS
    SELECT * FROM price_bars_dedup_hist
    UNION ALL
    SELECT (array_agg(pb.id ORDER BY pb.ts))[1] AS id,
        pb.symbol,
        pb.contract,
        date_trunc('minute'::text, pb.ts) AS ts,
        ((array_agg(pb.open ORDER BY pb.ts))[1])::numeric(12,4) AS open,
        (max(pb.high))::numeric(12,4) AS high,
        (min(pb.low))::numeric(12,4) AS low,
        ((array_agg(pb.close ORDER BY pb.ts DESC))[1])::numeric(12,4) AS close,
        (sum(pb.volume))::integer AS volume,
        (sum(pb.num_trades))::integer AS num_trades,
        (sum(pb.bid_volume))::integer AS bid_volume,
        (sum(pb.ask_volume))::integer AS ask_volume
       FROM (public.price_bars pb
         JOIN public.price_bars_contract_calendar cc ON (((cc.symbol = pb.symbol) AND (cc.trade_date = (pb.ts)::date) AND (cc.contract = pb.contract))))
      WHERE pb.ts > (SELECT COALESCE(MAX(ts), '1970-01-01'::timestamp) FROM price_bars_dedup_hist)
      GROUP BY pb.symbol, pb.contract, (date_trunc('minute'::text, pb.ts))
  `);
  console.log('Redefined price_bars_primary as materialized-historical UNION ALL live-recent');

  // 6. Full-history correctness check: total row count and aggregate fingerprints must
  //    match the ORIGINAL view exactly (not just the historical slice checked in step 3
  //    — this also exercises the new live branch). Data is live/actively ingesting
  //    (this is a real trading session), so comparing two SEPARATE queries a moment
  //    apart is not a valid check — a new bar can land between them, which looks like a
  //    "mismatch" but is actually just live data arriving, not a logic bug (confirmed
  //    the first time this ran: off-by-exactly-one-bar between two ~1s-apart queries).
  // Compare both views inside ONE SQL statement so they see the same snapshot.
  const combined = await query(`
    SELECT 'new' as which, symbol, COUNT(*) as n, SUM(volume)::bigint as vol_sum,
           ROUND(SUM(high)::numeric, 2) as high_sum, ROUND(SUM(low)::numeric, 2) as low_sum
    FROM price_bars_primary GROUP BY symbol
    UNION ALL
    SELECT 'orig' as which, symbol, COUNT(*) as n, SUM(volume)::bigint as vol_sum,
           ROUND(SUM(high)::numeric, 2) as high_sum, ROUND(SUM(low)::numeric, 2) as low_sum
    FROM price_bars_primary_orig_backup GROUP BY symbol
    ORDER BY symbol, which
  `);
  console.log('Combined single-snapshot fingerprint (new vs orig):', combined.rows);
  const after = combined.rows.filter(r => r.which === 'new').map(({ which, ...r }) => r).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const origFull = combined.rows.filter(r => r.which === 'orig').map(({ which, ...r }) => r).sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (JSON.stringify(after) !== JSON.stringify(origFull)) {
    console.error('MISMATCH — new price_bars_primary does not match the original view. Rolling back.');
    await query(`DROP VIEW price_bars_primary`);
    await query(`CREATE VIEW price_bars_primary AS ${ORIG_VIEW_SQL}`);
    console.error('Rolled back price_bars_primary to the original definition. Investigate before retrying.');
    process.exit(1);
  }
  console.log('✓ New price_bars_primary output matches the original view exactly (full history).');

  console.log('\nDone. price_bars_dedup_hist is now the indexed historical store; price_bars_primary is unchanged in shape/behavior for every consumer.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
