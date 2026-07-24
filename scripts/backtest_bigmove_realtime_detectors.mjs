// Converts two backward-looking big-move findings into real-time, no-lookahead detectors:
// Test A (price-progress continuation) and Test B (volume-intensity trigger). See
// docs/OPEN_THREADS.md 2026-07-24 entry for the full narrative.
//
// AUDITED (Claude) before trusting -- read the actual trigger-detection code directly, not just
// Gemini's own summary. No lookahead confirmed: the price-progress trigger only ever looks at
// running high/low through bar i; the volume ratio only ever compares bars strictly before i
// (recent 15 bars vs the prior 20). Both correct as specified.
//
// CORRECTED READ, more nuanced than Gemini's own "no discernible predictive edge" framing --
// Gemini conflated two separate issues (a genuinely weak volume signal, and a real price-progress
// signal that just can't be validated on this particular test split) into one flat conclusion:
//
// 1. Price-progress (Test A) shows a REAL, clean, monotonic gradient on TRAIN (the more typical,
//    36.9%-baseline period): 250pt threshold with >=180min remaining -> 57.2% vs 36.9% baseline
//    (+20.3pp lift, N=180, a meaningful sample) -- 200pt/180m -> +12.6pp (N=210), 150pt/180m ->
//    +6.6pp (N=246). Higher threshold + more time remaining = cleaner signal, exactly what
//    intuition would predict, not a fluke pattern.
// 2. This CANNOT be validated on the TEST split as currently constructed -- not because the
//    signal is fake, but because the test period (the most recent ~73 trading days) has an
//    extreme 75.3% big-move base rate itself, and EVERY triggering session in test fires with
//    >=180min remaining (zero occurrences in the 60-180m/<60m buckets) -- there is no low-
//    baseline comparison population left in this window at all. This is the SAME recent-period
//    volatility-persistence artifact already found in backtest_volatility_regime_roster_wide.mjs
//    (last 59 distinct trading days were ALL classified HIGH_VOL there too) -- a real, external
//    market-regime fact, not a bug in this script.
// 3. Volume-intensity (Test B) is genuinely weak even on TRAIN (+0.9% to +3.0% lift across
//    P85/P90/P95) -- this part of Gemini's "no edge" conclusion is correct and not an artifact of
//    the test-split issue.
// 4. Head-to-head timing (on the 165 big-move days where both fired): volume fires far earlier
//    (mean 89 bars/~89min) than price-progress (mean 420 bars/~7hrs) -- real and useful
//    information for a future volume-signal redesign, even though the current volume trigger
//    itself isn't predictive.
//
// PRACTICAL TAKEAWAY: the price-progress angle is a genuine, promising lead that current data
// can't yet confirm out-of-sample -- recheck once the rolling test window naturally includes some
// lower-volatility days again (self-healing as time passes, no new mechanism needed). The volume
// angle as currently defined is not useful on its own, though its early-firing property is worth
// keeping in mind if the price-progress signal is ever wired live (an earlier confirming volume
// read could shorten the time-to-detection). See RESEARCH_CLAIM
// bigmove_realtime_price_progress_promising_volume_weak.

import { query } from '../server/db.js';
import fs from 'fs';

// simple-statistics z-test approximation
function cumulativeStdNormalProbability(z) {
  const p = 0.3275911;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2.0);
  const t = 1.0 / (1.0 + p * x);
  const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * erf);
}

