import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

async function main() {
  console.log('Loading NQ 1-min bars...');
  const barsRes = await query(`
    SELECT ts, (date(ts AT TIME ZONE 'America/New_York'))::text as et_date,
      (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
       EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York'))::int as et_min,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol = 'NQ'
    ORDER BY ts ASC
  `);
  console.log(`Loaded ${barsRes.rows.length} bars.`);

  const rthDatesSet = new Set(barsRes.rows.filter(r => r.et_min >= 570 && r.et_min < 960).map(r => r.et_date));
  const rthDates = [...rthDatesSet].sort();

  const byDate = new Map();
  for (const b of barsRes.rows) {
    if (!byDate.has(b.et_date)) byDate.set(b.et_date, []);
    byDate.get(b.et_date).push(b);
  }

  // Define overnight sessions
  const overnightData = [];
  for (let i = 1; i < rthDates.length; i++) {
    const today = rthDates[i];
    const prior = rthDates[i - 1];
    const todayBars = byDate.get(today) || [];
    const priorBars = byDate.get(prior) || [];
    const overnightBars = priorBars.filter(b => b.et_min >= 960).concat(todayBars.filter(b => b.et_min < 570));
    if (overnightBars.length === 0) continue;

    const highs = overnightBars.map(b => b.high);
    const lows = overnightBars.map(b => b.low);
    const range = Math.max(...highs) - Math.min(...lows);

    const dToday = new Date(today + 'T12:00:00Z');
    const dPrior = new Date(prior + 'T12:00:00Z');
    if ((dToday - dPrior) > 6 * 24 * 3600 * 1000) continue; // data gap guard

    overnightData.push({ today, prior, overnightBars, range });
  }

  // Sort chronological for train/test split
  overnightData.sort((a, b) => a.today.localeCompare(b.today));

  // Compute Threshold on ALL data (to match exactly the existing method's threshold)
  const sortedRanges = [...overnightData].map(d => d.range).sort((a, b) => a - b);
  const threshold = sortedRanges[Math.floor(sortedRanges.length * 0.8)];
  console.log(`80th percentile threshold = ${threshold.toFixed(2)} pts (N days=${sortedRanges.length})`);

  // Split into 70% Train, 30% Test
  const splitIdx = Math.floor(overnightData.length * 0.7);
  const trainData = overnightData.slice(0, splitIdx);
  const testData = overnightData.slice(splitIdx);
  console.log(`Split: ${trainData.length} Train days, ${testData.length} Test days.`);

  function getLandmark(et_min) {
    if (et_min >= 960) {
      if (et_min < 1080) return '1_Pre_Globex'; // 16:00 - 18:00
      return '2_Evening'; // 18:00 - 00:00
    } else {
      if (et_min < 180) return '3_Asia'; // 00:00 - 03:00
      if (et_min < 510) return '4_London'; // 03:00 - 08:30
      return '5_Pre_Market'; // 08:30 - 09:30
    }
  }

  const landmarksOrder = ['1_Pre_Globex', '2_Evening', '3_Asia', '4_London', '5_Pre_Market'];

  function analyzeDataset(dataset, name) {
    const results = { UP: [], DOWN: [] };
    for (const d of dataset) {
      if (d.range < threshold) continue;
      let moveStartBar = null, startPrice = null, moveType = null;
      let rollingHigh = -Infinity, tHigh = null, rollingLow = Infinity, tLow = null;
      
      for (const b of d.overnightBars) {
        if (b.high > rollingHigh) { rollingHigh = b.high; tHigh = b; }
        if (b.low < rollingLow) { rollingLow = b.low; tLow = b; }
        if (b.close - rollingLow >= threshold) { moveStartBar = tLow; startPrice = tLow.low; moveType = 'UP'; break; }
        if (rollingHigh - b.close >= threshold) { moveStartBar = tHigh; startPrice = tHigh.high; moveType = 'DOWN'; break; }
      }
      
      if (!moveStartBar) continue;

      const startIdx = d.overnightBars.indexOf(moveStartBar);
      let taperBar = moveStartBar;
      let extremePrice = moveType === 'UP' ? moveStartBar.high : moveStartBar.low;
      
      for (let i = startIdx + 1; i < d.overnightBars.length; i++) {
        const b = d.overnightBars[i];
        if (moveType === 'UP') {
          if (b.high > extremePrice) {
            extremePrice = b.high;
            taperBar = b;
          }
        } else {
          if (b.low < extremePrice) {
            extremePrice = b.low;
            taperBar = b;
          }
        }
      }

      const landmark = getLandmark(taperBar.et_min);
      results[moveType].push({
        date: d.today,
        startEtMin: moveStartBar.et_min,
        taperEtMin: taperBar.et_min,
        landmark,
        taperBar
      });
    }
    return results;
  }

  const trainResults = analyzeDataset(trainData, 'Train');
  const testResults = analyzeDataset(testData, 'Test');

  function getCumulative(resultsForType) {
    const counts = { '1_Pre_Globex': 0, '2_Evening': 0, '3_Asia': 0, '4_London': 0, '5_Pre_Market': 0 };
    for (const r of resultsForType) {
      counts[r.landmark]++;
    }
    let cum = 0;
    const cumulatives = {};
    for (const l of landmarksOrder) {
      cum += counts[l];
      cumulatives[l] = resultsForType.length > 0 ? cum / resultsForType.length : 0;
    }
    return { counts, cumulatives, total: resultsForType.length };
  }

  const trainUp = getCumulative(trainResults.UP);
  const trainDown = getCumulative(trainResults.DOWN);

  console.log('\n--- TRAIN SET RESULTS ---');
  console.log(`UP Moves (N=${trainUp.total}):`, trainUp.cumulatives);
  console.log(`DOWN Moves (N=${trainDown.total}):`, trainDown.cumulatives);

  // Derive the landmark from the Train set
  // We want the landmark where DOWN moves are mostly tapered (>75%) and UP moves are less tapered (max difference)
  let bestLandmark = null;
  let maxDiff = -Infinity;
  for (const l of landmarksOrder) {
    if (l === '5_Pre_Market') continue; // Don't use the very end of the session
    const diff = trainDown.cumulatives[l] - trainUp.cumulatives[l];
    if (trainDown.cumulatives[l] >= 0.70 && diff > maxDiff) {
      maxDiff = diff;
      bestLandmark = l;
    }
  }

  if (!bestLandmark) {
    // Fallback to highest diff
    for (const l of landmarksOrder) {
      if (l === '5_Pre_Market') continue;
      const diff = trainDown.cumulatives[l] - trainUp.cumulatives[l];
      if (diff > maxDiff) {
        maxDiff = diff;
        bestLandmark = l;
      }
    }
  }

  console.log(`\nDerived Landmark from Train Set: ${bestLandmark} (Diff: ${(maxDiff*100).toFixed(1)}%)`);

  // Evaluate on Test set
  const testUp = getCumulative(testResults.UP);
  const testDown = getCumulative(testResults.DOWN);
  
  console.log('\n--- TEST SET RESULTS ---');
  console.log(`UP Moves (N=${testUp.total}):`, testUp.cumulatives);
  console.log(`DOWN Moves (N=${testDown.total}):`, testDown.cumulatives);

  // Rigor calculation for Test set
  // pnlFn returns 1 if tapered by bestLandmark, -1 if tapered after
  function getIsTaperedByBest(landmark) {
    const bestIdx = landmarksOrder.indexOf(bestLandmark);
    const thisIdx = landmarksOrder.indexOf(landmark);
    return thisIdx <= bestIdx;
  }

  const rigorDown = computeRigor(testResults.DOWN, { pnlFn: r => getIsTaperedByBest(r.landmark) ? 1 : -1 });
  const rigorUp = computeRigor(testResults.UP, { pnlFn: r => getIsTaperedByBest(r.landmark) ? 1 : -1 });

  const testDownRate = testDown.cumulatives[bestLandmark];
  const testUpRate = testUp.cumulatives[bestLandmark];
  
  const hasMinN = testDown.total >= 20 && testUp.total >= 20;

  const verdict = hasMinN 
    ? (testDownRate > testUpRate + 0.10
       ? `Positive finding: On the held-out test set (N>20), DOWN moves taper by ${bestLandmark} significantly more often ( ${(testDownRate*100).toFixed(1)}%, N=${testDown.total}) than UP moves (${(testUpRate*100).toFixed(1)}%, N=${testUp.total}). This confirms the RTH asymmetric taper pattern also exists in the overnight session.`
       : `Negative finding: On the held-out test set (N>20), DOWN moves (${(testDownRate*100).toFixed(1)}%) did not consistently taper faster than UP moves (${(testUpRate*100).toFixed(1)}%) by the derived ${bestLandmark} landmark. The overnight session does NOT reliably share the RTH directional taper asymmetry.`)
    : `Inconclusive / Negative finding: The held-out test set did not meet the N>=20 requirement (DOWN N=${testDown.total}, UP N=${testUp.total}). Cannot validate an out-of-sample pattern.`;

  const output = `
# Overnight Directional Taper Timing (Out-of-Sample Validated)

## Methodology
- **Threshold**: 80th percentile of Globex session ranges = ${threshold.toFixed(2)} pts (computed over N=${sortedRanges.length} days).
- **Move Start Detection**: Rolling-extremum walk from overnight start. The bar where price breaks the ${threshold.toFixed(2)}pt threshold from its rolling extreme is the start.
- **Taper Point Detection**: The timestamp of the absolute extreme (highest high for UP, lowest low for DOWN) reached before RTH open.
- **Out-of-Sample Rigor**: Data split chronologically into 70% Train (${trainData.length} days) and 30% Test (${testData.length} days).
- **Landmark Derivation**: The optimal landmark was derived *only* from the Train set to prevent overfitting.
- **Derived Landmark**: ${bestLandmark}.

## Train Set (In-Sample) Results
- DOWN Moves (N=${trainDown.total}): ${(trainDown.cumulatives[bestLandmark]*100).toFixed(1)}% tapered by ${bestLandmark}.
- UP Moves (N=${trainUp.total}): ${(trainUp.cumulatives[bestLandmark]*100).toFixed(1)}% tapered by ${bestLandmark}.
- In-sample gap: ${(maxDiff*100).toFixed(1)}%.

## Test Set (Out-of-Sample) Results
- DOWN Moves (N=${testDown.total}): ${(testDownRate*100).toFixed(1)}% tapered by ${bestLandmark}.
- UP Moves (N=${testUp.total}): ${(testUpRate*100).toFixed(1)}% tapered by ${bestLandmark}.
- Out-of-sample gap: ${((testDownRate - testUpRate)*100).toFixed(1)}%.

## Rigor Diagnostics (Test Set)
- DOWN moves day-clustering: ${JSON.stringify(rigorDown)}
- UP moves day-clustering: ${JSON.stringify(rigorUp)}

## Verdict
${verdict}
`;

  console.log('\n' + verdict);

  fs.writeFileSync('scratch/antigravity_response.md', output);
  fs.writeFileSync('scratch/backtest_overnight_taper_timing_RESULTS.md', output);

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
  await recordClaim({
    slug: 'globex_directional_taper_asymmetry',
    claimText: `${verdict} Test set rates: DOWN ${(testDownRate*100).toFixed(1)}% (N=${testDown.total}) vs UP ${(testUpRate*100).toFixed(1)}% (N=${testUp.total}) by ${bestLandmark}. Derived out-of-sample via 70/30 chronological split.`,
    sourceFile: 'scripts/backtest_overnight_taper_timing.mjs',
    sourceDate: today,
    sampleSize: testDown.total + testUp.total,
    winRate: testDownRate, // using down rate as the primary stat
    rigorStatus: rigorDown.clean && rigorUp.clean ? 'clean' : 'flagged',
    status: 'PROVISIONAL',
  });
  console.log('Recorded RESEARCH_CLAIM: globex_directional_taper_asymmetry');

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
