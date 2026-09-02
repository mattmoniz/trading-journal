import fs from 'fs';
import { query } from '../server/db.js';
import { recordClaim } from './record_claim.mjs';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

function getSessionTime(hr, min) {
  let t = hr * 60 + min;
  if (t >= 18 * 60) {
     t -= 24 * 60;
  }
  return t;
}

async function main() {
  console.log("Fetching NQ 1-minute price bars...");
  const r = await query(`
    SELECT 
      ts, 
      ts::date::text as d, 
      EXTRACT(hour FROM ts)::int as hr, 
      EXTRACT(minute FROM ts)::int as min, 
      open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND (EXTRACT(hour FROM ts) >= 18 OR EXTRACT(hour FROM ts) <= 8)
    ORDER BY ts
  `);
  
  const bySession = new Map();
  for (const b of r.rows) {
    let sessDate;
    if (b.hr >= 18) {
      const dt = new Date(b.d + 'T12:00:00Z'); 
      dt.setUTCDate(dt.getUTCDate() + 1);
      sessDate = dt.toISOString().slice(0, 10);
    } else {
      sessDate = b.d;
    }
    if (!bySession.has(sessDate)) bySession.set(sessDate, []);
    b.sessTime = getSessionTime(b.hr, b.min);
    bySession.get(sessDate).push(b);
  }

  const validSessions = [];
  
  for (const [sessDate, bars] of bySession.entries()) {
    // Sort bars by sessTime to be strictly chronological
    bars.sort((a, b) => a.sessTime - b.sessTime);
    
    const bar0230 = bars.find(b => b.sessTime === 150); // 02:30 is 150
    const bar0330 = bars.find(b => b.sessTime === 210); // 03:30 is 210
    
    if (!bar0230 || !bar0330) continue;
    
    const mom60 = bar0330.close - bar0230.close;
    if (mom60 === 0) continue;
    
    const volBars = bars.filter(b => b.sessTime > 150 && b.sessTime <= 210);
    if (volBars.length < 60) continue;
    
    const vol60 = volBars.reduce((sum, b) => sum + (b.high - b.low), 0) / volBars.length;
    if (vol60 === 0) continue;
    
    const entryIdx = bars.findIndex(b => b.sessTime > 210);
    if (entryIdx === -1) continue;
    const entryBar = bars[entryIdx];
    
    const postEntryBars = bars.slice(entryIdx).filter(b => b.sessTime <= 390); // 06:30 is 390
    if (postEntryBars.length === 0) continue;
    
    const direction = mom60 > 0 ? -1 : 1;
    
    validSessions.push({
      sessDate,
      mom60,
      vol60,
      direction,
      entryBar,
      postEntryBars
    });
  }
  
  const combos = [
    {stop: 1.0, target: 1.0},
    {stop: 1.0, target: 1.5},
    {stop: 1.0, target: 2.0},
    {stop: 1.5, target: 1.5},
    {stop: 1.5, target: 2.0}
  ];
  
  // Tercile computation
  const absMomList = validSessions.map(s => Math.abs(s.mom60)).sort((a,b) => a-b);
  const cutoffIdx = Math.floor(absMomList.length * 2 / 3);
  const tercileCutoff = absMomList[cutoffIdx];
  
  const dpp = LIVE_INSTRUMENT.dollarsPerPoint;
  const comm = LIVE_INSTRUMENT.commissionPerRoundTrip;
  
  function evalCombo(sessions, combo) {
    let N = 0;
    let wins = 0;
    let totalPnl = 0;
    let totalHoldMins = 0;
    let totalVolNormRet = 0;
    
    for (const s of sessions) {
      const stopDist = combo.stop * s.vol60;
      const targetDist = combo.target * s.vol60;
      const entryPrice = s.entryBar.open;
      
      const stopLevel = s.direction === 1 ? entryPrice - stopDist : entryPrice + stopDist;
      const targetLevel = s.direction === 1 ? entryPrice + targetDist : entryPrice - targetDist;
      
      let exitPrice = null;
      let exitBar = null;
      
      for (const b of s.postEntryBars) {
        let stopHit = false;
        let targetHit = false;
        
        if (s.direction === 1) { // LONG
          if (b.low <= stopLevel) stopHit = true;
          if (b.high >= targetLevel) targetHit = true;
        } else { // SHORT
          if (b.high >= stopLevel) stopHit = true;
          if (b.low <= targetLevel) targetHit = true;
        }
        
        if (stopHit && targetHit) {
          exitPrice = s.direction === 1 ? Math.min(b.open, stopLevel) : Math.max(b.open, stopLevel);
          exitBar = b;
          break;
        } else if (stopHit) {
          exitPrice = s.direction === 1 ? Math.min(b.open, stopLevel) : Math.max(b.open, stopLevel);
          exitBar = b;
          break;
        } else if (targetHit) {
          exitPrice = s.direction === 1 ? Math.max(b.open, targetLevel) : Math.min(b.open, targetLevel);
          exitBar = b;
          break;
        }
        
        if (b.sessTime === 390) {
          exitPrice = b.close;
          exitBar = b;
          break;
        }
      }
      
      if (exitPrice === null) {
        exitBar = s.postEntryBars[s.postEntryBars.length - 1];
        exitPrice = exitBar.close;
      }
      
      const pts = (exitPrice - entryPrice) * s.direction;
      const pnl = (pts * dpp) - comm;
      const volNormRet = pts / s.vol60;
      
      const entryTime = new Date(s.entryBar.ts).getTime();
      const exitTime = new Date(exitBar.ts).getTime();
      const holdMins = (exitTime - entryTime) / 60000;
      
      N++;
      if (pnl > 0) wins++;
      totalPnl += pnl;
      totalHoldMins += holdMins;
      totalVolNormRet += volNormRet;
    }
    
    return {
      N,
      winRate: N > 0 ? (wins / N) : 0,
      ev: N > 0 ? (totalPnl / N) : 0,
      totalPnl,
      avgHoldMins: N > 0 ? (totalHoldMins / N) : 0,
      avgVolNormRet: N > 0 ? (totalVolNormRet / N) : 0
    };
  }

  const results = {};
  for (const combo of combos) {
    const key = `Stop ${combo.stop}x, Target ${combo.target}x`;
    results[key] = {
      all: evalCombo(validSessions, combo),
      filtered: evalCombo(validSessions.filter(s => Math.abs(s.mom60) >= tercileCutoff), combo),
      combo
    };
  }
  
  // Find best combo from 'all'
  
  // Find best combo from 'all'
  let bestComboKeyAll = null;
  let bestEvAll = -Infinity;
  for (const key of Object.keys(results)) {
    if (results[key].all.ev > bestEvAll) {
      bestEvAll = results[key].all.ev;
      bestComboKeyAll = key;
    }
  }

  // Find overall best positive combo (all or filtered)
  let bestOverallName = null;
  let bestOverallEv = -Infinity;
  let bestOverallIsFiltered = false;
  let bestOverallComboKey = null;
  
  for (const key of Object.keys(results)) {
    if (results[key].all.ev > bestOverallEv) {
      bestOverallEv = results[key].all.ev;
      bestOverallName = key + ' (All)';
      bestOverallComboKey = key;
      bestOverallIsFiltered = false;
    }
    if (results[key].filtered.ev > bestOverallEv) {
      bestOverallEv = results[key].filtered.ev;
      bestOverallName = key + ' (Filtered)';
      bestOverallComboKey = key;
      bestOverallIsFiltered = true;
    }
  }
  const bestComboKey = bestComboKeyAll;
// Per year for best combo
  const bestCombo = results[bestComboKeyAll].combo;
  const years = {};
  const months = {};
  for (const s of validSessions) {
    const yr = s.sessDate.substring(0, 4);
    const mo = s.sessDate.substring(5, 7);
    if (!years[yr]) years[yr] = [];
    if (!months[mo]) months[mo] = [];
    years[yr].push(s);
    months[mo].push(s);
  }
  
  const bestYearMetrics = {};
  for (const yr of Object.keys(years).sort()) {
    bestYearMetrics[yr] = evalCombo(years[yr], bestCombo);
  }
  
  const bestMonthMetrics = {};
  for (const mo of Object.keys(months).sort()) {
    bestMonthMetrics[mo] = evalCombo(months[mo], bestCombo);
  }
  
  
  let md = `# Globex 03:30 Exhaustion Tradeability Backtest\n\n`;
  md += `**N = ${validSessions.length} total sessions** with valid signal and 60m trailing volatility data.\n`;
  md += `Filtered top-tercile cutoff: |mom60| >= ${tercileCutoff.toFixed(2)} (N = ${validSessions.filter(s => Math.abs(s.mom60) >= tercileCutoff).length})\n\n`;
  
  md += `### 1. Stop/Target Grid Performance\n\n`;
  md += `| Combo | All N | All WR | All EV | All Total $ | All Avg Hold | All VolNormRet | Filtered N | Filtered WR | Filtered EV | Filtered Total $ |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const key of Object.keys(results)) {
    const a = results[key].all;
    const f = results[key].filtered;
    md += `| ${key} | ${a.N} | ${(a.winRate*100).toFixed(1)}% | ${a.ev.toFixed(2)} | ${a.totalPnl.toFixed(2)} | ${a.avgHoldMins.toFixed(1)}m | ${a.avgVolNormRet.toFixed(3)} | ${f.N} | ${(f.winRate*100).toFixed(1)}% | ${f.ev.toFixed(2)} | ${f.totalPnl.toFixed(2)} |\n`;
  }
  
  md += `\n**Conservative Assumption Note**: If both stop and target were touched within the same 1-minute bar, the backtest assumed the stop was hit first (the worse outcome).\n`;
  
  md += `\n### 2. Breakdown of Best Setup from (a): ${bestComboKeyAll}\n\n`;
  md += `**By Year:**\n\n`;
  md += `| Year | N | WR | EV/trade | Total $ |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const yr of Object.keys(bestYearMetrics)) {
    const m = bestYearMetrics[yr];
    md += `| ${yr} | ${m.N} | ${(m.winRate*100).toFixed(1)}% | ${m.ev.toFixed(2)} | ${m.totalPnl.toFixed(2)} |\n`;
  }
  
  md += `\n**By Month (Highlighting August):**\n\n`;
  md += `| Month | N | WR | EV/trade | Total $ |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const mo of Object.keys(bestMonthMetrics)) {
    const m = bestMonthMetrics[mo];
    const flag = mo === '08' ? " **(August)**" : "";
    md += `| ${mo}${flag} | ${m.N} | ${(m.winRate*100).toFixed(1)}% | ${m.ev.toFixed(2)} | ${m.totalPnl.toFixed(2)} |\n`;
  }

  // Answer the "What I actually want to know" explicitly
  md += `\n### 3. Is there ANY combination with positive EV (N>=20)?\n\n`;
  if (bestOverallEv > 0) {
    const b = bestOverallIsFiltered ? results[bestOverallComboKey].filtered : results[bestOverallComboKey].all;
    if (b.N >= 20) {
      md += `Yes! The best combination is **${bestOverallName}** with EV ${bestOverallEv.toFixed(2)} (N = ${b.N}, WR = ${(b.winRate*100).toFixed(1)}%).\n\n`;
      md += `Here is the yearly breakdown for this specific combination to see if it holds up broadly:\n\n`;
      md += `| Year | N | WR | EV/trade | Total $ |\n`;
      md += `|---|---|---|---|---|\n`;
      const overallCombo = results[bestOverallComboKey].combo;
      for (const yr of Object.keys(years).sort()) {
        const set = bestOverallIsFiltered ? years[yr].filter(s => Math.abs(s.mom60) >= tercileCutoff) : years[yr];
        const m = evalCombo(set, overallCombo);
        md += `| ${yr} | ${m.N} | ${(m.winRate*100).toFixed(1)}% | ${m.ev.toFixed(2)} | ${m.totalPnl.toFixed(2)} |\n`;
      }
    } else {
      md += `There is a positive EV combination (${bestOverallName}), but N=${b.N} which is < 20, so it does not meet the sample size requirement.\n`;
    }
  } else {
    md += `No, there is NO combination (all or filtered) with a positive EV.\n`;
  }

