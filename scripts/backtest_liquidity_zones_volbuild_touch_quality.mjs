import pool from '../server/db.js';
import { getVolumeBaseline, computeVolumeBuildingMeasures } from '../server/services/touchQuality.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { classifyLevelFormation } from '../server/config/setupTypes.js';
import fs from 'fs';
import path from 'path';

const SAME_DAY_FORMING_MINUTE = {
  OR5_HIGH: 575, OR5_LOW: 575, OR5_MID: 575,
  OR10_HIGH: 580, OR10_LOW: 580, OR10_MID: 580,
  OR30_HIGH: 600, OR30_LOW: 600, OR30_MID: 600,
  IB_HIGH: 630, IB_LOW: 630, IB_MID: 630,
};

function etMinutesOfDay(dateObj) {
  const d = new Date(dateObj.toLocaleString("en-US", {timeZone: "America/New_York"}));
  return d.getHours() * 60 + d.getMinutes();
}

async function loadLevels() {
  const res = await pool.query(`
    SELECT trade_date::text as trade_date, level_name, price::float
    FROM level_prices
    ORDER BY trade_date ASC
  `);
  
  const levelsByDate = {};
  let currentTradeDate = null;
  let latestLevels = {};
  
  for (const row of res.rows) {
    if (row.trade_date !== currentTradeDate) {
      if (currentTradeDate !== null) {
        levelsByDate[currentTradeDate] = { ...latestLevels };
      }
      currentTradeDate = row.trade_date;
    }
    latestLevels[row.level_name] = row.price;
  }
  if (currentTradeDate !== null) {
    levelsByDate[currentTradeDate] = { ...latestLevels };
  }
  
  const allDates = Object.keys(levelsByDate).sort();
  if (allDates.length === 0) return { getLevelsForDate: () => null };

  const denseLevelMap = {};
  let runningLevels = {};
  const allCalendarDates = await pool.query(`SELECT DISTINCT trade_date::text as d FROM level_prices ORDER BY d ASC`);
  
  const checkpointDates = [];
  for (const row of allCalendarDates.rows) {
    const d = row.d;
    if (levelsByDate[d]) {
      runningLevels = { ...runningLevels, ...levelsByDate[d] };
    }
    denseLevelMap[d] = { ...runningLevels };
    checkpointDates.push(d);
  }
  
  const getLevelsForDate = (td) => {
    let lo = 0, hi = checkpointDates.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (checkpointDates[mid] <= td) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best === -1 ? null : denseLevelMap[checkpointDates[best]];
  };

  return { getLevelsForDate };
}

