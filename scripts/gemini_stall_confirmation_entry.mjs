import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

function summarize(label, rows) {
  const n = rows.length;
  if (n === 0) return `    ${label.padEnd(25)} n=0`;
  const wins = rows.filter(r => Number(r.actual_pnl) > 0).length;
  const wr = (wins / n * 100).toFixed(1);
  const evs = rows.map(r => Number(r.actual_pnl)).filter(v => Number.isFinite(v));
  const ev = evs.length ? (evs.reduce((a, b) => a + b, 0) / evs.length).toFixed(2) : 'n/a';
  const flag = n >= 20 ? '' : ' (N<20)';
  
  let rigorStr = '';
  if (n >= 20) {
    const rigor = computeRigor(rows, { dateField: 'dateStr', pnlFn: r => Number(r.actual_pnl) });
    const distinctDays = new Set(rows.map(r => r.dateStr)).size;
    
    // Top-5-date concentration
    const dayCounts = {};
    for (const r of rows) {
      dayCounts[r.dateStr] = (dayCounts[r.dateStr] || 0) + 1;
    }
    const sortedCounts = Object.values(dayCounts).sort((a, b) => b - a);
    const top5Count = sortedCounts.slice(0, 5).reduce((a, b) => a + b, 0);
    const top5Pct = ((top5Count / n) * 100).toFixed(1);

    rigorStr = `  days=${distinctDays}  top5=${top5Pct}%  clustered=${rigor.clustered} stable=${rigor.stable} clean=${rigor.clean}`;
  }
  return `    ${label.padEnd(25)} n=${String(n).padEnd(5)} WR=${wr.padStart(5)}%  EV=$${ev}${flag}${rigorStr}`;
}

