import express from 'express';
import { query } from '../db.js';

const router = express.Router();

async function getTradeBacktest() {
  const tradesQ = await query(`
    SELECT id, log_date::text as trade_date, entry_time, exit_time,
           direction, quantity, entry_price::float, exit_price::float,
           pnl::float, setup_type, EXTRACT(dow FROM entry_time)::int as dow
    FROM trades
    WHERE pnl IS NOT NULL AND exit_time IS NOT NULL
    ORDER BY entry_time ASC
  `);

  const sessions = {};
  for (const t of tradesQ.rows) {
    if (!sessions[t.trade_date]) sessions[t.trade_date] = [];
    sessions[t.trade_date].push(t);
  }

  const sortedDates = Object.keys(sessions).sort();
  const windows = [30, 60, 90, sortedDates.length];
  const results = {};

  for (const w of windows) {
    const datesSubset = sortedDates.slice(-w);
    const windowKey = w === sortedDates.length ? 'allTime' : `last${w}`;
    
    let baselinePnl = 0;
    let rule1Pnl = 0;
    let rule1TradesBlocked = 0;
    
    let rule2Pnl = 0;
    let rule2TradesModified = 0;
    
    let rule3Pnl = 0;
    let rule3DaysStoppedEarly = 0;

    let combinedPnl = 0;

    for (const date of datesSubset) {
      const dayTrades = sessions[date].sort((a, b) => new Date(a.entry_time) - new Date(b.entry_time));
      const dayOfWeek = dayTrades[0].dow; 
      
      let dayBaselinePnl = 0;
      let dayRule1Pnl = 0;
      let dayRule2Pnl = 0;
      let dayRule3Pnl = 0;
      let dayCombinedPnl = 0;

      let runningBaselinePnl = 0;
      let runningRule2Pnl = 0;
      let runningCombinedPnl = 0;
      
      let rule3Triggered = false;
      let rule3CappedPnl = 0;
      
      let combinedTriggered = false;
      let combinedCappedPnl = 0;

      let peakBaselineProfit = 0;
      let peakCombinedProfit = 0;

      for (const t of dayTrades) {
        dayBaselinePnl += t.pnl;
        runningBaselinePnl += t.pnl;
        if (runningBaselinePnl > peakBaselineProfit) peakBaselineProfit = runningBaselinePnl;

        // --- RULE 1: Monday Breakout Block ---
        const isMondayBreakout = dayOfWeek === 1 && (
          t.setup_type?.toUpperCase().includes('BREAKOUT') ||
          t.setup_type?.toUpperCase().includes('IB_BULLISH') ||
          t.setup_type?.toUpperCase().includes('IB_BEARISH') ||
          t.setup_type?.toUpperCase().includes('C_STANDALONE') ||
          new Date(t.entry_time).getHours() < 11
        );

        if (isMondayBreakout) {
          rule1TradesBlocked++;
        } else {
          dayRule1Pnl += t.pnl;
        }

        // --- RULE 2: Size Deceleration ---
        if (runningRule2Pnl < -400) {
          dayRule2Pnl += (t.pnl * 0.5);
          runningRule2Pnl += (t.pnl * 0.5);
          rule2TradesModified++;
        } else {
          dayRule2Pnl += t.pnl;
          runningRule2Pnl += t.pnl;
        }

        // --- RULE 3: Daily Cushion Lock ---
        if (!rule3Triggered) {
          dayRule3Pnl += t.pnl;
          const currentDayRule3Running = dayRule3Pnl;
          
          if (currentDayRule3Running > peakBaselineProfit) peakBaselineProfit = currentDayRule3Running;

          if (peakBaselineProfit >= 800 && currentDayRule3Running <= 500) {
            rule3Triggered = true;
            rule3CappedPnl = 500;
            rule3DaysStoppedEarly++;
          } else if (peakBaselineProfit >= 500 && currentDayRule3Running <= 250) {
            rule3Triggered = true;
            rule3CappedPnl = 250;
            rule3DaysStoppedEarly++;
          }
        }

        // --- COMBINED RULES ---
        if (!combinedTriggered) {
          if (isMondayBreakout) {
            // Blocked
          } else {
            let tradePnl = t.pnl;
            if (runningCombinedPnl < -400) {
              tradePnl = t.pnl * 0.5;
            }

            dayCombinedPnl += tradePnl;
            runningCombinedPnl += tradePnl;

            if (runningCombinedPnl > peakCombinedProfit) {
              peakCombinedProfit = runningCombinedPnl;
            }

            if (peakCombinedProfit >= 800 && runningCombinedPnl <= 500) {
              combinedTriggered = true;
              combinedCappedPnl = 500;
            } else if (peakCombinedProfit >= 500 && runningCombinedPnl <= 250) {
              combinedTriggered = true;
              combinedCappedPnl = 250;
            }
          }
        }
      }

      baselinePnl += dayBaselinePnl;
      rule1Pnl += dayRule1Pnl;
      rule2Pnl += dayRule2Pnl;
      rule3Pnl += rule3Triggered ? rule3CappedPnl : dayBaselinePnl;
      combinedPnl += combinedTriggered ? combinedCappedPnl : dayCombinedPnl;
    }

    const windowTrades = [];
    for (const date of datesSubset) {
      windowTrades.push(...sessions[date]);
    }
    const dowStats = {};
    for (let d = 1; d <= 5; d++) {
      dowStats[d] = { total: 0, wins: 0, pnl: 0, avgPnl: 0, winRate: 0 };
    }
    for (const t of windowTrades) {
      const d = t.dow;
      if (d >= 1 && d <= 5) {
        dowStats[d].total++;
        if (t.pnl > 0) dowStats[d].wins++;
        dowStats[d].pnl += t.pnl;
      }
    }
    for (let d = 1; d <= 5; d++) {
      if (dowStats[d].total > 0) {
        dowStats[d].winRate = parseFloat((dowStats[d].wins / dowStats[d].total * 100).toFixed(1));
        dowStats[d].avgPnl = parseFloat((dowStats[d].pnl / dowStats[d].total).toFixed(2));
      }
    }

    results[windowKey] = {
      windowSize: w,
      baselinePnl,
      rule1Pnl,
      rule1TradesBlocked,
      rule1Delta: rule1Pnl - baselinePnl,
      rule2Pnl,
      rule2TradesModified,
      rule2Delta: rule2Pnl - baselinePnl,
      rule3Pnl,
      rule3DaysStoppedEarly,
      rule3Delta: rule3Pnl - baselinePnl,
      combinedPnl,
      combinedDelta: combinedPnl - baselinePnl,
      dowStats
    };
  }

  return results;
}

