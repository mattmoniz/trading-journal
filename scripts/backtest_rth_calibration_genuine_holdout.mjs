// KNOWN CONFOUND, found and confirmed 2026-08-05 -- do not trust this script's headline result
// as-is. RESEARCH_CLAIM rth_calibration_genuine_holdout_test / OPEN_DECISION
// rth_holdout_test_needs_chronological_evaluation: the per-touch evaluation loop below (~line
// 211-230) uses an order-blind check (`if (mae > stop) ... else if (mfe >= target)`, no regard
// for which happened first chronologically) -- the same defect class as
// sweepOptimalStopAndTarget()'s own confirmed bug, just reproduced here in the TEST/evaluation
// step, not just calibration. This systematically favors whichever compared arm has the WIDER
// stop. Confirmed on the first real run: the "winning" Calib arm averaged 79.7pt stops across the
// 15 tested setup_types vs Live's 52.9pt and Flat's constant 32pt -- a width gap large enough to
// plausibly explain most of the reported EV gap on its own, independent of any genuine edge. Kept
// on disk because the touch-reconstruction (bar-history level-touch detection, uncensored MAE/MFE
// walk) and rigor-check machinery are likely still reusable -- only the outcome-determination
// logic needs a real bar-by-bar chronological walk (matching resolveSetupsByPrice()'s own
// convention) before this result can be trusted either direction.
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { LEVEL_FADE_DEFINITIONS } from '../server/config/setupDefinitions.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { sweepOptimalStopAndTarget, DEFAULT_DPP, computeEvAtStopTarget } from './update_optimal_stops.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const TARGET_SETUPS = [
  'OR_LOW_FADE_LONG',
  'OR_HIGH_FADE_SHORT',
  'IB_HIGH_FADE_SHORT',
  'IB_LOW_FADE_LONG',
  'RTH_VWAP_FADE_LONG',
  'RTH_VWAP_FADE_SHORT',
  'ONL_FADE_LONG',
  'ONH_FADE_SHORT',
  'DAILY_OPEN_FADE_SHORT',
  'DAILY_OPEN_FADE_LONG',
  'CAM_S2_FADE_LONG',
  'CAM_S3_FADE_LONG',
  'CAM_S1_FADE_LONG',
  'CAM_R3_FADE_SHORT',
  'CAM_R2_FADE_SHORT'
];

const CUTOFF_DATE = '2025-08-05';
const DPP = DEFAULT_DPP;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const idx = Math.floor(arr.length * p);
  return arr[idx];
}

