import { query } from '../server/db.js';
import { classifyACDOpeningCall } from '../server/services/openingCallClassifier.js';
import { resolve, loadData } from './backtest_unified.js';

async function main() {
  console.log('[setup_d_atr_hypothesis] Loading bar/ACD data...');
  const { barsByDate, dates } = await loadData();

  console.log('[setup_d_atr_hypothesis] Loading WEEKLY levels...');
  const levelsRes = await query(`
    SELECT trade_date::text as trade_date, level_name, price::float as price
    FROM level_prices
    WHERE category = 'WEEKLY' AND price IS NOT NULL
  `);
  const weeklyLevelsByDate = new Map();
  for (const row of levelsRes.rows) {
    if (!weeklyLevelsByDate.has(row.trade_date)) weeklyLevelsByDate.set(row.trade_date, []);
    weeklyLevelsByDate.get(row.trade_date).push(row);
  }

  // 1. Calculate RTH stats for ATR
  const rthStats = [];
  for (const date of dates) {
    const bars = barsByDate.get(date) || [];
    const rthBars = bars.filter(b => b.tod >= 570 && b.tod < 960);
    if (rthBars.length > 0) {
      const h = Math.max(...rthBars.map(b => b.high));
      const l = Math.min(...rthBars.map(b => b.low));
      const open = rthBars[0].open;
      rthStats.push({ date, high: h, low: l, range: h - l, open });
    }
  }

  const records = [];
  
  // Need 10 prior days for ATR
  for (let i = 10; i < rthStats.length; i++) {
    const todayStat = rthStats[i];
    const date = todayStat.date;
    
    // Compute 10-period ATR
    let sumRange = 0;
    for (let j = 1; j <= 10; j++) {
      sumRange += rthStats[i - j].range;
    }
    const atr10 = sumRange / 10;
    const atrHi = todayStat.open + atr10;
    const atrLo = todayStat.open - atr10;

    const bars = barsByDate.get(date) || [];
    const orBars = bars.filter(b => b.tod >= 570 && b.tod < 585); // 585 is 9:45
    const confirmBars = bars.filter(b => b.tod >= 570 && b.tod < 615); // 615 is 10:15

    if (orBars.length < 3 || confirmBars.length < 5) continue;
    
    const orH = Math.max(...orBars.map(b => b.high));
    const orL = Math.min(...orBars.map(b => b.low));
    const orRange = orH - orL || 1;

    const call = classifyACDOpeningCall(confirmBars, orH, orL);
    if (!call || call.type !== 'OPEN_DRIVE') continue;
    
    const isLong = call.driveDirection === 'UP';
    const direction = isLong ? 'LONG' : 'SHORT';

    const confirmEndIdx = bars.findIndex(b => b.tod >= 615);
    if (confirmEndIdx === -1) continue;
    const confirmCloseBar = bars[confirmEndIdx];

    const driveMag = isLong
      ? (confirmCloseBar.close - orH) / orRange
      : (orL - confirmCloseBar.close) / orRange;

    // Filter to big-break immediate-entry population
    if (driveMag < 0.479) continue;

    const entry = confirmCloseBar.close;
    // Walk to EOD for real MFE
    const stop = isLong ? entry - 2000 : entry + 2000;
    const target = isLong ? entry + 2000 : entry - 2000;
    const maxBars = bars.length - 1 - confirmEndIdx;
    
    const res = resolve(bars, confirmEndIdx, direction, entry, stop, target, maxBars);
    const realMfe = res.mfe;

    const atrLevel = isLong ? atrHi : atrLo;
    const distToAtr = Math.max(0, isLong ? (atrLevel - entry) : (entry - atrLevel));
    const gap = realMfe - distToAtr;
    
    // Stage 2: Overshoot
    // Using 0.2 * OR range as overshoot cutoff
    const overshootThreshold = 0.2 * orRange;
    const isOvershoot = gap > overshootThreshold;
    
    let weeklyLevelGap = null;
    let distToWeekly = null;
    let targetWeeklyLevel = null;
    
    if (isOvershoot) {
      const dateLevels = weeklyLevelsByDate.get(date) || [];
      if (isLong) {
        const thresholdPrice = Math.max(entry, atrLevel);
        let minDiff = Infinity;
        for (const lvl of dateLevels) {
          if (lvl.price >= thresholdPrice && (lvl.price - thresholdPrice) < minDiff) {
            minDiff = lvl.price - thresholdPrice;
            targetWeeklyLevel = lvl.price;
          }
        }
      } else {
        const thresholdPrice = Math.min(entry, atrLevel);
        let minDiff = Infinity;
        for (const lvl of dateLevels) {
          if (lvl.price <= thresholdPrice && (thresholdPrice - lvl.price) < minDiff) {
            minDiff = thresholdPrice - lvl.price;
            targetWeeklyLevel = lvl.price;
          }
        }
      }
      
      if (targetWeeklyLevel !== null) {
        distToWeekly = Math.abs(targetWeeklyLevel - entry);
        weeklyLevelGap = realMfe - distToWeekly;
      }
    }

    records.push({
      date, direction, entry, orRange,
      realMfe, distToAtr, gap, isOvershoot,
      weeklyLevelGap, distToWeekly
    });
  }

  console.log(`\nTotal Qualifying Big-Break Drives (mag >= 0.479): N=${records.length}`);
  
  function printDist(label, vals) {
    if (vals.length === 0) return console.log(`${label}: N=0`);
    vals.sort((a,b) => a-b);
    const mean = vals.reduce((a,b)=>a+b,0) / vals.length;
    const median = vals[Math.floor(vals.length/2)];
    const p25 = vals[Math.floor(vals.length * 0.25)];
    const p75 = vals[Math.floor(vals.length * 0.75)];
    console.log(`${label} (N=${vals.length}): Mean=${mean.toFixed(1)}, Median=${median.toFixed(1)}, p25=${p25.toFixed(1)}, p75=${p75.toFixed(1)}`);
  }
  
  const allGaps = records.map(r => r.gap);
  const longGaps = records.filter(r => r.direction === 'LONG').map(r => r.gap);
  const shortGaps = records.filter(r => r.direction === 'SHORT').map(r => r.gap);
  
  console.log('\n=== Stage 1: (Real MFE) - (Distance to ATR Level) ===');
  printDist('All Drives', allGaps);
  printDist('Long Drives', longGaps);
  printDist('Short Drives', shortGaps);
  
  const reached = records.filter(r => r.realMfe >= r.distToAtr).length;
  console.log(`Fraction reaching AT LEAST the ATR distance: ${reached}/${records.length} (${(reached / records.length * 100).toFixed(1)}%)`);

  // Chronological stability check
  const splitIdx = Math.floor(records.length / 2);
  const firstHalf = records.slice(0, splitIdx);
  const secondHalf = records.slice(splitIdx);
  console.log('\n--- Stability Check (Stage 1) ---');
  printDist('First Half', firstHalf.map(r => r.gap));
  printDist('Second Half', secondHalf.map(r => r.gap));

  console.log('\n=== Stage 2: Overshoot to Weekly Level ===');
  const overshootRecords = records.filter(r => r.isOvershoot);
  console.log(`Overshoot count (MFE exceeds ATR by > 20% of OR range): ${overshootRecords.length}/${records.length}`);
  
  const weeklyGaps = overshootRecords.filter(r => r.weeklyLevelGap !== null).map(r => r.weeklyLevelGap);
  console.log(`Overshoot trades with a valid WEEKLY level beyond the ATR: N=${weeklyGaps.length}`);
  printDist('(Real MFE) - (Distance to Weekly Level)', weeklyGaps);
  
  console.log('\nDone.');
}

main().catch(console.error);
