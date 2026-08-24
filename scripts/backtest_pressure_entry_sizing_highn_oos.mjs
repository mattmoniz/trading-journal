import { query } from '/home/mmoniz/trading-journal/server/db.js';
import { inferDirection } from '/home/mmoniz/trading-journal/server/config/setupTypes.js';
import { computeDirImbalance } from '/home/mmoniz/trading-journal/server/services/entryPressureService.js';

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, fired_at, actual_pnl::float as actual_pnl, resolution
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT', 'STOP_HIT') AND origin_status IN ('ACTIVE','SHADOW')
      AND actual_pnl IS NOT NULL AND fired_at IS NOT NULL
  `);
  const allTrades = tradesRes.rows.map(t => ({ ...t, dir: inferDirection(t.setup_type) }))
    .filter(t => t.dir !== null);

  const barsRes = await query(`
    SELECT ts, extract(epoch from ts)*1000 as ts_ms,
      COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;

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
  for (const t of allTrades) {
    const bar = lastCompletedBarBefore(new Date(t.fired_at).getTime());
    if (!bar) continue;
    const p = computeDirImbalance(bar.bid_volume, bar.ask_volume, t.dir === 'LONG');
    if (p === null) continue;
    enriched.push({ ...t, pressure: p, ts: new Date(t.fired_at).getTime() });
  }

  const byType = {};
  for (const t of enriched) (byType[t.setup_type] ??= []).push(t);

  const HIGH_N = 50;
  const highNTypes = Object.entries(byType).filter(([, rows]) => rows.length >= HIGH_N)
    .sort((a, b) => b[1].length - a[1].length);
  console.log(`${highNTypes.length} setup_types have N>=${HIGH_N} real directional trades:\n`);

  for (const [type, rowsUnsorted] of highNTypes) {
    const rows = [...rowsUnsorted].sort((a, b) => a.ts - b.ts); // chronological
    const splitIdx = Math.floor(rows.length * 0.6);
    const train = rows.slice(0, splitIdx);
    const test = rows.slice(splitIdx);

    const trainSorted = [...train].sort((a, b) => a.pressure - b.pressure);
    const trainThreshold = trainSorted[Math.floor(trainSorted.length * 2 / 3)]?.pressure;
    if (trainThreshold == null) continue;

    const trainAbove = train.filter(t => t.pressure >= trainThreshold);
    const trainBelow = train.filter(t => t.pressure < trainThreshold);
    const testAbove = test.filter(t => t.pressure >= trainThreshold);
    const testBelow = test.filter(t => t.pressure < trainThreshold);

    const ev = arr => arr.length ? (arr.reduce((s, t) => s + t.actual_pnl, 0) / arr.length).toFixed(2) : 'n/a';
    const trainLift = trainAbove.length && trainBelow.length ? (ev(trainAbove) - ev(trainBelow)).toFixed(2) : 'n/a';
    const testLift = testAbove.length && testBelow.length ? (ev(testAbove) - ev(testBelow)).toFixed(2) : 'n/a';

    const trainEvAbove = parseFloat(ev(trainAbove)), trainEvBelow = parseFloat(ev(trainBelow));
    const testEvAbove = parseFloat(ev(testAbove)), testEvBelow = parseFloat(ev(testBelow));
    const trainSign = trainEvAbove > trainEvBelow;
    const testSign = testEvAbove > testEvBelow;
    const verdict = (trainSign === testSign) ? (trainSign ? 'CONSISTENT (positive both)' : 'CONSISTENT (negative both)') : 'INVERTED';

    console.log(`${type} (N=${rows.length}, dir=${inferDirection(type)}):`);
    console.log(`  TRAIN (N=${train.length}): above N=${trainAbove.length} EV=$${ev(trainAbove)} vs below N=${trainBelow.length} EV=$${ev(trainBelow)}`);
    console.log(`  TEST  (N=${test.length}): above N=${testAbove.length} EV=$${ev(testAbove)} vs below N=${testBelow.length} EV=$${ev(testBelow)}`);
    console.log(`  VERDICT: ${verdict}\n`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
