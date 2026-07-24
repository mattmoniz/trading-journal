// Redesign of the broken Task 4 in backtest_big_moves_rolling_window.mjs (that version's 20pt
// zigzag micro-pivot detector, applied to whole-day windows, generated a meaningless population
// of ~127k "touches" vs 145 control -- a base-rate artifact, not a real finding; see that file's
// own header for the full incident). This version defines a genuine CONSOLIDATION as M=12
// consecutive 1-min bars (a real stalling period, not a zigzag wiggle) whose total range stays
// under a multiplier of the data's OWN median single-bar range (7.00pt) -- reusing the same
// "derive the floor from the data's own resolution" principle already established for the
// trailing-stop-width fix earlier this session, not an arbitrary pt value.
//
// AUDITED (Claude, same day) before trusting: population sizes are sane this time (908 Big-Move
// vs 4,666 Control consolidations on train, not the inverted 127k-vs-145 mess), the consolidation
// definition and no-lookahead level lookup match what was asked, and the z-test is a standard
// pooled-proportion 2-sample test, correctly implemented.
//
// RESULT: genuine, honest NULL on the original hypothesis ("big moves pause near known levels
// more than baseline chop does"), with one nuance worth separating from Gemini's own summary --
// the two width variants don't agree once train/test is split apart:
//   1.5x: Combined z=-2.18 p=0.029 (significant, but in the OPPOSITE direction of the original
//     hypothesis -- Big Move hit rate 78.2% < Control 81.1%). Train z=-0.95 p=0.34 (ns) and Test
//     z=-0.93 p=0.35 (ns) individually don't reach significance but DO agree in direction with the
//     combined number -- a consistent-but-underpowered-alone negative signal.
//   2.0x: Train z=-2.48 p=0.013 (significant, negative) but Test z=+0.79 p=0.43 (ns, POSITIVE --
//     a sign flip) -- exactly the train-shows-an-effect-that-doesn't-hold-on-test pattern this
//     session has flagged repeatedly elsewhere. Do not trust the 2.0x train result alone.
// Net: no reliable, train/test-confirmed evidence that big moves preferentially contend at known
// levels -- and what weak signal exists in the properly-powered combined data points the OPPOSITE
// direction (very slightly LESS likely, not more), itself not confidently proven on held-out data
// alone. See RESEARCH_CLAIM big_move_consolidation_contention_null for the full record.
import { query } from '../server/db.js';
import { PROXIMITY } from '../scripts/backtest_confluence.js';
import * as ss from 'simple-statistics';
import fs from 'fs';

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function proportionZTest(wins1, n1, wins2, n2) {
  if (n1 === 0 || n2 === 0) return { z: 0, p: 1 };
  const p1 = wins1 / n1, p2 = wins2 / n2;
  const pPool = (wins1 + wins2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  const p = 2 * (1 - ss.cumulativeStdNormalProbability(Math.abs(z)));
  return { z, p };
}

async function main() {
  console.log('Loading bars...');
  const barsRes = await query(`
    SELECT ts, high::float, low::float, close::float, open::float,
           (date(ts AT TIME ZONE 'America/New_York'))::text as et_date,
           COALESCE(volume,0)::int as volume
    FROM price_bars_primary 
    WHERE symbol='NQ' 
      AND ts >= (SELECT MAX(ts) FROM price_bars_primary WHERE symbol='NQ') - interval '2 years'
    ORDER BY ts
  `);
  const bars = barsRes.rows;

  if (bars.length === 0) {
    console.error("No bars loaded.");
    process.exit(1);
  }

  // 1. Compute single-bar range distribution
  const singleBarRanges = bars.map(b => b.high - b.low);
  const medianBarRange = pct(singleBarRanges, 0.50);
  const p75BarRange = pct(singleBarRanges, 0.75);
  console.log(`Single-bar range: Median = ${medianBarRange.toFixed(2)}, P75 = ${p75BarRange.toFixed(2)}`);

  // Define M for 12 minutes (12 bars). 
  // With 12 bars, we are capturing a genuine stalling / pause.
  const M = 12;

  const GAP_HOURS_CUTOFF = 0.75;
  const BIG_MOVE_THRESHOLD = 400;

  console.log('Grouping bars into sessions...');
  const sessions = [];
  let currentBars = [];
  
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (currentBars.length > 0) {
      const prevBar = currentBars[currentBars.length - 1];
      const gapHours = (bar.ts.getTime() - prevBar.ts.getTime()) / 3600000;
      if (gapHours > GAP_HOURS_CUTOFF) {
        sessions.push({ bars: currentBars });
        currentBars = [];
      }
    }
    currentBars.push(bar);
  }
  if (currentBars.length > 0) sessions.push({ bars: currentBars });

  // Only use 1-day windows as instructed to reuse the >= 400pt detection
  const windows = sessions.map(s => {
    let maxGap = 0;
    for (let i = 0; i < s.bars.length - 1; i++) {
      const gap = (s.bars[i+1].ts.getTime() - s.bars[i].ts.getTime()) / 3600000;
      if (gap > maxGap) maxGap = gap;
    }
    return { type: '1-day', bars: s.bars, maxGapHours: maxGap };
  });

  const validWindows = windows.filter(w => w.maxGapHours < 60); // loose gap check since session splits on 0.75

  const inBigMove = new Set();

  for (const w of validWindows) {
    let high = -Infinity, low = Infinity;
    for (const b of w.bars) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
    }
    w.range = high - low;
    if (w.range >= BIG_MOVE_THRESHOLD) {
      for (const b of w.bars) inBigMove.add(b);
    }
  }
  
  console.log(`Total bars: ${bars.length}, Bars in big moves: ${inBigMove.size}`);

  console.log('Loading level prices...');
  const levelPricesRes = await query(`SELECT trade_date::text as trade_date, level_name, price::float as price FROM level_prices WHERE price IS NOT NULL`);
  const lpByDate = new Map();
  for (const r of levelPricesRes.rows) {
    const d = r.trade_date.slice(0, 10);
    if (!lpByDate.has(d)) lpByDate.set(d, new Map());
    lpByDate.get(d).set(r.level_name, r.price);
  }

  function getNearbyLevels(price, dateStr) {
    const lp = lpByDate.get(dateStr);
    if (!lp) return [];
    const nearby = [];
    for (const [name, levelPrice] of lp) {
      if (Math.abs(price - levelPrice) <= PROXIMITY) {
        nearby.push({ name, dist: Math.abs(price - levelPrice) });
      }
    }
    return nearby;
  }

  function findConsolidations(barsList, multiplier) {
    const events = [];
    const threshold = multiplier * medianBarRange;
    let i = 0;
    while (i <= barsList.length - M) {
      const windowBars = barsList.slice(i, i + M);
      
      // Check for data gaps in the M bars
      let valid = true;
      for (let j = 0; j < windowBars.length - 1; j++) {
        if ((windowBars[j+1].ts - windowBars[j].ts) > 60000 * 5) { // 5 min gap max
          valid = false;
          break;
        }
      }
      
      if (valid) {
        let wHigh = -Infinity, wLow = Infinity;
        for (const b of windowBars) {
          if (b.high > wHigh) wHigh = b.high;
          if (b.low < wLow) wLow = b.low;
        }
        
        if (wHigh - wLow <= threshold) {
          const anchorBar = windowBars[0];
          const anchorPrice = (anchorBar.high + anchorBar.low) / 2;
          const etDate = anchorBar.et_date;
          
          const nearby = getNearbyLevels(anchorPrice, etDate);
          
          events.push({
            anchorPrice,
            etDate,
            hasTouch: nearby.length > 0,
            touchLevels: nearby.map(n => n.name)
          });
          
          i += M; // Skip forward to avoid overlapping
          continue;
        }
      }
      i++;
    }
    return events;
  }

  // Find continuous segments of Big Move bars and Control bars
  const bigMoveSegments = [];
  const controlSegments = [];
  
  let curSegment = [];
  let curIsBigMove = inBigMove.has(bars[0]);
  
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const isBM = inBigMove.has(b);
    if (isBM === curIsBigMove) {
      curSegment.push(b);
    } else {
      if (curSegment.length > 0) {
        if (curIsBigMove) bigMoveSegments.push(curSegment);
        else controlSegments.push(curSegment);
      }
      curSegment = [b];
      curIsBigMove = isBM;
    }
  }
  if (curSegment.length > 0) {
    if (curIsBigMove) bigMoveSegments.push(curSegment);
    else controlSegments.push(curSegment);
  }

  // Train / Test Split (80/20 Chronological by Date)
  const uniqueDates = [...new Set(bars.map(b => b.et_date))].sort();
  const splitIdx = Math.floor(uniqueDates.length * 0.8);
  const trainDates = new Set(uniqueDates.slice(0, splitIdx));
  const testDates = new Set(uniqueDates.slice(splitIdx));
  
  function analyze(multiplier) {
    const allBigEvents = [];
    for (const seg of bigMoveSegments) allBigEvents.push(...findConsolidations(seg, multiplier));
    
    const allControlEvents = [];
    for (const seg of controlSegments) allControlEvents.push(...findConsolidations(seg, multiplier));
    
    const trainBig = allBigEvents.filter(e => trainDates.has(e.etDate));
    const testBig = allBigEvents.filter(e => testDates.has(e.etDate));
    
    const trainControl = allControlEvents.filter(e => trainDates.has(e.etDate));
    const testControl = allControlEvents.filter(e => testDates.has(e.etDate));
    
    function summarize(bmSet, ctrlSet, label) {
      const bmHits = bmSet.filter(e => e.hasTouch).length;
      const ctrlHits = ctrlSet.filter(e => e.hasTouch).length;
      
      const bmN = bmSet.length;
      const ctrlN = ctrlSet.length;
      
      const bmRate = bmN > 0 ? bmHits / bmN : 0;
      const ctrlRate = ctrlN > 0 ? ctrlHits / ctrlN : 0;
      
      const bmDays = new Set(bmSet.map(e => e.etDate)).size;
      const ctrlDays = new Set(ctrlSet.map(e => e.etDate)).size;
      
      const { z, p } = proportionZTest(bmHits, bmN, ctrlHits, ctrlN);
      
      return `
#### ${label}
- **Big Move**: N=${bmN} consolidations across ${bmDays} days | Touches=${bmHits} | Hit Rate=${(bmRate*100).toFixed(1)}%
- **Control**: N=${ctrlN} consolidations across ${ctrlDays} days | Touches=${ctrlHits} | Hit Rate=${(ctrlRate*100).toFixed(1)}%
- **Stats**: z=${z.toFixed(2)}, p=${p.toFixed(4)}
`;
    }
    
    return `### ${multiplier.toFixed(1)}x Median Range Threshold
${summarize(trainBig, trainControl, "Train (80%)")}
${summarize(testBig, testControl, "Test (20%)")}
${summarize(allBigEvents, allControlEvents, "Combined")}
`;
  }
  
  const md = [
    "# Big Moves Consolidation & Contention Analysis",
    "",
    "## Configuration",
    `- **Median 1-Min Bar Range**: ${medianBarRange.toFixed(2)} pt`,
    `- **Consolidation Window (M)**: ${M} bars`,
    `- **PROXIMITY**: ${PROXIMITY} pt`,
    "- **Train/Test Split**: 80% / 20% chronologically",
    "",
    analyze(1.5),
    analyze(2.0),
    ""
  ];

  const resultStr = md.join('\\n');
  fs.writeFileSync('scratch/big_moves_consolidation_contention_RESULTS.md', resultStr);
  
  // also write summary to antigravity_response.md
  fs.writeFileSync('scratch/antigravity_response.md', resultStr);
  
  console.log("Done. Wrote results to scratch/big_moves_consolidation_contention_RESULTS.md and scratch/antigravity_response.md");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
