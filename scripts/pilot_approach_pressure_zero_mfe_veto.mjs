// Pilot: does against-direction order-flow pressure while price APPROACHES a level predict
// a "dead on arrival" trade (zero MFE — never moves favorably before resolving)?
// User's hypothesis (2026-08-24): price grinding down into a LONG support level under real
// selling pressure may signal the level is about to break, not hold.
//
// FIXED 2026-08-24: the first version of this script computed MFE itself via an unbounded
// bar walk (up to 500 bars, no session cutoff), which let trades "resolve" using price
// action from well after 4PM RTH close or even the next day -- time the live system never
// actually gave them (resolveSetupsByPrice() cuts RTH trades off at session end). That
// undercounted the real zero-MFE rate by roughly half (5.1% vs the correct 10.9%) -- caught
// because the user's own direct daily observation (1-3 zero-MFE trades/day) didn't match.
// Now reads the STORED mfe_points column (scripts/backfill_mae_mfe.mjs's own RTH-bounded,
// same-day replay -- the single source of truth every other script in this codebase uses),
// instead of re-deriving MFE itself. Still computes the against-direction pressure signal
// live (that part had no session-boundary bug).
import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { computeDirImbalance } from '../server/services/entryPressureService.js';

const APPROACH_BARS = 5; // same window as the existing buyersAtLevel/sellersAtLevel factor

async function main() {
  const tradesRes = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level, actual_pnl::float as actual_pnl,
      resolution, mfe_points::float as mfe_points
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT', 'STOP_HIT') AND origin_status IN ('ACTIVE','SHADOW')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND fired_at IS NOT NULL AND mfe_points IS NOT NULL
      AND setup_type NOT LIKE '%VWAP%' AND setup_type NOT LIKE '%GLOBEX%'
      AND setup_type NOT LIKE '%OVERNIGHT%' AND setup_type LIKE '%FADE%'
    ORDER BY fired_at ASC
  `);
  console.log(`Loaded ${tradesRes.rows.length} candidate real level-fade trades with real mfe_points.`);

  const barsRes = await query(`
    SELECT ts, extract(epoch from ts)*1000 as ts_ms,
      COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;
  console.log(`Loaded ${allBars.length} bars.`);

  function idxAtOrAfter(ms) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo+hi)>>1; if (allBars[mid].ts_ms < ms) lo = mid+1; else hi = mid; }
    return lo;
  }

  const enriched = [];
  for (const t of tradesRes.rows) {
    const direction = resolveDirection(t);
    if (direction == null) continue;
    const isLong = direction === 'LONG';
    const firedMs = new Date(t.fired_at).getTime();
    const flooredMs = Math.floor(firedMs / 60000) * 60000;
    const idx = idxAtOrAfter(flooredMs);
    if (idx < APPROACH_BARS) continue;

    const approachBars = allBars.slice(idx - APPROACH_BARS, idx);
    let fav = 0, adv = 0, tot = 0;
    for (const b of approachBars) {
      tot += b.bid_volume + b.ask_volume;
      fav += !isLong ? b.ask_volume : b.bid_volume; // "favorable" to the AGAINST side
      adv += !isLong ? b.bid_volume : b.ask_volume;
    }
    if (tot <= 0) continue;
    const againstPressure = (fav - adv) / tot;

    enriched.push({
      ...t, direction, isLong, againstPressure,
      zeroMfe: t.mfe_points <= 0,
      ts: firedMs,
    });
  }
  console.log(`Enriched ${enriched.length} trades with against-pressure + real (stored) mfe_points.\n`);

  const zeroMfeCount = enriched.filter(t => t.zeroMfe).length;
  console.log(`Baseline zero-MFE rate (corrected): ${zeroMfeCount}/${enriched.length} (${(100*zeroMfeCount/enriched.length).toFixed(1)}%)\n`);

  function testSplit(label, rows) {
    if (rows.length < 20) { console.log(`${label}: N=${rows.length}, too thin`); return; }
    const sorted = [...rows].sort((a,b) => a.againstPressure - b.againstPressure);
    const th = sorted[Math.floor(sorted.length*2/3)].againstPressure;
    const high = rows.filter(t => t.againstPressure >= th);
    const low = rows.filter(t => t.againstPressure < th);
    const zeroRateHigh = high.filter(t => t.zeroMfe).length / high.length;
    const zeroRateLow = low.filter(t => t.zeroMfe).length / low.length;
    const evHigh = high.reduce((s,t) => s+t.actual_pnl, 0) / high.length;
    const evLow = low.reduce((s,t) => s+t.actual_pnl, 0) / low.length;
    console.log(`${label} (N=${rows.length}):`);
    console.log(`  HIGH against-pressure: N=${high.length} zero-MFE-rate=${(100*zeroRateHigh).toFixed(1)}% EV=$${evHigh.toFixed(2)}`);
    console.log(`  LOW/neutral:           N=${low.length} zero-MFE-rate=${(100*zeroRateLow).toFixed(1)}% EV=$${evLow.toFixed(2)}`);

    const rowsSorted = [...rows].sort((a,b) => a.ts - b.ts);
    const splitIdx = Math.floor(rowsSorted.length * 0.6);
    const train = rowsSorted.slice(0, splitIdx), test = rowsSorted.slice(splitIdx);
    const trainSorted = [...train].sort((a,b) => a.againstPressure - b.againstPressure);
    const trainTh = trainSorted[Math.floor(trainSorted.length*2/3)]?.againstPressure;
    if (trainTh == null) return;
    const trH = train.filter(t=>t.againstPressure>=trainTh), trL = train.filter(t=>t.againstPressure<trainTh);
    const teH = test.filter(t=>t.againstPressure>=trainTh), teL = test.filter(t=>t.againstPressure<trainTh);
    const zr = arr => arr.length ? (100*arr.filter(t=>t.zeroMfe).length/arr.length).toFixed(1) : 'n/a';
    console.log(`  TRAIN (N=${train.length}): high N=${trH.length} zeroMFE%=${zr(trH)} | low N=${trL.length} zeroMFE%=${zr(trL)}`);
    console.log(`  TEST  (N=${test.length}): high N=${teH.length} zeroMFE%=${zr(teH)} | low N=${teL.length} zeroMFE%=${zr(teL)}`);
  }

  console.log('=== POOLED ===');
  testSplit('ALL', enriched);
  console.log('\n=== LONG only ===');
  testSplit('LONG', enriched.filter(t => t.isLong));
  console.log('\n=== SHORT only ===');
  testSplit('SHORT', enriched.filter(t => !t.isLong));

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