fs.writeFileSync('scratch/antigravity_response.md', md);
  console.log("Wrote report to scratch/antigravity_response.md");
  
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  
  
  
  let resultText = "Not tradeable.";
  let finalN = results[bestComboKeyAll].all.N;
  if (bestOverallEv > 0) {
    const b = bestOverallIsFiltered ? results[bestOverallComboKey].filtered : results[bestOverallComboKey].all;
    if (b.N >= 20) {
      resultText = `Tradeable via ${bestOverallName} with EV ${bestOverallEv.toFixed(2)} (N=${b.N}).`;
      finalN = b.N;
    }
  }
await recordClaim({
    slug: 'globex_0330_exhaustion_fade_tradeability',
    claimText: `Backtested bar-by-bar tradeability of the 03:30 ET Globex momentum exhaustion finding, net of MNQ costs ($2/pt, $2 RT). Checked pre-registered stop/target multiples of trailing 60m volatility. Best combo: ${bestComboKey}. ${resultText} See scratch/antigravity_response.md for full grid, filtered-population stats, and year/month breakdowns.`,
    sourceFile: 'scripts/pilot_globex_0330_exhaustion_tradeability.mjs',
    sourceDate: today,
    sampleSize: finalN,
    rigorStatus: 'bar_by_bar_walk_with_costs',
    status: 'PROVISIONAL',
  });
  console.log("Recorded claim.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
