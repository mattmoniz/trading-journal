// One-time repair for OPEN_DECISION eleven_pre_20260720_time_expired_null_pnl_rows.
// 11 real (ACTIVE/SHADOW-origin) active_setups rows, resolution='TIME_EXPIRED',
// resolution_method=NULL, actual_pnl=NULL, dated 2026-07-11 through 2026-07-17 --
// predate the 2026-07-20 TIME_EXPIRED mark-to-market fix and were missed by that day's
// own backfill population query (test_invariants.mjs check [7], added 2026-07-27,
// surfaced them; not caught earlier because that check's 30-day window now excludes
// them, checked directly via SQL instead).
//
// Root cause, confirmed via direct comparison against same-day/same-setup-type
// neighbors that DID resolve correctly: 6 of the 11 (5x IB_HIGH_FADE_SHORT + 1x
// IB_BULLISH, all trade_date=2026-07-17) carry a stale expires_at=13:00 ET SAME DAY --
// earlier than their own fired_at (14:05-15:29 ET). Every neighbor fired before 13:00
// that day correctly got expires_at=13:00 (a real, since-fixed hardcoded 1PM RTH-expiry
// cap), and a neighbor fired at 16:18 that same afternoon already shows the fix live
// (expires_at correctly = next session close) -- the cap bug was fixed intraday on
// 2026-07-17, and these 6 rows fired in the narrow window where the OLD stale cap value
// was still being written but was already in the past relative to fired_at. A naive
// bar-walk using the stored (broken) expires_at as the window's upper bound returns
// zero bars for these 6 (fired_at > expires_at), which is almost certainly why the
// 2026-07-20 backfill's own query skipped them rather than mis-repairing them --
// confirms the decision's own "confirm why they were missed" caveat rather than
// assuming a naive re-run of repair_null_pnl_shadow_setups_20260720.mjs would work.
// Fix: for those 6, use 2026-07-17 16:00 ET (real RTH close, matching every other RTH
// expiry convention in this codebase) as the bar-walk upper bound instead of the stored
// value. The other 5 (PD_POC_FADE_SHORT/PD_VAH_FADE_SHORT) have legitimate expires_at
// values, but turn out to have fired DURING the real weekend CME Globex closure
// (Fri 2026-07-10 ~18:00 ET through Sun 2026-07-12 18:00 ET -- confirmed zero
// price_bars_primary rows for NQ anywhere in that span, a real market closure, not a
// data gap) -- genuinely unrecoverable, marked resolution_method='NO_PRICE_DATA'
// (the established convention, see resolveSetupsByPrice()) rather than fabricated.
//
// Same conservative same-bar-stop-first tie-break and real $2/pt MNQ commission-inclusive
// formula as repair_null_pnl_shadow_setups_20260720.mjs (server/routes/acd.js's
// resolveSetupsByPrice() convention) -- not reimplemented from scratch.
// Backed up first: active_setups_pre20260720_timeexpired_repair_backup_20260819 (11 rows).
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const DRY_RUN = process.argv.includes('--dry-run');

// The 6 rows with a stale/broken expires_at (< fired_at) -- corrected window upper
// bound is real RTH close (16:00 ET) on their own fired-at trade_date.
const BROKEN_EXPIRY_IDS = new Set([59109, 59119, 59121, 59123, 59125, 59127]);

