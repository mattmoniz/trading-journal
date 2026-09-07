import { Client } from 'pg';
import { getLiveDayTypeRead } from '../server/services/caseEngine.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { stepWiderTarget } from '../server/services/widerTargetWalker.js';
import fs from 'fs';

const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'trading_journal',
  user: 'gemini_readonly',
  password: 'gemini_ro_2026'
});

async function run() {
  await client.connect();
  
  // 1. Get all real active_setups with their resolution times
  const query = `
    SELECT
      a.id, a.trade_date, a.setup_type, a.actual_pnl, a.resolution, a.entry_zone_high, a.entry_zone_low, a.stop_level, a.t1_level, a.origin_status,
      extract(epoch from (a.fired_at AT TIME ZONE 'America/New_York'))*1000 as fired_ms,
      (EXTRACT(hour FROM a.fired_at AT TIME ZONE 'America/New_York')*60 + EXTRACT(minute FROM a.fired_at AT TIME ZONE 'America/New_York'))::int as fired_et_min,
      (EXTRACT(hour FROM a.resolved_at AT TIME ZONE 'America/New_York')*60 + EXTRACT(minute FROM a.resolved_at AT TIME ZONE 'America/New_York'))::int as resolved_et_min
    FROM active_setups a
    WHERE a.origin_status IN ('ACTIVE', 'SHADOW')
      AND a.actual_pnl IS NOT NULL
      AND a.fired_at IS NOT NULL
      AND a.resolved_at IS NOT NULL
  `;
  const { rows: setups } = await client.query(query);
  setups.forEach(s => s.actual_pnl = parseFloat(s.actual_pnl));
  
  // Need to get all price bars for these days
  const tradeDates = [...new Set(setups.map(s => {
    const d = new Date(s.trade_date);
    return d.toISOString().split('T')[0];
  }))];
  
  const barsRes = await client.query(`
    SELECT DATE(ts) as trade_date,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      ts, open, high, low, close
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND DATE(ts) = ANY($1)
    ORDER BY ts ASC
  `, [tradeDates]);
  
  const barsByDate = {};
  barsRes.rows.forEach(b => {
    const d = new Date(b.trade_date).toISOString().split('T')[0];
    if (!barsByDate[d]) barsByDate[d] = [];
    b.open = parseFloat(b.open);
    b.high = parseFloat(b.high);
    b.low = parseFloat(b.low);
    b.close = parseFloat(b.close);
    b.mod = b.et_min;
    barsByDate[d].push(b);
  });
  
  // Calculate IB range rolling tercile.
  // Wait, I need the IB range for ALL days to calculate rolling percentiles, not just trade dates.
  const allDaysRes = await client.query(`
    SELECT DATE(ts) as trade_date, MAX(high) - MIN(low) as ib_range
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    GROUP BY DATE(ts)
    ORDER BY DATE(ts)
  `);
  const allDays = allDaysRes.rows;
  
  const dayIbPct = {}; // trade_date -> pctile
  for (let i = 0; i < allDays.length; i++) {
    const r = allDays[i];
    r.ib_range = parseFloat(r.ib_range);
    
    // rolling window of 180 days PRECEDING
    const start = Math.max(0, i - 180);
    const window = allDays.slice(start, i).map(x => x.ib_range).sort((a, b) => a - b);
    let pct = 0;
    if (window.length > 0) {
      let smaller = 0;
      for (const w of window) { if (w <= r.ib_range) smaller++; }
      pct = smaller / window.length;
    }
    const d = new Date(r.trade_date).toISOString().split('T')[0];
    dayIbPct[d] = pct;
  }
  
  const results = [];
  
  for (const t of setups) {
    const d = new Date(t.trade_date).toISOString().split('T')[0];
    const pct = dayIbPct[d] || 0;
    if (pct < 0.666) continue; // Top tercile only!
    
    const dayBars = barsByDate[d];
    if (!dayBars) continue;
    const barsUpToRes = dayBars.filter(b => b.et_min <= t.resolved_et_min);
    if (barsUpToRes.length === 0) continue;
    
    const ibBars = dayBars.filter(b => b.et_min >= 570 && b.et_min <= 629);
    if (ibBars.length === 0) continue;
    const ibHigh = Math.max(...ibBars.map(b => b.high));
    const ibLow = Math.min(...ibBars.map(b => b.low));
    const orWidth = ibHigh - ibLow;
    const sessOpen = dayBars[0].open;
    
    // LIVE reassessment up to resolved_at
    let liveRead;
    try {
      liveRead = await getLiveDayTypeRead({
        tradeDate: d,
        asOfMinutes: t.resolved_et_min,
        bars: barsUpToRes,
        sessOpen,
        ibHigh,
        ibLow,
        nl30: 0,
        orWidth
      });
    } catch (e) {
      continue;
    }
    
    if (liveRead.reassessed && liveRead.finalRead === 'TURBULENT') {
      // Simulate hold longer vs status quo
      // Hold longer variant: stepWiderTarget
      const long = t.setup_type.includes('LONG') || t.setup_type.includes('BULLISH'); // approx
      // Wait, let's look at setup_type.
      const isLong = !t.setup_type.includes('SHORT') && !t.setup_type.includes('BEARISH');
      const entry = isLong ? parseFloat(t.entry_zone_high) : parseFloat(t.entry_zone_low);
      const stop = parseFloat(t.stop_level);
      const t1 = parseFloat(t.t1_level);
      
      const effectiveBase = Math.abs(t1 - entry);
      const widerTarget = isLong ? entry + effectiveBase * 1.5 : entry - effectiveBase * 1.5;
      
      let state = { widening: false };
      let res = null;
      let barCount = 1;
      
      const walkBars = dayBars.filter(b => b.et_min >= t.fired_et_min);
      for (const bar of walkBars) {
        const r = stepWiderTarget(state, bar, {
          entry, stop, t1, widerTarget, long: isLong, barCount, maxBarsToT1: 4, firedMod: t.fired_et_min
        });
        state = r.state;
        if (r.resolution) {
          res = r.resolution;
          break;
        }
        barCount++;
      }
      
      if (!res && walkBars.length > 0) {
         res = { priceAtRes: walkBars[walkBars.length - 1].close };
      }
      
      if (res) {
        const pts = isLong ? res.priceAtRes - entry : entry - res.priceAtRes;
        const proposedPnl = pts * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip;
        
        results.push({
          trade_date: d,
          delta: proposedPnl - t.actual_pnl
        });
      }
    }
  }
  
  console.log(`\n--- Task 2 Results ---`);
  console.log(`Valid setups: ${results.length}`);
  
  if (results.length > 0) {
    const meanDelta = results.reduce((s, r) => s + r.delta, 0) / results.length;
    console.log(`Mean P&L delta (hold-longer - status-quo) = $${meanDelta.toFixed(2)}`);
    
    const rCheck = computeRigor(results, { dateField: 'trade_date', pnlFn: x => x.delta });
    console.log('Rigor:', JSON.stringify(rCheck, null, 2));
  }
  
  await client.end();
}
run().catch(console.error);
