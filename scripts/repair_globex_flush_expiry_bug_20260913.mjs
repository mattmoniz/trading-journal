// Repair for the GLOBEX_FLUSH*/REVERSAL* expires_at off-by-one bug fixed the same day in
// server/services/globexFlushDetector.js (expiresAt was `${departureDay} 09:30:00` with no +1
// day, always landing BEFORE fired_at, so every one of these 7 historical rows resolved as an
// instant flat TIME_EXPIRED/MARK_TO_MARKET (-$2) instead of tracking real overnight price
// action). All 7 rows are SHADOW-origin -- no real capital was ever at risk -- but the wrong
// resolution/actual_pnl would corrupt any future calibration pass that reads this setup family.
//
// Per docs/DB_MIGRATION_PROTOCOL.md: dry-run first (DRY_RUN=1, default), verify, then apply
// (DRY_RUN=0). fired_at and price_bars_primary.ts are both naive local (ET) timestamps in this
// DB -- direct SQL comparison, no JS Date parsing, sidesteps the naive-timestamp bug class
// entirely (per the protocol's own guidance).
import { query } from '../server/db.js';

const DRY_RUN = process.env.DRY_RUN !== '0';

async function main() {
  const rows = (await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at::text as fired_at,
           entry_zone_low::float as entry, stop_level::float as stop, t1_level::float as target
    FROM active_setups WHERE setup_type LIKE 'GLOBEX_FLUSH%' ORDER BY fired_at
  `)).rows;
  console.log(`${rows.length} GLOBEX_FLUSH* rows to repair.\n`);

  for (const r of rows) {
    const isLong = r.setup_type.includes('LONG');
    // Corrected expiry: trade_date + 1 day at 09:30:00 (the fix just shipped).
    const correctedExpiry = `${r.trade_date} 09:30:00`; // will add 1 day via SQL below

    const bars = (await query(`
      SELECT ts::text as ts, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1::timestamp AND ts <= ($2::timestamp + INTERVAL '1 day')
      ORDER BY ts ASC
    `, [r.fired_at, correctedExpiry])).rows;

    let resolution = null, resolutionMethod = null, actualPnl = null, resolvedAt = null;
    for (const b of bars) {
      const hitStop = isLong ? b.low <= r.stop : b.high >= r.stop;
      const hitTarget = isLong ? b.high >= r.target : b.low <= r.target;
      if (hitStop) {
        resolution = 'STOP_HIT'; resolutionMethod = 'PRICE_CLEAN';
        actualPnl = isLong ? -(r.entry - r.stop) * 2 - 2 : -(r.stop - r.entry) * 2 - 2;
        resolvedAt = b.ts; break;
      }
      if (hitTarget) {
        resolution = 'TARGET_HIT'; resolutionMethod = 'PRICE_CLEAN';
        actualPnl = isLong ? (r.target - r.entry) * 2 - 2 : (r.entry - r.target) * 2 - 2;
        resolvedAt = b.ts; break;
      }
    }
    if (resolution == null) {
      // Neither hit within the corrected window -- mark-to-market at the last available bar,
      // matching resolveSetupsByPrice()'s own established convention for this exact situation.
      if (bars.length) {
        const last = bars[bars.length - 1];
        resolution = 'TIME_EXPIRED'; resolutionMethod = 'MARK_TO_MARKET';
        actualPnl = isLong ? (last.close - r.entry) * 2 - 2 : (r.entry - last.close) * 2 - 2;
        resolvedAt = last.ts;
      } else {
        resolution = 'TIME_EXPIRED'; resolutionMethod = 'NO_PRICE_DATA'; actualPnl = null; resolvedAt = null;
      }
    }

    console.log(`id=${r.id} ${r.setup_type} fired=${r.fired_at} entry=${r.entry} stop=${r.stop} target=${r.target}`);
    console.log(`  OLD: resolution=TIME_EXPIRED method=MARK_TO_MARKET actual_pnl=-2 (bug: expired before it started)`);
    console.log(`  NEW: resolution=${resolution} method=${resolutionMethod} actual_pnl=${actualPnl != null ? actualPnl.toFixed(2) : 'null'} resolved_at=${resolvedAt} (${bars.length} real bars checked)`);

    if (!DRY_RUN) {
      await query(`
        UPDATE active_setups SET resolution=$1, resolution_method=$2, actual_pnl=$3, resolved_at=$4, expires_at=($5::timestamp + INTERVAL '1 day')
        WHERE id=$6
      `, [resolution, resolutionMethod, actualPnl, resolvedAt, correctedExpiry, r.id]);
      console.log(`  APPLIED.`);
    }
    console.log('');
  }
  console.log(DRY_RUN ? 'DRY RUN complete -- no rows written. Re-run with DRY_RUN=0 to apply.' : 'All rows repaired.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
