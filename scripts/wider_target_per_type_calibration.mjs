import { query } from '../server/db.js';
import { resolveDirection, getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { stepWiderTarget, MAX_BARS_TO_T1_FOR_WIDER } from '../server/services/widerTargetWalker.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const WIDER_MULTIPLIERS = [1.0, 1.2, 1.5, 1.8, 2.0, 2.5];

async function runBacktest(includeUnknown) {
  const originFilter = includeUnknown ? "('ACTIVE', 'SHADOW', 'UNKNOWN')" : "('ACTIVE', 'SHADOW')";
  console.log(`Loading resolved trades with origin_status IN ${originFilter}...`);
  const tradesRes = await query(`
    SELECT id, setup_type, origin_status, status, 
      fired_at::text as fired_at,
      trade_date::text as trade_date,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level
    FROM active_setups
    WHERE origin_status IN ${originFilter}
      AND status IN ('RESOLVED', 'EXPIRED')
      AND t1_level IS NOT NULL AND stop_level IS NOT NULL AND entry_zone_low IS NOT NULL
  `);
  const allTrades = tradesRes.rows;
  console.log(`Loaded ${allTrades.length} candidate trades.`);

  const firedAtIds = allTrades.map(t => t.id);
  if (firedAtIds.length === 0) return { trades: [], summary: {} };

  const firedAtRes = await query(`
    SELECT id, extract(epoch from (fired_at AT TIME ZONE 'America/New_York'))*1000 as ms
    FROM active_setups WHERE id = ANY($1)
  `, [firedAtIds]);
  const firedAtMsById = new Map(firedAtRes.rows.map(r => [r.id, parseFloat(r.ms)]));
  for (const t of allTrades) t._firedAtMs = firedAtMsById.get(t.id);

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
    const startIdx = firstIndexAfter(trade._firedAtMs);
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
      if (barCount > 3000) { resolution = { resolution: 'RUNAWAY', priceAtRes: null }; break; }
    }
    
    const baselinePnl = Math.round((origDistance * PNL_PER_POINT - COMMISSION) * 100) / 100;
    
    let simPnl = null;
    if (resolution && resolution.priceAtRes != null) {
       const points = long ? resolution.priceAtRes - entry : entry - resolution.priceAtRes;
       simPnl = Math.round((points * PNL_PER_POINT - COMMISSION) * 100) / 100;
    }
    
    return { armed: armed || state.widening || resolution?.method === 'WIDER_TARGET_HIT' || resolution?.method === 'WIDER_STOP_HIT' || resolution?.method === 'WIDER_TIME_EXPIRED', resolution, baselinePnl, simPnl };
  }

  const eligibleTrades = [];
  for (const trade of allTrades) {
    const direction = resolveDirection(trade);
    if (!direction) continue;
    
    const dummySim = runSim(trade, direction, 1.5);
    if (!dummySim.armed) continue;
    
    const tradeResult = {
      trade, direction,
      trade_date: trade.trade_date,
      baselinePnl: dummySim.baselinePnl,
      multResults: {}
    };
    
    let valid = true;
    for (const mult of WIDER_MULTIPLIERS) {
      const res = runSim(trade, direction, mult);
      if (res.simPnl === null) valid = false;
      tradeResult.multResults[mult] = res;
    }
    if (valid) eligibleTrades.push(tradeResult);
  }

  function summarizeGroup(trades) {
    const summary = {};
    for (const mult of WIDER_MULTIPLIERS) {
      const events = trades.map(t => ({
        date: t.trade_date,
        delta: (mult === 1.0 ? t.baselinePnl : t.multResults[mult].simPnl) - t.baselinePnl,
        simPnl: (mult === 1.0 ? t.baselinePnl : t.multResults[mult].simPnl),
        baselinePnl: t.baselinePnl
      }));
      
      const meanDelta = events.reduce((s, e) => s + e.delta, 0) / events.length;
      const meanSimPnl = events.reduce((s, e) => s + e.simPnl, 0) / events.length;
      const wrVsBaseline = events.filter(e => e.delta > 0).length / events.length;
      
      const rigor = computeRigor(events, { dateField: 'date', pnlFn: e => e.delta });
      
      summary[mult] = { N: events.length, meanSimPnl, meanDelta, wrVsBaseline, rigor };
    }
    return summary;
  }

  const setupGroups = {};
  for (const t of eligibleTrades) {
    const st = t.trade.setup_type;
    if (!setupGroups[st]) setupGroups[st] = [];
    setupGroups[st].push(t);
  }

  return { eligibleTrades, setupGroups, summarizeGroup };
}

