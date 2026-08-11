import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

async function main() {
  console.log("Fetching bars...");
  // Use a bounded query. 940 trading days from 2026-08 is roughly 2022-11-01. Let's use 2022-08-01.
  const { rows } = await query(`
    SELECT ts, ts::date::text as d, high::float, low::float, close::float, open::float,
      EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as bar_min
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND ts >= '2022-08-01' AND ts < CURRENT_DATE
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts ASC
  `);

  if (!rows.length) {
    console.log("No data found.");
    return;
  }
  console.log(`Fetched ${rows.length} bars.`);

  const days = [];
  let currentDay = null;
  for (const r of rows) {
    if (!currentDay || currentDay.d !== r.d) {
      currentDay = { d: r.d, bars: [] };
      days.push(currentDay);
    }
    currentDay.bars.push(r);
  }
  console.log(`Found ${days.length} trading days.`);

  // Helpers
  const getQuad = (bar_min) => {
    if (bar_min >= 570 && bar_min < 660) return 1;
    if (bar_min >= 660 && bar_min < 780) return 2;
    if (bar_min >= 780 && bar_min < 870) return 3;
    return 4;
  };

  const W = 10;
  const N = 30;

  // Compute metrics for all bars
  console.log("Computing metrics...");
  let allRange10 = [];
  
  for (let dIdx = 0; dIdx < days.length; dIdx++) {
    const day = days[dIdx];
    const bars = day.bars;
    for (let i = W - 1; i < bars.length; i++) {
      const quad = getQuad(bars[i].bar_min);
      bars[i].quad = quad;
      
      let maxH = -Infinity, minL = Infinity;
      for (let j = i - W + 1; j <= i; j++) {
        if (bars[j].high > maxH) maxH = bars[j].high;
        if (bars[j].low < minL) minL = bars[j].low;
      }
      bars[i].range_10 = maxH - minL;
      allRange10.push(bars[i].range_10);
      
      // Compute N=30 forward metrics if possible
      if (i + N < bars.length) {
        let fMaxH = -Infinity, fMinL = Infinity;
        let fMaxDisp = -Infinity;
        const refPrice = bars[i].close;
        for (let j = i + 1; j <= i + N; j++) {
          if (bars[j].high > fMaxH) fMaxH = bars[j].high;
          if (bars[j].low < fMinL) fMinL = bars[j].low;
          const disp = Math.abs(bars[j].close - refPrice);
          if (disp > fMaxDisp) fMaxDisp = disp;
        }
        bars[i].fwd_range_30 = fMaxH - fMinL;
        bars[i].fwd_max_disp = fMaxDisp;
      }
    }
  }

  allRange10.sort((a, b) => a - b);
  const globalP10 = allRange10[Math.floor(allRange10.length * 0.1)];
  const globalMedian = allRange10[Math.floor(allRange10.length * 0.5)];
  console.log(`Global P10 range_10: ${globalP10.toFixed(2)} (Median: ${globalMedian.toFixed(2)})`);

  let resolutionWarning = "";
  if (globalP10 < 15) {
    resolutionWarning = `WARNING: P10 range_10 (${globalP10.toFixed(2)}) is below 15pt. Resolution is marginal.`;
  }

  const getPercentile = (val, sortedArr) => {
    if (!sortedArr.length) return null;
    let count = 0;
    for (let x of sortedArr) if (x <= val) count++;
    return count / sortedArr.length;
  };

  const getPercentilesOfDistribution = (arr) => {
    if (!arr.length) return { p10: null, p40: null, p60: null };
    const p10 = arr[Math.floor(arr.length * 0.1)];
    const p40 = arr[Math.floor(arr.length * 0.4)];
    const p60 = arr[Math.floor(arr.length * 0.6)];
    const p75 = arr[Math.floor(arr.length * 0.75)];
    return { p10, p40, p60, p75 };
  };

  // Trailing distributions and event detection
  const events = [];
  const controls = [];
  let excludedCount = 0;
  let totalQualifyingBars = 0;
  
  let inContraction = false;

  console.log("Scanning for events and controls...");
  for (let dIdx = 60; dIdx < days.length; dIdx++) {
    const day = days[dIdx];
    const bars = day.bars;
    
    // Build trailing 60-day distributions per quadrant
    const hist = { 1: [], 2: [], 3: [], 4: [] };
    const histFwdR = { 1: [], 2: [], 3: [], 4: [] };
    const histFwdD = { 1: [], 2: [], 3: [], 4: [] };
    
    for (let h = dIdx - 60; h < dIdx; h++) {
      for (const b of days[h].bars) {
        if (b.range_10 !== undefined) hist[b.quad].push(b.range_10);
        if (b.fwd_range_30 !== undefined) {
          histFwdR[b.quad].push(b.fwd_range_30);
          histFwdD[b.quad].push(b.fwd_max_disp);
        }
      }
    }
    
    // Sort
    for (let q = 1; q <= 4; q++) {
      hist[q].sort((a, b) => a - b);
      histFwdR[q].sort((a, b) => a - b);
      histFwdD[q].sort((a, b) => a - b);
    }
    
    // Print lookahead sanity check for the first evaluated day (dIdx === 60)
    if (dIdx === 60) {
      console.log(`\n--- SANITY CHECK (Lookahead verification) ---`);
      console.log(`Evaluating Day D: ${day.d}`);
      console.log(`Trailing window bounds: Day D-60 (${days[dIdx-60].d}) to Day D-1 (${days[dIdx-1].d})`);
      console.log(`History count for Quad 1: ${hist[1].length} bars`);
      console.log(`Does Day D history contain any Day D bars? No, loop bounds are strict (h < dIdx).`);
      console.log(`---------------------------------------------\n`);
    }

    inContraction = false;
    let possibleControls = [];

    for (let i = W - 1; i < bars.length; i++) {
      const b = bars[i];
      const q = b.quad;
      const hRange = hist[q];
      if (!hRange.length) continue;
      
      const { p10, p40, p60 } = getPercentilesOfDistribution(hRange);
      
      if (b.fwd_range_30 === undefined) {
        if (b.range_10 <= p10) {
           excludedCount++;
           totalQualifyingBars++;
        }
        continue; // not enough fwd bars
      }

      const qFwdR = getPercentile(b.fwd_range_30, histFwdR[q]);
      const qFwdD = getPercentile(b.fwd_max_disp, histFwdD[q]);
      const isTopQuartileR = qFwdR >= 0.75 ? 1 : 0;
      const isTopQuartileD = qFwdD >= 0.75 ? 1 : 0;
      
      if (b.range_10 <= p10) {
        totalQualifyingBars++;
        if (!inContraction) {
          inContraction = true;
          events.push({
            date: day.d,
            bar: b,
            topQR: isTopQuartileR,
            topQD: isTopQuartileD,
            dIdx
          });
        }
      } else {
        inContraction = false;
        if (b.range_10 >= p40 && b.range_10 <= p60) {
          possibleControls.push({
            date: day.d,
            bar: b,
            topQR: isTopQuartileR,
            topQD: isTopQuartileD,
            dIdx
          });
        }
      }
    }
    
    // Sample controls (at least 1:1 if possible)
    const dayEventCount = events.filter(e => e.date === day.d).length;
    if (dayEventCount > 0 && possibleControls.length > 0) {
      // Pick controls randomly or evenly spaced. Let's pick evenly spaced to ensure good coverage.
      const step = Math.max(1, Math.floor(possibleControls.length / dayEventCount));
      for (let k = 0; k < dayEventCount && k*step < possibleControls.length; k++) {
        controls.push(possibleControls[k*step]);
      }
    }
  }
  
  console.log(`Clustered events: ${events.length} (from ${totalQualifyingBars} qualifying bars).`);
  console.log(`Excluded events (not enough forward bars): ${excludedCount}`);
  console.log(`Control events sampled: ${controls.length}`);

  // Analyze Events
  const analyzeGroup = (evs) => {
    if (!evs.length) return { hitRateR: 0, hitRateD: 0, n: 0 };
    const sumR = evs.reduce((sum, e) => sum + e.topQR, 0);
    const sumD = evs.reduce((sum, e) => sum + e.topQD, 0);
    return {
      hitRateR: +(sumR / evs.length).toFixed(4),
      hitRateD: +(sumD / evs.length).toFixed(4),
      n: evs.length
    };
  };

  const evStats = analyzeGroup(events);
  const ctStats = analyzeGroup(controls);

  // Chronological Split
  const halfIdx = Math.floor(days.length / 2); // Roughly 2 years split
  const splitDay = days[halfIdx].d;
  const ev1 = events.filter(e => e.dIdx < halfIdx);
  const ev2 = events.filter(e => e.dIdx >= halfIdx);
  const ct1 = controls.filter(e => e.dIdx < halfIdx);
  const ct2 = controls.filter(e => e.dIdx >= halfIdx);

  const statE1 = analyzeGroup(ev1);
  const statE2 = analyzeGroup(ev2);
  const statC1 = analyzeGroup(ct1);
  const statC2 = analyzeGroup(ct2);

  // Rigor
  const rigorD = computeRigor(events, { dateField: 'date', pnlFn: (e) => (e.topQD ? +1 : -1) });
  const rigorR = computeRigor(events, { dateField: 'date', pnlFn: (e) => (e.topQR ? +1 : -1) });
  
  let verdict = "PROVISIONAL";
  const beatsControl = (evStats.hitRateD > ctStats.hitRateD) && (evStats.hitRateR > ctStats.hitRateR);
  const beatsControlBothHalves = (statE1.hitRateD > statC1.hitRateD && statE1.hitRateR > statC1.hitRateR) &&
                                 (statE2.hitRateD > statC2.hitRateD && statE2.hitRateR > statC2.hitRateR);

  if (beatsControl && beatsControlBothHalves && rigorD.clean && rigorR.clean) {
    verdict = "CONFIRMED";
  }

  const resultText = `
# Pinch Contraction Pilot Results

## Global Data Resolution Check
- Median range_10: ${globalMedian.toFixed(2)}
- P10 range_10: ${globalP10.toFixed(2)}
${resolutionWarning}

## Event Statistics
- Total qualifying bars: ${totalQualifyingBars}
- Clustered events: ${events.length}
- Excluded due to insufficient forward bars: ${excludedCount}
- Ratio of bars to clustered events: ${(totalQualifyingBars / (events.length || 1)).toFixed(2)}
- Control events (same-day, same-quadrant, P40-P60 range): ${controls.length}

## Outcome Comparison (Probability of Forward Outcome in Top Quartile)

### Displacement Outcome (\`max(abs(close - price_at_event))\`)
- Contraction events: ${(evStats.hitRateD * 100).toFixed(1)}% (N=${evStats.n})
- Control events: ${(ctStats.hitRateD * 100).toFixed(1)}% (N=${ctStats.n})

### Range Outcome (\`max(high) - min(low)\`)
- Contraction events: ${(evStats.hitRateR * 100).toFixed(1)}% (N=${evStats.n})
- Control events: ${(ctStats.hitRateR * 100).toFixed(1)}% (N=${ctStats.n})

## Chronological Split
**First Half (before ${splitDay})**
- Displacement Outcome: Contraction ${(statE1.hitRateD * 100).toFixed(1)}% vs Control ${(statC1.hitRateD * 100).toFixed(1)}%
- Range Outcome: Contraction ${(statE1.hitRateR * 100).toFixed(1)}% vs Control ${(statC1.hitRateR * 100).toFixed(1)}%

**Second Half (after ${splitDay})**
- Displacement Outcome: Contraction ${(statE2.hitRateD * 100).toFixed(1)}% vs Control ${(statC2.hitRateD * 100).toFixed(1)}%
- Range Outcome: Contraction ${(statE2.hitRateR * 100).toFixed(1)}% vs Control ${(statC2.hitRateR * 100).toFixed(1)}%

## Rigor Diagnostics (Displacement Outcome)
- Clean: ${rigorD.clean}
- Distinct Dates: ${rigorD.distinctDates}
- Top 5 Day Pct: ${rigorD.top5DayPct}% (Clustered: ${rigorD.clustered})
- 3-way Stable: ${rigorD.stable} (Thirds: ${JSON.stringify(rigorD.thirds)})

## Rigor Diagnostics (Range Outcome)
- Clean: ${rigorR.clean}
- Distinct Dates: ${rigorR.distinctDates}
- Top 5 Day Pct: ${rigorR.top5DayPct}% (Clustered: ${rigorR.clustered})
- 3-way Stable: ${rigorR.stable} (Thirds: ${JSON.stringify(rigorR.thirds)})
`;

  fs.writeFileSync('scratch/pinch_contraction_pilot_RESULTS.md', resultText);
  console.log("Results written to scratch/pinch_contraction_pilot_RESULTS.md");

  // Record Claim
  const claimText = `Intraday (W=10) pinch contraction (P10) vs control. Disp top-quartile: ${(evStats.hitRateD*100).toFixed(1)}% vs ${(ctStats.hitRateD*100).toFixed(1)}%. Range top-quartile: ${(evStats.hitRateR*100).toFixed(1)}% vs ${(ctStats.hitRateR*100).toFixed(1)}%.`;
  await recordClaim({
    slug: 'intraday_pinch_contraction_p10_rth',
    claimText,
    sourceFile: 'scripts/pilot_pinch_contraction.mjs',
    sampleSize: events.length,
    winRate: evStats.hitRateD,
    evPerTrade: null,
    rigorStatus: (rigorD.clean && rigorR.clean) ? 'clean' : (!rigorD.clean ? 'failed_disp_rigor' : 'failed_range_rigor'),
    status: verdict
  });
  console.log("Recorded claim.");
}

main().then(() => process.exit(0)).catch(console.error);
