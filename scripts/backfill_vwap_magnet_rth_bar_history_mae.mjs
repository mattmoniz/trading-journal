// RTH sibling of backfill_vwap_magnet_bar_history_mae.mjs -- same bar-history-reconstruction
// methodology, applied to VWAP_MAGNET_LONG/SHORT (the RTH-fired setup, distinct from
// GLOBEX_VWAP_MAGNET_LONG/SHORT). Reuses the REAL live functions: computeRunningVwapSeries
// (server/services/developingValueService.js) and getTrailingVwapStd (server/services/
// queries.js) -- the exact functions server/routes/acd.js calls live (~line 5447-5486).
//
// Window is much shorter than the Globex sibling's ~3.5yr reconstruction: getTrailingVwapStd
// reads session_analysis.close_vs_vwap, which only goes back to 2026-03-25 -- so this can only
// reconstruct back to ~30 sessions after that (needs 30 prior days of session_analysis
// coverage for a real, non-fallback threshold). Calls the real DB function directly per day
// (not batched in-memory like the Globex version) -- the day count here (~60-70 candidate RTH
// days) is small enough that this isn't a performance problem the way the 857-day Globex
// version was.

import { query } from '../server/db.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { getTrailingVwapStd } from '../server/services/queries.js';
import fs from 'fs';

async function main() {
  console.log('Finding RTH trading days with session_analysis coverage...');
  const daysRes = await query(`SELECT DISTINCT trade_date::text as d FROM session_analysis WHERE close_vs_vwap IS NOT NULL ORDER BY d`);
  const allDays = daysRes.rows.map(r => r.d);
  const days = allDays.slice(30); // need 30 prior days for a real (non-fallback) threshold
  console.log(`${days.length} candidate RTH trading days (${days[0]} through ${days[days.length - 1]})`);

  console.log('Loading all RTH NQ bars...');
  const barsRes = await query(`
    SELECT ts::date::text as d, high::float, low::float, close::float,
           COALESCE(bid_volume,0)::int + COALESCE(ask_volume,0)::int as volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY ts
  `);
  const barsByDay = new Map();
  for (const b of barsRes.rows) { if (!barsByDay.has(b.d)) barsByDay.set(b.d, []); barsByDay.get(b.d).push(b); }

  const instances = [];
  let dayCount = 0;
  for (const d of days) {
    dayCount++;
    if (dayCount % 20 === 0) console.log(`  ...${dayCount}/${days.length} days, ${instances.length} instances so far`);
    const bars = barsByDay.get(d) || [];
    if (bars.length < 30) continue;
    const vwapSeries = computeRunningVwapSeries(bars);
    const std = await getTrailingVwapStd(d, 30);
    if (std.n < 20) continue;

    let wasBeyond = false;
    for (let i = 0; i < bars.length; i++) {
      const vwapNow = vwapSeries[i];
      if (vwapNow == null) continue;
      const dist = bars[i].close - vwapNow;
      const isBeyond = Math.abs(dist) >= std.threshold;
      if (isBeyond && !wasBeyond) {
        const isLong = dist < 0;
        const entry = bars[i].close;
        const endIdx = bars.length; // walk to RTH session close, same convention as the Globex fix
        let mae = 0, mfe = 0;
        const grid = {};
        const STOPS = [20, 30, 40, 52, 65, 80, 100, 125, 150];
        const TARGETS = [40, 60, 80, 100];
        for (const s of STOPS) { grid[s] = {}; for (const t of TARGETS) grid[s][t] = null; }
        for (let j = i + 1; j < endIdx; j++) {
          const adverse = isLong ? entry - bars[j].low : bars[j].high - entry;
          const favorable = isLong ? bars[j].high - entry : entry - bars[j].low;
          if (adverse > mae) mae = adverse;
          if (favorable > mfe) mfe = favorable;
          for (const s of STOPS) {
            const stopHit = adverse >= s;
            for (const t of TARGETS) {
              if (grid[s][t] != null) continue;
              const targetHit = favorable >= t;
              if (stopHit) grid[s][t] = 'STOP';
              else if (targetHit) grid[s][t] = 'TARGET';
            }
          }
        }
        instances.push({ date: d, direction: isLong ? 'LONG' : 'SHORT', entry, mae: +mae.toFixed(1), mfe: +mfe.toFixed(1), thresholdAtTrigger: std.threshold, grid });
      }
      wasBeyond = isBeyond;
    }
  }

  console.log(`\nTotal RTH fresh-trigger instances: ${instances.length}`);
  fs.writeFileSync('scratch/vwap_magnet_rth_bar_history_instances.json', JSON.stringify(instances, null, 2));
  for (const dirLabel of ['LONG', 'SHORT']) {
    const n = instances.filter(x => x.direction === dirLabel).length;
    console.log(`  ${dirLabel}: N=${n}`);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
