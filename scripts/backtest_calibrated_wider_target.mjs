import { query } from '../server/db.js';
import { resolveDirection, getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { stepWiderTarget, MAX_BARS_TO_T1_FOR_WIDER } from '../server/services/widerTargetWalker.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const WIDER_MULTIPLIERS = [1.2, 1.5, 1.8, 2.0, 2.5];

async function main() {
  console.log('Loading real resolved trades...');
  const tradesRes = await query(`
    SELECT id, setup_type, origin_status, status, 
      fired_at::text as fired_at,
      extract(epoch from (fired_at AT TIME ZONE 'America/New_York'))*1000 as fired_at_ms,
      trade_date::text as trade_date,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level
    FROM active_setups
    WHERE origin_status IN ('ACTIVE', 'SHADOW')
      AND status IN ('RESOLVED', 'EXPIRED')
      AND t1_level IS NOT NULL AND stop_level IS NOT NULL AND entry_zone_low IS NOT NULL
  `);
  const allTrades = tradesRes.rows;
  console.log(`Loaded ${allTrades.length} candidate real trades.`);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`
    SELECT to_char(ts AT TIME ZONE 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS') as ts_et,
           extract(epoch from (ts AT TIME ZONE 'America/New_York'))*1000 as ts_ms,
           high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;
  console.log(`Loaded ${allBars.length} price bars.`);

  function firstIndexAfter(tsMs) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts_ms <= tsMs) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function runSim(trade, direction, mult) {
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const stop = trade.stop_level;
    const t1 = trade.t1_level;
    const origDistance = Math.abs(t1 - entry);
    const widerTarget = +(long ? entry + origDistance * mult : entry - origDistance * mult).toFixed(2);
    
    let state = { widening: false };
    const startIdx = firstIndexAfter(trade.fired_at_ms);
    let resolution = null;
    let armed = false;
    
    for (let i = startIdx; i < allBars.length; i++) {
      const barCount = i - startIdx + 1;
      const b = allBars[i];
      const bar = { ts: b.ts_et, high: b.high, low: b.low, close: b.close };
      
      const stepRes = stepWiderTarget(state, bar, { entry, stop, t1, widerTarget, long, barCount, maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER });
      
      if (!state.widening && stepRes.state.widening) {
        armed = true;
      }
      state = stepRes.state;
      
      if (stepRes.resolution) {
        resolution = stepRes.resolution;
        break;
      }
    }
    
    // baseline is deterministic: if it armed, it would have banked T1.
    const baselinePnl = Math.round((origDistance * PNL_PER_POINT - COMMISSION) * 100) / 100;
    
    let simPnl = null;
    if (resolution) {
       const points = long ? resolution.priceAtRes - entry : entry - resolution.priceAtRes;
       simPnl = Math.round((points * PNL_PER_POINT - COMMISSION) * 100) / 100;
    }
    
    return { armed, resolution, baselinePnl, simPnl };
  }

  console.log('Simulating trades...');
  const eligibleTrades = [];
  let noDirection = 0, notArmed = 0, invalidSim = 0;

  for (const trade of allTrades) {
    const direction = resolveDirection(trade);
    if (!direction) { noDirection++; continue; }
    
    // Run with 1.5 to check if it arms. Arming depends only on T1 and maxBarsToT1.
    const dummySim = runSim(trade, direction, 1.5);
    if (!dummySim.armed) { notArmed++; continue; }
    
    if (dummySim.simPnl === null) { invalidSim++; continue; }

    const tradeResult = {
      trade, direction,
      trade_date: trade.trade_date,
      baselinePnl: dummySim.baselinePnl,
      multResults: {}
    };
    
    for (const mult of WIDER_MULTIPLIERS) {
      tradeResult.multResults[mult] = runSim(trade, direction, mult);
    }
    eligibleTrades.push(tradeResult);
  }

  console.log(`Eligible (armed) trades: ${eligibleTrades.length}. (no dir: ${noDirection}, not armed: ${notArmed}, invalid sim: ${invalidSim})`);

  function summarizeGroup(trades) {
    const summary = {};
    for (const mult of WIDER_MULTIPLIERS) {
      const events = trades.map(t => ({
        date: t.trade_date,
        delta: t.multResults[mult].simPnl - t.baselinePnl,
        simPnl: t.multResults[mult].simPnl,
        baselinePnl: t.baselinePnl
      }));
      
      const meanDelta = events.reduce((s, e) => s + e.delta, 0) / events.length;
      const meanSimPnl = events.reduce((s, e) => s + e.simPnl, 0) / events.length;
      
      // WR = fraction of trades where simPnl > baselinePnl
      const wrVsBaseline = events.filter(e => e.delta > 0).length / events.length;
      // Absolute WR = fraction of trades where simPnl > 0
      const absWr = events.filter(e => e.simPnl > 0).length / events.length;

      const rigor = computeRigor(events, { dateField: 'date', pnlFn: e => e.delta });
      
      summary[mult] = {
        N: events.length,
        meanSimPnl,
        meanDelta,
        wrVsBaseline,
        absWr,
        rigor
      };
    }
    return summary;
  }

  const pooledSummary = summarizeGroup(eligibleTrades);
  
  const setupGroups = {};
  for (const t of eligibleTrades) {
    const st = t.trade.setup_type;
    if (!setupGroups[st]) setupGroups[st] = [];
    setupGroups[st].push(t);
  }
  
  const finalGroups = {};
  for (const [st, trades] of Object.entries(setupGroups)) {
    if (trades.length >= 20) {
      finalGroups[st] = { isBetClass: false, trades };
    } else {
      const bc = getBetClass(st);
      if (!finalGroups[bc]) finalGroups[bc] = { isBetClass: true, trades: [] };
      finalGroups[bc].trades.push(...trades);
    }
  }

  // Build the markdown report
  let md = '# Wider Target Multiplier Calibration Results\n\n';
  md += `## Pooled Results (All Armed Trades, N=${eligibleTrades.length})\n\n`;
  md += '| Multiplier | N | WR vs Baseline | Abs WR | Mean EV | EV Delta vs Baseline | Rigor Verdict |\n';
  md += '|---|---|---|---|---|---|---|\n';
  
  for (const mult of WIDER_MULTIPLIERS) {
    const s = pooledSummary[mult];
    let rigorVerdict = s.rigor.clean ? 'CLEAN' : 'UNSTABLE';
    if (s.rigor.clustered) rigorVerdict += ' (Clustered)';
    if (s.rigor.stable === false) rigorVerdict += ' (Degrading)';
    
    md += `| ${mult}x | ${s.N} | ${(s.wrVsBaseline*100).toFixed(1)}% | ${(s.absWr*100).toFixed(1)}% | $${s.meanSimPnl.toFixed(2)} | $${s.meanDelta.toFixed(2)} | ${rigorVerdict} |\n`;
  }
  
  md += '\n## Results by Setup Type / Bet Class\n\n';
  
  for (const [groupName, data] of Object.entries(finalGroups)) {
    const s = summarizeGroup(data.trades);
    const label = data.isBetClass ? `Bet Class: ${groupName}` : `Setup Type: ${groupName}`;
    md += `### ${label}\n\n`;
    md += '| Multiplier | N | WR vs Baseline | Mean EV | EV Delta vs Baseline | Rigor Verdict |\n';
    md += '|---|---|---|---|---|---|\n';
    
    for (const mult of WIDER_MULTIPLIERS) {
      const ds = s[mult];
      let rigorVerdict = 'THIN';
      if (ds.N >= 20) {
         rigorVerdict = ds.rigor.clean ? 'CLEAN' : 'UNSTABLE';
         if (ds.rigor.clustered) rigorVerdict += ' (Clustered)';
         if (ds.rigor.stable === false) rigorVerdict += ' (Degrading)';
      }
      
      md += `| ${mult}x | ${ds.N} | ${(ds.wrVsBaseline*100).toFixed(1)}% | $${ds.meanSimPnl.toFixed(2)} | $${ds.meanDelta.toFixed(2)} | ${rigorVerdict} |\n`;
    }
    md += '\n';
  }

  md += '\n## Recommendation\n';
  md += '*(To be filled by Antigravity after reviewing the results)*\n';

  fs.writeFileSync('scratch/wider_target_multiplier_calibration_RESULTS.md', md);
  console.log('Results written to scratch/wider_target_multiplier_calibration_RESULTS.md');
}

main().catch(console.error);
