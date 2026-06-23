import express from 'express';
import https from 'https';
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

    // 9 EMA Snap-Back computation on 5-min resampled bars
    let emaSnap = null;
    const fiveBuckets = {};
    for (const b of bars) {
      const bk = Math.floor(b.et_min / 5) * 5;
      if (!fiveBuckets[bk]) fiveBuckets[bk] = { open: b.open, high: b.high, low: b.low, close: b.close };
      else { fiveBuckets[bk].high = Math.max(fiveBuckets[bk].high, b.high); fiveBuckets[bk].low = Math.min(fiveBuckets[bk].low, b.low); fiveBuckets[bk].close = b.close; }
    }
    const fiveBars = Object.values(fiveBuckets);
    if (fiveBars.length >= 14) {
      const fc = fiveBars.map(b => b.close), fh = fiveBars.map(b => b.high), fl = fiveBars.map(b => b.low);
      const ema9 = new Array(fc.length).fill(null);
      const ek = 2 / 10;
      ema9[8] = fc.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
      for (let i = 9; i < fc.length; i++) ema9[i] = fc[i] * ek + ema9[i - 1] * (1 - ek);
      const tr = fc.map((c, i) => i === 0 ? fh[i] - fl[i] : Math.max(fh[i] - fl[i], Math.abs(fh[i] - fc[i - 1]), Math.abs(fl[i] - fc[i - 1])));
      const atr = new Array(fc.length).fill(null);
      atr[13] = tr.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
      for (let i = 14; i < fc.length; i++) atr[i] = tr[i] * (2 / 15) + atr[i - 1] * (1 - 2 / 15);
      const last = fc.length - 1;
      if (ema9[last] != null && atr[last] != null && atr[last] > 0.5) {
        const dev = fc[last] - ema9[last];
        const devATR = dev / atr[last];
        emaSnap = {
          ema9: Math.round(ema9[last] * 100) / 100,
          atr14: Math.round(atr[last] * 100) / 100,
          price: fc[last],
          deviation: Math.round(dev * 100) / 100,
          deviationATR: Math.round(devATR * 100) / 100,
          absDeviationATR: Math.round(Math.abs(devATR) * 100) / 100,
          stretched: Math.abs(devATR) >= 2.0,
          direction: dev > 0 ? 'ABOVE' : 'BELOW',
          triggerLevel: Math.abs(devATR) >= 2.0 ? (dev > 0 ? 'FADE SHORT toward EMA' : 'FADE LONG toward EMA') : null,
        };
      }
    }

    // RSI Divergence detection for edge card (5-min)
    let rsiDiv = null;
    if (fiveBars.length >= 17) {
      const fc = fiveBars.map(b => b.close), fh = fiveBars.map(b => b.high), fl = fiveBars.map(b => b.low);
      const rsiArr = new Array(fc.length).fill(null);
      let rag = 0, ral = 0;
      for (let i = 1; i <= 14; i++) { const d = fc[i] - fc[i-1]; rag += d > 0 ? d : 0; ral += d < 0 ? -d : 0; }
      rag /= 14; ral /= 14;
      rsiArr[14] = ral === 0 ? 100 : 100 - 100 / (1 + rag / ral);
      for (let i = 15; i < fc.length; i++) {
        const d = fc[i] - fc[i-1]; rag = (rag * 13 + (d > 0 ? d : 0)) / 14; ral = (ral * 13 + (d < 0 ? -d : 0)) / 14;
        rsiArr[i] = ral === 0 ? 100 : 100 - 100 / (1 + rag / ral);
      }
      // Swing detection (N=3)
      const SW = 3, sHighs = [], sLows = [];
      for (let i = SW; i < fc.length - SW; i++) {
        let isH = true, isL = true;
        for (let j = 1; j <= SW; j++) { if (fh[i] <= fh[i-j] || fh[i] <= fh[i+j]) isH = false; if (fl[i] >= fl[i-j] || fl[i] >= fl[i+j]) isL = false; }
        if (isH) sHighs.push({ idx: i, price: fh[i], rsi: rsiArr[i] });
        if (isL) sLows.push({ idx: i, price: fl[i], rsi: rsiArr[i] });
      }
      const last = fc.length - 1;
      // Check for bearish divergence (building or confirmed)
      if (sHighs.length >= 2) {
        const curr = sHighs[sHighs.length - 1], prev = sHighs[sHighs.length - 2];
        if (curr.idx - prev.idx <= 40 && curr.price > prev.price && curr.rsi != null && prev.rsi != null && curr.rsi < prev.rsi) {
          const barsFromSwing = last - curr.idx;
          const confirmed = barsFromSwing >= 1 && fc[curr.idx + 1] < fc[curr.idx];
          rsiDiv = {
            type: 'BEARISH',
            detected: true,
            confirmed,
            building: !confirmed && barsFromSwing <= 5,
            swingHigh1: Math.round(prev.price),
            swingHigh2: Math.round(curr.price),
            rsi1: Math.round(prev.rsi),
            rsi2: Math.round(curr.rsi),
            rsiDelta: Math.round(prev.rsi - curr.rsi),
            barsFromSwing,
            currentRsi: rsiArr[last] != null ? Math.round(rsiArr[last]) : null,
          };
        }
      }
      // Check for bullish divergence (only if no bearish)
      if (!rsiDiv && sLows.length >= 2) {
        const curr = sLows[sLows.length - 1], prev = sLows[sLows.length - 2];
        if (curr.idx - prev.idx <= 40 && curr.price < prev.price && curr.rsi != null && prev.rsi != null && curr.rsi > prev.rsi) {
          const barsFromSwing = last - curr.idx;
          const confirmed = barsFromSwing >= 1 && fc[curr.idx + 1] > fc[curr.idx];
          rsiDiv = {
            type: 'BULLISH',
            detected: true,
            confirmed,
            building: !confirmed && barsFromSwing <= 5,
            swingLow1: Math.round(prev.price),
            swingLow2: Math.round(curr.price),
            rsi1: Math.round(prev.rsi),
            rsi2: Math.round(curr.rsi),
            rsiDelta: Math.round(curr.rsi - prev.rsi),
            barsFromSwing,
            currentRsi: rsiArr[last] != null ? Math.round(rsiArr[last]) : null,
          };
        }
      }
    }

    // Absorption detection for edge card
    let absorption = null;
    if (bars.length >= 30) {
      const absFiveBk = {};
      for (const b of bars) { const bk=Math.floor(b.et_min/5)*5; if(!absFiveBk[bk])absFiveBk[bk]={high:b.high,low:b.low,close:b.close};else{absFiveBk[bk].high=Math.max(absFiveBk[bk].high,b.high);absFiveBk[bk].low=Math.min(absFiveBk[bk].low,b.low);absFiveBk[bk].close=b.close;}}
      const absFb=Object.values(absFiveBk);
      if(absFb.length>=20){
        const absC=absFb.map(b=>b.close);
        const absRsi=new Array(absC.length).fill(null);
        let aag=0,aal=0;for(let i=1;i<=14;i++){const d=absC[i]-absC[i-1];aag+=d>0?d:0;aal+=d<0?-d:0;}aag/=14;aal/=14;
        absRsi[14]=aal===0?100:100-100/(1+aag/aal);
        for(let i=15;i<absC.length;i++){const d=absC[i]-absC[i-1];aag=(aag*13+(d>0?d:0))/14;aal=(aal*13+(d<0?-d:0))/14;absRsi[i]=aal===0?100:100-100/(1+aag/aal);}
        const AW=15,last=absC.length-1;
        if(last>=AW+5&&absRsi[last]!=null&&absRsi[last-AW]!=null){
          const wb=absFb.slice(last-AW,last+1);
          const wH=Math.max(...wb.map(b=>b.high)),wL=Math.min(...wb.map(b=>b.low));
          const rsiDrift=absRsi[last]-absRsi[last-AW];
          const priceDrift=absC[last]-absC[last-AW];
          const priceFlat=Math.abs(priceDrift)<(wH-wL)*0.3;
          const lowCluster=wb.filter(b=>Math.abs(b.low-wL)<5).length;
          const highCluster=wb.filter(b=>Math.abs(b.high-wH)<5).length;
          const bullDetected=lowCluster>=4&&rsiDrift>5&&priceFlat;
          const watching=lowCluster>=3&&rsiDrift>3&&priceFlat; // approaching threshold
          if(bullDetected||watching) absorption={detected:bullDetected,watching:watching&&!bullDetected,lowCluster,highCluster,rsiDrift:Math.round(rsiDrift*10)/10,wRange:Math.round(wH-wL),supportLevel:Math.round(wL)};
        }
      }
    }

    // Coil surge detection for edge card
    let coilSurge = null;
    if (bars.length >= 60) {
      const cRW=15, cRT=40, cVR=0.40, cBB=20;
      let cumPV=0, cumV=0;
      for (const b of bars) { cumPV+=(b.high+b.low+b.close)/3*(Number(b.volume)||1); cumV+=(Number(b.volume)||1); }
      const vwap = cumV > 0 ? cumPV / cumV : null;

      for (let ci = 50; ci < bars.length; ci++) {
        let cHi=-Infinity, cLo=Infinity;
        for (let j=ci-cRW+1;j<=ci;j++){cHi=Math.max(cHi,bars[j].high);cLo=Math.min(cLo,bars[j].low);}
        if(cHi-cLo>=cRT) continue;
        const cbs=Math.max(0,ci-cRW-cBB), cbe=ci-cRW; if(cbe-cbs<10) continue;
        const cBv=bars.slice(cbs,cbe).reduce((s,b)=>s+(Number(b.volume)||0),0)/(cbe-cbs);
        if(cBv<=0||(Number(bars[ci].volume)||0)/cBv>=cVR) continue;
        const lastVol = Number(bars[bars.length-1].volume)||0;
        const surgeRatio = cBv > 0 ? lastVol / cBv : 0;
        const coilRange = cHi - cLo;
        const distToVwap = vwap ? currentPrice - vwap : null;
        coilSurge = {
          detected: true,
          coilRange: Math.round(coilRange),
          volRatio: Math.round((Number(bars[ci].volume)||0)/cBv*100),
          surgeRatio: Math.round(surgeRatio * 10) / 10,
          surging: surgeRatio >= 2.5,
          vwap: vwap ? Math.round(vwap) : null,
          distToVwap: distToVwap ? Math.round(distToVwap) : null,
          direction: distToVwap && distToVwap < 0 ? 'LONG toward VWAP' : 'SHORT toward VWAP',
        };
        break;
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
      emaSnap,
      coilSurge,
      absorption,
      rsiDiv,
    };
  }

  // 4. Fetch Active Setups for targetDate (exclude SHADOW and removed setups)
  let setupsQ = await query(`
    SELECT s.id, s.setup_type, TO_CHAR(s.fired_at, 'HH24:MI') as fired_time,
           s.entry_zone_low::float, s.entry_zone_high::float, s.stop_level::float, s.t1_level::float,
           s.price_at_detection::float, s.resolution, s.status, s.trade_date::text as t_date,
           s.actual_pnl::float, s.nl30_at_detection::int as nl30_at_detection,
           EXTRACT(HOUR FROM s.fired_at AT TIME ZONE 'America/New_York')::int as hour_of_day
    FROM active_setups s
    WHERE s.trade_date = $1 AND s.status != 'SHADOW'
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

  // Fetch dynamically mined overnight edges
  const minedEdgesQ = await query(`
    SELECT setup_type, dimension, segment, win_rate::float as wr, baseline_win_rate::float as base_wr, deviation::float as deviation, status, p_value::float as p_value
    FROM dynamic_edges_mining
    WHERE status IN ('POSITIVE_BOOSTER', 'NEGATIVE_DRAG')
  `).catch(err => {
    console.error('Error fetching dynamic_edges_mining:', err);
    return { rows: [] };
  });
  const dynamicEdgesMap = {};
  for (const row of minedEdgesQ.rows) {
    if (!dynamicEdgesMap[row.setup_type]) {
      dynamicEdgesMap[row.setup_type] = [];
    }
    dynamicEdgesMap[row.setup_type].push(row);
  }

  // Setup-specific context adjustments — backtested on 440 resolved trades
  // across the 6 surviving setups (June 2025 - June 2026).
  const SETUP_CONTEXT = {
    'IB_BEARISH':                   { monAdj: -0.20, tightAdj: -0.09, wideAdj: +0.14, turbAdj: +0.25 },
    'OPEN_DRIVE_SHORT':             { monAdj: -0.10, tightAdj: -0.14, wideAdj: -0.20, turbAdj: +0.38 },
    'OPEN_DRIVE_LONG':              { monAdj: +0.19, tightAdj: +0.17, wideAdj: -0.27, turbAdj: +0.06 },
    'VALUE_AREA_RESPONSIVE_SHORT':  { monAdj: -0.08, tightAdj: -0.05, wideAdj: +0.04, turbAdj: +0.06 },
    'TRT_LONG':                     { monAdj: 0,     tightAdj: -0.40, wideAdj: 0,     turbAdj: 0 },
    'C_STANDALONE_DOWN':            { monAdj: -0.08, tightAdj: -0.11, wideAdj: +0.11, turbAdj: +0.26 },
  };
  const processedSetups = [];
  const todayD = new Date(setupDate + 'T12:00:00Z');
  const setupDayOfWeek = todayD.getDay();

  for (const s of setupsQ.rows) {
    const base = baselineMap[s.setup_type] || { wr: 0.50, n: 25 };
    let adjustedWr = base.wr;
    let confidence = 'MEDIUM';
    let rec = '';
    const ctx = SETUP_CONTEXT[s.setup_type];
    const reasons = [];
    const setupType = s.setup_type.toUpperCase();
    const isBreakout = setupType.includes('BREAKOUT') || setupType.includes('OPEN_DRIVE') || setupType.includes('OPEN_TEST_DRIVE') || setupType.includes('IB_BULLISH') || setupType.includes('IB_BEARISH') || setupType.includes('TRT_');
    const isMeanReversion = setupType.includes('REVERSAL') || setupType.includes('FAILED') || setupType.includes('RESPONSIVE') || setupType.includes('C_STANDALONE');

    if (ctx) {
      // 1. Monday Penalty (Statistically tested: negligible impact)
      if (setupDayOfWeek === 1 && isBreakout) {
        adjustedWr -= 0.01;
        rec = '✅ Monday Morning Breakout: standard risk profile (39.2% win rate, -0.7% deviation).';
      }
      // 2. OR5 Wide Range Penalty (Statistically tested: -7.2% impact)
      else if (currentOr5Status === 'WIDE' && isBreakout) {
        adjustedWr -= 0.07;
        rec = '⚠️ Wide Opening Range: breakout follow-through is degraded (-7.2% deviation). Standard sizing only.';
      }
      // 3. OR5 Tight Range Bonus (Statistically tested: +6.2% impact)
      else if (currentOr5Status === 'TIGHT' && isBreakout) {
        adjustedWr += 0.06;
        rec = '✅ Squeezed Opening Range: breakout follow-through edge is elevated (+6.2% deviation).';
      }
      // 4. Gap open context (Statistically tested: gap open degrades reversals by -5.9% due to trend continuation)
      else if (currentGapStatus !== 'INSIDE' && isMeanReversion) {
        adjustedWr -= 0.06;
        rec = '⚠️ Gap Open: reversal setups have degraded accuracy (-5.9% deviation) due to momentum continuation.';
      }
      else {
        if (setupDayOfWeek === 1 && ctx.monAdj !== 0) {
          adjustedWr += ctx.monAdj;
          if (ctx.monAdj <= -0.15) reasons.push(`Monday: ${(ctx.monAdj*100).toFixed(0)}% (reduce size)`);
          else if (ctx.monAdj <= -0.05) reasons.push(`Monday: mild ${(ctx.monAdj*100).toFixed(0)}% drag`);
          else if (ctx.monAdj > 0.05) reasons.push(`Monday: +${(ctx.monAdj*100).toFixed(0)}% boost for this setup`);
        }
        if (currentOr5Status === 'TIGHT' && ctx.tightAdj !== 0) {
          adjustedWr += ctx.tightAdj;
          reasons.push(`Tight OR: ${ctx.tightAdj > 0 ? '+' : ''}${(ctx.tightAdj*100).toFixed(0)}%`);
        }
        if (currentOr5Status === 'WIDE' && ctx.wideAdj !== 0) {
          adjustedWr += ctx.wideAdj;
          reasons.push(`Wide OR: ${ctx.wideAdj > 0 ? '+' : ''}${(ctx.wideAdj*100).toFixed(0)}%`);
        }
      }
    }

    // Apply dynamic overnight mined edges
    const dynamicEdges = dynamicEdgesMap[s.setup_type] || [];
    let dynamicAdj = 0;
    const dynamicReasons = [];

    for (const edge of dynamicEdges) {
      let matches = false;
      if (edge.dimension === 'DAY_OF_WEEK') {
        const dowLabels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        if (dowLabels[setupDayOfWeek] === edge.segment) matches = true;
      } else if (edge.dimension === 'TIME_OF_DAY') {
        const hr = s.hour_of_day;
        if (hr !== null && hr !== undefined) {
          if (edge.segment === 'Morning (9:30-11:30)' && hr < 11) matches = true;
          if (edge.segment === 'Midday (11:30-13:30)' && hr >= 11 && hr < 13) matches = true;
          if (edge.segment === 'Afternoon (13:30-16:00)' && hr >= 13) matches = true;
        }
      } else if (edge.dimension === 'OR_SIZE') {
        if (edge.segment === 'Tight OR' && currentOr5Status === 'TIGHT') matches = true;
        if (edge.segment === 'Normal OR' && currentOr5Status === 'NORMAL') matches = true;
        if (edge.segment === 'Wide OR' && currentOr5Status === 'WIDE') matches = true;
      } else if (edge.dimension === 'TREND_ALIGNMENT') {
        const nl = s.nl30_at_detection;
        if (nl !== null && nl !== undefined) {
          if (edge.segment === 'Bull Aligned' && nl > 9) matches = true;
          if (edge.segment === 'Bear Aligned' && nl < -9) matches = true;
          if (edge.segment === 'Ranging market' && nl >= -9 && nl <= 9) matches = true;
        }
      }

      if (matches) {
        const val = edge.deviation / 100;
        dynamicAdj += val;
        const sign = val >= 0 ? '+' : '';
        const icon = edge.status === 'POSITIVE_BOOSTER' ? '🚀' : '🛑';
        dynamicReasons.push(`${icon} Dynamic ${edge.segment} (${edge.dimension}): ${sign}${(val*100).toFixed(1)}%`);
      }
    }

    if (dynamicAdj !== 0) {
      adjustedWr += dynamicAdj;
      const dynamicStr = dynamicReasons.join(' · ');
      if (!rec || rec.includes('Standard context')) {
        rec = dynamicStr;
      } else {
        rec = rec + ' · ' + dynamicStr;
      }
    }

    adjustedWr = Math.max(0.05, Math.min(0.95, adjustedWr));
    if (!rec) rec = reasons.length > 0 ? reasons.join(' · ') : 'Standard context — no significant adjustments.';

    if (adjustedWr >= 0.58) confidence = 'HIGH';
    else if (adjustedWr >= 0.46) confidence = 'MEDIUM';
    else if (adjustedWr <= 0.38) confidence = 'AVOID';
    else confidence = 'LOW';

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

  // Confluence levels for edge display (controlled-test-validated)
  const confLevelsQ = await query(`
    SELECT trade_date::text as d, vah::float, val::float, poc::float, session_high::float as sh, session_low::float as sl
    FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 3
  `, [targetDate]).catch(() => ({ rows: [] }));
  const pd1va = confLevelsQ.rows[0] || null;
  const pd2va = confLevelsQ.rows[1] || null;
  const pd3va = confLevelsQ.rows[2] || null;

  // Prior week high/low
  const pwQ = await query(`
    SELECT MAX(session_high)::float as pwh, MIN(session_low)::float as pwl
    FROM (SELECT session_high, session_low FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 5) x
  `, [targetDate]).catch(() => ({ rows: [] }));
  const pwHigh = pwQ.rows[0]?.pwh || null;
  const pwLow = pwQ.rows[0]?.pwl || null;

  const orMid = acdToday?.or_high && acdToday?.or_low ? (acdToday.or_high + acdToday.or_low) / 2 : null;

  // Standard Floor Pivots from prior RTH session
  let floorPivots = null;
  try {
    const priorRTH = await query(`
      SELECT MAX(high)::float as h, MIN(low)::float as l,
        (array_agg(close ORDER BY ts DESC))[1]::float as c
      FROM price_bars_primary WHERE symbol='NQ'
      AND ts::date = (SELECT MAX(ts::date) FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1)
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    `, [targetDate]);
    const p = priorRTH.rows[0];
    if (p?.h && p?.l && p?.c) {
      const PP = (p.h + p.l + p.c) / 3;
      floorPivots = {
        pp: Math.round(PP * 100) / 100,
        r1: Math.round((2*PP - p.l) * 100) / 100,
        r2: Math.round((PP + (p.h - p.l)) * 100) / 100,
        r3: Math.round((p.h + 2*(PP - p.l)) * 100) / 100,
        s1: Math.round((2*PP - p.h) * 100) / 100,
        s2: Math.round((PP - (p.h - p.l)) * 100) / 100,
        s3: Math.round((p.l - 2*(p.h - PP)) * 100) / 100,
      };
    }
  } catch {}

  const pd2VA = pd2va ? { vah: pd2va.vah, val: pd2va.val } : null;

  const confluenceLevels = {
    pd1: pd1va ? { vah: pd1va.vah, val: pd1va.val, poc: pd1va.poc, high: pd1va.sh, low: pd1va.sl } : null,
    pd2: pd2va ? { vah: pd2va.vah, val: pd2va.val } : null,
    pd3: pd3va ? { vah: pd3va.vah, val: pd3va.val, poc: pd3va.poc } : null,
    pw: { high: pwHigh, low: pwLow },
    orMid,
    floorPivots,
  };

  // Overnight structural reads for edge display
  const arReads = await query(`SELECT overnight_inventory, open_vs_prior_value, prior_day_profile FROM auction_reads WHERE trade_date=$1`, [targetDate]).catch(() => ({ rows: [] }));
  const overnightContext = arReads.rows[0] || {};

  return {
    windows: resultsByWindow,
    liveStatus,
    limits: { Q1_LIMIT, Q4_LIMIT },
    setups: {
      date: setupDate,
      isFallback,
      list: processedSetups
    },
    tradeBacktest,
    pd2VA,
    confluenceLevels,
    overnightContext,
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

// GET /api/antigravity/news
router.get('/antigravity/news', async (req, res) => {
  try {
    const url = 'https://finance.yahoo.com/news/rssindex';
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (rssRes) => {
      let data = '';
      rssRes.on('data', chunk => data += chunk);
      rssRes.on('end', () => {
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(data)) !== null) {
          const content = match[1];
          const titleMatch = content.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || content.match(/<title>([\s\S]*?)<\/title>/);
          const linkMatch = content.match(/<link>([\s\S]*?)<\/link>/);
          const pubDateMatch = content.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
          const descriptionMatch = content.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || content.match(/<description>([\s\S]*?)<\/description>/);

          if (titleMatch) {
            items.push({
              title: titleMatch[1].trim(),
              link: linkMatch ? linkMatch[1].trim() : '#',
              pubDate: pubDateMatch ? pubDateMatch[1].trim() : '',
              description: descriptionMatch ? descriptionMatch[1].trim().replace(/<[^>]*>?/gm, '') : ''
            });
          }
        }
        res.json(items.slice(0, 15)); // return top 15 news items
      });
    }).on('error', (e) => {
      res.status(500).json({ error: e.message });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── LIVE EXHAUSTION DETECTOR ────────────────────────────────────────
router.get('/antigravity/exhaustion', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etMin = nowET.getHours() * 60 + nowET.getMinutes();
    const timestamp = `${String(nowET.getHours()).padStart(2,'0')}:${String(nowET.getMinutes()).padStart(2,'0')}:${String(nowET.getSeconds()).padStart(2,'0')}`;

    // Get last 15 bars
    const barsQ = await query(`
      SELECT ts, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
        open::float, high::float, low::float, close::float, volume::bigint as vol
      FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 15
    `);
    const bars = barsQ.rows.reverse();
    if (bars.length < 10) return res.json({ signals: [], timestamp });

    const currentPrice = bars[bars.length - 1].close;

    // Get levels to check
    const dvlQ = await query(`SELECT vah::float, val::float, poc::float FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [todayET]);
    const pd1 = dvlQ.rows[0] || {};

    const acdQ = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
    const acd = acdQ.rows[0] || {};
    const orMid = acd.or_high && acd.or_low ? (acd.or_high + acd.or_low) / 2 : null;

    const fpQ = await query(`SELECT MAX(high)::float as h, MIN(low)::float as l, (array_agg(close ORDER BY ts DESC))[1]::float as c FROM price_bars_primary WHERE symbol='NQ' AND ts::date = (SELECT MAX(ts::date) FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1) AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, [todayET]);
    const fp = fpQ.rows[0];
    let floorPP = null, floorS1 = null, floorR1 = null;
    if (fp?.h && fp?.l && fp?.c) {
      const pp = (fp.h + fp.l + fp.c) / 3;
      floorPP = pp; floorS1 = 2 * pp - fp.h; floorR1 = 2 * pp - fp.l;
    }

    const ibQ = await query(`SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630`, [todayET]);
    const ib = ibQ.rows[0] || {};

    const PROX = 25;
    const levels = [
      { name: 'PD-1 VAH', price: pd1.vah, role: 'resistance' },
      { name: 'PD-1 VAL', price: pd1.val, role: 'support' },
      { name: 'PD-1 POC', price: pd1.poc, role: 'magnet' },
      { name: 'OR Mid', price: orMid, role: 'pivot' },
      { name: 'Floor PP', price: floorPP, role: 'pivot' },
      { name: 'Floor S1', price: floorS1, role: 'support' },
      { name: 'Floor R1', price: floorR1, role: 'resistance' },
      { name: 'IB High', price: ib.h, role: 'resistance' },
      { name: 'IB Low', price: ib.l, role: 'support' },
    ].filter(l => l.price != null);

    const signals = [];
    const last10 = bars.slice(-10);
    const last5 = last10.slice(-5);
    const prior5 = last10.slice(0, 5);
    const lastBar = bars[bars.length - 1];
    const barRange = lastBar.high - lastBar.low;

    const avgRange5 = last5.reduce((s, b) => s + (b.high - b.low), 0) / 5;
    const avgRangePrior = prior5.reduce((s, b) => s + (b.high - b.low), 0) / 5;
    const rangeShrinking = avgRange5 < avgRangePrior * 0.6;

    // Volume analysis
    const avgVol5 = last5.reduce((s, b) => s + Number(b.vol || 0), 0) / 5;
    const avgVolPrior = prior5.reduce((s, b) => s + Number(b.vol || 0), 0) / 5;
    const volDeclining = avgVol5 < avgVolPrior * 0.6;
    const volSpiking = avgVol5 > avgVolPrior * 1.5;

    for (const level of levels) {
      const dist = Math.abs(currentPrice - level.price);
      if (dist > PROX) continue;

      const isApproachingFromBelow = currentPrice > level.price;
      const isApproachingFromAbove = currentPrice < level.price;

      const signs = [];

      if (rangeShrinking) signs.push('bar ranges shrinking (momentum fading)');

      // Wick analysis relative to level
      if (isApproachingFromBelow && barRange > 0) {
        const upperWick = (lastBar.high - Math.max(lastBar.open, lastBar.close)) / barRange;
        if (upperWick > 0.5) signs.push('long upper wick (sellers stepping in)');
        const closeNearLow = (lastBar.close - lastBar.low) / barRange < 0.3;
        if (closeNearLow) signs.push('close near low of bar (buyers couldn\'t hold)');
      }
      if (isApproachingFromAbove && barRange > 0) {
        const lowerWick = (Math.min(lastBar.open, lastBar.close) - lastBar.low) / barRange;
        if (lowerWick > 0.5) signs.push('long lower wick (buyers stepping in)');
        const closeNearHigh = (lastBar.high - lastBar.close) / barRange < 0.3;
        if (closeNearHigh) signs.push('close near high of bar (sellers couldn\'t push)');
      }

      if (volDeclining) signs.push('volume declining into the level');
      if (volSpiking && signs.length >= 1) signs.push('volume spike with no follow-through');

      // Absorption: bar clustering
      const clusterBars = last5.filter(b => {
        if (level.role === 'support') return Math.abs(b.low - level.price) < 8;
        return Math.abs(b.high - level.price) < 8;
      }).length;
      if (clusterBars >= 3) signs.push(`${clusterBars} bars clustering at level (absorption)`);

      // FLIPPED LOGIC: 0 signs = level defended (62% fade WR, N=170)
      // More signs = level weakening (34% fade WR = 66% breakout, N=119)
      const type = signs.length === 0 ? 'DEFENDED' : signs.length >= 2 ? 'WEAKENING' : 'CAUTION';

      const direction = signs.length === 0
        ? (level.role === 'resistance' ? 'FADE SHORT (62% WR)' : level.role === 'support' ? 'FADE LONG (62% WR)' : 'FADE (62% WR)')
        : (level.role === 'resistance' ? 'BREAKOUT LIKELY — do NOT fade' : level.role === 'support' ? 'BREAKDOWN LIKELY — do NOT buy' : 'BREAKOUT LIKELY');

      signals.push({
        type,
        level: level.name,
        levelPrice: Math.round(level.price),
        currentPrice: Math.round(currentPrice),
        distance: Math.round(dist),
        direction,
        signs,
        timestamp,
        barsSinceApproach: bars.filter(b => Math.abs(b.close - level.price) <= PROX).length,
      });
    }

    // Sort by severity
    signals.sort((a, b) => b.signs.length - a.signs.length);

    res.json({ signals, timestamp, price: Math.round(currentPrice), barsAnalyzed: bars.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