async function main() {
  const rows = (await query(`
    SELECT id, setup_type, trade_date::text as trade_date,
           entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
           stop_level::float as stop_level, t1_level::float as t1_level,
           fired_at::text as fired_at, expires_at::text as expires_at
    FROM active_setups
    WHERE resolution='TIME_EXPIRED' AND resolution_method IS NULL AND actual_pnl IS NULL
      AND trade_date BETWEEN '2026-07-11' AND '2026-07-17'
    ORDER BY fired_at
  `)).rows;

  if (rows.length !== 11) {
    console.error(`Expected exactly 11 rows, found ${rows.length} -- population drifted since this script was written, stopping without writing.`);
    process.exit(1);
  }

  console.log(`Repairing ${rows.length} rows${DRY_RUN ? ' (DRY RUN)' : ''}...`);

  const tally = { TARGET_HIT: 0, STOP_HIT: 0, TIME_EXPIRED: 0, NO_BAR_DATA: 0 };

  for (const row of rows) {
    const long = inferDirection(row.setup_type) === 'LONG';
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const { stop_level: stop, t1_level: t1 } = row;

    // Corrected window upper bound for the 6 broken-expiry rows: real RTH close
    // (16:00 ET) on the row's own trade_date. price_bars_primary.ts is a naive
    // `timestamp without time zone` storing ET WALL-CLOCK directly (confirmed:
    // information_schema + hand-verified raw bar timestamps), same domain as
    // fired_at/expires_at -- a plain ET-naive literal is the correct/only bound here.
    // FIXED 2026-08-19 (caught by DeepSeek code review, independently confirmed): this
    // originally ran the trade_date through etNaiveStringToUtcIso() and fed the
    // resulting UTC ISO instant ("...T20:00:00.000Z") into this same naive-column
    // comparison. Postgres silently coerced it by dropping the trailing Z rather than
    // converting -- '2026-07-17T20:00:00.000Z'::timestamp = '2026-07-17 20:00:00', 4
    // hours past the intended 16:00 close -- so the bug didn't error, it silently
    // widened the window. etNaiveStringToUtcIso() is for producing a UTC instant to
    // store in a genuinely tz-aware context (e.g. Sierra Chart import); it was the
    // wrong tool for bounding a comparison against an already-ET-naive column. Caused
    // one real mis-resolution (id=59127, corrected via a follow-up UPDATE -- see
    // docs/DB_BACKUP_CATALOG.md's 2026-08-19 entry) before being caught.
    let windowEnd = row.expires_at;
    if (BROKEN_EXPIRY_IDS.has(row.id)) {
      windowEnd = `${row.trade_date} 16:00:00`;
      console.log(`  id=${row.id} ${row.setup_type}: broken expires_at=${row.expires_at} -> corrected window end (RTH close)=${windowEnd}`);
    }

    const bars = (await query(`
      SELECT ts::text as ts, high::float as high, low::float as low, close::float as close
      FROM price_bars_primary WHERE symbol='NQ' AND ts > $1 AND ts <= $2
      ORDER BY ts
    `, [row.fired_at, windowEnd])).rows;

    if (bars.length === 0) {
      // The 5 PD_POC_FADE_SHORT/PD_VAH_FADE_SHORT rows fired inside the real weekend CME
      // Globex closure (confirmed: price_bars_primary has zero NQ bars anywhere between
      // Friday ~17:00 ET and Sunday 18:00 ET for this week -- not a data gap, a real
      // closed market) -- genuinely unrecoverable, not a script bug to work around.
      // Per CLAUDE.md's "never guess at genuinely unrecoverable historical data" rule and
      // resolveSetupsByPrice()'s own established NO_PRICE_DATA convention for this exact
      // case, mark resolution_method honestly rather than leaving it null forever;
      // actual_pnl stays null (no fabricated price).
      tally.NO_BAR_DATA++;
      console.log(`  id=${row.id} ${row.setup_type}: NO BAR DATA in window (${row.fired_at} .. ${windowEnd}) -- market closed (weekend), marking NO_PRICE_DATA`);
      if (!DRY_RUN) {
        await query(`
          UPDATE active_setups
          SET resolution_method='NO_PRICE_DATA', updated_at=NOW()
          WHERE id=$1
        `, [row.id]);
      }
      continue;
    }

    let resolution = null, method = null, priceAtRes = null, resolvedAt = null;
    let runMfe = 0, runMae = 0, barCount = 0;
    for (const bar of bars) {
      barCount++;
      const favorable = long ? bar.high - entry : entry - bar.low;
      const adverse   = long ? entry - bar.low  : bar.high - entry;
      runMfe = Math.max(runMfe, favorable);
      runMae = Math.max(runMae, adverse);

      const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (t1Hit && stopHit) {
        resolution = 'STOP_HIT'; method = 'SAME_BAR_STOP_FIRST'; priceAtRes = stop; resolvedAt = bar.ts; break;
      } else if (t1Hit) {
        resolution = 'TARGET_HIT'; method = 'PRICE_CLEAN'; priceAtRes = t1; resolvedAt = bar.ts; break;
      } else if (stopHit) {
        resolution = 'STOP_HIT'; method = 'PRICE_CLEAN'; priceAtRes = stop; resolvedAt = bar.ts; break;
      }
    }
    if (!resolution) {
      const last = bars[bars.length - 1];
      resolution = 'TIME_EXPIRED'; method = 'RECOVERY_MTM'; priceAtRes = last.close; resolvedAt = last.ts;
    }

    const pnl = (long ? (priceAtRes - entry) : (entry - priceAtRes)) * PNL_PER_POINT - COMMISSION;
    tally[resolution] = (tally[resolution] || 0) + 1;
    console.log(`  id=${row.id} ${row.setup_type}: ${resolution} (${method}) pnl=$${pnl.toFixed(2)} bars=${barCount}`);

    if (!DRY_RUN) {
      await query(`
        UPDATE active_setups
        SET resolution=$2, resolution_method=$3, actual_outcome=$2, actual_pnl=$4,
            price_at_resolution=$5, resolved_at=$6, updated_at=NOW(),
            mae_points=$7, mfe_points=$8, bars_to_resolution=$9,
            resolution_bar_time=$6, replay_resolution=$2
        WHERE id=$1
      `, [row.id, resolution, method, Math.round(pnl * 100) / 100, priceAtRes, resolvedAt,
          Math.round(runMae * 100) / 100, Math.round(runMfe * 100) / 100, barCount]);
    }
  }

  console.log('\nOverall tally:', JSON.stringify(tally));
  console.log(`\n${DRY_RUN ? 'DRY RUN complete, no writes made.' : 'Repair complete.'}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