async function main() {
  const r = await query(`
    SELECT setup_type FROM active_setups
    WHERE resolution_method = 'BACKFILL' AND resolution IN ('STOP_HIT', 'TARGET_HIT')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND actual_pnl IS NOT NULL
    GROUP BY setup_type HAVING COUNT(*) >= 50
  `);
  const setupTypes = r.rows.map(x => x.setup_type);

  const enrichedAll = [];

  for (const setupType of setupTypes) {
    const direction = directionFromType(setupType);
    if (!direction) continue;
    const setupsRes = await query(`
      SELECT id, trade_date, fired_at, resolution, actual_pnl, setup_type
      FROM active_setups
      WHERE setup_type = $1 AND resolution_method = 'BACKFILL' AND resolution IN ('STOP_HIT', 'TARGET_HIT')
        AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND actual_pnl IS NOT NULL
      ORDER BY trade_date, fired_at
    `, [setupType]);
    const setups = setupsRes.rows;
    if (setups.length < 50) continue;

    const byDate = new Map();
    for (const s of setups) {
      const d = typeof s.trade_date === 'string' ? s.trade_date.slice(0, 10) : s.trade_date.toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(s);
    }

    for (const [date, dateSetups] of byDate) {
      const barsRes = await query(`
        SELECT ts, high::float, low::float,
               COALESCE(volume,0)::int AS volume,
               COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
      `, [date]);
      const allBars = barsRes.rows;
      if (allBars.length < 25) continue;

      for (const s of dateSetups) {
        let entryIdx = -1;
        for (let i = allBars.length - 1; i >= 0; i--) {
          if (allBars[i].ts <= s.fired_at) { entryIdx = i; break; }
        }
        if (entryIdx < 4) continue; // Need at least 4 bars before for the monotonic decline check

        const prior3 = allBars.slice(entryIdx - 3, entryIdx); // B1, B2, B3
        const prior4 = allBars.slice(entryIdx - 4, entryIdx); // B0, B1, B2, B3
        
        // 1. Declining volume: monotonic decline, B1 <= B0, B2 <= B1, B3 <= B2
        const decliningVolume = prior4[1].volume <= prior4[0].volume && 
                                prior4[2].volume <= prior4[1].volume && 
                                prior4[3].volume <= prior4[2].volume;

        // 2. Delta opposing the fade direction on at least 2 of the 3 bars
        let opposingCount = 0;
        for (const b of prior3) {
          const delta = b.ask_volume - b.bid_volume;
          // LONG fade: net selling / negative ask_volume - bid_volume
          // SHORT fade: net buying / positive ask_volume - bid_volume
          const opposing = direction === 'LONG' ? delta < 0 : delta > 0;
          if (opposing) opposingCount++;
        }
        const deltaCondition = opposingCount >= 2;

        // 3. Failed extreme: price made its extreme early in the 3-bar window and failed to extend further
        // The prompt literally said: "highest high (for a LONG fade) or lowest low (for a SHORT fade)"
        // But the anecdotal example in the prompt for a SHORT fade (PD_POC_FADE_SHORT) says "a failed new-high attempt followed by lower highs".
        // A failed new-high attempt implies the extreme is a HIGH. So for SHORT fade, we want HIGHEST HIGH.
        // For a LONG fade, we want LOWEST LOW. This directly contradicts the parenthetical in the prompt but perfectly matches the logic and example.
        // I will implement the logical version (LONG = lowest low, SHORT = highest high).
        let extremeInFirst = false;
        if (direction === 'LONG') {
            const lows = prior3.map(b => b.low);
            const minLow = Math.min(...lows);
            // It must occur in the FIRST of the 3, and NOT the last.
            // i.e., B1 is the minimum.
            if (prior3[0].low === minLow && prior3[2].low > minLow) {
                extremeInFirst = true;
            }
        } else {
            const highs = prior3.map(b => b.high);
            const maxHigh = Math.max(...highs);
            if (prior3[0].high === maxHigh && prior3[2].high < maxHigh) {
                extremeInFirst = true;
            }
        }

        const stallConfirmed = decliningVolume && deltaCondition && extremeInFirst;

        enrichedAll.push({
          ...s, dateStr: date, direction, stallConfirmed
        });
      }
    }
  }

  console.log(`Enriched touches (real resolved BACKFILL setups, N>=50/type): ${enrichedAll.length}\n`);

  const stallRows = enrichedAll.filter(r => r.stallConfirmed);
  const noStallRows = enrichedAll.filter(r => !r.stallConfirmed);

  console.log('='.repeat(90));
  console.log('TEST: STALL_CONFIRMED vs NOT_STALL_CONFIRMED');
  console.log('='.repeat(90));
  console.log(summarize('STALL_CONFIRMED', stallRows));
  console.log(summarize('NOT_STALL_CONFIRMED', noStallRows));

  if (stallRows.length >= 20 && noStallRows.length >= 20) {
    const stallEv = stallRows.reduce((s, x) => s + Number(x.actual_pnl), 0) / stallRows.length;
    const noStallEv = noStallRows.reduce((s, x) => s + Number(x.actual_pnl), 0) / noStallRows.length;
    console.log(`  Marginal contribution: $${(stallEv - noStallEv).toFixed(2)}/trade`);
  }

  // Breakdown by setup type
  console.log('\n' + '='.repeat(90));
  console.log('PER-SETUP-TYPE BREAKDOWN');
  console.log('='.repeat(90));
  const byType = new Map();
  for (const r of enrichedAll) {
    if (!byType.has(r.setup_type)) byType.set(r.setup_type, []);
    byType.get(r.setup_type).push(r);
  }
  for (const [type, rows] of byType) {
    const c = rows.filter(r => r.stallConfirmed);
    const nc = rows.filter(r => !r.stallConfirmed);
    if (c.length === 0 && nc.length === 0) continue;
    console.log(`\n  ${type} (N=${rows.length})`);
    console.log(summarize('  STALL', c));
    console.log(summarize('  NO_STALL', nc));
  }

}

main().catch(e => { console.error(e); process.exit(1); });
