import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { sweepOptimalStopAndTarget } from './update_optimal_stops.mjs';
import { computeCorrectedTarget } from '../server/services/targetCalibrationService.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const EXCLUDED = new Set(['OR_HIGH', 'OR_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR_MID',
  'OR_MID_AFTER_IB', 'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);
const RTH_START = 570, RTH_END = 960;
const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint, COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

function pct(arr, p) { 
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b); 
  return s[Math.min(s.length-1, Math.floor(p*s.length))]; 
}

async function main() {
  console.log('Loading full history of levels and bars...');
  const lvlRes = await query(`SELECT trade_date::text as d, level_name, price::float as price FROM level_prices`);
  const levelsByDate = new Map();
  for (const r of lvlRes.rows) {
    if (EXCLUDED.has(r.level_name)) continue;
    if (!levelsByDate.has(r.d)) levelsByDate.set(r.d, {});
    levelsByDate.get(r.d)[r.level_name] = r.price;
  }
  const levelNames = [...new Set(lvlRes.rows.map(r => r.level_name).filter(n => !EXCLUDED.has(n)))];
  const dates = [...levelsByDate.keys()].sort();

  const barsRes = await query(`
    SELECT ts, ts::date::text as d, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
      high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));
  console.log(`${levelNames.length} levels, ${dates.length} days, ${allBars.length} bars loaded.`);

  function firstIdxAtOrAfter(dateStr, todMin) {
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].d > dateStr) return i;
      if (allBars[i].d === dateStr && allBars[i].tod >= todMin) return i;
    }
    return -1;
  }

  const dayInfo = [];
  for (const d of dates) {
    const startIdx = firstIdxAtOrAfter(d, RTH_START);
    if (startIdx <= 0) continue;
    let rthEndIdx = allBars.length;
    for (let i = startIdx; i < allBars.length; i++) {
      if (allBars[i].d > d || (allBars[i].d === d && allBars[i].tod >= RTH_END)) { rthEndIdx = i; break; }
    }
    const wideStartTs = allBars[startIdx].ts - 15.5 * 3600 * 1000;
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts < wideStartTs) lo = mid + 1; else hi = mid; }
    const wideStartIdx = Math.max(lo, 1);

    dayInfo.push({ d, startIdx, rthEndIdx, wideStartIdx });
  }

  console.log('Scanning overnight touches with flat stop/target resolution...');
  const touchesByCombo = new Map();

  for (const x of dayInfo) {
    const lv = levelsByDate.get(x.d);
    if (!lv) continue;
    const isMonday = new Date(x.d + 'T12:00:00').getDay() === 1;
    const defaultStop = isMonday ? 60 : 90, defaultTarget = isMonday ? 30 : 40;

    for (const name of levelNames) {
      const lvl = lv[name];
      if (lvl == null) continue;
      for (let i = x.wideStartIdx + 1; i < x.startIdx; i++) {
        const b = allBars[i], prev = allBars[i - 1];
        if (Math.abs(b.close - lvl) > 15) continue;
        const dir = prev.close > lvl ? 'SHORT' : 'LONG';
        const long = dir === 'LONG';
        const entry = b.close;
        const comboName = `${name}_${dir}`;
        
        const stopPrice = long ? entry - defaultStop : entry + defaultStop;
        const targetPrice = long ? entry + defaultTarget : entry - defaultTarget;
        
        const r = resolve(allBars, i, dir, entry, stopPrice, targetPrice, x.rthEndIdx - i);
        const pnl = r.result === 'TARGET_HIT' ? defaultTarget * PNL_PER_POINT - COMMISSION
          : r.result === 'STOP_HIT' ? -(defaultStop * PNL_PER_POINT + COMMISSION) : r.pnl; // Note: actual_pnl from resolve can be used, but since it's flat, I'll use the precise values for stop/target hits. Wait, resolve returns pnl directly? The big moves script manually calculates pnl. Let's do it manually like the big moves script.

        if (!touchesByCombo.has(comboName)) touchesByCombo.set(comboName, []);
        touchesByCombo.get(comboName).push({
          fired_at: new Date(b.ts),
          entry_zone_low: entry,
          entry_zone_high: entry,
          mae_points: r.mae,
          mfe_points: r.mfe,
          actual_pnl: pnl,
          defaultStop,
          defaultTarget
        });
        break;
      }
    }
  }

  let stage1Pass = 0;
  let stage2Pass = 0;
  const topCombos = [];
  
  console.log(`Evaluating ${touchesByCombo.size} level+direction combinations...`);

  for (const [comboName, touches] of touchesByCombo.entries()) {
    const n = touches.length;
    const winRate = touches.filter(t => t.actual_pnl > 0).length / n;
    const evPerTrade = touches.reduce((s, t) => s + t.actual_pnl, 0) / n;
    
    const maes = touches.map(t => t.mae_points);
    const mfes = touches.map(t => t.mfe_points);
    const p25_mae = pct(maes, 0.25) || 0;
    const p40_mae = pct(maes, 0.40) || 0;
    const p50_mae = pct(maes, 0.50) || 0;
    const p60_mae = pct(maes, 0.60) || 0;
    const p75_mae = pct(maes, 0.75) || 0;
    const p50_mfe = pct(mfes, 0.50) || 0;
    const p75_mfe = pct(mfes, 0.75) || 0;

    let optStop = Math.round(p75_mae);
    let optTarget = Math.round(p50_mfe);
    let optEV = evPerTrade;
    let notes = { method: 'insufficient_data', exclusionReason: n < 20 ? 'insufficient_trade_count' : 'thin-tail' };

    let swept = null;
    let corrected = null;

    if (n >= 20) {
      const maeCandidates = [
        { value: p25_mae, pct: 0.25 },
        { value: p40_mae, pct: 0.40 },
        { value: p50_mae, pct: 0.50 },
        { value: p60_mae, pct: 0.60 },
        { value: p75_mae, pct: 0.75 }
      ];
      
      swept = sweepOptimalStopAndTarget(touches, maeCandidates, Math.round(p75_mfe), PNL_PER_POINT, PNL_PER_POINT, COMMISSION);
      
      if (swept) {
        stage1Pass++;
        optStop = swept.stop;
        optTarget = swept.target;
        optEV = swept.ev;
        notes = { method: 'EV-sweep' };
        
        const long = comboName.endsWith('_LONG');
        
        corrected = computeCorrectedTarget({
          trades: touches,
          allBars,
          stop: optStop,
          oldTarget: optTarget,
          long,
          pnlPerPoint: PNL_PER_POINT,
          commission: COMMISSION
        });
        
        if (corrected && !corrected.exclusionReason) {
          stage2Pass++;
          const preCorrectionTarget = optTarget;
          optTarget = corrected.bestTarget;
          optEV = corrected.fullEv;
          notes = { method: 'corrected-resim', oldTarget: preCorrectionTarget, ...corrected };
        } else if (corrected) {
          notes = { method: 'EV-sweep', correctionAttempted: true, exclusionReason: corrected.exclusionReason, exclusionDetail: corrected.exclusionDetail };
        }
      }
    }
    
    topCombos.push({ comboName, n, optStop, optTarget, optEV, winRate, passedStage1: !!swept, passedStage2: !!(corrected && !corrected.exclusionReason) });
    
    // Save to DB
    await query(`
      INSERT INTO performance_audit (
        run_date, window_days, signal_type, signal_name,
        sample_size, win_rate, ev_per_trade,
        p50_mae, p75_mae, p50_mfe, p75_mfe,
        optimal_stop, optimal_target, notes
      ) VALUES (
        CURRENT_DATE, 9999, 'OVERNIGHT_OPTIMAL_STOP', $1,
        $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11
      )
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size    = EXCLUDED.sample_size,
        win_rate       = EXCLUDED.win_rate,
        ev_per_trade   = EXCLUDED.ev_per_trade,
        p50_mae        = EXCLUDED.p50_mae,
        p75_mae        = EXCLUDED.p75_mae,
        p50_mfe        = EXCLUDED.p50_mfe,
        p75_mfe        = EXCLUDED.p75_mfe,
        optimal_stop   = EXCLUDED.optimal_stop,
        optimal_target = EXCLUDED.optimal_target,
        notes          = EXCLUDED.notes
    `, [
      comboName, n, winRate, optEV,
      p50_mae, p75_mae, p50_mfe, p75_mfe,
      optStop, optTarget, JSON.stringify(notes)
    ]);
  }
  
  topCombos.sort((a, b) => b.n - a.n);
  
  const report = `# Overnight Optimal Stop Calibration Results (2026-07-20)

## Overview
- Total Combinations Evaluated: ${touchesByCombo.size}
- Stage 1 Survivors (N>=20 & Thin-Tail Gate Passed): ${stage1Pass}
- Stage 2 Survivors (Corrected Resim): ${stage2Pass}

## Top 10 by Sample Size
| Setup | N | Stop | Target | EV | Stage 1 Pass | Stage 2 Pass |
|---|---|---|---|---|---|---|
${topCombos.slice(0, 10).map(c => `| ${c.comboName} | ${c.n} | ${c.optStop} | ${c.optTarget} | $${c.optEV.toFixed(2)} | ${c.passedStage1 ? 'Yes' : 'No'} | ${c.passedStage2 ? 'Yes' : 'No'} |`).join('\n')}

## All Setup Calibrations (N>=20)
| Setup | N | Stop | Target | EV | Method |
|---|---|---|---|---|---|
${topCombos.filter(c => c.n >= 20).map(c => `| ${c.comboName} | ${c.n} | ${c.optStop} | ${c.optTarget} | $${c.optEV.toFixed(2)} | ${c.passedStage2 ? 'corrected-resim' : (c.passedStage1 ? 'EV-sweep' : 'insufficient_data/thin-tail')} |`).join('\n')}
`;

  fs.writeFileSync('scratch/backtest_overnight_optimal_stop_RESULTS.md', report);
  
  const claimText = `Overnight OPTIMAL_STOP calibration ran on ${touchesByCombo.size} level+direction combinations. ${stage1Pass} cleared stage 1 (EV-sweep with N>=20 and thin-tail gate), and ${stage2Pass} additionally cleared stage 2 (corrected-resim). Surviving combinations received a calibrated target and stop derived directly from their own overnight MAE/MFE distribution, while failing combinations fell back to their raw p75 MAE and p50 MFE. Results persisted to performance_audit with signal_type='OVERNIGHT_OPTIMAL_STOP'.`;

  
  await recordClaim({
    slug: 'OVERNIGHT_OPTIMAL_STOP',
    claimText: claimText,
    sourceFile: 'scripts/calibrate_overnight_optimal_stops_20260720.mjs',
    sampleSize: touchesByCombo.size
  });
  
  console.log('Done.');
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