async function main() {
  console.log('Loading all NQ bars into memory...');
  const res = await query(`
    SELECT 
      ts::date::text as trade_date,
      ts::text as ts_text,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod,
      close::float, high::float, low::float,
      volume::float as volume
    FROM price_bars_primary 
    WHERE symbol='NQ'
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `);

  const barsByDay = new Map();
  for (const b of res.rows) {
    if (!barsByDay.has(b.trade_date)) barsByDay.set(b.trade_date, []);
    barsByDay.get(b.trade_date).push(b);
  }

  console.log('Loading level_prices...');
  const levelsRes = await query(`
    SELECT trade_date::text, level_name, price::float
    FROM level_prices
  `);
  const levelsByDay = new Map();
  for (const r of levelsRes.rows) {
    if (!levelsByDay.has(r.trade_date)) levelsByDay.set(r.trade_date, new Map());
    levelsByDay.get(r.trade_date).set(r.level_name, r.price);
  }

  console.log('Loading current LIVE optimal stops for comparison...');
  const liveStopsRes = await query(`
    SELECT signal_name as setup_type, optimal_stop::float as stop, optimal_target::float as target
    FROM performance_audit
    WHERE signal_type = 'OPTIMAL_STOP'
      AND run_date = (SELECT MAX(run_date) FROM performance_audit WHERE signal_type = 'OPTIMAL_STOP')
  `);
  const liveValues = new Map();
  const allStops = [];
  const allTargets = [];
  for (const r of liveStopsRes.rows) {
    liveValues.set(r.setup_type, { stop: r.stop, target: r.target });
    if (r.stop) allStops.push(r.stop);
    if (r.target) allTargets.push(r.target);
  }
  
  allStops.sort((a,b)=>a-b);
  allTargets.sort((a,b)=>a-b);
  const flatStop = percentile(allStops, 0.5) || 65;
  const flatTarget = percentile(allTargets, 0.5) || 35;
  console.log(`Flat baseline chosen: Stop=${flatStop}pt, Target=${flatTarget}pt (median of all live calibrated values)`);

  const allTouches = [];

  console.log('Reconstructing touches...');
  for (const [date, bars] of barsByDay.entries()) {
    const dayLevels = levelsByDay.get(date) || new Map();
    const runningVwap = computeRunningVwapSeries(bars);
    
    const firedToday = new Set();
    
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const vwapNow = runningVwap[i];
      
      for (const setupType of TARGET_SETUPS) {
        if (firedToday.has(setupType)) continue;
        
        const isLong = setupType.includes('_LONG');
        const baseLevelName = setupType.replace(/_FADE_(LONG|SHORT)$/, '');
        
        let levelPrice = null;
        let formationGate = null;
        
        if (baseLevelName === 'RTH_VWAP') {
          levelPrice = vwapNow;
          formationGate = 570;
        } else {
          levelPrice = dayLevels.get(baseLevelName);
          const def = LEVEL_FADE_DEFINITIONS[baseLevelName];
          formationGate = def ? (def.formationGate || 570) : 570;
        }
        
        if (levelPrice == null) continue;
        if (bar.mod < formationGate) continue;
        
        if (Math.abs(bar.close - levelPrice) <= 15) {
          firedToday.add(setupType);
          
          let mae = 0;
          let mfe = 0;
          const entry = bar.close;
          const endClose = bars[bars.length - 1].close;
          const expirePnlPoints = isLong ? (endClose - entry) : (entry - endClose);
          const actualPnl = expirePnlPoints * DPP - COMM;
          
          for (let j = i + 1; j < bars.length; j++) {
            const adverse = isLong ? entry - bars[j].low : bars[j].high - entry;
            const favorable = isLong ? bars[j].high - entry : entry - bars[j].low;
            if (adverse > mae) mae = adverse;
            if (favorable > mfe) mfe = favorable;
          }
          
          allTouches.push({
            date,
            setupType,
            entry,
            mae,
            mfe,
            isLong,
            actualPnl
          });
        }
      }
    }
  }

  console.log(`Found ${allTouches.length} total touches.`);
  
  const trainTouches = allTouches.filter(t => t.date < CUTOFF_DATE);
  const testTouches = allTouches.filter(t => t.date >= CUTOFF_DATE);
  
  console.log(`Train (before ${CUTOFF_DATE}): ${trainTouches.length}`);
  console.log(`Test (on/after ${CUTOFF_DATE}): ${testTouches.length}`);
  
  let aggCalibPnl = 0, aggFlatPnl = 0, aggLivePnl = 0;
  let aggCalibWin = 0, aggFlatWin = 0, aggLiveWin = 0;
  let totalTestN = 0;

  const typeResults = [];

  for (const setupType of TARGET_SETUPS) {
    const trainGroup = trainTouches.filter(t => t.setupType === setupType);
    if (trainGroup.length < 20) {
      console.log(`Skipping ${setupType} - insufficient train N (${trainGroup.length})`);
      continue;
    }
    
    const maes = trainGroup.map(t => t.mae).sort((a,b)=>a-b);
    const mfes = trainGroup.map(t => t.mfe).sort((a,b)=>a-b);
    
    const maeCandidates = [
      { value: percentile(maes, 0.25), pct: 0.25 },
      { value: percentile(maes, 0.40), pct: 0.40 },
      { value: percentile(maes, 0.50), pct: 0.50 },
      { value: percentile(maes, 0.60), pct: 0.60 },
      { value: percentile(maes, 0.75), pct: 0.75 }
    ];
    const maxT = percentile(mfes, 0.75);
    
    const sweepTrades = trainGroup.map(t => ({
      mae_points: t.mae,
      mfe_points: t.mfe,
      actual_pnl: t.actualPnl
    }));
    
    const swept = sweepOptimalStopAndTarget(sweepTrades, maeCandidates, maxT, DPP, DPP, COMM);
    if (!swept) {
      console.log(`Skipping ${setupType} - sweep failed.`);
      continue;
    }
    const { stop: calibStop, target: calibTarget } = swept;
    
    const liveStopData = liveValues.get(setupType);
    const liveStop = liveStopData?.stop || 65;
    const liveTarget = liveStopData?.target || 35;
    
    const testGroup = testTouches.filter(t => t.setupType === setupType);
    totalTestN += testGroup.length;
    
    // Evaluate three models on testGroup
    let cPnl = 0, cWin = 0;
    let fPnl = 0, fWin = 0;
    let lPnl = 0, lWin = 0;
    
    for (const t of testGroup) {
      // Calib
      if (t.mae > calibStop) { cPnl += -calibStop * DPP - COMM; }
      else if (t.mfe >= calibTarget) { cPnl += calibTarget * DPP - COMM; cWin++; }
      else { cPnl += t.actualPnl; if (t.actualPnl > 0) cWin++; }
      
      // Flat
      if (t.mae > flatStop) { fPnl += -flatStop * DPP - COMM; }
      else if (t.mfe >= flatTarget) { fPnl += flatTarget * DPP - COMM; fWin++; }
      else { fPnl += t.actualPnl; if (t.actualPnl > 0) fWin++; }
      
      // Live
      if (t.mae > liveStop) { lPnl += -liveStop * DPP - COMM; }
      else if (t.mfe >= liveTarget) { lPnl += liveTarget * DPP - COMM; lWin++; }
      else { lPnl += t.actualPnl; if (t.actualPnl > 0) lWin++; }
    }
    
    aggCalibPnl += cPnl; aggCalibWin += cWin;
    aggFlatPnl += fPnl; aggFlatWin += fWin;
    aggLivePnl += lPnl; aggLiveWin += lWin;
    
    typeResults.push({
      setupType,
      n: testGroup.length,
      calib: { stop: calibStop, target: calibTarget, pnl: cPnl, winRate: testGroup.length ? cWin/testGroup.length : 0, ev: testGroup.length ? cPnl/testGroup.length : 0 },
      flat: { pnl: fPnl, winRate: testGroup.length ? fWin/testGroup.length : 0, ev: testGroup.length ? fPnl/testGroup.length : 0 },
      live: { stop: liveStop, target: liveTarget, pnl: lPnl, winRate: testGroup.length ? lWin/testGroup.length : 0, ev: testGroup.length ? lPnl/testGroup.length : 0 },
      testGroup // for rigor
    });
    
    console.log(`[${setupType}] Test N=${testGroup.length}`);
    console.log(`  Calib (${calibStop}/${calibTarget}): EV=$${(testGroup.length ? cPnl/testGroup.length : 0).toFixed(2)} WR=${(testGroup.length ? cWin/testGroup.length*100 : 0).toFixed(1)}%`);
    console.log(`  Flat  (${flatStop}/${flatTarget}): EV=$${(testGroup.length ? fPnl/testGroup.length : 0).toFixed(2)} WR=${(testGroup.length ? fWin/testGroup.length*100 : 0).toFixed(1)}%`);
    console.log(`  Live  (${liveStop}/${liveTarget}): EV=$${(testGroup.length ? lPnl/testGroup.length : 0).toFixed(2)} WR=${(testGroup.length ? lWin/testGroup.length*100 : 0).toFixed(1)}%`);
  }
  
  console.log(`\n=== AGGREGATE RESULTS (Holdout >= ${CUTOFF_DATE}, N=${totalTestN}) ===`);
  const cEv = totalTestN ? aggCalibPnl / totalTestN : 0;
  const fEv = totalTestN ? aggFlatPnl / totalTestN : 0;
  const lEv = totalTestN ? aggLivePnl / totalTestN : 0;
  
  console.log(`Calib (Honest Train): PnL=$${aggCalibPnl.toFixed(2)}, EV=$${cEv.toFixed(2)}, WR=${(totalTestN ? aggCalibWin/totalTestN*100 : 0).toFixed(1)}%`);
  console.log(`Flat Baseline       : PnL=$${aggFlatPnl.toFixed(2)}, EV=$${fEv.toFixed(2)}, WR=${(totalTestN ? aggFlatWin/totalTestN*100 : 0).toFixed(1)}%`);
  console.log(`Live (Contaminated) : PnL=$${aggLivePnl.toFixed(2)}, EV=$${lEv.toFixed(2)}, WR=${(totalTestN ? aggLiveWin/totalTestN*100 : 0).toFixed(1)}%`);
  
  const winner = (cEv > fEv) ? 'Calib' : 'Flat';
  
  let bestEvents = [];
  for (const r of typeResults) {
    for (const t of r.testGroup) {
      let pnl = 0;
      if (winner === 'Calib') {
        const cS = r.calib.stop, cT = r.calib.target;
        if (t.mae > cS) pnl = -cS*DPP - COMM;
        else if (t.mfe >= cT) pnl = cT*DPP - COMM;
        else pnl = t.actualPnl;
      } else {
        if (t.mae > flatStop) pnl = -flatStop*DPP - COMM;
        else if (t.mfe >= flatTarget) pnl = flatTarget*DPP - COMM;
        else pnl = t.actualPnl;
      }
      bestEvents.push({ date: t.date, pnl });
    }
  }
  
  bestEvents.sort((a,b) => a.date.localeCompare(b.date));
  
  console.log(`\nComputing rigor for best arm (${winner})...`);
  const rigor = computeRigor(bestEvents, { dateField: 'date', pnlFn: e => e.pnl });
  console.log(`Rigor: DistinctDates=${rigor.distinctDates}, Top5DayPct=${rigor.top5DayPct}%, Stable=${rigor.stable}, Clean=${rigor.clean}`);
  if (rigor.thirds) console.log(`  Thirds: EV1=$${rigor.thirds.ev1}, EV2=$${rigor.thirds.ev2}, EV3=$${rigor.thirds.ev3}`);
  
  const text = (cEv > fEv) 
    ? `RTH calibration pipeline is valid on uncensored data. Honest train/test calibration beat the flat baseline (EV $${cEv.toFixed(2)} vs $${fEv.toFixed(2)}) over ${totalTestN} held-out touches.` 
    : `RTH calibration pipeline is OVERFITTING. A flat uniform baseline beat honest per-setup calibration (EV $${fEv.toFixed(2)} vs $${cEv.toFixed(2)}) over ${totalTestN} held-out touches.`;
    
  // Fixed 2026-08-05 (pre-commit hook caught it): JS new Date().toISOString() is UTC, the DB
  // server runs America/New_York -- the two disagree once past 8PM ET. CURRENT_DATE::text is the
  // established fix per CLAUDE.md's "no static thresholds"/trading-day-date hard rule.
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  await recordClaim({
    slug: 'rth_calibration_genuine_holdout_test',
    claimText: text,
    sourceFile: 'scripts/backtest_rth_calibration_genuine_holdout.mjs',
    sourceDate: today,
    sampleSize: totalTestN,
    winRate: winner === 'Calib' ? (totalTestN ? aggCalibWin/totalTestN : 0) : (totalTestN ? aggFlatWin/totalTestN : 0),
    evPerTrade: winner === 'Calib' ? cEv : fEv,
    rigorStatus: rigor.clean ? 'clean' : 'failed'
  });
  console.log('Claim recorded.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
