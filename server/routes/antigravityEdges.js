import express from 'express';
import { query } from '../db.js';

const router = express.Router();

async function getTradeBacktest() {
  const isFunded = (acct) => /PRO\d|DIRECT\d/.test(acct || '');

  // Load raw trades
  const tradesQ = await query(`
    SELECT id, log_date::text as trade_date, entry_time, exit_time,
           direction, quantity, entry_price::float, exit_price::float,
           pnl::float, setup_type, EXTRACT(dow FROM entry_time)::int as dow,
           custom_fields->>'account' as account,
           custom_fields->'sierra_data'->>'Exit DateTime' as exit_dt,
           custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' as ftf,
           custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' as cumpl,
           custom_fields->'sierra_data'->>'Max Open Quantity' as max_open_qty,
           custom_fields->'sierra_data'->>'sierra_row' as sierra_row_a,
           custom_fields->>'sierra_row' as sierra_row_b
    FROM trades
    WHERE entry_time IS NOT NULL AND exit_time IS NOT NULL AND custom_fields->>'account' IS NOT NULL
    ORDER BY entry_time ASC
  `);

  const rows = tradesQ.rows.map(r => ({
    ...r,
    sierra_row: r.sierra_row_a ?? r.sierra_row_b ?? 0,
  }));

  // Dedup (account-aware)
  const seen = new Set();
  const fills = rows.filter(r => {
    const key = `${r.account}|${r.entry_time}|${r.exit_time}|${r.direction}|${r.quantity}|${r.entry_price}|${r.exit_price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Group into flat-to-flat net trades
  const dayGroups = new Map();
  for (const f of fills) {
    const key = `${f.account}|${f.trade_date}|${f.direction}`;
    (dayGroups.get(key) ?? dayGroups.set(key, []).get(key)).push(f);
  }

  const netTrades = [];
  for (const [, groupFills] of dayGroups) {
    groupFills.sort((a, b) => {
      const td = new Date(a.entry_time) - new Date(b.entry_time);
      if (td !== 0) return td;
      return (parseFloat(a.sierra_row) || 0) - (parseFloat(b.sierra_row) || 0);
    });

    const isEP = (f) => typeof f.exit_dt === 'string' && f.exit_dt.trimEnd().endsWith('EP');
    const sessionEndTimes = [...new Set(groupFills.filter(isEP).map(f => f.exit_time))].sort();
    const boundaries = sessionEndTimes.length > 0
      ? sessionEndTimes
      : [groupFills[groupFills.length - 1]?.exit_time].filter(Boolean);

    const sessions = new Map();
    for (const b of boundaries) sessions.set(b, []);
    for (const f of groupFills) {
      const boundary = boundaries.find(b => new Date(b) >= new Date(f.exit_time));
      const assignTo = boundary ?? boundaries[boundaries.length - 1];
      sessions.get(assignTo)?.push(f);
    }

    for (const sessionFills of sessions.values()) {
      if (!sessionFills.length) continue;
      let latestExitTime = null, earliestEntryTime = null;
      for (const f of sessionFills) {
        if (!latestExitTime || f.exit_time > latestExitTime) latestExitTime = f.exit_time;
        if (!earliestEntryTime || f.entry_time < earliestEntryTime) earliestEntryTime = f.entry_time;
      }
      const epFill = sessionFills.find(isEP);
      const ftfRaw = String(epFill?.ftf || '').trim().replace(/\s*F$/i, '');
      const totalPnl = ftfRaw !== '' ? parseFloat(ftfRaw) : sessionFills.reduce((s, f) => s + (f.pnl || 0), 0);
      const totalQty = sessionFills.reduce((mx, f) => Math.max(mx, parseFloat(f.max_open_qty) || 0), 0) || sessionFills[0]?.quantity || 0;
      const setup_type = sessionFills.find(f => f.setup_type)?.setup_type || null;

      netTrades.push({
        account: sessionFills[0].account,
        trade_date: sessionFills[0].trade_date,
        entry_time: earliestEntryTime,
        latestExitTime,
        totalQty,
        totalPnl,
        epFill,
        setup_type,
        dow: sessionFills[0].dow,
      });
    }
  }

  // CumPL-diff correction (per account, chronological)
  const lastCumPLByAccount = new Map();
  netTrades
    .sort((a, b) => {
      if (a.account !== b.account) return a.account.localeCompare(b.account);
      return new Date(a.latestExitTime) - new Date(b.latestExitTime);
    })
    .forEach(session => {
      const epFill = session.epFill;
      if (!epFill) return;
      const cumPLStr = String(epFill.cumpl || '').trim();
      const thisCumPL = parseFloat(cumPLStr);
      if (isNaN(thisCumPL)) return;
      const prev = lastCumPLByAccount.get(session.account) ?? 0;
      session.totalPnl = thisCumPL - prev;
      lastCumPLByAccount.set(session.account, thisCumPL);
    });

  // Filter for LIVE/FUNDED accounts only
  const liveTrades = netTrades.filter(t => isFunded(t.account));

  // Group live trades by (account, trade_date) to form trading sessions
  const sessionsByDateAcct = {};
  for (const t of liveTrades) {
    const key = `${t.account}|${t.trade_date}`;
    if (!sessionsByDateAcct[key]) sessionsByDateAcct[key] = [];
    sessionsByDateAcct[key].push(t);
  }

  // Group sessions by trade_date
  const sessionsByDate = {};
  for (const [key, dayTrades] of Object.entries(sessionsByDateAcct)) {
    const [, date] = key.split('|');
    if (!sessionsByDate[date]) sessionsByDate[date] = [];
    sessionsByDate[date].push(dayTrades);
  }

  const sortedDates = Object.keys(sessionsByDate).sort();
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
      const acctSessions = sessionsByDate[date];

      for (const dayTrades of acctSessions) {
        dayTrades.sort((a, b) => new Date(a.entry_time) - new Date(b.entry_time));
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
          dayBaselinePnl += t.totalPnl;
          runningBaselinePnl += t.totalPnl;
          if (runningBaselinePnl > peakBaselineProfit) peakBaselineProfit = runningBaselinePnl;

          // --- RULE 1: Monday Morning (pre-11 AM) Block ---
          const isMondayBreakout = dayOfWeek === 1 && (
            new Date(t.entry_time).getHours() < 11 ||
            (t.setup_type && (
              (t.setup_type.toUpperCase().includes('BREAKOUT') ||
               t.setup_type.toUpperCase().includes('IB_BULLISH') ||
               t.setup_type.toUpperCase().includes('IB_BEARISH') ||
               t.setup_type.toUpperCase().includes('TRT_')) &&
              !t.setup_type.toUpperCase().includes('C_STANDALONE')
            ))
          );

          if (isMondayBreakout) {
            rule1TradesBlocked++;
          } else {
            dayRule1Pnl += t.totalPnl;
          }

          // --- RULE 2: Size Deceleration ---
          if (runningRule2Pnl < -400) {
            dayRule2Pnl += (t.totalPnl * 0.5);
            runningRule2Pnl += (t.totalPnl * 0.5);
            rule2TradesModified++;
          } else {
            dayRule2Pnl += t.totalPnl;
            runningRule2Pnl += t.totalPnl;
          }

          // --- RULE 3: Daily Cushion Lock ---
          if (!rule3Triggered) {
            dayRule3Pnl += t.totalPnl;
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
              let tradePnl = t.totalPnl;
              if (runningCombinedPnl < -400) {
                tradePnl = t.totalPnl * 0.5;
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
    }

    // Dow stats
    const dowStats = {};
    for (let d = 1; d <= 5; d++) {
      dowStats[d] = { total: 0, wins: 0, pnl: 0, avgPnl: 0, winRate: 0 };
    }
    const windowTrades = [];
    for (const date of datesSubset) {
      const acctSessions = sessionsByDate[date];
      for (const s of acctSessions) {
        windowTrades.push(...s);
      }
    }
    for (const t of windowTrades) {
      const d = t.dow;
      if (d >= 1 && d <= 5) {
        dowStats[d].total++;
        if (t.totalPnl > 0) dowStats[d].wins++;
        dowStats[d].pnl += t.totalPnl;
      }
    }
    for (let d = 1; d <= 5; d++) {
      if (dowStats[d].total > 0) {
        dowStats[d].winRate = parseFloat((dowStats[d].wins / dowStats[d].total * 100).toFixed(1));
        dowStats[d].avgPnl = parseFloat((dowStats[d].pnl / dowStats[d].total).toFixed(2));
      }
    }

    results[windowKey] = {
      windowSize: datesSubset.length,
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
  // Limit to last 120 trading days — covers all analysis windows (30/60/90/allTime)
  // without a full sequential scan of the entire price_bars table on every request.
  const barsQ = await query(`
    SELECT DISTINCT ON (ts)
      ts::date::text as trade_date,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float, volume::float
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND ts::date >= CURRENT_DATE - INTERVAL '170 days'
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

  const allOr5Ranges = sessionData.map(s => s.or5Range).filter(r => r != null).sort((a, b) => a - b);
  const Q1_LIMIT = allOr5Ranges.length > 0 ? parseFloat(allOr5Ranges[Math.floor(allOr5Ranges.length * 0.25)].toFixed(2)) : 47.5;
  const Q4_LIMIT = allOr5Ranges.length > 0 ? parseFloat(allOr5Ranges[Math.floor(allOr5Ranges.length * 0.75)].toFixed(2)) : 91.5;

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

  // Check if we have setups today. If not, check if we have price bars today (meaning today is a trading day).
  const todaySetupsCount = await query(`
    SELECT COUNT(*) FROM active_setups WHERE trade_date=$1
  `, [todayET]);

  const todayBarsCount = await query(`
    SELECT 1 FROM price_bars WHERE ts >= $1::date AND ts < $1::date + interval '1 day' LIMIT 1
  `, [todayET]);

  const hasBarsToday = todayBarsCount.rows.length > 0;
  const hasSetupsToday = parseInt(todaySetupsCount.rows[0].count) > 0;

  if (!hasSetupsToday && !hasBarsToday) {
    // If no setups and no price bars today, we are in a non-trading period (e.g. weekend or holiday).
    // Fall back to the last trading day with price bars.
    const lastBarDateQ = await query(`
      SELECT ts::date::text as last_date FROM price_bars WHERE ts < $1 ORDER BY ts DESC LIMIT 1
    `, [todayET]);
    if (lastBarDateQ.rows.length > 0) {
      targetDate = lastBarDateQ.rows[0].last_date;
      isFallback = true;
    }
  }

  // Fetch price bars for targetDate
  const todayBarsQ = await query(`
    SELECT DISTINCT ON (ts)
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float,
      COALESCE(volume, 0)::int as volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date=$1
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY ts, id DESC
  `, [targetDate]);

  // Fetch ACD levels for today (used for coil level proximity)
  const acdTodayQ = await query(`
    SELECT a_up_level::float, a_down_level::float, or_high::float, or_low::float
    FROM acd_daily_log WHERE trade_date = $1
  `, [targetDate]);
  const acdToday = acdTodayQ.rows[0] || null;

  let liveStatus = { active: false, reason: 'Market closed or no bars today' };
  let currentOr5Status = 'WAITING';
  let currentGapStatus = 'INSIDE';

  if (todayBarsQ.rows.length > 0) {
    const bars = todayBarsQ.rows.sort((a,b)=>a.et_min-b.et_min);
    const currentPrice = bars[bars.length - 1].close;
    
    // OR5 Range (only resolve once the first 5 minutes [9:30-9:34] are complete)
    const or5Bars = bars.filter(b => b.et_min >= 570 && b.et_min <= 574);
    const hasFiveMinutesPassed = bars.some(b => b.et_min >= 574);
    
    let or5Range = null;
    if (hasFiveMinutesPassed && or5Bars.length > 0) {
      const or5High = Math.max(...or5Bars.map(b => b.high));
      const or5Low = Math.min(...or5Bars.map(b => b.low));
      or5Range = or5High - or5Low;
      currentOr5Status = or5Range < Q1_LIMIT ? 'TIGHT' : or5Range >= Q4_LIMIT ? 'WIDE' : 'NORMAL';
    }

    // Gap status relative to yesterday — filter to sessions strictly before today
    // so today's live session (once it crosses 300 bars) doesn't pollute PDH/PDL/PDC
    const priorSessions = sessionData.filter(s => s.date < targetDate);
    const lastSession = priorSessions.length > 0 ? priorSessions[priorSessions.length - 1] : null;
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

    // VWAP: volume-weighted average price from today's bars
    let vwap = null;
    {
      const totalVol = bars.reduce((s, b) => s + (b.volume || 0), 0);
      if (totalVol > 0) {
        const sumTP = bars.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * (b.volume || 0), 0);
        vwap = Math.round((sumTP / totalVol) * 100) / 100;
      }
    }

    // IB high/low (first hour, 9:30–10:30)
    const ibHigh = fhBars.length > 0 ? Math.max(...fhBars.map(b => b.high)) : null;
    const ibLow  = fhBars.length > 0 ? Math.min(...fhBars.map(b => b.low)) : null;

    // Key levels map for coil proximity check
    const keyLevels = [
      vwap != null                  && { label: 'VWAP',          value: vwap },
      ibHigh != null                && { label: 'IB High',       value: ibHigh },
      ibLow != null                 && { label: 'IB Low',        value: ibLow },
      lastSession?.high != null     && { label: 'Prior Day High', value: lastSession.high },
      lastSession?.low != null      && { label: 'Prior Day Low',  value: lastSession.low },
      lastSession?.close != null    && { label: 'Prior Day Close', value: lastSession.close },
      acdToday?.a_up_level != null  && { label: 'A-Up',          value: acdToday.a_up_level },
      acdToday?.a_down_level != null && { label: 'A-Down',       value: acdToday.a_down_level },
    ].filter(Boolean);

    // Returns nearest named level within maxPts, or null
    function nearestLevel(price, maxPts = 15) {
      let best = null, bestDist = Infinity;
      for (const kl of keyLevels) {
        const dist = Math.abs(kl.value - price);
        if (dist <= maxPts && dist < bestDist) { best = kl; bestDist = dist; }
      }
      return best ? { ...best, dist: Math.round(bestDist * 10) / 10 } : null;
    }

    // Coiling detection: 15-bar rolling range + volume dry-up vs anchored preceding 20-bar baseline.
    let coilingStatus = { active: false };
    if (bars.length >= 35) {
      const recentBars = bars.slice(-15);
      const recentHigh = Math.max(...recentBars.map(b => b.high));
      const recentLow = Math.min(...recentBars.map(b => b.low));
      const recentRange = recentHigh - recentLow;
      const recentAvgVol = recentBars.reduce((s, b) => s + (b.volume || 0), 0) / 15;

      let isCoiling = false;
      let compStartIdx = bars.length - 15;

      if (recentRange < 40) {
        // Walk backward to find the start of the compression period
        for (let j = bars.length - 15; j >= 20; j--) {
          const win3 = bars.slice(j, j + 3);
          const wHi = Math.max(...win3.map(b => b.high));
          const wLo = Math.min(...win3.map(b => b.low));
          if (wHi - wLo < 35) {
            compStartIdx = j;
          } else {
            break;
          }
        }

        // 20-bar baseline preceding the compression period
        const baselineBars = bars.slice(Math.max(0, compStartIdx - 20), compStartIdx);
        const baselineAvgVol = baselineBars.length > 0
          ? baselineBars.reduce((s, b) => s + (b.volume || 0), 0) / baselineBars.length
          : 0;

        const volRatio = baselineAvgVol > 0 ? recentAvgVol / baselineAvgVol : null;
        isCoiling = volRatio != null && volRatio < 0.40;

        if (isCoiling) {
          const durationBars = bars.length - compStartIdx;
          const coilPhase = durationBars < 5 ? 'nascent'
            : durationBars <= 15 ? 'optimal'
            : 'stale';

          // Pop trigger: last bar approaches boundary and volume surges >= 1.8x
          let popSurge = false;
          let popDir = null;
          let volSurgeRatio = null;
          if (bars.length >= 10) {
            const lastBar = bars[bars.length - 1];
            const nearBoundaryPts = 10;
            const nearHigh = lastBar.high >= recentHigh - nearBoundaryPts;
            const nearLow = lastBar.low <= recentLow + nearBoundaryPts;
            const nearBoundary = nearHigh || nearLow;

            const priorSlice = bars.slice(-9, -1);
            const priorAvgVol = priorSlice.length > 0
              ? priorSlice.reduce((s, b) => s + (b.volume || 0), 0) / priorSlice.length
              : null;
            volSurgeRatio = priorAvgVol && priorAvgVol > 0 ? lastBar.volume / priorAvgVol : null;

            if (nearBoundary && volSurgeRatio != null && volSurgeRatio >= 1.8) {
              popSurge = true;
              popDir = nearHigh ? 'high' : 'low';
            }
          }

          const coilHighLevel = nearestLevel(recentHigh);
          const coilLowLevel  = nearestLevel(recentLow);

          coilingStatus = {
            active: true,
            range: Math.round(recentRange * 10) / 10,
            high: Math.round(recentHigh * 100) / 100,
            low: Math.round(recentLow * 100) / 100,
            avgVolume: Math.round(recentAvgVol),
            baselineVolume: baselineAvgVol > 0 ? Math.round(baselineAvgVol) : null,
            volRatio: volRatio != null ? Math.round(volRatio * 100) : null,
            durationBars,
            coilPhase,
            popSurge,
            popDir,
            volSurgeRatio: volSurgeRatio != null ? Math.round(volSurgeRatio * 10) / 10 : null,
            highLevel: coilHighLevel,
            lowLevel:  coilLowLevel,
            vwap,
          };
        }
      }
    }

    // Volume climax detection: last bar volume ≥ 4x trailing 20-bar average.
    // Signals potential exhaustion / institutional reversal — price has moved fast
    // and large participants are likely absorbing the move.
    let volumeClimax = null;
    if (bars.length >= 21) {
      const lastBar = bars[bars.length - 1];
      const trail20 = bars.slice(-21, -1);
      const trail20Avg = trail20.reduce((s, b) => s + (b.volume || 0), 0) / trail20.length;
      const climaxRatio = trail20Avg > 0 ? lastBar.volume / trail20Avg : null;
      if (climaxRatio != null && climaxRatio >= 4.0) {
        const barDir = lastBar.close > lastBar.open ? 'up' : lastBar.close < lastBar.open ? 'down' : 'flat';
        const nearLevel = nearestLevel(lastBar.close, 20);
        volumeClimax = {
          active: true,
          ratio: Math.round(climaxRatio * 10) / 10,
          volume: lastBar.volume,
          avgVolume: Math.round(trail20Avg),
          price: lastBar.close,
          barDir,
          nearLevel,
        };
      }
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
      firstHourStats,
      coiling: coilingStatus,
      volumeClimax,
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

  // Apply Antigravity Heuristic Adjustments
  // CRITICAL NOTE: The adjustments below (-0.15, -0.18, +0.08, +0.06) are qualitative coaching
  // assumptions and heuristic guidelines from manual review rules. They are NOT dynamically 
  // computed statistical findings from historical trade data in the database.
  const processedSetups = [];
  const todayD = new Date(setupDate + 'T12:00:00Z');
  const setupDayOfWeek = todayD.getDay(); // 1=Monday...

  for (const s of setupsQ.rows) {
    const base = baselineMap[s.setup_type] || { wr: 0.50, n: 25 };
    let adjustedWr = base.wr;
    let confidence = 'MEDIUM';
    let rec = 'Execute standard risk parameters.';

    const setupType = s.setup_type.toUpperCase();
    const isBreakout = setupType.includes('BREAKOUT') || setupType.includes('OPEN_DRIVE') || setupType.includes('OPEN_TEST_DRIVE') || setupType.includes('IB_BULLISH') || setupType.includes('IB_BEARISH') || setupType.includes('TRT_');
    const isMeanReversion = setupType.includes('REVERSAL') || setupType.includes('FAILED') || setupType.includes('RESPONSIVE') || setupType.includes('C_STANDALONE');

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