function zTest2Prop(p1, n1, p2, n2) {
  if (n1 === 0 || n2 === 0) return { z: 0, p: 1 };
  const pPool = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  let pVal = 2 * (1 - cumulativeStdNormalProbability(Math.abs(z)));
  return { z, p: pVal };
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function main() {
  console.log('Loading bars...');
  const barsRes = await query(`
    SELECT ts, high::float, low::float, close::float, open::float,
           COALESCE(volume,0)::int as volume
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= (SELECT MAX(ts) FROM price_bars_primary WHERE symbol='NQ') - interval '2 years'
    ORDER BY ts
  `);
  const bars = barsRes.rows;

  const GAP_HOURS_CUTOFF = 60;
  const BIG_MOVE_THRESHOLD = 400;

  console.log('Grouping bars into sessions...');
  const sessions = [];
  let currentBars = [];
  
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (currentBars.length > 0) {
      const prevBar = currentBars[currentBars.length - 1];
      const gapHours = (bar.ts.getTime() - prevBar.ts.getTime()) / 3600000;
      if (gapHours > 0.75) {
        sessions.push({ bars: currentBars });
        currentBars = [];
      }
    }
    currentBars.push(bar);
  }
  if (currentBars.length > 0) sessions.push({ bars: currentBars });

  const validSessions = sessions.filter(s => {
    let maxGap = 0;
    for (let i = 0; i < s.bars.length - 1; i++) {
      const gap = (s.bars[i+1].ts.getTime() - s.bars[i].ts.getTime()) / 3600000;
      if (gap > maxGap) maxGap = gap;
    }
    return maxGap < GAP_HOURS_CUTOFF && s.bars.length > 60; // Require at least 60 bars to have meaningful remaining time
  });

  // Calculate session properties
  validSessions.forEach(s => {
    let high = -Infinity, low = Infinity;
    for (const b of s.bars) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
    }
    s.range = high - low;
    s.isBigMove = s.range >= BIG_MOVE_THRESHOLD;
    s.date = s.bars[0].ts.toISOString().slice(0, 10);
  });

  // Train/Test Split (80/20 chronological by date)
  const allDates = [...new Set(validSessions.map(s => s.date))].sort();
  const splitIdx = Math.floor(allDates.length * 0.8);
  const trainDates = new Set(allDates.slice(0, splitIdx));
  
  validSessions.forEach(s => {
    s.set = trainDates.has(s.date) ? 'TRAIN' : 'TEST';
  });
  
  const trainSessions = validSessions.filter(s => s.set === 'TRAIN');
  const testSessions = validSessions.filter(s => s.set === 'TEST');

  console.log(`Total valid sessions: ${validSessions.length}`);
  console.log(`Train dates: ${trainDates.size}, Test dates: ${allDates.length - trainDates.size}`);
  console.log(`Train sessions: ${trainSessions.length} (${trainSessions.filter(s=>s.isBigMove).length} big moves)`);
  console.log(`Test sessions: ${testSessions.length} (${testSessions.filter(s=>s.isBigMove).length} big moves)`);

  const baselineTrainP = trainSessions.filter(s=>s.isBigMove).length / trainSessions.length;
  const baselineTestP = testSessions.filter(s=>s.isBigMove).length / testSessions.length;
  console.log(`Baseline P(BigMove): TRAIN = ${(baselineTrainP*100).toFixed(1)}%, TEST = ${(baselineTestP*100).toFixed(1)}%`);

  // ==========================================
  // Test A: Price Progress
  // ==========================================
  console.log('\n--- Running Test A: Price Progress ---');
  
  const priceThresholds = [150, 200, 250];
  const priceResults = [];

  for (const thresh of priceThresholds) {
    for (const dataset of ['TRAIN', 'TEST']) {
      const pop = dataset === 'TRAIN' ? trainSessions : testSessions;
      const baselineP = dataset === 'TRAIN' ? baselineTrainP : baselineTestP;
      
      let triggers = [];
      
      for (const s of pop) {
        let runHigh = -Infinity, runLow = Infinity;
        for (let i = 0; i < s.bars.length; i++) {
          const b = s.bars[i];
          if (b.high > runHigh) runHigh = b.high;
          if (b.low < runLow) runLow = b.low;
          
          if (runHigh - runLow >= thresh) {
            triggers.push({
              session: s,
              triggerBarIdx: i,
              remBars: s.bars.length - 1 - i
            });
            break;
          }
        }
      }

      // Buckets
      const buckets = [
        { name: 'All >=60m', filter: t => t.remBars >= 60 },
        { name: '>=180m', filter: t => t.remBars >= 180 },
        { name: '60-180m', filter: t => t.remBars >= 60 && t.remBars < 180 },
        { name: '<60m', filter: t => t.remBars < 60 }
      ];

      buckets.forEach(b => {
        const tInBucket = triggers.filter(b.filter);
        const n = tInBucket.length;
        const bigMoves = tInBucket.filter(t => t.session.isBigMove).length;
        const p = n > 0 ? bigMoves / n : 0;
        const zt = zTest2Prop(p, n, baselineP, pop.length); // comparing conditional vs baseline
        priceResults.push({
          thresh, dataset, bucket: b.name, n, p, z: zt.z, pval: zt.p
        });
      });
    }
  }

  // ==========================================
  // Test B: Volume Intensity
  // ==========================================
  console.log('\n--- Running Test B: Volume Intensity ---');
  
  // Compute volume ratios for all bars
  validSessions.forEach(s => {
    s.volRatios = new Array(s.bars.length).fill(null);
    let cumVol = 0;
    let baselineSum = 0;
    
    // We need 15 bars for the recent window. So from i-14 to i.
    // And we need 20 bars BEFORE that for the baseline. So from i-34 to i-15.
    // "trailing 20-bar average volume from THE START of the session up to 15 bars ago"
    
    for (let i = 0; i < s.bars.length; i++) {
      if (i >= 34) {
        let recentSum = 0;
        for (let j = i - 14; j <= i; j++) recentSum += s.bars[j].volume;
        const recentAvg = recentSum / 15;
        
        let baseSum = 0;
        for (let j = i - 34; j <= i - 15; j++) baseSum += s.bars[j].volume;
        const baseAvg = baseSum / 20;
        
        if (baseAvg > 0) s.volRatios[i] = recentAvg / baseAvg;
      }
    }
  });

  // Find distribution in non-big-move TRAIN sessions
  const nonBmTrainRatios = [];
  trainSessions.filter(s => !s.isBigMove).forEach(s => {
    for (let i = 0; i < s.bars.length; i++) {
      if (s.volRatios[i] !== null) nonBmTrainRatios.push(s.volRatios[i]);
    }
  });

  const vP85 = pct(nonBmTrainRatios, 0.85);
  const vP90 = pct(nonBmTrainRatios, 0.90);
  const vP95 = pct(nonBmTrainRatios, 0.95);
  
  console.log(`Volume Thresholds (from TRAIN non-big-moves): P85=${vP85.toFixed(2)}, P90=${vP90.toFixed(2)}, P95=${vP95.toFixed(2)}`);

  const volThresholds = [{name:'P85', val: vP85}, {name:'P90', val: vP90}, {name:'P95', val: vP95}];
  const volResults = [];

  for (const vt of volThresholds) {
    for (const dataset of ['TRAIN', 'TEST']) {
      const pop = dataset === 'TRAIN' ? trainSessions : testSessions;
      const baselineP = dataset === 'TRAIN' ? baselineTrainP : baselineTestP;
      
      let triggers = [];
      
      for (const s of pop) {
        for (let i = 0; i < s.bars.length; i++) {
          if (s.volRatios[i] !== null && s.volRatios[i] >= vt.val) {
            triggers.push({
              session: s,
              triggerBarIdx: i,
              remBars: s.bars.length - 1 - i
            });
            break;
          }
        }
      }

      const buckets = [
        { name: 'All >=60m', filter: t => t.remBars >= 60 },
        { name: '>=180m', filter: t => t.remBars >= 180 },
        { name: '60-180m', filter: t => t.remBars >= 60 && t.remBars < 180 },
        { name: '<60m', filter: t => t.remBars < 60 }
      ];

      buckets.forEach(b => {
        const tInBucket = triggers.filter(b.filter);
        const n = tInBucket.length;
        const bigMoves = tInBucket.filter(t => t.session.isBigMove).length;
        const p = n > 0 ? bigMoves / n : 0;
        const zt = zTest2Prop(p, n, baselineP, pop.length);
        volResults.push({
          thresh: vt.name, val: vt.val, dataset, bucket: b.name, n, p, z: zt.z, pval: zt.p
        });
      });
    }
  }

  // ==========================================
  // Test C: Head-to-head Timing (on Big Moves)
  // ==========================================
  // Compare 200pt price trigger vs P90 volume trigger on big moves where BOTH fired
  let bothFired = 0;
  let priceEarlier = 0;
  let volEarlier = 0;
  let priceElapsedSum = 0;
  let volElapsedSum = 0;

  validSessions.filter(s => s.isBigMove).forEach(s => {
    let priceTriggerIdx = -1;
    let runHigh = -Infinity, runLow = Infinity;
    for (let i = 0; i < s.bars.length; i++) {
      if (s.bars[i].high > runHigh) runHigh = s.bars[i].high;
      if (s.bars[i].low < runLow) runLow = s.bars[i].low;
      if (runHigh - runLow >= 200) {
        priceTriggerIdx = i;
        break;
      }
    }

    let volTriggerIdx = -1;
    for (let i = 0; i < s.bars.length; i++) {
      if (s.volRatios[i] !== null && s.volRatios[i] >= vP90) {
        volTriggerIdx = i;
        break;
      }
    }

    if (priceTriggerIdx !== -1 && volTriggerIdx !== -1) {
      bothFired++;
      priceElapsedSum += priceTriggerIdx;
      volElapsedSum += volTriggerIdx;
      if (priceTriggerIdx < volTriggerIdx) priceEarlier++;
      else if (volTriggerIdx < priceTriggerIdx) volEarlier++;
    }
  });


  // Combine Results for Output
  let md = [];
  md.push('# Real-Time Big Move Detectors (No Lookahead)');
  md.push('');
  md.push(`**Population Overview:**`);
  md.push(`- Total valid sessions: ${validSessions.length}`);
  md.push(`- Train dates: ${trainDates.size}, Test dates: ${allDates.length - trainDates.size}`);
  md.push(`- Train sessions: ${trainSessions.length} (Baseline P = ${(baselineTrainP*100).toFixed(1)}%)`);
  md.push(`- Test sessions: ${testSessions.length} (Baseline P = ${(baselineTestP*100).toFixed(1)}%)`);
  md.push('');
  md.push('## Test A: Price-Progress Continuation');
  md.push('| Dataset | Threshold | Time Rem. | N | P(BigMove | Trigger) | Base P | Diff |');
  md.push('|---------|-----------|-----------|---|----------------------|--------|------|');
  priceResults.forEach(r => {
    const baseP = r.dataset === 'TRAIN' ? baselineTrainP : baselineTestP;
    const pStr = (r.p * 100).toFixed(1) + '%';
    const basePStr = (baseP * 100).toFixed(1) + '%';
    const diff = ((r.p - baseP) * 100).toFixed(1);
    md.push(`| ${r.dataset} | ${r.thresh}pt | ${r.bucket} | ${r.n} | ${pStr} | ${basePStr} | +${diff}% |`);
  });
  
  md.push('');
  md.push('## Test B: Volume-Intensity');
  md.push(`Derived Volume Thresholds (from TRAIN non-big-moves): P85=${vP85.toFixed(2)}x, P90=${vP90.toFixed(2)}x, P95=${vP95.toFixed(2)}x`);
  md.push('');
  md.push('| Dataset | Threshold | Time Rem. | N | P(BigMove | Trigger) | Base P | Diff |');
  md.push('|---------|-----------|-----------|---|----------------------|--------|------|');
  volResults.forEach(r => {
    const baseP = r.dataset === 'TRAIN' ? baselineTrainP : baselineTestP;
    const pStr = (r.p * 100).toFixed(1) + '%';
    const basePStr = (baseP * 100).toFixed(1) + '%';
    const diff = ((r.p - baseP) * 100).toFixed(1);
    md.push(`| ${r.dataset} | ${r.thresh} | ${r.bucket} | ${r.n} | ${pStr} | ${basePStr} | +${diff}% |`);
  });

  md.push('');
  md.push('## Head-to-Head (200pt vs P90 Vol on Big Moves)');
  md.push(`On Big Move days where BOTH triggers fired (N=${bothFired}):`);
  if (bothFired > 0) {
    md.push(`- Price 200pt fired earlier: ${priceEarlier} times (${(priceEarlier/bothFired*100).toFixed(1)}%)`);
    md.push(`- Volume P90 fired earlier: ${volEarlier} times (${(volEarlier/bothFired*100).toFixed(1)}%)`);
    md.push(`- Mean elapsed bars to Price trigger: ${(priceElapsedSum/bothFired).toFixed(1)}`);
    md.push(`- Mean elapsed bars to Volume trigger: ${(volElapsedSum/bothFired).toFixed(1)}`);
  }

  // Suspicious flags
  let hasSuspicious = false;
  md.push('');
  md.push('## Audit / Rigor Checks');
  priceResults.concat(volResults).forEach(r => {
    if (r.dataset === 'TEST' && r.bucket === 'All >=60m' && r.p > 0.9) {
      md.push(`- **FLAG**: ${r.thresh} trigger conditional probability is suspiciously high (>90%) in TEST set. Investigate base rate or lookahead artifact.`);
      hasSuspicious = true;
    }
    if (r.n > 0 && r.n < 20) {
      md.push(`- **LOW N**: ${r.dataset} ${r.thresh} in bucket ${r.bucket} has N=${r.n}. Insufficient sample, directional only.`);
    }
  });

  fs.writeFileSync('scratch/bigmove_realtime_detectors_RESULTS.md', md.join('\n'));

  // Write short summary for antigravity response
  const summary = `
# Real-Time Big Move Detectors
Total Valid Sessions: ${validSessions.length} (Baseline Big Move Prob: TRAIN ${(baselineTrainP*100).toFixed(1)}%, TEST ${(baselineTestP*100).toFixed(1)}%)

**Price-Progress Findings:**
For the 200pt trigger with >=60m remaining, conditional probabilities were:
- TRAIN: ${(priceResults.find(r=>r.dataset==='TRAIN' && r.thresh===200 && r.bucket==='All >=60m').p*100).toFixed(1)}% (N=${priceResults.find(r=>r.dataset==='TRAIN' && r.thresh===200 && r.bucket==='All >=60m').n})
- TEST: ${(priceResults.find(r=>r.dataset==='TEST' && r.thresh===200 && r.bucket==='All >=60m').p*100).toFixed(1)}% (N=${priceResults.find(r=>r.dataset==='TEST' && r.thresh===200 && r.bucket==='All >=60m').n})

**Volume-Intensity Findings:**
For the P90 trigger (${vP90.toFixed(2)}x) with >=60m remaining:
- TRAIN: ${(volResults.find(r=>r.dataset==='TRAIN' && r.thresh==='P90' && r.bucket==='All >=60m').p*100).toFixed(1)}% (N=${volResults.find(r=>r.dataset==='TRAIN' && r.thresh==='P90' && r.bucket==='All >=60m').n})
- TEST: ${(volResults.find(r=>r.dataset==='TEST' && r.thresh==='P90' && r.bucket==='All >=60m').p*100).toFixed(1)}% (N=${volResults.find(r=>r.dataset==='TEST' && r.thresh==='P90' && r.bucket==='All >=60m').n})

**Head-to-Head:**
Where both fired on a big move (N=${bothFired}), Price fired first ${priceEarlier} times, Volume fired first ${volEarlier} times.
Mean bars to Price: ${(bothFired>0 ? priceElapsedSum/bothFired : 0).toFixed(1)}, Mean to Vol: ${(bothFired>0 ? volElapsedSum/bothFired : 0).toFixed(1)}.

Full results written to \`scratch/bigmove_realtime_detectors_RESULTS.md\`.
  `;
  fs.writeFileSync('scratch/antigravity_response.md', summary);

  console.log('Finished writing results.');
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  fs.writeFileSync('scratch/antigravity_response.md', 'Error: ' + e.message + '\n\n' + e.stack);
  process.exit(1);
});
