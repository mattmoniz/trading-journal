import { query } from '../server/db.js';
import { getVolumeBaseline } from '../server/services/touchQuality.js';
import { getPaceBaseline } from '../server/routes/acd.js';
import { computeVolumeProfileForRange } from '../server/services/developingValueService.js';
import { recordClaim } from './record_claim.mjs';
import { computeVWAP } from '../scripts/backtest_confluence.js';
import fs from 'fs';
import * as ss from 'simple-statistics';

const LIVE_FIRES = [
  { tsStr: '2026-07-29T19:21', date: '2026-07-29', direction: 'SHORT', volZ: 3.06, osr: 0.56, cc: 5, paceZ: 14.88 },
  { tsStr: '2026-07-30T14:55', date: '2026-07-30', direction: 'SHORT', volZ: 1.43, osr: 0.56, cc: 5, paceZ: 3.25 },
  { tsStr: '2026-07-30T16:41', date: '2026-07-30', direction: 'SHORT', volZ: 0.97, osr: 0.57, cc: 4, paceZ: 1.24 },
  { tsStr: '2026-07-31T18:12', date: '2026-07-31', direction: 'SHORT', volZ: 0.77, osr: 0.58, cc: 4, paceZ: 2.63 },
  { tsStr: '2026-08-06T15:55', date: '2026-08-06', direction: 'SHORT', volZ: 1.84, osr: 0.59, cc: 4, paceZ: 1.22 }
];

