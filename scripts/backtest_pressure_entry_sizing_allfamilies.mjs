import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeDirImbalance } from '../server/services/entryPressureService.js';

function getFamily(setupType) {
  if (setupType.includes('GLOBEX')) return 'GLOBEX';
  if (setupType.includes('OVERNIGHT')) return 'OVERNIGHT';
  if (setupType.includes('VWAP')) return 'VWAP_MAGNET';
  if (setupType.includes('FADE')) return 'LEVEL_FADE';
  return 'OTHER';
}

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, fired_at, actual_pnl::float as actual_pnl, resolution
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT', 'STOP_HIT') AND origin_status IN ('ACTIVE','SHADOW')
      AND actual_pnl IS NOT NULL AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const shortTrades = tradesRes.rows.filter(t => inferDirection(t.setup_type) === 'SHORT');
  console.log(`Loaded ${shortTrades.length} real SHORT trades.`);

  const barsRes = await query(`
    SELECT ts, extract(epoch from ts)*1000 as ts_ms,
      COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;
  console.log(`Loaded ${allBars.length} bars.`);

  function lastCompletedBarBefore(firedAtMs) {
    const flooredMs = Math.floor(firedAtMs / 60000) * 60000;
    let lo = 0, hi = allBars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (allBars[mid].ts_ms < flooredMs) lo = mid + 1; else hi = mid;
    }
    return lo > 0 ? allBars[lo - 1] : null;
  }

  const enriched = [];
  for (const t of shortTrades) {
    const family = getFamily(t.setup_type);
    const bar = lastCompletedBarBefore(new Date(t.fired_at).getTime());
    if (!bar) continue;
    
    // Check total volume for null pressure checks
    const totalVol = bar.bid_volume + bar.ask_volume;
    
    let p = null;
    if (totalVol > 0) {
      p = computeDirImbalance(bar.bid_volume, bar.ask_volume, false); // false for SHORT
    }
    
    enriched.push({ ...t, family, pressure: p, totalVol });
  }

  const families = ['LEVEL_FADE', 'VWAP_MAGNET', 'GLOBEX', 'OVERNIGHT', 'OTHER'];
  
  for (const family of families) {
    console.log(`\n=== FAMILY: ${family} ===`);
    const familyTrades = enriched.filter(t => t.family === family);
    if (familyTrades.length === 0) {
      console.log(`No trades found for ${family}.`);
      continue;
    }
    
    const nullPressure = familyTrades.filter(t => t.totalVol <= 0);
    console.log(`Null pressure rate (totalVol <= 0): ${nullPressure.length}/${familyTrades.length} (${(nullPressure.length / familyTrades.length * 100).toFixed(1)}%)`);

    const validTrades = familyTrades.filter(t => t.pressure !== null);
    if (validTrades.length < 20) {
      console.log(`Insufficient valid N (${validTrades.length} < 20). Skipping split/stats.`);
      continue;
    }

    const sorted = [...validTrades].sort((a, b) => a.pressure - b.pressure);
    const threshold = sorted[Math.floor(sorted.length * 2 / 3)]?.pressure ?? null;

    const above = validTrades.filter(t => t.pressure >= threshold);
    const below = validTrades.filter(t => t.pressure < threshold);
    const evAll = validTrades.reduce((s, t) => s + t.actual_pnl, 0) / validTrades.length;
    const evAbove = above.reduce((s, t) => s + t.actual_pnl, 0) / above.length;
    const evBelow = below.reduce((s, t) => s + t.actual_pnl, 0) / below.length;
    const lift = evAbove - evAll;

    console.log(`Total N: ${validTrades.length} | Baseline EV: $${evAll.toFixed(2)}`);
    console.log(`Threshold (Top Tercile): ${threshold?.toFixed(4)}`);
    console.log(`Above N: ${above.length} | EV: $${evAbove.toFixed(2)} | Lift: $${lift.toFixed(2)}`);
    console.log(`Below N: ${below.length} | EV: $${evBelow.toFixed(2)}`);

    if (family !== 'LEVEL_FADE') {
      console.log(`\n--- Chronological 60/40 Split for ${family} ---`);
      const splitIdx = Math.floor(validTrades.length * 0.6);
      const train = validTrades.slice(0, splitIdx);
      const test = validTrades.slice(splitIdx);
      
      const trainSorted = [...train].sort((a, b) => a.pressure - b.pressure);
      const trainThreshold = trainSorted[Math.floor(trainSorted.length * 2 / 3)]?.pressure ?? null;

      if (trainThreshold === null) continue;

      const trainAbove = train.filter(t => t.pressure >= trainThreshold);
      const trainBelow = train.filter(t => t.pressure < trainThreshold);
      const trainEvAll = train.reduce((s, t) => s + t.actual_pnl, 0) / train.length;
      const trainEvAbove = trainAbove.length ? trainAbove.reduce((s, t) => s + t.actual_pnl, 0) / trainAbove.length : 0;
      
      const testAbove = test.filter(t => t.pressure >= trainThreshold);
      const testBelow = test.filter(t => t.pressure < trainThreshold);
      const testEvAll = test.reduce((s, t) => s + t.actual_pnl, 0) / test.length;
      const testEvAbove = testAbove.length ? testAbove.reduce((s, t) => s + t.actual_pnl, 0) / testAbove.length : 0;

      console.log(`Train N=${train.length} | Baseline EV=$${trainEvAll.toFixed(2)} | Top Tercile EV=$${trainEvAbove.toFixed(2)} | Lift=$${(trainEvAbove - trainEvAll).toFixed(2)}`);
      console.log(`Test  N=${test.length} | Baseline EV=$${testEvAll.toFixed(2)} | Top Tercile EV=$${testEvAbove.toFixed(2)} | Lift=$${(testEvAbove - testEvAll).toFixed(2)}`);
      
      if (trainEvAbove - trainEvAll > 0 && testEvAbove - testEvAll > 0) {
        console.log(`Verdict for ${family}: REPLICATES (Positive lift in both halves)`);
      } else {
        console.log(`Verdict for ${family}: FAILS REPLICATION (Lift inverts or is negative in one/both halves)`);
      }
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
