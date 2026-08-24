import { query } from '/home/mmoniz/trading-journal/server/db.js';
import { inferDirection } from '/home/mmoniz/trading-journal/server/config/setupTypes.js';
import { computeDirImbalance } from '/home/mmoniz/trading-journal/server/services/entryPressureService.js';
import { computeReplication } from '/home/mmoniz/trading-journal/server/services/rigorDiagnostics.js';

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, fired_at, actual_pnl::float as actual_pnl, resolution
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT', 'STOP_HIT') AND origin_status IN ('ACTIVE','SHADOW')
      AND actual_pnl IS NOT NULL AND fired_at IS NOT NULL
  `);
  const allTrades = tradesRes.rows.map(t => ({ ...t, dir: inferDirection(t.setup_type) }))
    .filter(t => t.dir !== null);
  console.log(`Loaded ${allTrades.length} real directional trades.`);

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
    enriched.push({ ...t, pressure: p });
  }
  console.log(`Enriched ${enriched.length} trades with valid pressure.\n`);

  // Group by (setup_type, direction) — a setup_type's own direction is fixed by
  // inferDirection(), so this is really just grouping by setup_type, but keep dir explicit
  // for clarity in output.
  const byType = {};
  for (const t of enriched) (byType[t.setup_type] ??= []).push(t);

  const MIN_N = 20;
  const candidates = Object.entries(byType).filter(([, rows]) => rows.length >= MIN_N);
  console.log(`${candidates.length} of ${Object.keys(byType).length} setup_types have N>=${MIN_N} real directional trades.\n`);

  // Per-type top-tercile above-vs-below lift (pooled, no train/test yet — that's expensive
  // per-type at this N and the replication check below is the real guard against noise).
  const results = [];
  for (const [type, rows] of candidates) {
    const sorted = [...rows].sort((a, b) => a.pressure - b.pressure);
    const threshold = sorted[Math.floor(sorted.length * 2 / 3)].pressure;
    const above = rows.filter(t => t.pressure >= threshold);
    const below = rows.filter(t => t.pressure < threshold);
    if (above.length < 5 || below.length < 5) continue;
    const evAbove = above.reduce((s, t) => s + t.actual_pnl, 0) / above.length;
    const evBelow = below.reduce((s, t) => s + t.actual_pnl, 0) / below.length;
    results.push({ type, n: rows.length, nAbove: above.length, evAbove, evBelow, lift: evAbove - evBelow });
  }

  results.sort((a, b) => b.lift - a.lift);
  console.log('=== Top 15 by lift (above-tercile EV minus below EV) ===');
  for (const r of results.slice(0, 15)) {
    console.log(`  ${r.type.padEnd(30)} N=${String(r.n).padEnd(4)} above N=${r.nAbove} EV=$${r.evAbove.toFixed(2).padStart(8)}  below EV=$${r.evBelow.toFixed(2).padStart(8)}  lift=$${r.lift.toFixed(2)}`);
  }
  console.log('\n=== Bottom 10 by lift (worst / most negative) ===');
  for (const r of results.slice(-10)) {
    console.log(`  ${r.type.padEnd(30)} N=${String(r.n).padEnd(4)} above N=${r.nAbove} EV=$${r.evAbove.toFixed(2).padStart(8)}  below EV=$${r.evBelow.toFixed(2).padStart(8)}  lift=$${r.lift.toFixed(2)}`);
  }

  // Replication check: is the top-K's lift real, or an artifact of testing many types?
  // Pool the "above" bucket for the top 10 by lift as the SELECTED units, everything else's
  // "above" bucket as HELD OUT, and check whether the selected group's positive sign holds
  // up against the pooled held-out group.
  const topK = 10;
  const selectedTypes = new Set(results.slice(0, topK).map(r => r.type));
  const units = results.map(r => ({ type: r.type, n: r.nAbove, value: r.lift }));
  const rep = computeReplication(units, {
    idFn: u => u.type,
    metricFn: u => ({ n: u.n, value: u.value }),
    selectedIds: [...selectedTypes],
  });
  console.log(`\n=== Replication check (top ${topK} lift vs everything else) ===`);
  console.log(JSON.stringify(rep, null, 2));

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
