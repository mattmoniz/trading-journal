import fs from 'fs';
import { query } from '../server/db.js';
import * as ss from 'simple-statistics';
import { getVolumeBaseline, classifyTouch } from '../server/services/touchQuality.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const PNL_PER_POINT = 2;
const COMMISSION = 1;
const WINDOW_DAYS = 1000;
const LOOK_FORWARD = 60; // N=60 bars to forecast
const PROXIMITY = 15;

async function getTradingDays() {
  const r = await query(`
    SELECT lp.trade_date::text as trade_date
    FROM level_prices lp
    WHERE lp.trade_date <= CURRENT_DATE
      AND EXISTS (
        SELECT 1 FROM price_bars_primary p
        WHERE p.ts::date = lp.trade_date
          AND EXTRACT(hour FROM p.ts)*60+EXTRACT(minute FROM p.ts) BETWEEN 570 AND 959
      )
    GROUP BY lp.trade_date
    HAVING COUNT(DISTINCT lp.level_name) >= 5
    ORDER BY lp.trade_date DESC
    LIMIT $1
  `, [WINDOW_DAYS]);
  return r.rows.map(r => r.trade_date).sort();
}

async function getLevelPrices(tradeDate) {
  const r = await query(`
    SELECT level_name, price::float FROM level_prices
    WHERE trade_date = $1 AND price IS NOT NULL
  `, [tradeDate]);
  const map = {};
  for (const row of r.rows) map[row.level_name] = row.price;
  return map;
}

async function getRTHBars(tradeDate) {
  const r = await query(`
    SELECT
      ts,
      EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
      open::float, high::float, low::float, close::float,
      volume::int, bid_volume::int, ask_volume::int
    FROM price_bars_primary
    WHERE ts::date = $1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `, [tradeDate]);
  return r.rows;
}

async function getAcdDailyLog() {
  const r = await query(`
    SELECT trade_date::text as trade_date, day_type, profile_shape, close_position
    FROM acd_daily_log
  `);
  const map = {};
  for (const row of r.rows) map[row.trade_date] = row;
  return map;
}

function getFormationGate(levelName) {
  if (['OR_HIGH', 'OR_LOW'].includes(levelName)) return 575;
  if (['IB_HIGH', 'IB_LOW', 'IB_MID', 'OR_MID', 'PD_IB_HIGH', 'PD_IB_LOW'].includes(levelName)) return 630;
  return 570;
}

function createTouch(name, dir, bar, barIdx, bars, date) {
  const entryPrice = bar.close;
  return {
    levelName: name,
    direction: dir,
    barIdx,
    entryPrice,
    date,
    tod: bar.tod
  };
}