async function main() {
  console.log("Loading calibrations...");
  const perfRes = await pool.query(`
    SELECT signal_name, signal_type, optimal_stop::float as stop, optimal_target::float as target, notes
    FROM performance_audit
    WHERE signal_type IN ('OPTIMAL_STOP', 'TOUCH_QUALITY')
  `);
  const calibrations = {};
  for (const row of perfRes.rows) {
    if (!calibrations[row.signal_name]) calibrations[row.signal_name] = {};
    if (row.signal_type === 'OPTIMAL_STOP') {
      calibrations[row.signal_name].R = row.target;
      calibrations[row.signal_name].B = row.stop;
    }
    if (row.signal_type === 'TOUCH_QUALITY') {
      try {
        const notes = JSON.parse(row.notes);
        if (notes.window_bars) calibrations[row.signal_name].H = notes.window_bars;
      } catch(e) {}
    }
  }

  const { getLevelsForDate } = await loadLevels();

  const dateRes = await pool.query(`SELECT DISTINCT trade_date::text as td FROM level_prices ORDER BY td ASC`);
  // PERFORMANCE FIX (2026-09-01, Claude, after Gemini's script timed out at 15min on a 5-date
  // dry run alone -- 2m19s for 5 dates extrapolates to ~3.7hrs for the full 479-date history).
  // A 5-date dry run already produced N=2495 scoreable touches (RUN=181/HELD=2314) with a
  // striking bucket pattern (top-CS-quartile RUN rate 20.1% vs bottom-quartile 1.8%) -- far more
  // than the N>=20 floor needs. Scoped to the most recent 120 trading days (~6 months): enough
  // distinct days for the day-clustering check to be meaningful (5 days is structurally 100%
  // clustered by definition, uninformative), while keeping runtime tractable. Full-history
  // coverage isn't needed for statistical power here; it can be widened later if 120 days proves
  // day-clustered.
  const datesToProcess = dateRes.rows.map(r => r.td).slice(-120);
  console.log(`Scoped to most recent ${datesToProcess.length} dates (${datesToProcess[0]} to ${datesToProcess[datesToProcess.length - 1]}) for runtime -- see comment above.`);

  const baselineCache = new Map();
  const queryFn = async (sql, params) => pool.query(sql, params);
  async function getCachedBaseline(td) {
    if (baselineCache.has(td)) return baselineCache.get(td);
    const bl = await getVolumeBaseline(queryFn, td);
    baselineCache.set(td, bl);
    return bl;
  }

  let totalTouchEvents = 0;
  let resolvableTouchEvents = 0;
  let scoreableTouchEvents = 0;
  let scoreableRun = 0;
  let scoreableHeld = 0;

  const results = [];

  for (let d = 0; d < datesToProcess.length; d++) {
    const td = datesToProcess[d];
    console.log(`Processing date ${td} (${d+1}/${datesToProcess.length})...`);
    
    const baseline = await getCachedBaseline(td);

    const barRes = await pool.query(`
      SELECT ts, open::float, high::float, low::float, close::float, bid_volume, ask_volume
      FROM price_bars_primary
      WHERE symbol='NQ' 
        AND ts >= ($1::date - interval '3 days') 
        AND ts < ($1::date + interval '2 days')
      ORDER BY ts ASC
    `, [td]);
    const bars = barRes.rows;

    const levels = getLevelsForDate(td);
    if (!levels) continue;
    const levelNames = Object.keys(levels);

    const sessionStartBound = new Date(td + 'T00:00:00Z');
    sessionStartBound.setUTCDate(sessionStartBound.getUTCDate() - 1);
    const sessionStartBoundStr = sessionStartBound.toISOString().slice(0, 10) + ' 18:00:00';
    const sessionStartBoundDate = new Date(sessionStartBoundStr + 'Z');

    // PERFORMANCE FIX (2026-09-01, Claude): the original per-touch backward walk to find each
    // touch's own session-start index was O(session length) PER TOUCH, redundant across the many
    // touches sharing the same session (5141 touches found in just 5 dates in the dry run this
    // replaced). Precompute both possible session-start indices for every bar ONCE per date in a
    // single forward pass -- same semantics as the original walk (verified by construction: the
    // original checked `bars[k-1]` against the boundary condition while walking back from k,
    // stopping at the first bar that breaks the run; this precompute tracks the same "last
    // boundary-breaking bar seen so far" state moving forward, using only bars STRICTLY BEFORE
    // index i to decide index i's own session start, matching the original's exclusion of the
    // touch bar itself from the boundary check).
    const rthSessionStartIdx = new Array(bars.length);
    const globexSessionStartIdx = new Array(bars.length);
    {
      let lastRthBreak = -1;    // idx of most recent bar with mod OUTSIDE [570,960) -- breaks an RTH run
      let lastGlobexBreak = -1; // idx of most recent bar with mod INSIDE [570,1080) -- breaks a Globex run
      for (let i = 0; i < bars.length; i++) {
        rthSessionStartIdx[i] = lastRthBreak + 1;
        globexSessionStartIdx[i] = lastGlobexBreak + 1;
        const mod = etMinutesOfDay(bars[i].ts);
        if (!(mod >= 570 && mod < 960)) lastRthBreak = i;
        if (mod >= 570 && mod < 1080) lastGlobexBreak = i;
      }
    }

    let activeTouches = {};

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.ts < sessionStartBoundDate) continue;
      
      const etMin = etMinutesOfDay(b.ts);

      for (const ln of levelNames) {
        const formationMin = SAME_DAY_FORMING_MINUTE[ln];
        if (formationMin !== undefined && etMin < formationMin) continue;

        const lp = levels[ln];
        const inBandNow = Math.abs(b.close - lp) <= 15;
        
        if (!activeTouches[ln]) activeTouches[ln] = { inBand: false, touchStartBarIdx: null, approachSide: null };
        const state = activeTouches[ln];

        if (inBandNow) {
          if (!state.inBand) {
            state.inBand = true;
            state.touchStartBarIdx = i;
            if (i > 0) {
              const prev = bars[i-1];
              if (prev.close > lp + 15) state.approachSide = 'FROM_ABOVE';
              else if (prev.close < lp - 15) state.approachSide = 'FROM_BELOW';
              else state.approachSide = b.close > lp ? 'FROM_ABOVE' : 'FROM_BELOW';
            } else {
              state.approachSide = b.close > lp ? 'FROM_ABOVE' : 'FROM_BELOW';
            }
          }
        } else {
          if (state.inBand) {
            totalTouchEvents++;
            const anchorBarIdx = state.touchStartBarIdx;
            const setupType = ln + (state.approachSide === 'FROM_ABOVE' ? '_FADE_LONG' : '_FADE_SHORT');
            const calib = calibrations[setupType];
            
            let R, B, H;
            if (calib && calib.R != null && calib.B != null && calib.H != null) {
              R = calib.R; B = calib.B; H = calib.H;
            } else {
              const trailing30 = bars.slice(Math.max(0, anchorBarIdx - 30), anchorBarIdx);
              let medRange = 10;
              if (trailing30.length > 0) {
                const ranges = trailing30.map(x => x.high - x.low).sort((a,b) => a - b);
                medRange = ranges[Math.floor(ranges.length / 2)];
                if (medRange === 0) medRange = 5;
              }
              R = medRange; B = medRange; H = 10;
            }

            let resolution = 'UNRESOLVED';
            for (let j = anchorBarIdx; j <= Math.min(anchorBarIdx + H, bars.length - 1); j++) {
              const fbar = bars[j];
              let runTrigger = false;
              let heldTrigger = false;
              if (state.approachSide === 'FROM_ABOVE') {
                if (fbar.low <= lp - B) runTrigger = true;
                if (fbar.high >= lp + R) heldTrigger = true;
              } else {
                if (fbar.high >= lp + B) runTrigger = true;
                if (fbar.low <= lp - R) heldTrigger = true;
              }
              if (runTrigger) { resolution = 'RUN'; break; }
              if (heldTrigger) { resolution = 'HELD'; break; }
            }

            if (resolution === 'RUN' || resolution === 'HELD') {
              resolvableTouchEvents++;
              
              const anchorBar = bars[anchorBarIdx];
              const anchorEtMin = etMinutesOfDay(anchorBar.ts);
              const isRth = (anchorEtMin >= 570 && anchorEtMin < 960);

              const sessionStartIdx = isRth ? rthSessionStartIdx[anchorBarIdx] : globexSessionStartIdx[anchorBarIdx];

              const sessionBars = bars.slice(sessionStartIdx, anchorBarIdx + 1).map(b => ({
                mod: etMinutesOfDay(b.ts),
                volume: (b.bid_volume || 0) + (b.ask_volume || 0)
              }));
              
              const touchIdx = sessionBars.length - 1;
              const measures = computeVolumeBuildingMeasures(sessionBars, touchIdx, baseline);
              
              let compositeStrength = null;
              if (measures.avgVolZ != null && measures.volZTrend != null && measures.avgDayVolZ != null && measures.dayVolZTrend != null) {
                compositeStrength = measures.avgVolZ + measures.volZTrend + measures.avgDayVolZ + measures.dayVolZTrend;
              }

              if (compositeStrength !== null) {
                scoreableTouchEvents++;
                if (resolution === 'RUN') scoreableRun++;
                if (resolution === 'HELD') scoreableHeld++;
                
                results.push({
                  date: td,
                  levelName: ln,
                  resolution,
                  compositeStrength,
                  isRth,
                  // reused verbatim (share-modules convention) -- do not re-derive by hand,
                  // classifyLevelFormation()'s first draft had a real coverage gap (missed
                  // OR*_HIGH/OR*_LOW) that diluted an earlier finding before being caught.
                  formation: classifyLevelFormation(ln),
                });
              }
            }

            state.inBand = false;
          }
        }
      }
    }
  }

  let out = `## Executive Summary\n\n`;
  out += `Total touches processed: ${totalTouchEvents}\n`;
  out += `Resolvable touches (RUN/HELD): ${resolvableTouchEvents}\n`;
  out += `Scoreable touches (non-null compositeStrength): ${scoreableTouchEvents}\n`;
  out += `  RUN: ${scoreableRun}\n`;
  out += `  HELD: ${scoreableHeld}\n\n`;

  function analyzeSubset(subset, label) {
    if (subset.length === 0) return `No data for ${label}\n`;
    const runs = subset.filter(r => r.resolution === 'RUN');
    const held = subset.filter(r => r.resolution === 'HELD');
    
    const runMean = runs.length > 0 ? runs.reduce((s, x) => s + x.compositeStrength, 0) / runs.length : 0;
    const heldMean = held.length > 0 ? held.reduce((s, x) => s + x.compositeStrength, 0) / held.length : 0;
    const diff = runMean - heldMean;
    
    const sorted = [...subset].sort((a, b) => a.compositeStrength - b.compositeStrength);
    let table = `### ${label}\n\n`;
    table += `N = ${subset.length} (RUN: ${runs.length}, HELD: ${held.length})\n`;
    table += `RUN mean compositeStrength: ${runMean.toFixed(3)}\n`;
    table += `HELD mean compositeStrength: ${heldMean.toFixed(3)}\n`;
    table += `Difference (RUN - HELD): ${diff.toFixed(3)}\n\n`;
    
    const numBuckets = subset.length > 100 ? 4 : (subset.length > 50 ? 3 : 2);
    const bSize = Math.ceil(sorted.length / numBuckets);
    table += `| Bucket (by CS) | N | Min CS | Max CS | RUN Rate | HELD Rate |\n`;
    table += `|---|---|---|---|---|---|\n`;
    
    for (let i = 0; i < numBuckets; i++) {
      const b = sorted.slice(i * bSize, (i + 1) * bSize);
      if (b.length === 0) continue;
      const bRuns = b.filter(x => x.resolution === 'RUN').length;
      const bHeld = b.filter(x => x.resolution === 'HELD').length;
      const bRunRate = bRuns / b.length;
      const bHeldRate = bHeld / b.length;
      table += `| ${i+1} | ${b.length} | ${b[0].compositeStrength.toFixed(3)} | ${b[b.length-1].compositeStrength.toFixed(3)} | ${(bRunRate*100).toFixed(1)}% | ${(bHeldRate*100).toFixed(1)}% |\n`;
    }
    
    if (numBuckets >= 2) {
      const topQ = sorted.slice((numBuckets - 1) * bSize);
      const overallRunRate = runs.length / subset.length;
      
      const rigorQTop = computeRigor(topQ, {
        dateField: 'date',
        // if this bucket's run rate is > overall run rate, check if that holds chronologically
        pnlFn: e => (e.resolution === 'RUN' ? 1 : 0) - overallRunRate
      });
      table += `\nTop Bucket Rigor (Chronological stability of RUN-rate vs baseline):\n`;
      table += `- Stable across thirds: ${rigorQTop.stable}\n`;
      table += `- Clustered (Top 5 days %): ${rigorQTop.top5DayPct}%\n`;
    }
    
    return table + '\n';
  }

  out += analyzeSubset(results, "Pooled (All Touches)");
  out += analyzeSubset(results.filter(r => r.isRth), "RTH Only");
  out += analyzeSubset(results.filter(r => !r.isRth), "Globex Only");

  // Cross-validation against the already-parked SAME_DAY_FORMING vs PRIOR_DAY_OR_DEVELOPING
  // finding (docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md sec 6b, N=324/618, $11.95 vs $2.17
  // per-trade gap on realized P&L) -- does the RUN/HELD behavioral measure (a different,
  // much larger population, N in the tens of thousands here) concentrate the same way?
  out += `\n## Cross-check against the parked SAME_DAY_FORMING vs PRIOR_DAY_OR_DEVELOPING split\n\n`;
  out += analyzeSubset(results.filter(r => r.formation === 'SAME_DAY_FORMING'), "SAME_DAY_FORMING (IB/OR family)");
  out += analyzeSubset(results.filter(r => r.formation === 'PRIOR_DAY_OR_DEVELOPING'), "PRIOR_DAY_OR_DEVELOPING (PD_POC/VAH/VAL, VWAP, pivots, etc)");
  out += analyzeSubset(results.filter(r => r.formation === 'OTHER'), "OTHER (unclassified)");

  const runs = results.filter(r => r.resolution === 'RUN');
  const held = results.filter(r => r.resolution === 'HELD');
  const rthRuns = results.filter(r => r.isRth && r.resolution === 'RUN');
  const rthHeld = results.filter(r => r.isRth && r.resolution === 'HELD');
  const gxRuns = results.filter(r => !r.isRth && r.resolution === 'RUN');
  const gxHeld = results.filter(r => !r.isRth && r.resolution === 'HELD');

  const diffRth = (rthRuns.length ? rthRuns.reduce((s,x)=>s+x.compositeStrength,0)/rthRuns.length : 0) - (rthHeld.length ? rthHeld.reduce((s,x)=>s+x.compositeStrength,0)/rthHeld.length : 0);
  const diffGx = (gxRuns.length ? gxRuns.reduce((s,x)=>s+x.compositeStrength,0)/gxRuns.length : 0) - (gxHeld.length ? gxHeld.reduce((s,x)=>s+x.compositeStrength,0)/gxHeld.length : 0);

  out += `### Verdict\n\n`;
  if (rthRuns.length > 0 && gxRuns.length > 0 && Math.sign(diffRth) === Math.sign(diffGx) && (Math.abs(diffRth) > 0.1 || Math.abs(diffGx) > 0.1)) {
    out += `Volume-building strength at touch GENUINELY distinguishes RUN from HELD. The effect holds in both RTH and Globex with agreement in sign. Higher composite strength correlates with ${diffRth > 0 ? 'RUN (consumption)' : 'HELD (defense)'}.\n`;
  } else if (rthRuns.length > 0 && gxRuns.length > 0 && Math.sign(diffRth) !== Math.sign(diffGx)) {
    out += `Volume-building strength diverges between RTH and Globex. It does NOT universally predict RUN vs HELD across both day-types.\n`;
  } else {
    out += `Volume-building strength does NOT strongly distinguish RUN from HELD (effect size is marginal, or missing data in one session).\n`;
  }

  fs.writeFileSync(path.join(process.cwd(), 'scratch', 'antigravity_response.md'), out);
  console.log("Wrote antigravity response to scratch/antigravity_response.md");
}

main().catch(console.error).finally(() => pool.end());
