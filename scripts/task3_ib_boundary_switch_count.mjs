import { Client } from 'pg';
import { getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeReplication, computeRigor } from '../server/services/rigorDiagnostics.js';

const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'trading_journal',
  user: 'gemini_readonly',
  password: 'gemini_ro_2026'
});

async function run() {
  await client.connect();

  // 1. Fetch days and compute switch-counts
  const barsRes = await client.query(`
    SELECT DATE(ts) as trade_date,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      high, low
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    ORDER BY ts ASC
  `);
  
  const barsByDate = {};
  barsRes.rows.forEach(b => {
    const d = new Date(b.trade_date).toISOString().split('T')[0];
    if (!barsByDate[d]) barsByDate[d] = [];
    barsByDate[d].push({ et: b.et_min, h: parseFloat(b.high), l: parseFloat(b.low) });
  });
  
  const dayStats = {};
  const allDays = Object.keys(barsByDate).sort();
  
  for (const d of allDays) {
    const bars = barsByDate[d];
    if (bars.length < 50) continue; // "sufficient IB-window bar coverage" (60 mins max, require 50)
    
    let runningHigh = bars[0].h;
    let runningLow = bars[0].l;
    let lastEventDir = null; // 'UP' or 'DOWN'
    let switchCount = 0;
    
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      let newHigh = false;
      let newLow = false;
      if (b.h > runningHigh) { runningHigh = b.h; newHigh = true; }
      if (b.l < runningLow) { runningLow = b.l; newLow = true; }
      
      if (newHigh && newLow) {
        // Outside bar expanding both? Treat as whichever is bigger, or just two events.
        // But let's look at it sequentially: a 1-min bar expands both. It's rare but possible.
        // We'll ignore the switch if it expands both for simplicity, or count 1 switch.
        // The prompt: "each bar that extends the running IB high OR running IB low is an extreme event"
        // Let's say if it expands both, it definitely switched if it came from one side.
        // For now, if newHigh && newLow, we'll pick the one that extended MORE as the event, or just count a switch.
        // It's a 1-min bar, so it's a whipsaw in itself.
        switchCount++; 
        // lastEventDir remains unchanged or maybe set to null.
      } else if (newHigh) {
        if (lastEventDir === 'DOWN') switchCount++;
        lastEventDir = 'UP';
      } else if (newLow) {
        if (lastEventDir === 'UP') switchCount++;
        lastEventDir = 'DOWN';
      }
    }
    
    dayStats[d] = {
      switches: switchCount,
      range: runningHigh - runningLow
    };
  }
  
  const validDates = Object.keys(dayStats).sort();
  console.log(`Total days with valid IB-window coverage: ${validDates.length}`);
  
  // Calculate rolling percentiles for range and switches.
  // Wait, if it's backtesting, we shouldn't use lookahead percentiles. We use 180-day rolling.
  const dayMetrics = {};
  for (let i = 0; i < validDates.length; i++) {
    const d = validDates[i];
    const stat = dayStats[d];
    
    const start = Math.max(0, i - 180);
    const window = validDates.slice(start, i).map(dt => dayStats[dt]);
    
    if (window.length > 0) {
      const ranges = window.map(x => x.range).sort((a,b)=>a-b);
      const switches = window.map(x => x.switches).sort((a,b)=>a-b);
      
      let rangePct = 0, switchPct = 0;
      for (const r of ranges) { if (r <= stat.range) rangePct++; }
      for (const s of switches) { if (s <= stat.switches) switchPct++; }
      
      dayMetrics[d] = {
        rangePct: rangePct / window.length,
        switchPct: switchPct / window.length,
        switches: stat.switches
      };
    }
  }
  
  const scoredDates = Object.keys(dayMetrics);
  
  // Test 1: predict REAL day-type.
  const arQuery = `
    SELECT trade_date, day_type
    FROM acd_daily_log
    WHERE day_type IN ('TREND', 'TURBULENT', 'BALANCE')
  `;
  const { rows: arRows } = await client.query(arQuery);
  const realDayTypes = {};
  arRows.forEach(r => {
    const d = new Date(r.trade_date).toISOString().split('T')[0];
    realDayTypes[d] = r.day_type;
  });
  
  let wideIbDays = [];
  let wideIbLowSwitch = [];
  let wideIbHighSwitch = [];
  
  for (const d of scoredDates) {
    const dm = dayMetrics[d];
    const rt = realDayTypes[d];
    if (rt && dm.rangePct >= 0.666) {
      wideIbDays.push(rt);
      if (dm.switchPct <= 0.333) wideIbLowSwitch.push(rt);
      else if (dm.switchPct >= 0.666) wideIbHighSwitch.push(rt);
    }
  }
  
  const getCounts = (arr) => {
    return {
      TREND: arr.filter(x => x === 'TREND').length,
      TURBULENT: arr.filter(x => x === 'TURBULENT').length,
      BALANCE: arr.filter(x => x === 'BALANCE').length,
      TOTAL: arr.length
    };
  };
  
  console.log(`\n--- Task 3.2: Market Behavior (Wide IB Days) ---`);
  console.log('All Wide IB:', getCounts(wideIbDays));
  console.log('Wide IB + Low Switch:', getCounts(wideIbLowSwitch));
  console.log('Wide IB + High Switch:', getCounts(wideIbHighSwitch));

  // Test 2: real setup performance. Same active_setups join as Task 1.
  const query = `
    SELECT
      a.trade_date,
      a.setup_type,
      a.actual_pnl
    FROM active_setups a
    WHERE a.origin_status IN ('ACTIVE', 'SHADOW')
      AND a.actual_pnl IS NOT NULL
  `;
  const { rows: setups } = await client.query(query);
  
  const realFadeSetups = setups.filter(r => getBetClass(r.setup_type) === 'VALUE_FADE');
  realFadeSetups.forEach(r => r.actual_pnl = parseFloat(r.actual_pnl));
  
  const lowSwitchSetups = [];
  const highSwitchSetups = [];
  
  for (const s of realFadeSetups) {
    const d = new Date(s.trade_date).toISOString().split('T')[0];
    const dm = dayMetrics[d];
    if (!dm) continue;
    if (dm.switchPct <= 0.333) lowSwitchSetups.push(s);
    else if (dm.switchPct >= 0.666) highSwitchSetups.push(s);
  }
  
  const getStats = (arr) => {
    if (arr.length === 0) return {n: 0, wr: 0, ev: 0};
    const n = arr.length;
    const wins = arr.filter(x => x.actual_pnl > 0).length;
    const wr = wins / n;
    const totalPnl = arr.reduce((sum, x) => sum + x.actual_pnl, 0);
    const ev = (totalPnl * LIVE_INSTRUMENT.dollarsPerPoint) / n;
    return {n, wr: +(wr*100).toFixed(1), ev: +ev.toFixed(2)};
  };
  
  const lsStats = getStats(lowSwitchSetups);
  const hsStats = getStats(highSwitchSetups);
  
  console.log(`\n--- Task 3.3: Real Setup Performance (Fade Setups) ---`);
  console.log(`Low Switch (Clean Legs) : N=${lsStats.n}, WR=${lsStats.wr}%, EV=$${lsStats.ev}`);
  console.log(`High Switch (Churn)     : N=${hsStats.n}, WR=${hsStats.wr}%, EV=$${hsStats.ev}`);
  
  const setupTypes = [...new Set(realFadeSetups.map(r => r.setup_type))];
  
  const metricFn = (type) => {
    const subset = realFadeSetups.filter(r => r.setup_type === type);
    const ls = [];
    const hs = [];
    for (const s of subset) {
      const d = new Date(s.trade_date).toISOString().split('T')[0];
      const dm = dayMetrics[d];
      if (!dm) continue;
      if (dm.switchPct <= 0.333) ls.push(s);
      else if (dm.switchPct >= 0.666) hs.push(s);
    }
    if (ls.length === 0 || hs.length === 0) return null;
    const lsStats = getStats(ls);
    const hsStats = getStats(hs);
    const diff = hsStats.ev - lsStats.ev; // EV difference
    return { n: ls.length + hs.length, value: diff, lsN: ls.length, hsN: hs.length, lsEV: lsStats.ev, hsEV: hsStats.ev };
  };
  
  const allStats = setupTypes.map(type => {
    return { type, metric: metricFn(type) };
  }).filter(x => x.metric !== null).sort((a, b) => b.metric.value - a.metric.value);
  
  console.log('\n--- Task 3.3: Per-setup breakdown (N>=20 total) ---');
  allStats.filter(x => x.metric.n >= 20).forEach(x => {
    console.log(`${x.type}: N=${x.metric.n} (LowSwitch: N=${x.metric.lsN}, EV=$${x.metric.lsEV} | HighSwitch: N=${x.metric.hsN}, EV=$${x.metric.hsEV}) -> Diff: $${x.metric.value.toFixed(2)}`);
  });
  
  const selectedIds = allStats.slice(0, 2).map(x => x.type);
  const rep = computeReplication(setupTypes, { idFn: u => u, metricFn, selectedIds });
  console.log('\n--- computeReplication (Top 2 by EV Diff vs Rest) ---');
  console.log(JSON.stringify(rep, null, 2));

  await client.end();
}
run().catch(console.error);
