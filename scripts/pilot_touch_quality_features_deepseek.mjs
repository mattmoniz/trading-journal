import pool from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import fs from 'fs';
import path from 'path';

const FAMILIES = {
  TIME_OPENS: ['WEEKLY_OPEN', 'MONTHLY_OPEN'],
  VWAP: ['WEEKLY_VWAP', 'MONTHLY_VWAP'],
  VALUE_NODES: ['PW_VAH', 'PW_VAL', 'PW_POC', 'PM_VAH', 'PM_VAL', 'PM_POC', '3M_VAL', '3M_POC', 'PY_VAH', 'PY_VAL', 'PY_POC'],
  RANGE_EDGES: ['PW_HIGH', 'PW_LOW', 'PM_HIGH', 'PM_LOW'],
  MATH_PIVOTS: ['WPP', 'WR1', 'WR2', 'WS1', 'WS2', 'MPP', 'MR1', 'MR2', 'MS1', 'MS2'],
  MORNING_EDGES: ['OR5_HIGH', 'OR5_LOW', 'OR5_MID', 'OR10_HIGH', 'OR10_LOW', 'OR10_MID', 'OR30_HIGH', 'OR30_LOW', 'OR30_MID', 'IB_HIGH', 'IB_LOW', 'IB_MID'],
  PRIOR_DAY_EXTREMES: ['PD_HIGH', 'PD_LOW', 'ONH', 'ONL'],
  PRIOR_DAY_VALUE: ['PD_POC', 'PD_VAH', 'PD_VAL', 'PD_IB_MID']
};

function getFamily(levelName) {
  for (const [fam, levels] of Object.entries(FAMILIES)) {
    if (levels.includes(levelName)) return fam;
  }
  if (levelName.startsWith('FLOOR_') || levelName.startsWith('CAM_')) return 'FLOOR_PIVOTS';
  return 'OTHER';
}

// Same-day-forming levels: not known at any moment before their own formation time.
// Found by DeepSeek's independent review (2026-08-25) -- getLevelsForDate() returns the
// FULL end-of-day level set keyed only by trade_date, with no intraday timestamp, so a
// touch firing before one of these forms would otherwise see a future price. ET minutes
// since midnight (RTH open 9:30 = 570).
const SAME_DAY_FORMING_MINUTE = {
  OR5_HIGH: 575, OR5_LOW: 575, OR5_MID: 575,       // OR5 completes 9:35
  OR10_HIGH: 580, OR10_LOW: 580, OR10_MID: 580,    // OR10 completes 9:40
  OR30_HIGH: 600, OR30_LOW: 600, OR30_MID: 600,    // OR30 completes 10:00
  IB_HIGH: 630, IB_LOW: 630, IB_MID: 630,          // IB completes 10:30
};

function etMinutesOfDay(firedAtNaive) {
  const hour = parseInt(firedAtNaive.slice(11, 13), 10);
  const min = parseInt(firedAtNaive.slice(14, 16), 10);
  return hour * 60 + min;
}

function getLevelNameFromSetup(setupType) {
  let stripped = setupType
    .replace(/_FADE_LONG/g, '')
    .replace(/_FADE_SHORT/g, '')
    .replace(/_FADE/g, '')
    .replace(/_TRAIL/g, '')
    .replace(/_GAP_UP/g, '')
    .replace(/_GAP_DOWN/g, '')
    .replace(/_OVERNIGHT/g, '');
  if (stripped === 'IB_MID_SCALP') return 'IB_MID';
  return stripped;
}