async function getDayData(d) {
  const q = await query(`
    WITH raw_bars AS (
      SELECT ts, close::float, high::float, low::float, open::float,
             EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
             bid_volume::int, ask_volume::int
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1::date - interval '1 day' AND ts < $1::date + interval '1 day'
      ORDER BY ts ASC
    )
    SELECT *, EXTRACT(EPOCH FROM (ts - LAG(ts) OVER (ORDER BY ts))) / 60 AS gap
    FROM raw_bars
    ORDER BY ts ASC
  `, [d]);
  
  const svBaseline = await getVolumeBaseline(query, d);
  const paceBaseline = await getPaceBaseline(d);
  
  const lpQ = await query(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND price IS NOT NULL AND level_name != 'RTH_VWAP'`, [d]);
  const map = {};
  for (const r of lpQ.rows) map[r.level_name] = r.price;

  const pd2Q = await query(`
    SELECT vah::float, val::float FROM developing_value_log
    WHERE trade_date < (SELECT MAX(trade_date) FROM developing_value_log WHERE trade_date < $1)
    ORDER BY trade_date DESC LIMIT 1
  `, [d]).catch(() => ({ rows: [] }));
  if (pd2Q.rows[0]) {
    if (pd2Q.rows[0].vah != null) map.PD2_VAH = pd2Q.rows[0].vah;
    if (pd2Q.rows[0].val != null) map.PD2_VAL = pd2Q.rows[0].val;
  }

  const last2Q = await query(`
    SELECT log_date::text as d FROM daily_logs
    WHERE log_date < $1
    GROUP BY log_date
    ORDER BY log_date DESC LIMIT 2
  `, [d]).then(r => r.rows.map(x => x.d)).catch((err) => { console.error(err); return []; });
  
  if (last2Q.length >= 2) {
    const profile = await computeVolumeProfileForRange(query, { startDate: last2Q[1], endDate: last2Q[0] }).catch(() => null);
    if (profile && profile.poc) {
      map['2D_POC'] = profile.poc;
    }
  }

  return { dayBars: q.rows, svBaseline, paceBaseline, map };
}

function classifyStackVolBar(bar, i, dayBars, svBaseline, paceBaseline, map, returnAll = false) {
  const svBars = [];
  for (let j = i; j >= 0; j--) {
    const diff = (bar.ts.getTime() - dayBars[j].ts.getTime()) / (1000 * 60 * 60);
    if (diff <= 3) svBars.unshift(dayBars[j]);
    else break;
  }

  const svLevels = { ...map };
  if (bar.tod < 630) { delete svLevels.IB_HIGH; delete svLevels.IB_LOW; delete svLevels.IB_MID; }
  if (bar.tod < 575) { delete svLevels.OR5_HIGH; delete svLevels.OR5_LOW; }
  
  svLevels.VWAP = computeVWAP(svBars, svBars.length - 1);

  const levelsArr = Object.entries(svLevels)
    .filter(([, p]) => p != null && isFinite(p))
    .map(([name, price]) => ({ name, price }))
    .sort((a, b) => a.price - b.price);

  const clusters = [];
  let cur = levelsArr.length ? [levelsArr[0]] : [];
  for (let j = 1; j < levelsArr.length; j++) {
    if (levelsArr[j].price - levelsArr[j - 1].price <= 15) cur.push(levelsArr[j]);
    else { clusters.push(cur); cur = [levelsArr[j]]; }
  }
  if (cur.length) clusters.push(cur);

  const totalVol = (bar.bid_volume || 0) + (bar.ask_volume || 0);
  const bl = svBaseline.get(Number(bar.tod));
  const volZ = (bl && bl.std_vol > 0) ? (totalVol - bl.avg_vol) / bl.std_vol : 0;

  const isRth = bar.tod >= 570 && bar.tod <= 959;
  const minClusterSize = isRth ? 1 : 2;
  const volZCutoff = isRth ? 0.5 : 1.5;
  const osrCutoff = isRth ? 0.55 : 0.65;

  let consecutiveCount = 0, paceZ = 0;
  if (isRth) {
    const pBl = paceBaseline.get(Number(bar.tod));
    const prev5Idx = Math.max(0, svBars.length - 1 - 5);
    const prev5Close = svBars[prev5Idx].close;
    const netPace = Math.abs(bar.close - prev5Close);
    paceZ = (pBl && pBl.std_pace > 0) ? (netPace - pBl.avg_pace) / pBl.std_pace : 0;
  }

  const results = [];

  for (const cluster of clusters) {
    if (cluster.length < minClusterSize) continue;
    const clusterMin = cluster[0].price, clusterMax = cluster[cluster.length - 1].price;
    let direction = null;

    if (bar.close < clusterMin) {
      let foundAbove = false, validBreak = true;
      for (let k = 1; k <= 30; k++) {
        const pbIdx = svBars.length - 1 - k;
        if (pbIdx < 0) break;
        const pb = svBars[pbIdx];
        if (pb.gap == null || pb.gap > 5) { validBreak = false; break; }
        if (pb.close >= clusterMax) { foundAbove = true; break; }
        if (pb.close < clusterMin) { validBreak = false; break; }
      }
      if (foundAbove && validBreak) direction = 'SHORT';
    } else if (bar.close > clusterMax) {
      let foundBelow = false, validBreak = true;
      for (let k = 1; k <= 30; k++) {
        const pbIdx = svBars.length - 1 - k;
        if (pbIdx < 0) break;
        const pb = svBars[pbIdx];
        if (pb.gap == null || pb.gap > 5) { validBreak = false; break; }
        if (pb.close <= clusterMin) { foundBelow = true; break; }
        if (pb.close > clusterMax) { validBreak = false; break; }
      }
      if (foundBelow && validBreak) direction = 'LONG';
    }
    if (bar.ts.toISOString() === '2026-08-06T15:55:00.000Z') {
      console.log(`Trace for ${bar.ts.toISOString()}: close=${bar.close}, clusterMin=${clusterMin}, clusterMax=${clusterMax}, dir=${direction}`);
      if (clusterMin === 29535.5 || clusterMin === 29519) {
        console.log(`Checking breaks for clusterMin=${clusterMin}:`);
        for (let k = 1; k <= 30; k++) {
          const pbIdx = svBars.length - 1 - k;
          if (pbIdx < 0) break;
          const pb = svBars[pbIdx];
          console.log(`  k=${k} bar.ts=${pb.ts.toISOString()} gap=${pb.gap} close=${pb.close}`);
        }
      }
    }

    if (!direction) continue;

    consecutiveCount = 0;
    for (let k = Math.max(0, svBars.length - 1 - 4); k <= svBars.length - 1; k++) {
      const b = svBars[k];
      if (direction === 'SHORT' && b.close < b.open) consecutiveCount++;
      if (direction === 'LONG' && b.close > b.open) consecutiveCount++;
    }

    const favorableVol = direction === 'LONG' ? (bar.ask_volume || 0) : (bar.bid_volume || 0);
    const adverseVol = direction === 'LONG' ? (bar.bid_volume || 0) : (bar.ask_volume || 0);
    const oneSidedRatio = (favorableVol + adverseVol) > 0 ? favorableVol / (favorableVol + adverseVol) : 0.5;

    // Checks
    const passThresholds = (volZ >= volZCutoff && oneSidedRatio >= osrCutoff) && (!isRth || (consecutiveCount >= 4 && paceZ >= 1));
    
    if (passThresholds || returnAll) {
      // Confounds calculation
      const chaseDist = direction === 'LONG' ? bar.close - clusterMax : clusterMin - bar.close;
      
      let nearSessionBoundary = false;
      for (let k = 1; k <= 30; k++) {
        const pbIdx = Math.max(0, i - k);
        if (dayBars[pbIdx] && dayBars[pbIdx].gap > 5) { nearSessionBoundary = true; break; }
      }

      const driftStart = Math.max(0, i - 20);
      const priorDrift = bar.close - dayBars[driftStart].close;

      results.push({
        direction, volZ, oneSidedRatio, consecutiveCount, paceZ,
        isRth, chaseDist, nearSessionBoundary, priorDrift, ts: bar.ts
      });
    }
  }
  return results;
}

async function run() {
  console.log("Q1 Verification check: Baselines");
  const dates = ['2026-07-29', '2026-07-30', '2026-07-31'];
  const pace1 = await getPaceBaseline(dates[0]);
  const pace2 = await getPaceBaseline(dates[1]);
  const vol1 = await getVolumeBaseline(query, dates[0]);
  const vol2 = await getVolumeBaseline(query, dates[1]);
  console.log(`Different pace baselines? ${pace1 !== pace2}`);
  console.log(`Different vol baselines? ${vol1 !== vol2}`);

  console.log("\\nRunning live-fire validation...");
  // CORRECTED (2nd pass, Claude direct): `triggeredAt` is wall-clock INSERT time from the
  // live 15s poll loop, not the timestamp of the bar that actually satisfied the
  // conditions -- Gemini's own diagnostic found a real case lagging 20+ minutes, and the
  // live engine's own lookback window is up to 3 hours, so no fixed-size time window
  // around `triggeredAt` is a reliable anchor. Instead: scan the ENTIRE trading day (RTH+
  // Globex bars already in `dayBars`) for a bar producing a signal whose stat FINGERPRINT
  // (volZ/OSR/consecutiveCount/paceZ, all continuous values unlikely to coincide by chance)
  // matches the recorded live values on the correct direction -- the fingerprint is the
  // reliable anchor here, not the timestamp.
  let matchedFires = 0;
  let diagnosticLog = '';
  for (const fire of LIVE_FIRES) {
    const data = await getDayData(fire.date);
    let found = false;
    let bestCandidates = [];

    for (let i = 0; i < data.dayBars.length; i++) {
      const bar = data.dayBars[i];
      const signals = classifyStackVolBar(bar, i, data.dayBars, data.svBaseline, data.paceBaseline, data.map, true);
      for (const s of signals) {
        if (s.direction !== fire.direction) continue;
        const volMatch = Math.abs(s.volZ - fire.volZ) < 0.1;
        const osrMatch = Math.abs(s.oneSidedRatio - fire.osr) < 0.05;
        const ccMatch = s.consecutiveCount === fire.cc;
        const paceMatch = Math.abs(s.paceZ - fire.paceZ) < 0.1;
        if (volMatch && osrMatch && ccMatch && paceMatch) {
          if (!found) {
            matchedFires++;
            found = true;
            console.log(`Matched: ${fire.tsStr} at bar ${bar.ts.toISOString()} (volZ=${s.volZ.toFixed(2)}, osr=${s.oneSidedRatio.toFixed(2)}, cc=${s.consecutiveCount}, paceZ=${s.paceZ.toFixed(2)}, lag=${((bar.ts.getTime()-new Date(fire.tsStr+':00Z').getTime())/60000).toFixed(1)}min)`);
          }
        } else {
          // Track near-misses (right direction, at least one stat close) for diagnostics.
          const closeCount = [volMatch, osrMatch, ccMatch, paceMatch].filter(Boolean).length;
          if (closeCount >= 2) bestCandidates.push({ ts: bar.ts.toISOString(), s, closeCount });
        }
      }
    }
    let allSignalsInWindow = bestCandidates.slice(0, 10).map(c => ({ barTs: c.ts, signals: [c.s] }));
    
    if (!found) {
      let failLog = `FAILED to match fire at ${fire.tsStr}\n`;
      failLog += `DB Values: direction=${fire.direction}, volZ=${fire.volZ}, osr=${fire.osr}, cc=${fire.cc}, paceZ=${fire.paceZ}\n`;
      failLog += `Signals found within ±5 minutes:\n`;
      let printed = false;
      for (const w of allSignalsInWindow) {
        if (w.signals.length > 0) {
          printed = true;
          for (const s of w.signals) {
            failLog += `  Bar: ${w.barTs} | Dir: ${s.direction} | volZ: ${s.volZ.toFixed(2)} | osr: ${s.oneSidedRatio.toFixed(2)} | cc: ${s.consecutiveCount} | paceZ: ${s.paceZ.toFixed(2)}\n`;
          }
        }
      }
      if (!printed) {
        failLog += `  (No signals found in ±5 min window)\n`;
      }
      console.log(`\n${failLog}`);
      diagnosticLog += `\n${failLog}\n`;
    }
  }

  if (matchedFires < 5) {
    const msg = `Validation failed! Only matched ${matchedFires}/5 fires. Stopping.`;
    console.error(msg);
    let md = `# StackVol Horizon Profile: Validation Failed\n\n${msg}\n\n`;
    md += `The compiled snapshot could not successfully validate against the 5 live historical fires (${matchedFires} matches) even with a widened ±3 minute window.\n\n`;
    md += `## Diagnostics for Unmatched Fires (±5 minute window)\n\n\`\`\`text\n${diagnosticLog}\n\`\`\`\n\n`;
    md += `Execution halted before the full run, as required by the instructions.`;
    fs.writeFileSync('scratch/stackvol_horizon_profile_RESULTS.md', md);
    process.exit(0);
  } else {
    console.log(`Validation passed (${matchedFires}/5 matched). Proceeding with full run...\n`);
  }

  const START_DATE = '2023-12-16';
  const daysQ = await query(`SELECT DISTINCT ts::date::text as d FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date ORDER BY d ASC`, [START_DATE]);
  const days = daysQ.rows.map(r => r.d);

  // We need to fetch all bars to compute unconditional baselines and backtest.
  // Actually, computing unconditional forward returns:
  const baselineReturns = {
    RTH: { 1: [], 3: [], 5: [], 10: [], 20: [] },
    GLOBEX: { 1: [], 3: [], 5: [], 10: [], 20: [] }
  };

  const signals = [];
  let dedupCount = 0;
  let rawCount = 0;

  for (let dIdx = 0; dIdx < days.length; dIdx++) {
    const d = days[dIdx];
    if (dIdx % 20 === 0) console.log(`Processing day ${dIdx + 1}/${days.length}: ${d}`);
    
    const data = await getDayData(d);
    
    let lastSignal = { LONG: -Infinity, SHORT: -Infinity };
    
    for (let i = 0; i < data.dayBars.length; i++) {
      const bar = data.dayBars[i];
      if (bar.ts.toISOString().split('T')[0] !== d) continue; // process today's bars only
      
      const isRth = bar.tod >= 570 && bar.tod <= 959;
      const bRet = isRth ? baselineReturns.RTH : baselineReturns.GLOBEX;
      
      // Calculate unconditional forward returns (absolute magnitude or just mean? The prompt says unconditional mean. It's usually ~0, but we just compute it. Wait, forward return in points for every bar's own forward return)
      for (const h of [1, 3, 5, 10, 20]) {
        if (i + h < data.dayBars.length) {
          bRet[h].push(data.dayBars[i + h].close - bar.close); // baseline uses natural forward return
        }
      }

      const barSignals = classifyStackVolBar(bar, i, data.dayBars, data.svBaseline, data.paceBaseline, data.map);
      
      for (const s of barSignals) {
        rawCount++;
        if (i - lastSignal[s.direction] >= 5) {
          dedupCount++;
          lastSignal[s.direction] = i;
          
          // Forward returns
          const fwd = {};
          for (const h of [1, 3, 5, 10, 20]) {
            if (i + h < data.dayBars.length) {
              const diff = data.dayBars[i + h].close - bar.close;
              fwd[h] = s.direction === 'LONG' ? diff : -diff; // directional return
            }
          }
          
          signals.push({ ...s, fwd });
        }
      }
    }
  }
  
  // Aggregate baseline
  const baselineMeans = { RTH: {}, GLOBEX: {} };
  for (const session of ['RTH', 'GLOBEX']) {
    for (const h of [1, 3, 5, 10, 20]) {
       const vals = baselineReturns[session][h];
       baselineMeans[session][h] = vals.length > 0 ? ss.mean(vals) : 0;
    }
  }
  
  // Confounds
  let avgChaseDist = 0;
  let nearBoundaryPct = 0;
  let trendCont = { LONG: [], SHORT: [] };
  
  if (signals.length > 0) {
    avgChaseDist = ss.mean(signals.map(s => s.chaseDist));
    nearBoundaryPct = signals.filter(s => s.nearSessionBoundary).length / signals.length;
    for (const s of signals) trendCont[s.direction].push(s.priorDrift);
  }
  const meanDriftLong = trendCont.LONG.length > 0 ? ss.mean(trendCont.LONG) : 0;
  const meanDriftShort = trendCont.SHORT.length > 0 ? ss.mean(trendCont.SHORT) : 0;

  // Grouping
  const groups = [
    { session: true, dir: 'LONG', name: 'RTH LONG' },
    { session: true, dir: 'SHORT', name: 'RTH SHORT' },
    { session: false, dir: 'LONG', name: 'GLOBEX LONG' },
    { session: false, dir: 'SHORT', name: 'GLOBEX SHORT' },
  ];

  let resMd = `# STACK_VOL_BREAK_LIVE Horizon Profile\n\n`;
  resMd += `## Diagnostics\n`;
  resMd += `- **Multiplicity:** Raw signals = ${rawCount}, Deduplicated (5-bar) = ${dedupCount}\n`;
  resMd += `- **Chase Confound:** Mean distance from cluster edge to signal close = ${avgChaseDist.toFixed(2)} pts\n`;
  resMd += `- **Session Boundary:** ${(nearBoundaryPct*100).toFixed(1)}% of signals are within 30 bars of a >5-min gap\n`;
  resMd += `- **Trend Contamination:** Mean prior 20-bar drift for LONGs = ${meanDriftLong.toFixed(2)} pts, SHORTs = ${meanDriftShort.toFixed(2)} pts\n\n`;

  resMd += `## Horizon Returns\n`;
  resMd += `| Group | Horizon | N | Cond. Mean | Uncond. Mean | Edge | t-stat (vs 0) |\n`;
  resMd += `|-------|---------|---|------------|--------------|------|---------------|\n`;

  let ev10 = 0;
  
  for (const g of groups) {
    const subset = signals.filter(s => s.isRth === g.session && s.direction === g.dir);
    for (const h of [1, 3, 5, 10, 20]) {
      const rets = subset.map(s => s.fwd[h]).filter(x => x !== undefined);
      const n = rets.length;
      if (n < 2) {
        resMd += `| ${g.name} | ${h} | ${n} | N/A | N/A | N/A | N/A |\n`;
        continue;
      }
      
      const condMean = ss.mean(rets);
      const uncond = baselineMeans[g.session ? 'RTH' : 'GLOBEX'][h];
      const uncondDir = g.dir === 'LONG' ? uncond : -uncond; // align direction
      const edge = condMean - uncondDir;
      const stdDev = ss.sampleStandardDeviation(rets) || 1;
      const tstat = condMean / (stdDev / Math.sqrt(n));
      
      if (g.name === 'RTH LONG' && h === 10) ev10 = condMean;
      if (g.name === 'RTH SHORT' && h === 10) ev10 = (ev10 + condMean) / 2;
      
      resMd += `| ${g.name} | ${h} | ${n} | ${condMean.toFixed(2)} | ${uncondDir.toFixed(2)} | ${edge.toFixed(2)} | ${tstat.toFixed(2)} |\n`;
    }
  }

  fs.writeFileSync('scratch/stackvol_horizon_profile_RESULTS.md', resMd);
  
  // Record claim
  const claimDesc = "STACK_VOL_BREAK_LIVE shows its forward return horizon profile across 1/3/5/10/20 bars.";
  await recordClaim({
    slug: 'STACK_VOL_BREAK_HORIZON',
    claimText: claimDesc,
    sourceFile: 'scratch/stackvol_horizon_profile_RESULTS.md',
    sampleSize: dedupCount,
    evPerTrade: ev10,
    rigorStatus: 'horizon_profile_only',
    status: 'PROVISIONAL'
  });
  
  const check = await query(`SELECT signal_name FROM performance_audit WHERE signal_name='STACK_VOL_BREAK_HORIZON'`);
  console.log(`Claim recorded: ${check.rows.length > 0}`);
  process.exit(0);
}

run().catch(console.error);
