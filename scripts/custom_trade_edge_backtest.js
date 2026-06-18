import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const isFunded = (acct) => /PRO\d|DIRECT\d/.test(acct || '');

function runBacktestForDates(dates, label, sessionsByDate) {
  let baselinePnl = 0;
  let rule1Pnl = 0;
  let rule1TradesBlocked = 0;

  let rule2Pnl = 0;
  let rule2TradesModified = 0;

  let rule3Pnl = 0;
  let rule3DaysStoppedEarly = 0;

  let combinedPnl = 0;

  for (const date of dates) {
    const acctSessions = sessionsByDate[date] || [];

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
          new Date(t.entry_time).getHours() < 11
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

  console.log(`------------------------------------------------------------------------------`);
  console.log(`${label.toUpperCase()}`);
  console.log(`------------------------------------------------------------------------------`);
  console.log(`  Baseline P&L (Your Actual Results):   $${baselinePnl.toFixed(2)}`);
  console.log(`  Rule 1 (Monday Breakout Block):      $${rule1Pnl.toFixed(2)}  (Blocked ${rule1TradesBlocked} trades)  [Delta: $${(rule1Pnl - baselinePnl).toFixed(2)}]`);
  console.log(`  Rule 2 (Size Deceleration < -$400):   $${rule2Pnl.toFixed(2)}  (Modified ${rule2TradesModified} trades) [Delta: $${(rule2Pnl - baselinePnl).toFixed(2)}]`);
  console.log(`  Rule 3 (Cushion Lock Trails):        $${rule3Pnl.toFixed(2)}  (Stopped ${rule3DaysStoppedEarly} days early) [Delta: $${(rule3Pnl - baselinePnl).toFixed(2)}]`);
  console.log(`  COMBINED EDGE (All Rules Active):     $${combinedPnl.toFixed(2)}  [NET SAVINGS/GAIN: +$${(combinedPnl - baselinePnl).toFixed(2)}]`);
  console.log('');
}

async function main() {
  console.log('=== CORRECTED TRADING EDGE BACKTEST (LIVE/FUNDED ONLY, CumPL-DIFF) ===');

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
  console.log(`Loaded ${netTrades.length} total net trades.`);
  console.log(`Filtered to ${liveTrades.length} net trades on LIVE/FUNDED accounts.`);

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
  console.log(`Total live trading days with activity: ${sortedDates.length}\n`);

  // 1. Standard lookback windows
  const windows = [30, 60, 90, sortedDates.length];
  for (const w of windows) {
    const datesSubset = sortedDates.slice(-w);
    const label = w === sortedDates.length ? `LIVE ALL-TIME (${w} days)` : `LIVE LAST ${w} DAYS`;
    runBacktestForDates(datesSubset, label, sessionsByDate);
  }

  // 2. Train-Test Split (Out-of-sample validation)
  console.log('==============================================================================');
  console.log('🧪 OUT-OF-SAMPLE TRAIN/TEST VALIDATION SPLIT');
  console.log('==============================================================================');
  console.log('To address overfitting (in-sample curve fitting), we split the 53 active days:');
  console.log('  - Training / In-Sample Set (First 35 days):  Where rules were derived');
  console.log('  - Testing / Out-of-Sample Set (Last 18 days): Real forward performance check\n');

  const trainDates = sortedDates.slice(0, 35);
  const testDates = sortedDates.slice(35);

  runBacktestForDates(trainDates, 'IN-SAMPLE TRAINING SET (First 35 Active Days)', sessionsByDate);
  runBacktestForDates(testDates, 'OUT-OF-SAMPLE TEST SET (Last 18 Active Days)', sessionsByDate);
}

main().catch(console.error);