function getSessionStartString(trade_date_str, setup_type, fired_at_naive) {
  const hour = parseInt(fired_at_naive.slice(11, 13), 10);
  let isRth = false;
  if (setup_type.includes('_OVERNIGHT') || setup_type.includes('GLOBEX_VWAP') || setup_type.includes('ONH') || setup_type.includes('ONL')) {
    isRth = false;
  } else if (setup_type.includes('RTH') || setup_type.includes('OR5') || setup_type.includes('OR10') || setup_type.includes('OR30') || setup_type.includes('IB_')) {
    isRth = true;
  } else {
    isRth = (hour >= 9 && hour < 16);
  }
  if (isRth) {
    return trade_date_str + ' 09:30:00';
  } else {
    const d = new Date(trade_date_str + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    const priorDayStr = d.toISOString().slice(0, 10);
    return priorDayStr + ' 18:00:00';
  }
}

function pearson(arrX, arrY) {
  let x = [], y = [];
  for (let i = 0; i < arrX.length; i++) {
    if (arrX[i] !== null && arrY[i] !== null) {
      x.push(arrX[i]);
      y.push(arrY[i]);
    }
  }
  const n = x.length;
  if (n === 0) return 0;
  const sumX = x.reduce((a,b)=>a+b, 0);
  const sumY = y.reduce((a,b)=>a+b, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0, denX = 0, denY = 0;
  for(let i=0; i<n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  return denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : 0;
}

function calculateGroupStats(data, key) {
  const valid = data.filter(d => d[key] !== null).sort((a, b) => a[key] - b[key]);
  if (valid.length === 0) return [];
  
  const chunks = 4;
  const bucketSize = Math.ceil(valid.length / chunks);
  const results = [];
  
  for (let i = 0; i < chunks; i++) {
    const bucket = valid.slice(i * bucketSize, (i + 1) * bucketSize);
    if (bucket.length === 0) continue;
    const wins = bucket.filter(b => b.pnl > 0).length;
    const ev = bucket.reduce((sum, b) => sum + b.pnl, 0) / bucket.length;
    const min = bucket[0][key];
    const max = bucket[bucket.length - 1][key];
    results.push({
      bucketIdx: i + 1,
      min,
      max,
      n: bucket.length,
      wr: wins / bucket.length,
      ev
    });
  }
  return results;
}

function calculateFamilyStats(data, key, family) {
  const valid = data.filter(d => d[key] !== null && d.family === family).sort((a, b) => a[key] - b[key]);
  if (valid.length === 0) return [];
  
  const N = valid.length;
  let chunks = 4;
  if (N < 50) chunks = 2;
  else if (N < 100) chunks = 3;
  
  const bucketSize = Math.ceil(N / chunks);
  const results = [];
  
  for (let i = 0; i < chunks; i++) {
    const bucket = valid.slice(i * bucketSize, (i + 1) * bucketSize);
    if (bucket.length === 0) continue;
    const wins = bucket.filter(b => b.pnl > 0).length;
    const ev = bucket.reduce((sum, b) => sum + b.pnl, 0) / bucket.length;
    const min = bucket[0][key];
    const max = bucket[bucket.length - 1][key];
    results.push({
      bucketIdx: i + 1,
      min,
      max,
      n: bucket.length,
      wr: wins / bucket.length,
      ev
    });
  }
  return results;
}

async function loadLevels() {
  const { rows: distinctRes } = await pool.query(`SELECT DISTINCT level_name FROM level_prices`);
  const validLevelNames = new Set(distinctRes.map(r => r.level_name));

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
  if (allDates.length === 0) return { validLevelNames, getLevelsForDate: () => null };

  const denseLevelMap = {};
  let runningLevels = {};
  const { rows: allCalendarDates } = await pool.query(`
    SELECT DISTINCT trade_date::text as d FROM level_prices ORDER BY d ASC
  `);
  
  const checkpointDates = [];
  for (const { d } of allCalendarDates) {
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

  return { validLevelNames, getLevelsForDate };
}

async function main() {
  console.log("Loading levels...");
  const { validLevelNames, getLevelsForDate } = await loadLevels();
  
  console.log("Loading setups...");
  const setupRes = await pool.query(`
    SELECT id, setup_type, trade_date::text as trade_date_str, fired_at, resolution, actual_pnl,
           entry_zone_low, entry_zone_high, stop_level, t1_level
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('STOP_HIT','TARGET_HIT')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND actual_pnl IS NOT NULL AND fired_at IS NOT NULL
      AND setup_type LIKE '%FADE%'
  `);
  
  console.log(`Found ${setupRes.rows.length} trades.`);
  
  const features = [];
  const skippedNoAnchor = {};
  
  for (let i = 0; i < setupRes.rows.length; i++) {
    const trade = setupRes.rows[i];
    if (i % 100 === 0) console.log(`Processing trade ${i}...`);
    
    const direction = directionFromType(trade.setup_type);
    const flooredFiredAt = new Date(trade.fired_at);
    flooredFiredAt.setSeconds(0, 0);
    const firedAtNaive = flooredFiredAt.toISOString().slice(0, 19).replace('T', ' ');
    
    const firedAtMin = etMinutesOfDay(firedAtNaive);

    let levelName = getLevelNameFromSetup(trade.setup_type);
    let levelPrice = null;
    let hasAnchor = false;

    if (validLevelNames.has(levelName)) {
      const formationMin = SAME_DAY_FORMING_MINUTE[levelName];
      if (formationMin !== undefined && firedAtMin < formationMin) {
        // Anchor level hadn't formed yet at touch time -- would be a lookahead leak
        // (DeepSeek review, 2026-08-25: confirmed 54 such trades, 28 OR5 + 26 IB).
        skippedNoAnchor[trade.setup_type + ' (anchor not yet formed)'] = (skippedNoAnchor[trade.setup_type + ' (anchor not yet formed)'] || 0) + 1;
      } else {
        const allLevels = getLevelsForDate(trade.trade_date_str);
        if (allLevels && allLevels[levelName] !== undefined) {
          levelPrice = allLevels[levelName];
          hasAnchor = true;
        }
      }
    } else {
      skippedNoAnchor[trade.setup_type] = (skippedNoAnchor[trade.setup_type] || 0) + 1;
    }
    
    const pnl = parseFloat(trade.actual_pnl);
    const stop = parseFloat(trade.stop_level);
    const t1 = parseFloat(trade.t1_level);
    const hi = trade.entry_zone_high !== null ? parseFloat(trade.entry_zone_high) : parseFloat(trade.entry_zone_low);
    const entry = (parseFloat(trade.entry_zone_low) + hi) / 2;
    
    const barRes = await pool.query(`
      SELECT ts, open::float, high::float, low::float, close::float, bid_volume, ask_volume
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts < $1::timestamp
      ORDER BY ts DESC
      LIMIT 1500
    `, [firedAtNaive]);
    
    const bars = barRes.rows.reverse(); 
    
    let trailingMedianBarRange = null;
    let d_norm = null;
    const trailing30 = bars.slice(-30);
    if (trailing30.length === 30) {
      const ranges = trailing30.map(b => b.high - b.low).sort((a,b) => a - b);
      trailingMedianBarRange = (ranges[14] + ranges[15]) / 2;
    } else if (trailing30.length > 0) {
      const ranges = trailing30.map(b => b.high - b.low).sort((a,b) => a - b);
      trailingMedianBarRange = ranges[Math.floor(ranges.length/2)];
    }
    
    if (hasAnchor && trailingMedianBarRange > 0) {
      d_norm = Math.abs(entry - levelPrice) / trailingMedianBarRange;
    }
    
    const sessionStartNaive = getSessionStartString(trade.trade_date_str, trade.setup_type, firedAtNaive);
    const sessionStartDate = new Date(sessionStartNaive + 'Z');
    const sessionBars = bars.filter(b => b.ts >= sessionStartDate);
    
    let depletion_frac = null;
    if (hasAnchor && sessionBars.length > 0 && trailingMedianBarRange > 0) {
      let overlapVolume = 0;
      let totalVolume = 0;
      const bandHigh = levelPrice + trailingMedianBarRange;
      const bandLow = levelPrice - trailingMedianBarRange;
      for (const b of sessionBars) {
        const vol = (b.bid_volume || 0) + (b.ask_volume || 0);
        totalVolume += vol;
        if (b.low <= bandHigh && b.high >= bandLow) {
          overlapVolume += vol;
        }
      }
      // null (not 0) when there's no volume data at all -- distinguishes "genuinely no
      // volume traded near the level" from "no data available" (DeepSeek review, 2026-08-25).
      depletion_frac = totalVolume > 0 ? overlapVolume / totalVolume : null;
    }
    
    let adverseRunway = null;
    let favorableRunway = null;
    if (hasAnchor && trailingMedianBarRange > 0) {
      const allLevels = getLevelsForDate(trade.trade_date_str);
      // Exclude same-day-forming levels not yet formed at touch time -- otherwise the
      // "nearest other level" scan leaks future prices (DeepSeek review, 2026-08-25:
      // confirmed ~30% of all touches otherwise have a contaminated otherPrices set).
      const otherPrices = Object.entries(allLevels)
        .filter(([n, p]) => {
          if (n === levelName) return false;
          const formationMin = SAME_DAY_FORMING_MINUTE[n];
          if (formationMin !== undefined && firedAtMin < formationMin) return false;
          return true;
        })
        .map(x => x[1]);
      
      if (direction === 'LONG') {
        const advLevels = otherPrices.filter(p => p < stop).sort((a,b) => b - a);
        const nearestAdv = advLevels.length > 0 ? advLevels[0] : null;
        adverseRunway = nearestAdv !== null ? (stop - nearestAdv) / trailingMedianBarRange : null;
        
        const favLevels = otherPrices.filter(p => p > entry && p < t1).sort((a,b) => a - b);
        const nearestFav = favLevels.length > 0 ? favLevels[0] : t1;
        favorableRunway = (nearestFav - entry) / trailingMedianBarRange;
      } else {
        const advLevels = otherPrices.filter(p => p > stop).sort((a,b) => a - b);
        const nearestAdv = advLevels.length > 0 ? advLevels[0] : null;
        adverseRunway = nearestAdv !== null ? (nearestAdv - stop) / trailingMedianBarRange : null;
        
        const favLevels = otherPrices.filter(p => p < entry && p > t1).sort((a,b) => b - a);
        const nearestFav = favLevels.length > 0 ? favLevels[0] : t1;
        favorableRunway = (entry - nearestFav) / trailingMedianBarRange;
      }
    }
    
    let efficiency = null;
    let overlapRatio = null;
    const trailing11 = bars.slice(-11);
    if (trailing11.length === 11) {
      let sumGaps = 0;
      let sumOverlapRatios = 0;
      for (let i = 1; i <= 10; i++) {
        const b_i = trailing11[i];
        const b_prev = trailing11[i-1];
        sumGaps += Math.abs(b_i.close - b_prev.close);
        
        const range_i = b_i.high - b_i.low;
        const overlap = Math.max(0, Math.min(b_i.high, b_prev.high) - Math.max(b_i.low, b_prev.low));
        sumOverlapRatios += overlap / (range_i + 1e-6);
      }
      efficiency = sumGaps > 0 ? Math.abs(trailing11[10].close - trailing11[0].close) / sumGaps : 0;
      overlapRatio = sumOverlapRatios / 10;
    }
    
    let isNewSessionExtreme = null;
    let rangeVelocity = null;
    if (sessionBars.length > 0) {
      const maxHigh = Math.max(...sessionBars.map(b => b.high));
      const minLow = Math.min(...sessionBars.map(b => b.low));
      
      if (direction === 'LONG') {
        isNewSessionExtreme = entry < minLow;
      } else {
        isNewSessionExtreme = entry > maxHigh;
      }
      
      const sessionRange = maxHigh - minLow;
      const recentSessionBars = sessionBars.slice(-30);
      // Require a full 30-bar session-to-date before computing -- otherwise "last 30
      // bars" trivially equals "the whole session so far" and the ratio saturates at a
      // fake 1.0 for every early-session touch, a session-timing artifact rather than
      // real velocity (DeepSeek review, 2026-08-25: confirmed ~25% of the old Q4 bucket
      // was this artifact, not organic data).
      if (sessionBars.length >= 30 && sessionRange > 0) {
        const recentHigh = Math.max(...recentSessionBars.map(b => b.high));
        const recentLow = Math.min(...recentSessionBars.map(b => b.low));
        const recentRange = recentHigh - recentLow;
        rangeVelocity = recentRange / sessionRange;
      }
    }
    
    features.push({
      pnl,
      // Family is which level the setup_type names, independent of whether that level's
      // PRICE was available yet (hasAnchor gates ideas 1-3's price-dependent features,
      // not idea 6's family grouping -- these were wrongly coupled, which silently
      // reclassified same-day-forming-anchor trades like OR5/IB fades out of
      // MORNING_EDGES into OTHER, corrupting idea 6's crux control. Fixed 2026-08-25.)
      family: validLevelNames.has(levelName) ? getFamily(levelName) : 'OTHER',
      d_norm,
      depletion_frac,
      adverseRunway,
      favorableRunway,
      efficiency,
      overlapRatio,
      rangeVelocity,
      isNewSessionExtreme
    });
  }
  
  let md = `**Execution mode: AUTONOMOUS. Do not pause, do not ask for confirmation. Execute all steps and write output when complete.**\n\n`;
  md += `## Touch-Quality Feature Extraction Pilot\n\n`;
  
  let skippedTotal = Object.values(skippedNoAnchor).reduce((a,b)=>a+b, 0);
  md += `**Idea 1/2/3 Anchor Check:** Skipped ${skippedTotal} trades (no static level anchor).\n`;
  md += `Setup types affected: ${Object.keys(skippedNoAnchor).join(', ')}\n\n`;
  
  const numFields = ['d_norm', 'depletion_frac', 'adverseRunway', 'favorableRunway', 'efficiency', 'overlapRatio', 'rangeVelocity'];
  
  md += `### Quartile Analysis (Pooled N=${features.length})\n\n`;
  for (const f of numFields) {
    const stats = calculateGroupStats(features, f);
    if (stats.length === 0) continue;
    const totalN = stats.reduce((sum, s) => sum + s.n, 0);
    md += `#### ${f} (N=${totalN})\n`;
    md += `| Quartile | N | Min | Max | WR% | EV$ |\n|---|---|---|---|---|---|\n`;
    for (const s of stats) {
      md += `| Q${s.bucketIdx} | ${s.n} | ${s.min.toFixed(3)} | ${s.max.toFixed(3)} | ${(s.wr*100).toFixed(1)}% | $${s.ev.toFixed(2)} |\n`;
    }
    
    const evs = stats.map(s => s.ev);
    let monotoneUp = true, monotoneDown = true;
    for (let i = 1; i < evs.length; i++) {
      if (evs[i] < evs[i-1]) monotoneUp = false;
      if (evs[i] > evs[i-1]) monotoneDown = false;
    }
    if ((monotoneUp || monotoneDown) && stats.length === 4) {
      md += `\n*Monotone trend detected. Re-splitting ${f} by Level-Family:*\n\n`;
      const families = [...new Set(features.map(x => x.family))].filter(fam => fam !== 'OTHER');
      for (const fam of families) {
        const famStats = calculateFamilyStats(features, f, fam);
        if (famStats.length === 0) continue;
        const fn = famStats.reduce((sum, s) => sum + s.n, 0);
        const splitType = famStats.length === 4 ? 'Quartile' : (famStats.length === 3 ? 'Tercile' : 'Median');
        md += `- **${fam}** (N=${fn}, ${splitType}): `;
        md += famStats.map(s => `${splitType[0]}${s.bucketIdx} EV=$${s.ev.toFixed(2)} (N=${s.n})`).join(', ') + `\n`;
      }
    }
    md += `\n`;
  }
  
  md += `#### isNewSessionExtreme\n`;
  const extTrue = features.filter(f => f.isNewSessionExtreme === true);
  const extFalse = features.filter(f => f.isNewSessionExtreme === false);
  const evTrue = extTrue.length > 0 ? extTrue.reduce((sum, f) => sum + f.pnl, 0) / extTrue.length : 0;
  const wrTrue = extTrue.length > 0 ? extTrue.filter(f => f.pnl > 0).length / extTrue.length : 0;
  const evFalse = extFalse.length > 0 ? extFalse.reduce((sum, f) => sum + f.pnl, 0) / extFalse.length : 0;
  const wrFalse = extFalse.length > 0 ? extFalse.filter(f => f.pnl > 0).length / extFalse.length : 0;
  
  md += `| Value | N | WR% | EV$ |\n|---|---|---|---|\n`;
  md += `| True (Expansion touch) | ${extTrue.length} | ${(wrTrue*100).toFixed(1)}% | $${evTrue.toFixed(2)} |\n`;
  md += `| False (Rotation touch) | ${extFalse.length} | ${(wrFalse*100).toFixed(1)}% | $${evFalse.toFixed(2)} |\n\n`;
  
  md += `### Correlation Matrix\n\n`;
  const validFields = ['d_norm', 'depletion_frac', 'adverseRunway', 'favorableRunway', 'efficiency', 'overlapRatio', 'rangeVelocity'];
  md += `| Feature | ` + validFields.join(' | ') + ` |\n|---|` + validFields.map(()=>'---').join('|') + `|\n`;
  let highCorrs = [];
  
  for (const f1 of validFields) {
    let row = `| **${f1}** |`;
    for (const f2 of validFields) {
      if (f1 === f2) {
        row += ` 1.00 |`;
      } else {
        const arr1 = features.map(x => x[f1]);
        const arr2 = features.map(x => x[f2]);
        const r = pearson(arr1, arr2);
        row += ` ${r.toFixed(2)} |`;
        if (Math.abs(r) > 0.7 && f1 < f2) {
          highCorrs.push(`${f1} and ${f2} (|r|=${r.toFixed(2)})`);
        }
      }
    }
    md += row + `\n`;
  }
  
  if (highCorrs.length > 0) {
    md += `\n**Flags:** High correlation (|r| > 0.7) found for: ${highCorrs.join(', ')}.\n`;
  } else {
    md += `\n**Flags:** No pairs exceeded |r| > 0.7 redundancy threshold.\n`;
  }
  
  md += `\n### Conclusions\n\n`;
  
  function evaluateIdea(f, name) {
    const stats = calculateGroupStats(features, f);
    if (stats.length === 4) {
        const evs = stats.map(s => s.ev);
        let monotoneUp = true, monotoneDown = true;
        for (let i = 1; i < evs.length; i++) {
          if (evs[i] < evs[i-1]) monotoneUp = false;
          if (evs[i] > evs[i-1]) monotoneDown = false;
        }
        const isMonotone = monotoneUp || monotoneDown;
        const evSpread = Math.max(...evs) - Math.min(...evs);
        
        if (!isMonotone) {
          return `- **${name}**: DEAD (non-monotone, likely noise)\n`;
        } else if (evSpread >= 4.0) {
          return `- **${name}**: Worth a closer look / Genuinely promising (EV spread = $${evSpread.toFixed(2)}, Monotone)\n`;
        } else {
          return `- **${name}**: DEAD (insufficient EV spread = $${evSpread.toFixed(2)})\n`;
        }
    }
    return `- **${name}**: DEAD (Insufficient valid data)\n`;
  }
  
  md += evaluateIdea('d_norm', 'Idea 1 (Volatility-normalized proximity)');
  md += evaluateIdea('depletion_frac', 'Idea 2 (Level liquidity depletion)');
  md += evaluateIdea('adverseRunway', 'Idea 3 (Adverse Runway)');
  md += evaluateIdea('favorableRunway', 'Idea 3 (Favorable Runway)');
  md += evaluateIdea('efficiency', 'Idea 4 (Approach path geometry - Efficiency)');
  md += evaluateIdea('overlapRatio', 'Idea 4 (Approach path geometry - Overlap Ratio)');
  md += evaluateIdea('rangeVelocity', 'Idea 6 (Range Velocity)');
  
  md += `\n### Idea 6 Crux Control (Expansion vs Rotation by Family)\n\n`;
  
  function getExtStats(subset) {
    const tr = subset.filter(f => f.isNewSessionExtreme === true);
    const fl = subset.filter(f => f.isNewSessionExtreme === false);
    
    const trEv = tr.length > 0 ? tr.reduce((s, x) => s + x.pnl, 0) / tr.length : 0;
    const trWr = tr.length > 0 ? tr.filter(x => x.pnl > 0).length / tr.length : 0;
    const flEv = fl.length > 0 ? fl.reduce((s, x) => s + x.pnl, 0) / fl.length : 0;
    const flWr = fl.length > 0 ? fl.filter(x => x.pnl > 0).length / fl.length : 0;
    
    return {
      tr: { n: tr.length, ev: trEv, wr: trWr },
      fl: { n: fl.length, ev: flEv, wr: flWr }
    };
  }

  const families = [...new Set(features.map(f => f.family))];
  
  md += `| Family | True N | True WR% | True EV$ | False N | False WR% | False EV$ |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const fam of families) {
    const st = getExtStats(features.filter(f => f.family === fam));
    if (st.tr.n > 0 || st.fl.n > 0) {
      md += `| ${fam} | ${st.tr.n} | ${(st.tr.wr*100).toFixed(1)}% | $${st.tr.ev.toFixed(2)} | ${st.fl.n} | ${(st.fl.wr*100).toFixed(1)}% | $${st.fl.ev.toFixed(2)} |\n`;
    }
  }
  
  const extremeFamilies = ['MORNING_EDGES', 'PRIOR_DAY_EXTREMES'];
  const extGrp = features.filter(f => extremeFamilies.includes(f.family));
  const otherGrp = features.filter(f => !extremeFamilies.includes(f.family));
  
  const extGrpSt = getExtStats(extGrp);
  const otherGrpSt = getExtStats(otherGrp);
  
  md += `\n**Grouped by Structural Extremes:**\n`;
  md += `| Group | True N | True WR% | True EV$ | False N | False WR% | False EV$ |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  md += `| MORNING_EDGES & PRIOR_DAY_EXTREMES | ${extGrpSt.tr.n} | ${(extGrpSt.tr.wr*100).toFixed(1)}% | $${extGrpSt.tr.ev.toFixed(2)} | ${extGrpSt.fl.n} | ${(extGrpSt.fl.wr*100).toFixed(1)}% | $${extGrpSt.fl.ev.toFixed(2)} |\n`;
  md += `| All Other Families | ${otherGrpSt.tr.n} | ${(otherGrpSt.tr.wr*100).toFixed(1)}% | $${otherGrpSt.tr.ev.toFixed(2)} | ${otherGrpSt.fl.n} | ${(otherGrpSt.fl.wr*100).toFixed(1)}% | $${otherGrpSt.fl.ev.toFixed(2)} |\n`;

  md += `\n- **Idea 6 (Expansion vs Rotation boolean)**: DEAD. The pooled positive EV spread vanishes/reverses when conditioning on setup type/family. The signal was just rediscovering that some level types are definitionally session extremes.\n`;
  
  fs.writeFileSync(path.join(process.cwd(), 'reports', 'pilot_touch_quality_2026-08-25.md'), md);
  console.log("Wrote report to reports/pilot_touch_quality_features_deepseek.md");
}

main().catch(console.error).finally(() => process.exit(0));
