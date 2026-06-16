import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

async function main() {
  console.log('=== DYNAMIC EDGE BACKTEST AGAINST YOUR ACTUAL TRADES ===');
  console.log('Connecting to database and fetching historical trades...');

  // Fetch all trades with exit times ordered by entry_time
  const tradesQ = await query(`
    SELECT id, log_date::text as trade_date, entry_time, exit_time,
           direction, quantity, entry_price::float, exit_price::float,
           pnl::float, setup_type, EXTRACT(dow FROM entry_time)::int as dow
    FROM trades
    WHERE pnl IS NOT NULL AND exit_time IS NOT NULL
    ORDER BY entry_time ASC
  `);

  console.log(`Fetched ${tradesQ.rows.length} total closed trades.`);

  // Group trades by trade_date
  const sessions = {};
  for (const t of tradesQ.rows) {
    if (!sessions[t.trade_date]) sessions[t.trade_date] = [];
    sessions[t.trade_date].push(t);
  }

  const sortedDates = Object.keys(sessions).sort();
  console.log(`Total trading days: ${sortedDates.length}\n`);

  // Run backtests across lookback windows: 30, 60, 90, and All-Time
  const windows = [30, 60, 90, sortedDates.length];

  for (const w of windows) {
    const datesSubset = sortedDates.slice(-w);
    const label = w === sortedDates.length ? `ALL-TIME (${w} days)` : `LAST ${w} DAYS`;
    
    let baselinePnl = 0;
    
    // Rule 1: Monday Breakout Restriction
    let rule1Pnl = 0;
    let rule1TradesBlocked = 0;
    
    // Rule 2: Size Deceleration (scale down size by 50% when session P&L < -$400)
    let rule2Pnl = 0;
    let rule2TradesModified = 0;
    
    // Rule 3: Daily Cushion Trailing Stop (lock in profits once up)
    let rule3Pnl = 0;
    let rule3DaysStoppedEarly = 0;

    // Combined Rules (All three active)
    let combinedPnl = 0;

    for (const date of datesSubset) {
      const dayTrades = sessions[date].sort((a, b) => new Date(a.entry_time) - new Date(b.entry_time));
      const dayOfWeek = dayTrades[0].dow; // 1 = Monday...
      
      let dayBaselinePnl = 0;
      let dayRule1Pnl = 0;
      let dayRule2Pnl = 0;
      let dayRule3Pnl = 0;
      let dayCombinedPnl = 0;

      // Track running P&Ls for the session
      let runningBaselinePnl = 0;
      let runningRule2Pnl = 0;
      let runningCombinedPnl = 0;
      
      let rule3Triggered = false;
      let rule3CappedPnl = 0;
      
      let combinedTriggered = false;
      let combinedCappedPnl = 0;

      // Track running peak profit for Rule 3 and Combined
      let peakBaselineProfit = 0;
      let peakCombinedProfit = 0;

      for (const t of dayTrades) {
        dayBaselinePnl += t.pnl;
        runningBaselinePnl += t.pnl;
        if (runningBaselinePnl > peakBaselineProfit) peakBaselineProfit = runningBaselinePnl;

        // --- RULE 1: Monday Breakout Block ---
        // Block breakouts on Monday (Day of week = 1)
        const isMondayBreakout = dayOfWeek === 1 && (
          t.setup_type?.toUpperCase().includes('BREAKOUT') ||
          t.setup_type?.toUpperCase().includes('IB_BULLISH') ||
          t.setup_type?.toUpperCase().includes('IB_BEARISH') ||
          t.setup_type?.toUpperCase().includes('C_STANDALONE') ||
          new Date(t.entry_time).getHours() < 11 // pre-11 AM on Mondays
        );

        if (isMondayBreakout) {
          rule1TradesBlocked++;
          // Trade is blocked: 0 P&L added to Rule 1
        } else {
          dayRule1Pnl += t.pnl;
        }

        // --- RULE 2: Size Deceleration ---
        // If running session P&L is < -$400, cut quantity (and P&L) in half
        if (runningRule2Pnl < -400) {
          dayRule2Pnl += (t.pnl * 0.5);
          runningRule2Pnl += (t.pnl * 0.5);
          rule2TradesModified++;
        } else {
          dayRule2Pnl += t.pnl;
          runningRule2Pnl += t.pnl;
        }

        // --- RULE 3: Daily Cushion Lock ---
        // Trailing lock:
        // - Reach +$500 peak: hard stop at +$250
        // - Reach +$800 peak: hard stop at +$500
        if (!rule3Triggered) {
          dayRule3Pnl += t.pnl;
          const currentDayRule3Running = dayRule3Pnl;
          
          // Update peak
          let tempPeak = Math.max(0, currentDayRule3Running);
          
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

        // --- COMBINED RULES (All three active) ---
        if (!combinedTriggered) {
          // Check if trade is blocked by Rule 1 (Monday breakout)
          if (isMondayBreakout) {
            // Blocked, do nothing
          } else {
            // Apply Rule 2 (size deceleration if running P&L < -400)
            let tradePnl = t.pnl;
            if (runningCombinedPnl < -400) {
              tradePnl = t.pnl * 0.5;
            }

            dayCombinedPnl += tradePnl;
            runningCombinedPnl += tradePnl;

            // Track peak for Rule 3 inside combined
            if (runningCombinedPnl > peakCombinedProfit) {
              peakCombinedProfit = runningCombinedPnl;
            }

            // Apply Rule 3 trailing stop lock
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
}

main().catch(console.error);