async function run() {
  console.log('=== LEVEL ANTICIPATION BACKTEST ===');
  
  const tradingDays = await getTradingDays();
  console.log(`Found ${tradingDays.length} trading days`);
  
  const acdLog = await getAcdDailyLog();
  
  const touchesByDay = {};
  let priorDayClose = null;

  const allTouchesWithContext = [];

  for (let di = 0; di < tradingDays.length; di++) {
    const date = tradingDays[di];
    if (di % 30 === 0) console.log(`Processing day ${di + 1}/${tradingDays.length}: ${date}`);

    const [levelPrices, bars, baselineMap] = await Promise.all([
      getLevelPrices(date),
      getRTHBars(date),
      getVolumeBaseline(query, date)
    ]);

    if (Object.keys(levelPrices).length < 5 || bars.length < 60) {
      if (bars.length > 0) priorDayClose = bars[bars.length - 1].close;
      continue;
    }

    const dayAcd = acdLog[date] || {};
    const overnightInventoryBias = priorDayClose !== null ? (bars[0].open - priorDayClose) : null;
    priorDayClose = bars[bars.length - 1].close;

    const touchedLevels = new Map();

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const tod = bar.tod;

      for (const [name, level] of Object.entries(levelPrices)) {
        if (level == null || !isFinite(level)) continue;
        if (tod < getFormationGate(name)) continue;

        const distToHigh = Math.abs(bar.high - level);
        const distToLow  = Math.abs(bar.low - level);

        const processTouch = (dir) => {
          const key = `${name}_${dir}`;
          const lastTouch = touchedLevels.get(key);
          if (lastTouch === undefined || i - lastTouch >= 5) {
            touchedLevels.set(key, i);
            const t = createTouch(name, dir, bar, i, bars, date);
            
            t.dayTypeKnown = tod >= 630;
            t.dayType = t.dayTypeKnown ? dayAcd.day_type : 'UNKNOWN';
            t.profileShape = t.dayTypeKnown ? dayAcd.profile_shape : 'UNKNOWN';
            t.overnightBias = overnightInventoryBias ? (overnightInventoryBias > 0 ? 'LONG' : 'SHORT') : 'FLAT';
            
            const windowBars = [];
            let gaveFurtherGround = false;
            for (let j = 1; j <= 5; j++) {
              if (i + j < bars.length) {
                const b = bars[i+j];
                windowBars.push({
                  mod: b.tod,
                  bid_volume: b.bid_volume,
                  ask_volume: b.ask_volume
                });
                const pnl = dir === 'SHORT' ? t.entryPrice - b.high : b.low - t.entryPrice;
                if (pnl < -10) gaveFurtherGround = true; 
              }
            }
            
            const quality = classifyTouch({
              windowBars,
              direction: dir,
              baseline: baselineMap,
              highVolZCutoff: 1.0,
              gaveFurtherGround
            });
            
            t.touchQuality = quality ? quality.bucket : 'UNKNOWN';
            
            if (i >= 5) {
              const startBar = bars[i-5];
              t.velocityIntoTouch = dir === 'SHORT' ? bar.high - startBar.low : startBar.high - bar.low; 
            } else {
              t.velocityIntoTouch = 0;
            }

            allTouchesWithContext.push(t);
            if (!touchesByDay[date]) touchesByDay[date] = [];
            touchesByDay[date].push(t);
          }
        };

        if (distToHigh <= PROXIMITY && bar.high >= level) processTouch('SHORT');
        if (distToLow <= PROXIMITY && bar.low <= level) processTouch('LONG');
      }
    }
  }

  // Define B touches within LOOK_FORWARD
  for (const date of Object.keys(touchesByDay)) {
    const dayTouches = touchesByDay[date].sort((a, b) => a.barIdx - b.barIdx);
    for (let i = 0; i < dayTouches.length; i++) {
      const aTouch = dayTouches[i];
      aTouch.subsequentTouches = [];
      for (let j = i + 1; j < dayTouches.length; j++) {
        const bTouch = dayTouches[j];
        if (bTouch.barIdx - aTouch.barIdx > LOOK_FORWARD) break;
        if (bTouch.levelName !== aTouch.levelName) {
          aTouch.subsequentTouches.push(bTouch);
        }
      }
    }
  }

  const results = [];
  
  // We want to evaluate: A -> B rotations
  // P(B touched within 60 bars | A touched) vs P(B touched within 60 bars | A touched + Feature)

  const pairsMap = {}; // A -> B : { total: [], features: { ... } }
  
  for (const t of allTouchesWithContext) {
    const aKey = `${t.levelName}_${t.direction}`;
    
    // Seen subsequent levels for this touch
    const seenB = new Set();
    for (const b of t.subsequentTouches) {
      const bKey = `${b.levelName}_${b.direction}`;
      if (seenB.has(bKey)) continue;
      seenB.add(bKey);
      
      const pairKey = `${aKey} -> ${bKey}`;
      if (!pairsMap[pairKey]) pairsMap[pairKey] = { baseEvents: [], eventsByFeature: {} };
      
      // record positive event
      pairsMap[pairKey].baseEvents.push({ date: t.date, hit: 1 });
    }
  }
  
  // To get the probability, we need the denominator: total A touches
  const aTouchCounts = {};
  const aTouchesList = {};
  for (const t of allTouchesWithContext) {
    const aKey = `${t.levelName}_${t.direction}`;
    if (!aTouchCounts[aKey]) {
      aTouchCounts[aKey] = 0;
      aTouchesList[aKey] = [];
    }
    aTouchCounts[aKey]++;
    aTouchesList[aKey].push(t);
  }

  const featureExtractors = [
    { name: 'DayType_TREND_UP', ext: t => t.dayType === 'TREND_UP' },
    { name: 'DayType_TREND_DOWN', ext: t => t.dayType === 'TREND_DOWN' },
    { name: 'DayType_NEUTRAL', ext: t => t.dayType === 'NEUTRAL' },
    { name: 'OvernightBias_LONG', ext: t => t.overnightBias === 'LONG' },
    { name: 'OvernightBias_SHORT', ext: t => t.overnightBias === 'SHORT' },
    { name: 'Quality_OVERRUN', ext: t => t.touchQuality === 'HIGH_VOL_OVERRUN' },
    { name: 'Quality_ABSORBED', ext: t => t.touchQuality === 'HIGH_VOL_ABSORBED' },
    { name: 'Quality_QUIET', ext: t => t.touchQuality === 'QUIET' },
    { name: 'HighVelocity', ext: t => t.velocityIntoTouch > 20 }
  ];

  for (const [pairKey, pairData] of Object.entries(pairsMap)) {
    const aKey = pairKey.split(' -> ')[0];
    const totalA = aTouchCounts[aKey];
    if (totalA < 20) continue;
    
    const baseHitRate = pairData.baseEvents.length / totalA;
    if (pairData.baseEvents.length < 20) continue; // Needs at least 20 positive examples to even be considered a pattern

    // For each feature, compute conditional hit rate
    for (const f of featureExtractors) {
      const aTouchesWithFeature = aTouchesList[aKey].filter(f.ext);
      const featureN = aTouchesWithFeature.length;
      if (featureN < 20) continue; // Hard floor

      // How many of these feature touches resulted in B being touched?
      const hitsWithFeature = aTouchesWithFeature.filter(t => {
        return t.subsequentTouches.some(b => `${b.levelName}_${b.direction}` === pairKey.split(' -> ')[1]);
      });
      
      const condHitRate = hitsWithFeature.length / featureN;
      const delta = condHitRate - baseHitRate;
      
      // We only care if the feature meaningfully increases probability (> 10% delta)
      if (delta > 0.1) {
        // Rigor check: pass a +1/-1 hit/miss proxy
        const rigorEvents = aTouchesWithFeature.map(t => {
          const hit = t.subsequentTouches.some(b => `${b.levelName}_${b.direction}` === pairKey.split(' -> ')[1]);
          return { date: t.date, val: hit ? 1 : -1 };
        });
        
        const rigor = computeRigor(rigorEvents, { dateField: 'date', pnlFn: e => e.val });
        
        results.push({
          pair: pairKey,
          feature: f.name,
          n: featureN,
          condHitRate,
          baseHitRate,
          delta,
          rigor,
          baseEvents: pairData.baseEvents.length,
          totalA
        });
      }
    }
  }

  // Section 3: Open Invitation (Day of week effects?)
  const openResults = [];
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const [pairKey, pairData] of Object.entries(pairsMap)) {
    const aKey = pairKey.split(' -> ')[0];
    const totalA = aTouchCounts[aKey];
    if (totalA < 20) continue;
    const baseHitRate = pairData.baseEvents.length / totalA;
    
    for (let dow = 1; dow <= 5; dow++) {
      const aTouchesWithDow = aTouchesList[aKey].filter(t => new Date(t.date).getUTCDay() === dow);
      const featureN = aTouchesWithDow.length;
      if (featureN < 20) continue;
      
      const hitsWithDow = aTouchesWithDow.filter(t => {
        return t.subsequentTouches.some(b => `${b.levelName}_${b.direction}` === pairKey.split(' -> ')[1]);
      });
      
      const condHitRate = hitsWithDow.length / featureN;
      const delta = condHitRate - baseHitRate;
      
      if (delta > 0.15) {
        const rigorEvents = aTouchesWithDow.map(t => {
          const hit = t.subsequentTouches.some(b => `${b.levelName}_${b.direction}` === pairKey.split(' -> ')[1]);
          return { date: t.date, val: hit ? 1 : -1 };
        });
        const rigor = computeRigor(rigorEvents, { dateField: 'date', pnlFn: e => e.val });
        
        openResults.push({
          pair: pairKey,
          feature: `DOW_${dowNames[dow]}`,
          n: featureN,
          condHitRate,
          baseHitRate,
          delta,
          rigor
        });
      }
    }
  }

  // Write findings
  results.sort((a, b) => b.delta - a.delta);
  openResults.sort((a, b) => b.delta - a.delta);
  
  const allOutput = {
    marketContext: results.filter(r => r.feature.startsWith('DayType') || r.feature.startsWith('Overnight')),
    touchQuality: results.filter(r => r.feature.startsWith('Quality') || r.feature.startsWith('HighVelocity')),
    openIdeas: openResults
  };
  
  fs.writeFileSync('scratch/level_anticipation_findings.json', JSON.stringify(allOutput, null, 2));

  let md = '# Level Anticipation Study Findings\n\n';
  
  const formatRigor = (r) => {
    return `${r.clean ? 'CLEAN' : (r.clustered ? 'CLUST' : 'UNSTAB')} (${r.top5DayPct}%)`;
  };

  md += '## 1. Market Context Leading Indicators\n';
  md += '| Pair (A -> B) | Feature | N | Cond P(B) | Base P(B) | Delta | Rigor |\n';
  md += '|---|---|---|---|---|---|---|\n';
  for (const r of allOutput.marketContext.slice(0, 30)) {
    md += `| ${r.pair} | ${r.feature} | ${r.n} | ${(r.condHitRate*100).toFixed(1)}% | ${(r.baseHitRate*100).toFixed(1)}% | +${(r.delta*100).toFixed(1)}% | ${formatRigor(r.rigor)} |\n`;
  }
  md += '\n';

  md += '## 2. Price-Action / Order-Flow (Touch Quality)\n';
  md += '| Pair (A -> B) | Feature | N | Cond P(B) | Base P(B) | Delta | Rigor |\n';
  md += '|---|---|---|---|---|---|---|\n';
  for (const r of allOutput.touchQuality.slice(0, 30)) {
    md += `| ${r.pair} | ${r.feature} | ${r.n} | ${(r.condHitRate*100).toFixed(1)}% | ${(r.baseHitRate*100).toFixed(1)}% | +${(r.delta*100).toFixed(1)}% | ${formatRigor(r.rigor)} |\n`;
  }
  md += '\n';

  md += '## 3. Open Ideas (Day of Week clustering)\n';
  md += '| Pair (A -> B) | Feature | N | Cond P(B) | Base P(B) | Delta | Rigor |\n';
  md += '|---|---|---|---|---|---|---|\n';
  for (const r of allOutput.openIdeas.slice(0, 30)) {
    md += `| ${r.pair} | ${r.feature} | ${r.n} | ${(r.condHitRate*100).toFixed(1)}% | ${(r.baseHitRate*100).toFixed(1)}% | +${(r.delta*100).toFixed(1)}% | ${formatRigor(r.rigor)} |\n`;
  }
  md += '\n';

  fs.writeFileSync('scratch/antigravity_response.md', md);
  console.log('Results written to scratch/level_anticipation_findings.json and scratch/antigravity_response.md');
  process.exit(0);
}

run().catch(console.error);