async function main() {
  const realRun = await runBacktest(false);
  const extRun = await runBacktest(true);

  let md = '# Wider Target Multiplier Calibration Results\n\n';

  function processRun(runName, runData, isReal) {
    const { eligibleTrades, setupGroups, summarizeGroup } = runData;
    let sectionMd = `## ${runName} (Armed N=${eligibleTrades.length})\n\n`;
    
    const typeResults = [];
    let totalImpactEvDelta = 0;
    
    for (const [st, trades] of Object.entries(setupGroups)) {
      const ds = summarizeGroup(trades);
      const N = trades.length;
      
      let winnerValue = 1.5;
      let winnerStr = '1.5x';
      let reason = '';
      let confidence = '';

      if (N < 20) {
        winnerStr = '1.5x';
        reason = 'default, insufficient real N';
        confidence = 'THIN';
      } else {
        let validCandidates = [];
        for (const cand of [1.2, 1.5, 1.8, 2.0, 2.5]) {
          const s = ds[cand];
          const prevCand = [1.0, 1.2, 1.5, 1.8, 2.0][ [1.2, 1.5, 1.8, 2.0, 2.5].indexOf(cand) ];
          const prevDelta = prevCand === 1.0 ? 0 : ds[prevCand].meanDelta;
          
          if (s.meanDelta > 0 && prevDelta >= 0 && s.rigor.clean) {
            validCandidates.push(cand);
          }
        }
        
        const isNetHarmful = [1.2, 1.5, 1.8, 2.0, 2.5].every(c => ds[c].meanDelta < 0);
        
        if (validCandidates.length > 0) {
          winnerValue = Math.max(...validCandidates);
          winnerStr = winnerValue + 'x';
          reason = 'CLEAN and Plateau';
          confidence = 'CLEAR';
        } else if (isNetHarmful) {
          winnerValue = 1.0;
          winnerStr = '1.0x';
          reason = 'holding for more is net harmful at all wider multipliers';
          confidence = 'CLEAR';
        } else {
          winnerStr = '1.5x';
          reason = 'default, no candidate cleared guardrails';
          confidence = 'GUARDRAIL-FAILED';
        }
      }
      
      let typeImpact = 0;
      for (const t of trades) {
         typeImpact += ((winnerValue === 1.0 ? t.baselinePnl : t.multResults[winnerValue].simPnl) - t.multResults[1.5].simPnl);
      }
      totalImpactEvDelta += typeImpact;
      
      typeResults.push({ st, N, winnerStr, confidence, reason, ds });
    }
    
    typeResults.sort((a, b) => b.N - a.N);
    
    sectionMd += '### Calibration Summary\n\n';
    sectionMd += '| Setup Type | Armed N | Calibrated Mult | Confidence | Reason |\n';
    sectionMd += '|---|---|---|---|---|\n';
    for (const r of typeResults) {
      sectionMd += `| ${r.st} | ${r.N} | **${r.winnerStr}** | ${r.confidence} | ${r.reason} |\n`;
    }
    
    sectionMd += `\n**Total Simulated $ Impact vs Flat 1.5x:** $${totalImpactEvDelta.toFixed(2)}\n\n`;
    
    sectionMd += '### Detailed Type Breakdowns\n\n';
    for (const r of typeResults) {
      sectionMd += `#### ${r.st} (N=${r.N})\n`;
      sectionMd += '| Multiplier | EV Delta vs 1.0x | Rigor Verdict |\n';
      sectionMd += '|---|---|---|\n';
      for (const mult of WIDER_MULTIPLIERS) {
        if (mult === 1.0) {
          sectionMd += `| 1.0x | $0.00 | BASELINE |\n`;
          continue;
        }
        const s = r.ds[mult];
        let rigorVerdict = 'THIN';
        if (r.N >= 20) {
           rigorVerdict = s.rigor.clean ? 'CLEAN' : 'UNSTABLE';
           if (s.rigor.clustered) rigorVerdict += ' (Clustered)';
           if (s.rigor.stable === false) rigorVerdict += ' (Degrading)';
        }
        sectionMd += `| ${mult}x | $${s.meanDelta.toFixed(2)} | ${rigorVerdict} |\n`;
      }
      sectionMd += '\n';
    }
    
    return sectionMd;
  }

  md += processRun('REAL HISTORY (ACTIVE + SHADOW only, ~6 weeks)', realRun, true);
  md += '---\n\n';
  md += processRun('EXTENDED/UNVERIFIED HISTORY — includes UNKNOWN and/or synthetic BACKFILL rows, not a real-trading claim', extRun, false);

  fs.writeFileSync('scratch/wider_target_per_type_full_history_RESULTS.md', md);
  console.log('Done.');
}

main().catch(console.error);
