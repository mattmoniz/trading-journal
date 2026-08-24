import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';

async function main() {
  console.log("Loading trades...");
  const tradesRes = await query(`
    SELECT setup_type, trade_date::text as trade_date, fired_at,
      extract(epoch from fired_at)*1000 as fired_at_ms,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level, actual_pnl::float as actual_pnl,
      resolution
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT', 'STOP_HIT') 
      AND origin_status IN ('ACTIVE','SHADOW')
      AND actual_pnl IS NOT NULL
      AND setup_type NOT LIKE '%VWAP%' 
      AND setup_type NOT LIKE '%GLOBEX%' 
      AND setup_type NOT LIKE '%OVERNIGHT%' 
      AND setup_type LIKE '%FADE%'
    ORDER BY fired_at ASC
  `);
  
  const trades = tradesRes.rows.filter(t => inferDirection(t.setup_type) !== null);
  console.log(`Loaded ${trades.length} level-fade trades.`);

  console.log("Loading all NQ bars...");
  const barsRes = await query(`
    SELECT ts, ts::date::text as trade_date, high::float as high, low::float as low,
      extract(epoch from ts)*1000 as ts_ms,
      COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume,
      extract(hour from ts)*60 + extract(minute from ts) as et_min
    FROM price_bars_primary 
    WHERE symbol='NQ' 
    ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;
  console.log(`Loaded ${allBars.length} bars.`);

  console.log("Computing daily delta percentiles...");
  const dailyDeltaRes = await query(`
    WITH daily_delta AS (
      SELECT ts::date::text as trade_date, ABS(SUM(COALESCE(ask_volume,0) - COALESCE(bid_volume,0))) as abs_delta
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND
        extract(hour from ts)*60 + extract(minute from ts) BETWEEN 570 AND 959
      GROUP BY ts::date
    )
    SELECT trade_date, abs_delta FROM daily_delta ORDER BY trade_date ASC
  `);
  const dailyDeltas = dailyDeltaRes.rows;
  
  const p25p75ByDate = new Map();
  for (let i = 0; i < dailyDeltas.length; i++) {
    const today = dailyDeltas[i].trade_date;
    const prior = dailyDeltas.slice(Math.max(0, i - 60), i).map(x => x.abs_delta).sort((a,b) => a - b);
    if (prior.length > 0) {
      const p25 = prior[Math.floor(prior.length * 0.25)];
      const p75 = prior[Math.floor(prior.length * 0.75)];
      p25p75ByDate.set(today, { p25, p75 });
    }
  }

  function getBarsBefore(firedAtMs, count) {
    const flooredMs = Math.floor(firedAtMs / 60000) * 60000;
    let lo = 0, hi = allBars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (allBars[mid].ts_ms < flooredMs) lo = mid + 1;
      else hi = mid;
    }
    return allBars.slice(Math.max(0, lo - count), lo);
  }

  function getRthBarsBefore(firedAtMs) {
    const flooredMs = Math.floor(firedAtMs / 60000) * 60000;
    const d = new Date(flooredMs);
    const dateStr = d.toISOString().slice(0, 10);
    // Find first bar of day at 09:30
    const startMs = new Date(`${dateStr}T09:30:00-04:00`).getTime();
    let lo = 0, hi = allBars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (allBars[mid].ts_ms < flooredMs) lo = mid + 1;
      else hi = mid;
    }
    const bars = [];
    for (let i = lo - 1; i >= 0; i--) {
      if (allBars[i].ts_ms < startMs) break;
      if (allBars[i].et_min >= 570 && allBars[i].et_min <= 959) {
        bars.push(allBars[i]);
      }
    }
    return bars.reverse();
  }

  // First pass: compute metrics for all trades
  const enriched = [];
  const pressure1ByDate = new Map();
  const pressure2ByDate = new Map();

  for (const t of trades) {
    const dir = inferDirection(t.setup_type);
    const isLong = dir === 'LONG';
    const bars1 = getBarsBefore(t.fired_at_ms, 1);
    const bars2 = getBarsBefore(t.fired_at_ms, 2);
    const bars5 = getBarsBefore(t.fired_at_ms, 5);

    function calcPressure(bars) {
      let fav = 0, adv = 0, tot = 0;
      for (const b of bars) {
        tot += b.bid_volume + b.ask_volume;
        fav += isLong ? b.ask_volume : b.bid_volume;
        adv += isLong ? b.bid_volume : b.ask_volume;
      }
      return tot > 0 ? (fav - adv) / tot : null;
    }

    const p1 = calcPressure(bars1);
    const p2 = calcPressure(bars2);
    
    // approach delta for 5 bars
    const approachDelta = bars5.reduce((s, b) => s + (b.ask_volume || 0) - (b.bid_volume || 0), 0);
    const buyersAtLevel = isLong && approachDelta > 0;
    const sellersAtLevel = !isLong && approachDelta < 0;

    // session delta
    const rthBars = getRthBarsBefore(t.fired_at_ms);
    const _lfSessionDelta = rthBars.reduce((sum, b) => sum + ((b.ask_volume || 0) - (b.bid_volume || 0)), 0);
    const _lfAbsDelta = Math.abs(_lfSessionDelta);
    
    const dp = p25p75ByDate.get(t.trade_date);
    const _lfDeltaNeutral = dp != null && _lfAbsDelta < dp.p25;
    const _lfDeltaHigh = dp != null && _lfAbsDelta > dp.p75;

    const dateStr = t.trade_date.slice(0, 10);
    if (p1 !== null) {
      if (!pressure1ByDate.has(dateStr)) pressure1ByDate.set(dateStr, []);
      pressure1ByDate.get(dateStr).push(p1);
    }
    if (p2 !== null) {
      if (!pressure2ByDate.has(dateStr)) pressure2ByDate.set(dateStr, []);
      pressure2ByDate.get(dateStr).push(p2);
    }

    enriched.push({
      ...t, dir, isLong, p1, p2, 
      buyersAtLevel, sellersAtLevel,
      _lfDeltaNeutral, _lfDeltaHigh,
      dateStr
    });
  }

  // Second pass: compute rolling z-scores
  const uniqueDates = Array.from(pressure1ByDate.keys()).sort();
  const zEnriched = [];

  for (const r of enriched) {
    if (r.p1 === null || r.p2 === null) continue;
    const dateIdx = uniqueDates.indexOf(r.dateStr);
    
    // We want 60-session rolling.
    // That means all trades in the previous 60 dates.
    const startIdx = Math.max(0, dateIdx - 60);
    let past1 = [], past2 = [];
    for (let i = startIdx; i < dateIdx; i++) {
      past1.push(...pressure1ByDate.get(uniqueDates[i]));
      past2.push(...pressure2ByDate.get(uniqueDates[i]));
    }

    function calcZ(val, past) {
      if (past.length < 20) return null; // Need min samples for valid std
      const mean = past.reduce((a, b) => a + b, 0) / past.length;
      const vari = past.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / past.length;
      const std = Math.sqrt(vari);
      return std > 0 ? (val - mean) / std : 0;
    }

    const z1 = calcZ(r.p1, past1);
    const z2 = calcZ(r.p2, past2);
    
    if (z1 !== null && z2 !== null) {
      zEnriched.push({ ...r, z1, z2 });
    }
  }

  console.log(`Enriched ${zEnriched.length} trades with valid Z-scores.`);
  
  function printSummaries(label, rows) {
    const wins = rows.filter(r => r.resolution === 'TARGET_HIT').length;
    const n = rows.length;
    const wr = n > 0 ? (wins / n * 100).toFixed(1) : '0.0';
    const ev = n > 0 ? (rows.reduce((s, r) => s + r.actual_pnl, 0) / n).toFixed(2) : 'n/a';
    return `  ${label.padEnd(30)} N=${String(n).padEnd(4)} WR=${wr.padStart(5)}%  EV=$${ev.padStart(6)}`;
  }

  function reportCheck(title, rows, conditionFn) {
    const yes = rows.filter(conditionFn);
    const no = rows.filter(r => !conditionFn(r));
    return `\n=== ${title} ===\n${printSummaries('YES', yes)}\n${printSummaries('NO', no)}`;
  }

  // 1-bar buckets
  const b1_neg_large = zEnriched.filter(r => r.z1 <= -1.0);
  const b1_neutral = zEnriched.filter(r => r.z1 > -1.0 && r.z1 < 1.0);
  const b1_pos_large = zEnriched.filter(r => r.z1 >= 1.0);
  
  console.log("\n=== 1-Bar Pressure Z-Score ===");
  console.log("POOLED:");
  console.log(printSummaries("Z <= -1.0 (SAME_SEL_NO_SIG)", b1_neg_large));
  console.log(printSummaries("-1 < Z < 1 (NEVER_SELECTED)", b1_neutral));
  console.log(printSummaries("Z >= 1.0 (SIGNAL)", b1_pos_large));
  
  const b1_long = zEnriched.filter(r => r.isLong);
  const b1_short = zEnriched.filter(r => !r.isLong);
  
  console.log("\nLONG:");
  console.log(printSummaries("Z <= -1.0", b1_long.filter(r => r.z1 <= -1.0)));
  console.log(printSummaries("-1 < Z < 1", b1_long.filter(r => r.z1 > -1.0 && r.z1 < 1.0)));
  console.log(printSummaries("Z >= 1.0", b1_long.filter(r => r.z1 >= 1.0)));

  console.log("\nSHORT:");
  console.log(printSummaries("Z <= -1.0", b1_short.filter(r => r.z1 <= -1.0)));
  console.log(printSummaries("-1 < Z < 1", b1_short.filter(r => r.z1 > -1.0 && r.z1 < 1.0)));
  console.log(printSummaries("Z >= 1.0", b1_short.filter(r => r.z1 >= 1.0)));

  // 2-bar robustness
  console.log("\n=== 2-Bar Pressure Z-Score (Robustness) ===");
  console.log(printSummaries("Z <= -1.0", zEnriched.filter(r => r.z2 <= -1.0)));
  console.log(printSummaries("-1 < Z < 1", zEnriched.filter(r => r.z2 > -1.0 && r.z2 < 1.0)));
  console.log(printSummaries("Z >= 1.0", zEnriched.filter(r => r.z2 >= 1.0)));
  
  // Confound checks
  console.log("\n=== Confound Check: Structural Advantage (Baseline) ===");
  console.log(printSummaries("ALL VALID TRADES BASELINE", zEnriched));
  
  console.log("\\n=== Redundancy Tests (Recomputed from acd.js logic) ===");
  console.log(reportCheck('Buyers/Sellers At Level (Approach Delta)', zEnriched, r => r.buyersAtLevel || r.sellersAtLevel));
  console.log(reportCheck('Session Delta Neutral (Quiet Session)', zEnriched, r => r._lfDeltaNeutral));
  console.log(reportCheck('Session Delta High (Strong Conviction)', zEnriched, r => r._lfDeltaHigh));
  
  // --- DIRECTION-SPLIT RIGOR FOLLOW-UP ---
  console.log("\\n\\n================================================");
  console.log("=== DIRECTION-SPLIT RIGOR & REDUNDANCY CHECK ===");
  console.log("================================================\\n");

  const longZHigh = b1_long.filter(r => r.z1 >= 1.0);
  const longZLow = b1_long.filter(r => r.z1 <= -1.0);
  const shortZHigh = b1_short.filter(r => r.z1 >= 1.0);
  const shortZLow = b1_short.filter(r => r.z1 <= -1.0);
  
  function runRigor(name, tradesSubset) {
    console.log(`\n--- Rigor Check: ${name} (N=${tradesSubset.length}) ---`);
    if (tradesSubset.length === 0) return;
    try {
      const rigor = computeRigor(tradesSubset, { dateField: 'trade_date', pnlFn: r => r.actual_pnl });
      console.log(`  top5DayPct: ${(rigor.top5DayPct*100).toFixed(1)}%`);
      console.log(`  clustered: ${rigor.clustered}`);
      console.log(`  stable: ${rigor.stable}`);
      console.log(`  thirds (ev1/ev2/ev3): ${rigor.thirds ? (rigor.thirds.ev1 + '/' + rigor.thirds.ev2 + '/' + rigor.thirds.ev3) : 'null'}`);
      
      console.log(`  computeReplication() at N=${tradesSubset.length} is not meaningful — it requires categorical 'selectedIds' (like cherry-picked setup_types), not a continuous variable slice (like Z-score), and cannot run on trade-level data directly.`);
    } catch (e) {
      console.log("  Rigor failed:", e.message);
    }
  }

  runRigor("LONG Z >= 1.0", longZHigh);
  runRigor("LONG Z <= -1.0", longZLow);
  runRigor("SHORT Z >= 1.0", shortZHigh);
  runRigor("SHORT Z <= -1.0", shortZLow);
  
  console.log("\n\n--- Direction-Specific Redundancy Check ---");
  console.log("SHORT Z >= 1.0 (sellersAtLevel == true) :", printSummaries("", shortZHigh.filter(r => r.sellersAtLevel)));
  console.log("SHORT Z >= 1.0 (sellersAtLevel == false):", printSummaries("", shortZHigh.filter(r => !r.sellersAtLevel)));
  
  console.log("LONG Z >= 1.0 (buyersAtLevel == true)  :", printSummaries("", longZHigh.filter(r => r.buyersAtLevel)));
  console.log("LONG Z >= 1.0 (buyersAtLevel == false) :", printSummaries("", longZHigh.filter(r => !r.buyersAtLevel)));

  console.log("\n\n--- Structural Check: Composition ---");
  function showComposition(name, tradesSubset) {
    console.log(`\nComposition for ${name} (N=${tradesSubset.length}):`);
    const bySetup = {};
    const byHour = {};
    for (const r of tradesSubset) {
      bySetup[r.setup_type] = (bySetup[r.setup_type] || 0) + 1;
      const d = new Date(parseFloat(r.fired_at_ms));
      const hour = d.getHours();
      byHour[hour] = (byHour[hour] || 0) + 1;
    }
    const setups = Object.entries(bySetup).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}: ${v}`).join(", ");
    const hours = Object.entries(byHour).sort((a,b)=>parseInt(a[0])-parseInt(b[0])).map(([k,v])=>`${k}h: ${v}`).join(", ");
    console.log("  Setups: " + setups);
    console.log("  Hours:  " + hours);
  }

  showComposition("LONG Z >= 1.0", longZHigh);
  showComposition("LONG Z <= -1.0", longZLow);
  showComposition("SHORT Z >= 1.0", shortZHigh);
  showComposition("SHORT Z <= -1.0", shortZLow);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
