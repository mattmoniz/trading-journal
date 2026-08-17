import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import fs from 'fs';
import path from 'path';

function etMinuteOfDay(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const h = +parts.find(p => p.type === 'hour').value;
  const m = +parts.find(p => p.type === 'minute').value;
  return h * 60 + m;
}

function etHHMM(ts) {
  const m = etMinuteOfDay(ts);
  const hh = Math.floor(m / 60).toString().padStart(2, '0');
  const mm = (m % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function getTimeBucket(ts) {
  const m = etMinuteOfDay(ts);
  if (m >= 570 && m < 660) return 'Morning (9:30-11:00)';
  if (m >= 660 && m < 810) return 'Midday (11:00-13:30)';
  if (m >= 810 && m < 960) return 'Afternoon (13:30-16:00)';
  return 'Overnight/Globex';
}

function getALevelAlignment(trade) {
  if (!trade.fired_at) return 'NEITHER';
  const firedTime = etHHMM(trade.fired_at);
  const dir = inferDirection(trade.setup_type);
  if (!dir) return 'NEITHER';

  let upTime = trade.a_up_fired && trade.a_up_time <= firedTime ? trade.a_up_time : null;
  let downTime = trade.a_down_fired && trade.a_down_time <= firedTime ? trade.a_down_time : null;

  if (upTime && downTime) {
    if (upTime > downTime) downTime = null;
    else upTime = null;
  }

  if (dir === 'LONG') {
    if (upTime) return 'WITH_A';
    if (downTime) return 'AGAINST_A';
    return 'NEITHER';
  } else {
    if (downTime) return 'WITH_A';
    if (upTime) return 'AGAINST_A';
    return 'NEITHER';
  }
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values) {
  if (values.length <= 1) return null;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

async function main() {
  const tradesRes = await query(`
    SELECT t.setup_type, t.fired_at, t.resolved_at, t.entry_zone_low::float as entry_zone_low,
      t.entry_zone_high::float as entry_zone_high, t.t1_level::float as t1_level,
      t.mae_points::float as mae_points, t.mfe_points::float as mfe_points, t.origin_status,
      t.bars_to_resolution, d.a_up_fired, d.a_up_time, d.a_down_fired, d.a_down_time
    FROM active_setups t
    LEFT JOIN acd_daily_log d ON t.trade_date = d.trade_date
    WHERE t.resolution = 'TARGET_HIT' 
      AND t.mae_points IS NOT NULL AND t.mfe_points IS NOT NULL
      AND t.entry_zone_low IS NOT NULL AND t.entry_zone_high IS NOT NULL 
      AND t.t1_level IS NOT NULL AND t.resolved_at IS NOT NULL
  `);
  
  let validTrades = tradesRes.rows.filter(t => inferDirection(t.setup_type) !== null);

  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const horizons = [15, 30, 60, 120, 240];

  for (let trade of validTrades) {
    trade.direction = inferDirection(trade.setup_type);
    trade.entry = trade.direction === 'LONG' ? (trade.entry_zone_high ?? trade.entry_zone_low) : (trade.entry_zone_low ?? trade.entry_zone_high);
    // Actually the acd.js entry convention: entry_zone_high ?? entry_zone_low
    trade.entry = trade.entry_zone_high ?? trade.entry_zone_low; 
    
    trade.timeBucket = getTimeBucket(trade.resolved_at);
    trade.aLevelAlignment = getALevelAlignment(trade);
    
    const resolvedTime = new Date(trade.resolved_at).getTime();
    const startIdx = firstIndexAfter(resolvedTime);
    
    trade.excursions = {};
    for (let h of horizons) {
      if (startIdx + h - 1 < allBars.length) {
        const bar = allBars[startIdx + h - 1];
        const fav = trade.direction === 'LONG' ? bar.high - trade.entry : trade.entry - bar.low;
        trade.excursions[h] = fav;
      } else {
        trade.excursions[h] = null;
      }
    }
  }

  // Velocity terciles
  const velocities = validTrades.map(t => t.bars_to_resolution).filter(v => v !== null).sort((a,b)=>a-b);
  const t1Idx = Math.floor(velocities.length / 3);
  const t2Idx = Math.floor(velocities.length * 2 / 3);
  const velT1 = velocities[t1Idx];
  const velT2 = velocities[t2Idx];
  
  for (let trade of validTrades) {
    if (trade.bars_to_resolution == null) trade.velocityBucket = 'Unknown';
    else if (trade.bars_to_resolution <= velT1) trade.velocityBucket = 'Fast';
    else if (trade.bars_to_resolution <= velT2) trade.velocityBucket = 'Medium';
    else trade.velocityBucket = 'Slow';
  }

  const outRows = [];
  const modes = ['ALL', 'REAL_ONLY'];

  for (let mode of modes) {
    const pop = validTrades.filter(t => mode === 'ALL' || ['ACTIVE', 'SHADOW'].includes(t.origin_status));
    
    let backfillCount = pop.filter(t => !['ACTIVE', 'SHADOW'].includes(t.origin_status)).length;
    let pctBackfill = (backfillCount / pop.length * 100).toFixed(1);

    const baselines = {};
    for (let h of horizons) {
      const vals = pop.map(t => t.excursions[h]).filter(v => v !== null);
      baselines[h] = { mean: mean(vals), median: median(vals) };
    }

    const slices = [];
    // Setup type
    const bySetup = {};
    pop.forEach(t => { (bySetup[t.setup_type] ||= []).push(t); });
    for (const [k, v] of Object.entries(bySetup)) slices.push({ category: 'setup_type', name: k, trades: v });
    
    // Time of day
    const byTime = {};
    pop.forEach(t => { (byTime[t.timeBucket] ||= []).push(t); });
    for (const [k, v] of Object.entries(byTime)) slices.push({ category: 'time_of_day', name: k, trades: v });
    
    // Velocity
    const byVel = {};
    pop.forEach(t => { (byVel[t.velocityBucket] ||= []).push(t); });
    for (const [k, v] of Object.entries(byVel)) slices.push({ category: 'velocity', name: k, trades: v });
    
    // A-Level
    const byA = {};
    pop.forEach(t => { (byA[t.aLevelAlignment] ||= []).push(t); });
    for (const [k, v] of Object.entries(byA)) slices.push({ category: 'a_level', name: k, trades: v });

    for (let slice of slices) {
      for (let h of horizons) {
        const vals = slice.trades.map(t => t.excursions[h]).filter(v => v !== null);
        const n = vals.length;
        const missing = slice.trades.length - n;
        
        const m = mean(vals);
        const med = median(vals);
        const stdev = stddev(vals);
        
        const baselineMean = baselines[h].mean;
        const baselineMed = baselines[h].median;
        
        const delta = m !== null && baselineMean !== null ? m - baselineMean : null;
        
        outRows.push({
          mode,
          pop_n: pop.length,
          pct_backfill: pctBackfill,
          category: slice.category,
          slice_name: slice.name,
          horizon: h,
          n,
          missing_horizon: missing,
          baseline_mean: baselineMean,
          baseline_med: baselineMed,
          mean: m,
          median: med,
          stddev: stdev,
          delta_mean: delta,
          status: n >= 20 ? 'OK' : 'INSUFFICIENT'
        });
      }
    }
  }

  const csvLines = ['mode,pop_n,pct_backfill,category,slice_name,horizon,n,missing_horizon,baseline_mean,baseline_median,slice_mean,slice_median,slice_stddev,delta_mean,status'];
  for (let r of outRows) {
    csvLines.push(`${r.mode},${r.pop_n},${r.pct_backfill},${r.category},${r.slice_name},${r.horizon},${r.n},${r.missing_horizon},${r.baseline_mean?.toFixed(2)},${r.baseline_med?.toFixed(2)},${r.mean?.toFixed(2)},${r.median?.toFixed(2)},${r.stddev?.toFixed(2)},${r.delta_mean?.toFixed(2)},${r.status}`);
  }
  
  const reportPath = path.join(process.cwd(), 'reports', 'post_t1_continuation_slices_2026-08-16.csv');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, csvLines.join('\n'));
  
  console.log('Report generated at ' + reportPath);
  
  const okRows = outRows.filter(r => r.status === 'OK' && r.delta_mean > 0 && r.n >= 20);
  const bySlice = {};
  for (let r of okRows) {
    const key = r.mode + '|' + r.category + '|' + r.slice_name;
    (bySlice[key] ||= []).push(r);
  }
  
  const persistent = [];
  for (let [key, rows] of Object.entries(bySlice)) {
    if (rows.length >= 3) {
      persistent.push(key);
    }
  }
  
  console.log("Persistent positive delta slices (N>=20, >=3 horizons):", persistent);
}

main().catch(console.error);