async function getLiveEdgesContext() {
  // 1. Fetch all RTH price bars for NQ (9:30 ET to 16:00 ET)
  const barsQ = await query(`
    SELECT DISTINCT ON (ts)
      ts::date::text as trade_date,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float, volume::float
    FROM price_bars
    WHERE symbol='NQ'
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY ts, id DESC
  `);

  // Group bars by date
  const sessions = {};
  for (const bar of barsQ.rows) {
    if (!sessions[bar.trade_date]) sessions[bar.trade_date] = [];
    sessions[bar.trade_date].push(bar);
  }

  const sortedDates = Object.keys(sessions).sort();
  const sessionData = [];

  for (const date of sortedDates) {
    const bars = sessions[date].sort((a, b) => a.et_min - b.et_min);
    if (bars.length < 300) continue; // Require a reasonably complete RTH session

    const open = bars[0].open;
    const close = bars[bars.length - 1].close;
    const high = Math.max(...bars.map(b => b.high));
    const low = Math.min(...bars.map(b => b.low));
    const range = high - low;

    // OR5 Range
    const or5Bars = bars.filter(b => b.et_min >= 570 && b.et_min <= 574);
    const or5High = or5Bars.length ? Math.max(...or5Bars.map(b => b.high)) : null;
    const or5Low = or5Bars.length ? Math.min(...or5Bars.map(b => b.low)) : null;
    const or5Range = (or5High && or5Low) ? or5High - or5Low : null;

    // OR30 Range
    const or30Bars = bars.filter(b => b.et_min >= 570 && b.et_min <= 599);
    const or30High = or30Bars.length ? Math.max(...or30Bars.map(b => b.high)) : null;
    const or30Low = or30Bars.length ? Math.min(...or30Bars.map(b => b.low)) : null;
    const or30Range = (or30High && or30Low) ? or30High - or30Low : null;

    const highBar = bars.find(b => b.high === high);
    const lowBar = bars.find(b => b.low === low);
    const highTime = highBar ? highBar.et_min : null;
    const lowTime = lowBar ? lowBar.et_min : null;

    const morningBars = bars.filter(b => b.et_min >= 570 && b.et_min < 720);
    const morningHigh = morningBars.length ? Math.max(...morningBars.map(b => b.high)) : null;
    const morningLow = morningBars.length ? Math.min(...morningBars.map(b => b.low)) : null;

    sessionData.push({
      date, open, close, high, low, range,
      or5Range, or30High, or30Low, or30Range,
      morningHigh, morningLow, highTime, lowTime
    });
  }

  const windows = [30, 60, 90, sessionData.length];
  const resultsByWindow = {};

  const Q1_LIMIT = 47.5;
  const Q4_LIMIT = 91.5;

  for (const w of windows) {
    const subset = sessionData.slice(-w);
    const windowKey = w === sessionData.length ? 'allTime' : `last${w}`;

    // 1. Gaps
    let gapUps = 0, gapUpsFilled = 0;
    let gapDowns = 0, gapDownsFilled = 0;
    let insideOpens = 0, sweepHighRejections = 0, sweepLowRejections = 0;

    for (let i = 1; i < subset.length; i++) {
      const prev = subset[i - 1];
      const curr = subset[i];
      if (curr.open > prev.high) {
        gapUps++;
        if (curr.low <= prev.high) gapUpsFilled++;
      } else if (curr.open < prev.low) {
        gapDowns++;
        if (curr.high >= prev.low) gapDownsFilled++;
      } else {
        insideOpens++;
        if (curr.morningHigh > prev.high && curr.close < prev.high) sweepHighRejections++;
        if (curr.morningLow < prev.low && curr.close > prev.low) sweepLowRejections++;
      }
    }

    const gapUpFillPct = gapUps > 0 ? (gapUpsFilled / gapUps * 100).toFixed(1) : '0.0';
    const gapDownFillPct = gapDowns > 0 ? (gapDownsFilled / gapDowns * 100).toFixed(1) : '0.0';
    const sweepPct = insideOpens > 0 ? ((sweepHighRejections + sweepLowRejections) / insideOpens * 100).toFixed(1) : '0.0';

    // 2. 10:00 AM Pivot
    let pivotCount = 0;
    for (const s of subset) {
      const isHighInWindow = s.highTime >= 595 && s.highTime <= 605;
      const isLowInWindow = s.lowTime >= 595 && s.lowTime <= 605;
      if (isHighInWindow || isLowInWindow) pivotCount++;
    }
    const pivotPct = (pivotCount / subset.length * 100).toFixed(1);

    // 3. OR5 size behaviors (Tight vs Wide)
    const tightOR = subset.filter(s => s.or5Range != null && s.or5Range < Q1_LIMIT);
    const wideOR = subset.filter(s => s.or5Range != null && s.or5Range >= Q4_LIMIT);

    const tightBreakoutRun = tightOR.filter(s => {
      if (!s.or30Range) return false;
      return Math.max(s.high - s.or30High, s.or30Low - s.low) >= 2.5 * s.or30Range;
    });
    const tightTrendDays = tightOR.filter(s => (s.high - s.close < 0.15 * s.range || s.close - s.low < 0.15 * s.range) && s.range > 220);

    const wideBreakoutRun = wideOR.filter(s => {
      if (!s.or30Range) return false;
      return Math.max(s.high - s.or30High, s.or30Low - s.low) >= 2.5 * s.or30Range;
    });
    const wideTrendDays = wideOR.filter(s => (s.high - s.close < 0.15 * s.range || s.close - s.low < 0.15 * s.range) && s.range > 220);

    resultsByWindow[windowKey] = {
      windowSize: w,
      gapUps,
      gapUpsFilled,
      gapUpFillPct: parseFloat(gapUpFillPct),
      gapDowns,
      gapDownsFilled,
      gapDownFillPct: parseFloat(gapDownFillPct),
      insideOpens,
      sweepHighRejections,
      sweepLowRejections,
      sweepPct: parseFloat(sweepPct),
      pivotCount,
      pivotPct: parseFloat(pivotPct),
      tightCount: tightOR.length,
      tightRunPct: tightOR.length > 0 ? parseFloat((tightBreakoutRun.length / tightOR.length * 100).toFixed(1)) : 0,
      tightTrendPct: tightOR.length > 0 ? parseFloat((tightTrendDays.length / tightOR.length * 100).toFixed(1)) : 0,
      wideCount: wideOR.length,
      wideRunPct: wideOR.length > 0 ? parseFloat((wideBreakoutRun.length / wideOR.length * 100).toFixed(1)) : 0,
      wideTrendPct: wideOR.length > 0 ? parseFloat((wideTrendDays.length / wideOR.length * 100).toFixed(1)) : 0,
    };
  }

  // Calculate live session info if active
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let targetDate = todayET;
  let isFallback = false;

  // Check if we have setups today. If not, find the last active setup date.
  const todaySetupsCount = await query(`
    SELECT COUNT(*) FROM active_setups WHERE trade_date=$1
  `, [todayET]);

  if (parseInt(todaySetupsCount.rows[0].count) === 0) {
    const lastSetupDateQ = await query(`
      SELECT trade_date::text as last_date FROM active_setups ORDER BY trade_date DESC LIMIT 1
    `);
    if (lastSetupDateQ.rows.length > 0) {
      targetDate = lastSetupDateQ.rows[0].last_date;
      isFallback = true;
    }
  }

  // Fetch price bars for targetDate
  const todayBarsQ = await query(`
    SELECT DISTINCT ON (ts)
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float
    FROM price_bars
    WHERE symbol='NQ' AND ts::date=$1
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY ts, id DESC
  `, [targetDate]);

  let liveStatus = { active: false, reason: 'Market closed or no bars today' };
  let currentOr5Status = 'WAITING';
  let currentGapStatus = 'INSIDE';

  if (todayBarsQ.rows.length > 0) {
    const bars = todayBarsQ.rows.sort((a,b)=>a.et_min-b.et_min);
    const currentPrice = bars[bars.length - 1].close;
    
    // OR5 Range
    const or5Bars = bars.filter(b => b.et_min >= 570 && b.et_min <= 574);
    const or5High = or5Bars.length ? Math.max(...or5Bars.map(b => b.high)) : null;
    const or5Low = or5Bars.length ? Math.min(...or5Bars.map(b => b.low)) : null;
    const or5Range = (or5High && or5Low) ? or5High - or5Low : null;
    
    if (or5Range != null) {
      currentOr5Status = or5Range < Q1_LIMIT ? 'TIGHT' : or5Range >= Q4_LIMIT ? 'WIDE' : 'NORMAL';
    }

    // Gap status relative to yesterday
    const lastSession = isFallback
      ? sessionData[sessionData.length - 2]
      : sessionData[sessionData.length - 1];
    let gapOpenValue = 0;
    if (lastSession) {
      if (bars[0].open > lastSession.high) {
        currentGapStatus = 'UP';
        gapOpenValue = bars[0].open - lastSession.high;
      } else if (bars[0].open < lastSession.low) {
        currentGapStatus = 'DOWN';
        gapOpenValue = lastSession.low - bars[0].open;
      }
    }

    // First hour stats (9:30-10:30, i.e. 570-629 inclusive)
    const fhBars = bars.filter(b => b.et_min >= 570 && b.et_min <= 629);
    let firstHourStats = null;
    if (fhBars.length > 0) {
      const bodyRatios = [];
      const ranges = [];
      for (const b of fhBars) {
        const r = b.high - b.low;
        ranges.push(r);
        if (r > 0) bodyRatios.push(Math.abs(b.close - b.open) / r);
      }
      const avgBodyRatio = bodyRatios.length > 0 ? bodyRatios.reduce((a,b)=>a+b,0)/bodyRatios.length : null;
      const avgRange = ranges.reduce((a,b)=>a+b,0)/ranges.length;

      const dirs = fhBars.map(b => b.close > b.open ? 1 : (b.close < b.open ? -1 : 0));
      let flips = 0, consideredPairs = 0;
      for (let i = 1; i < dirs.length; i++) {
        if (dirs[i] !== 0 && dirs[i-1] !== 0) {
          consideredPairs++;
          if (dirs[i] !== dirs[i-1]) flips++;
        }
      }
      const reversalRate = consideredPairs > 0 ? (flips / consideredPairs) * 100 : null;

      const netMove = Math.abs(fhBars[fhBars.length-1].close - fhBars[0].open);
      const bodySum = fhBars.reduce((a,b)=>a+Math.abs(b.close-b.open), 0);
      const efficiency = bodySum > 0 ? netMove / bodySum : null;

      let trSum = 0;
      for (let i = 0; i < fhBars.length; i++) {
        const b = fhBars[i];
        if (i === 0) { trSum += b.high - b.low; }
        else {
          const pc = fhBars[i-1].close;
          trSum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
        }
      }
      const fhHi = Math.max(...fhBars.map(b=>b.high));
      const fhLo = Math.min(...fhBars.map(b=>b.low));
      const choppinessIndex = (fhHi - fhLo) > 0 ? 100 * Math.log10(trSum / (fhHi - fhLo)) / Math.log10(fhBars.length) : null;

      firstHourStats = {
        efficiency: efficiency != null ? parseFloat(efficiency.toFixed(3)) : null,
        choppinessIndex: choppinessIndex != null ? parseFloat(choppinessIndex.toFixed(1)) : null,
        reversalRate: reversalRate != null ? parseFloat(reversalRate.toFixed(1)) : null,
        avgBodyRatio: avgBodyRatio != null ? parseFloat(avgBodyRatio.toFixed(3)) : null,
        avgRange: parseFloat(avgRange.toFixed(2)),
        n: fhBars.length
      };
    }

    liveStatus = {
      active: true,
      isLive: !isFallback,
      date: targetDate,
      currentPrice,
      or5Range,
      or5Status: currentOr5Status,
      gapStatus: currentGapStatus,
      gapOpenValue,
      barsCount: bars.length,
      firstHourStats
    };
  }

  // 4. Fetch Active Setups for targetDate
  let setupsQ = await query(`
    SELECT s.id, s.setup_type, TO_CHAR(s.fired_at, 'HH24:MI') as fired_time,
           s.entry_zone_low::float, s.entry_zone_high::float, s.stop_level::float, s.t1_level::float,
           s.price_at_detection::float, s.resolution, s.status, s.trade_date::text as t_date,
           s.actual_pnl::float
    FROM active_setups s
    WHERE s.trade_date = $1
    ORDER BY s.fired_at DESC
  `, [targetDate]);

  let setupDate = targetDate;

  // Fetch baseline win rates
  const baselinesQ = await query(`
    SELECT setup_type, win_rate::float as wr, decided_n as n
    FROM setup_daytype_winrates
    WHERE day_type = 'OVERALL' AND computed_date = (SELECT MAX(computed_date) FROM setup_daytype_winrates)
  `);
  const baselineMap = {};
  for (const row of baselinesQ.rows) {
    baselineMap[row.setup_type] = { wr: row.wr, n: row.n };
  }

  // Apply Antigravity Confidence Adjustment Logic
  const processedSetups = [];
  const todayD = new Date(setupDate + 'T12:00:00Z');
  const setupDayOfWeek = todayD.getDay(); // 1=Monday...

  for (const s of setupsQ.rows) {
    const base = baselineMap[s.setup_type] || { wr: 0.50, n: 25 };
    let adjustedWr = base.wr;
    let confidence = 'MEDIUM';
    let rec = 'Execute standard risk parameters.';

    const isBreakout = s.setup_type.includes('BULLISH') || s.setup_type.includes('BEARISH') || s.setup_type.includes('UP') || s.setup_type.includes('DOWN');
    const isMeanReversion = s.setup_type.includes('REVERSAL') || s.setup_type.includes('FAILED') || s.setup_type.includes('RESPONSIVE');

    // 1. Monday Penalty
    if (setupDayOfWeek === 1 && isBreakout) {
      adjustedWr -= 0.15;
      confidence = 'AVOID';
      rec = '❌ Monday Morning Breakout: high failure chop environment. DO NOT trade.';
    }
    // 2. OR5 Wide Range Penalty
    else if (currentOr5Status === 'WIDE' && isBreakout) {
      adjustedWr -= 0.18;
      confidence = 'LOW';
      rec = '⚠️ Wide Opening Range: breakout has 95% fail rate. Look to fade expansion instead.';
    }
    // 3. OR5 Tight Range Bonus
    else if (currentOr5Status === 'TIGHT' && isBreakout) {
      adjustedWr += 0.08;
      confidence = 'HIGH';
      rec = '✅ Squeezed Opening Range: breakout follow-through edge is high (12%+).';
    }
    // 4. Gap open context
    else if (currentGapStatus !== 'INSIDE' && isMeanReversion) {
      adjustedWr += 0.06;
      confidence = 'HIGH';
      rec = '✅ Gap open: gap-fill probability is ~66%. Reversal trades are high-probability.';
    }

    if (confidence !== 'AVOID') {
      if (adjustedWr >= 0.58) confidence = 'HIGH';
      else if (adjustedWr >= 0.46) confidence = 'MEDIUM';
      else confidence = 'LOW';
    }

    processedSetups.push({
      ...s,
      baselineWr: base.wr,
      sampleN: base.n,
      adjustedWr: parseFloat(Math.max(0.05, Math.min(0.95, adjustedWr)).toFixed(3)),
      confidence,
      recommendation: rec
    });
  }

  const tradeBacktest = await getTradeBacktest();

  return {
    windows: resultsByWindow,
    liveStatus,
    limits: { Q1_LIMIT, Q4_LIMIT },
    setups: {
      date: setupDate,
      isFallback,
      list: processedSetups
    },
    tradeBacktest
  };
}

// GET /api/antigravity/edges-context
router.get('/antigravity/edges-context', async (req, res) => {
  try {
    const data = await getLiveEdgesContext();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
