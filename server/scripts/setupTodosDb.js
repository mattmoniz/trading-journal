import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

const TODO_ITEMS = [
  // Category A
  { category: 'A: Real-Time Risk & Execution Guardrails', priority: 1, title: 'DTC Gateway Pre-Trade Sizing Rules', impact: '30% - 35% reduction in maximum daily drawdown', description: 'Connect the server to Sierra Chart\'s DTC port and block or reduce order sizes by 50% automatically if the daily loss limit or drawdown threshold is crossed.' },
  { category: 'A: Real-Time Risk & Execution Guardrails', priority: 2, title: 'Automated Position Flattening on Up-and-Done', impact: '25% reduction in session profit give-back rates', description: 'Send an active webhook command to Sierra Chart to instantly flatten all open positions and cancel working orders once your daily "Up & Done" profit targets are met.' },
  { category: 'A: Real-Time Risk & Execution Guardrails', priority: 3, title: 'Pre-Session Walkthrough Gate', impact: '15% reduction in "unforced error" emotional trades', description: 'Block all trade ingestion from Sierra Chart until the user has checked off the morning brief and pre-market walkthrough checklist on the frontend.' },
  { category: 'A: Real-Time Risk & Execution Guardrails', priority: 4, title: 'Strict Size Deceleration Gate', impact: '20% reduction in average losing session size', description: 'Programmatically restrict maximum contract sizes inside your dashboard when running P&L is in a drawdown ($<-400).' },
  { category: 'A: Real-Time Risk & Execution Guardrails', priority: 5, title: 'Forced Post-Loss Cooling Lockout', impact: '15% reduction in revenge-trading sequences', description: 'Implement a hard lockout page on the dashboard for 15 minutes following a daily loss limit breach to prevent emotional revenge-trading.' },
  { category: 'A: Real-Time Risk & Execution Guardrails', priority: 6, title: 'Dynamic Cushion Trails', impact: '12% increase in net retained weekly profit', description: 'Calculate a trailing profit-protection stop-loss based on peak daily open equity, locking in 75% of gains once daily P&L exceeds +800.' },
  { category: 'A: Real-Time Risk & Execution Guardrails', priority: 7, title: 'Rules Violation Logging Table', impact: '10% improvement in rules compliance discipline', description: 'Create a rule_violations database table to track when trades were executed outside of standard hours, with incorrect sizing, or against the ACD number line.' },
  { category: 'A: Real-Time Risk & Execution Guardrails', priority: 8, title: 'Premarket Range Block', impact: '8% reduction in slippage costs on opening drives', description: 'Enforce a rule that prevents any new trade entries in the first 5 minutes of RTH (9:30–9:35 AM ET) to avoid high-spread slippage.' },
  { category: 'A: Real-Time Risk & Execution Guardrails', priority: 9, title: 'Max Open Loss Alert', impact: '5% improvement in stop-loss enforcement speed', description: 'Scan active trades and trigger browser notification alerts when open paper losses exceed daily limits.' },
  { category: 'A: Real-Time Risk & Execution Guardrails', priority: 10, title: 'Rest-of-Day Shutdown Trigger', impact: '5% reduction in afternoon overtrading losses', description: 'Automatically shut down node process watchers after 12:00 PM ET on Mondays, since Monday afternoons are statistically dead ranges.' },

  // Category B
  { category: 'B: Real-Time Setup & Analysis Edges', priority: 11, title: 'Premarket High/Low Rejection/Acceptance Tracker', impact: '20% improvement in morning bias assessment accuracy', description: 'Add a widget that measures whether opening drives above the premarket high fail (rejection) or hold (acceptance) to guide morning biases.' },
  { category: 'B: Real-Time Setup & Analysis Edges', priority: 12, title: 'Rolling Volatility-Regime Indicator', impact: '15% increase in playbook compliance', description: 'Highlight the z-score of morning volatility directly in your header to remind you what trading playbook is active.' },
  { category: 'B: Real-Time Setup & Analysis Edges', priority: 13, title: 'Intraday Volume-Climax Reversal Alerts', impact: '12% increase in counter-trend reversal trade accuracy', description: 'Alert the trader on the dashboard when a 1-minute volume bar exceeds 4x of the trailing 20-bar average, signaling potential exhaustion.' },
  { category: 'B: Real-Time Setup & Analysis Edges', priority: 14, title: 'VWAP Deviation Bands Indicator', impact: '10% reduction in chasing overextended markets', description: 'Calculate and display price deviation from VWAP (in standard deviations) to warn you when NQ is overextended.' },
  { category: 'B: Real-Time Setup & Analysis Edges', priority: 15, title: 'Prior Week Range Proximity Alert', impact: '8% improvement in locating major weekly turning zones', description: 'Highlight when NQ enters the "weekly edges" (within 10 points of the prior week High/Low) where institutional reactions occur.' },
  { category: 'B: Real-Time Setup & Analysis Edges', priority: 16, title: 'Dynamic Stop-Loss ATR Recommendations', impact: '8% reduction in sizing errors on high-volatility days', description: 'Display a recommended trade sizing and point-stop value next to every setup based on the current 10-day ATR.' },
  { category: 'B: Real-Time Setup & Analysis Edges', priority: 17, title: 'Integrate Drawdown & Stop-Outs in Confluence Backtests', impact: '35% - 40% improvement in backtest accuracy', description: 'Modify combo_backtest.js to simulate minute-by-minute price movement after a level touch instead of assuming a buy-and-hold to the close. If an ATR-based stop is hit first, log it as a loss to eliminate holding bias.' },
  { category: 'B: Real-Time Setup & Analysis Edges', priority: 18, title: 'Implement Out-of-Sample (OOS) Data Splitting', impact: '25% reduction in parameter curve-fitting/overfitting errors', description: 'Enforce a 70/30 data split in the Scenario Tester/Parameter Optimizer to ensure parameters remain robust on unseen data.' },
  { category: 'B: Real-Time Setup & Analysis Edges', priority: 19, title: 'Add Walk-Forward Optimization (WFO)', impact: '20% increase in long-term parameter robustness', description: 'Automate rolling backtest windows (optimize on 3 months, test on the next 1 month) to see if parameters adapt to shifting market regimes.' },
  { category: 'B: Real-Time Setup & Analysis Edges', priority: 20, title: 'Lessons Learned Tag Cloud', impact: '18% improvement in identifying pattern errors', description: 'Aggregate notes and mistakes columns, running a word-frequency count to highlight your most expensive psychological behaviors.' },

  // Category C
  { category: 'C: Database & Ingestion Optimization', priority: 21, title: 'Eliminate Type Casting in WHERE Clauses (Seq Scan Fix)', impact: '85% - 90% reduction in database query response times', description: 'Rewrite SQL queries containing ts::date = $1 to explicit range searches (ts >= $1 AND ts < $2) to utilize indexes.' },
  { category: 'C: Database & Ingestion Optimization', priority: 22, title: 'Add Derived Index Columns to price_bars', impact: '75% reduction in RTH 1-minute historical slice queries', description: 'Add trade_date (DATE) and et_min (INT) columns to price_bars during ingestion and index them to speed up RTH session queries.' },
  { category: 'C: Database & Ingestion Optimization', priority: 23, title: 'Enforce Database-Level Unique Constraints', impact: '60% reduction in query duplication bugs', description: 'Add a composite unique index (symbol, ts) on price_bars to prevent duplicate bar insertion on watcher recycles.' },
  { category: 'C: Database & Ingestion Optimization', priority: 24, title: 'Implement File Stability Checks in Ingestion Service', impact: '50% reduction in partial/corrupt bar record imports', description: 'Ensure chokidar doesn\'t read half-written text files by verifying the file size has not changed for at least 1 second.' },
  { category: 'C: Database & Ingestion Optimization', priority: 25, title: 'Database Connection Pool Recycling', impact: '30% reduction in active server DB connection hangs', description: 'Implement connection recycling and error listeners on the pg Pool to prevent database connection timeouts on long sessions.' },
  { category: 'C: Database & Ingestion Optimization', priority: 26, title: 'Index setup_daytype_winrates on (setup_type, day_type)', impact: '25% reduction in page load latency for setup views', description: 'Speed up dashboard load times by indexing lookups on setup win rate baselines.' },
  { category: 'C: Database & Ingestion Optimization', priority: 27, title: 'Auto-Clean Old Sierra Log Files', impact: '20% reduction in disk storage space footprint', description: 'Add a script that archives or deletes imported Sierra text logs older than 30 days to save server disk space.' },
  { category: 'C: Database & Ingestion Optimization', priority: 28, title: 'Create a process_log Cleanup Cron', impact: '15% reduction in overall system log table bloat', description: 'Automatically prune success logs older than 90 days to keep database footprint lean.' },
  { category: 'C: Database & Ingestion Optimization', priority: 29, title: 'Denormalize Trade Metrics on Write', impact: '10% improvement in trade summary statistics load times', description: 'Pre-calculate profit-to-drawdown and risk-reward ratios when writing to trades rather than calculating them on the fly.' },
  { category: 'C: Database & Ingestion Optimization', priority: 30, title: 'Use PostgreSQL Partitioning for price_bars', impact: '10% future-proof index search velocity', description: 'Partition the price_bars table by year/month to keep queries fast as history grows beyond 1,000,000 bars.' },

  // Category D
  { category: 'D: Frontend Architecture & Code Quality', priority: 31, title: 'Deconstruct the 20,000-Line App.jsx File', impact: '70% reduction in hot-reload and bundle-load times', description: 'Move all sub-views (ACD, tearsheets, calendars) into modular files under /src/pages/ and /src/components/.' },
  { category: 'D: Frontend Architecture & Code Quality', priority: 32, title: 'Introduce React Router DOM', impact: '50% improvement in UX navigation smoothness', description: 'Use structured page routes (/dashboard, /edges, /calendar) to enable browser back buttons, bookmarks, and clean URL states.' },
  { category: 'D: Frontend Architecture & Code Quality', priority: 33, title: 'Replace Inline Styles with CSS Variables & Utility Classes', impact: '40% reduction in visual CSS code redundancy', description: 'Move hardcoded colors and layout properties into a centralized theme system in src/index.css for consistent styling.' },
  { category: 'D: Frontend Architecture & Code Quality', priority: 34, title: 'Implement Global State Management (Zustand or Context)', impact: '30% reduction in React component re-rendering latency', description: 'Lift shared states (accounts, selected accounts, live session data) out of App.jsx into a lightweight store.' },
  { category: 'D: Frontend Architecture & Code Quality', priority: 35, title: 'Add Input Debouncing on Filter Panels', impact: '25% improvement in filter panel response times', description: 'Prevent the UI from lagging by debouncing search inputs and date pickers before firing SQL queries.' },
  { category: 'D: Frontend Architecture & Quality', priority: 36, title: 'Centralize Toast Notification System', impact: '20% code reduction in layout notification rendering', description: 'Replace local state arrays for notifications with a clean, standardized Toast provider.' },
  { category: 'D: Frontend Architecture & Code Quality', priority: 37, title: 'Enforce React Error Boundaries on Individual Panels', impact: '15% increase in dashboard application stability', description: 'Ensure a crash in one chart doesn\'t break the entire dashboard by wrapping individual cards in boundary gates.' },
  { category: 'D: Frontend Architecture & Code Quality', priority: 38, title: 'Create a Shared Chart Component Wrapper', impact: '15% reduction in chart-code configuration bloat', description: 'Standardize Recharts options (tooltips, grid lines, legends) into a single reusable chart container.' },
  { category: 'D: Frontend Architecture & Code Quality', priority: 39, title: 'Add a Loading State Skeleton', impact: '10% improvement in apparent app loading speeds', description: 'Show skeleton loader animations on the calendar and tearsheets during query execution instead of blank screens.' },
  { category: 'D: Frontend Architecture & Code Quality', priority: 40, title: 'Implement a Frontend Theme Toggle (Dark/Light Mode)', impact: '5% improvement in dashboard accessibility', description: 'Allow switching between a sleek dark-slate theme and a clean light-mode dashboard.' },

  // Category E
  { category: 'E: Secondary Backtest & Reporting Improvements', priority: 41, title: 'Incorporate Slippage & Commissions in Backtest Results', impact: '15% correction in net profit expectations', description: 'Add a standard 1.0-tick slippage and exchange commission ($2.46/side per NQ contract) to all backtests to reflect real trading execution costs.' },
  { category: 'E: Secondary Backtest & Reporting Improvements', priority: 42, title: 'Dynamic Stop-Loss ATR Recommendations (Reporting)', impact: '8% reduction in sizing errors on high-volatility days', description: 'Display a recommended trade sizing and point-stop value next to every setup based on the current 10-day ATR.' },
  { category: 'E: Secondary Backtest & Reporting Improvements', priority: 43, title: 'Volatility-Adjusted Stop and Target Rules', impact: '12% increase in average trade trade profit factors', description: 'Replace hardcoded profit targets and stop-losses on the setup cards with dynamic targets based on 10-day ATR.' },
  { category: 'E: Secondary Backtest & Reporting Improvements', priority: 44, title: 'Dynamic Parameter Optimizer for Level Touches', impact: '10% increase in selected entry point edge', description: 'Add optimization loops that test varying proximity thresholds (from 5 to 30 points) to determine the mathematical sweet spot of "stacked" levels.' },
  { category: 'E: Secondary Backtest & Reporting Improvements', priority: 45, title: 'Day-of-Week Win Rate Heatmap', impact: '10% reduction in choosing low-probability trade days', description: 'Replace simple tables with a grid calendar showing which days of the week are historically profitable for each setup.' },
  { category: 'E: Secondary Backtest & Reporting Improvements', priority: 46, title: 'Automated Backtest Seeding on Server Startup', impact: '10% reduction in manual data-maintenance time', description: 'Run backfill/backtest scripts automatically in the background if the database has new days of price bars since the last run.' },
  { category: 'E: Secondary Backtest & Reporting Improvements', priority: 47, title: 'Multi-Asset Backtest Support (ES/RTY)', impact: '8% expansion in overall trading opportunities', description: 'Abstract all setup and backtest scripts to run on symbols other than NQ by passing tick sizes, multipliers, and trading hours dynamically.' },
  { category: 'E: Secondary Backtest & Reporting Improvements', priority: 48, title: 'Trade Timeline Event Reconstruction', impact: '5% improvement in setup-confluence debugging', description: 'In the backtester, reconstruct the chronological order of level touches, daily score changes, and setup fires to build a trade timeline.' },
  { category: 'E: Secondary Backtest & Reporting Improvements', priority: 49, title: 'P&L Drawdown Duration Curve', impact: '5% improvement in equity curve drawdown management', description: 'Plot a chart showing how long your account stays in drawdowns, helping you optimize your risk-recovery phases.' },
  { category: 'E: Secondary Backtest & Reporting Improvements', priority: 50, title: 'Account Comparison Statistics', impact: '5% increase in trade execution discipline under pressure', description: 'Compare Sim vs. Live account metrics side-by-side to highlight behavioral gaps and execution slippage under financial pressure.' },
];

async function run() {
  console.log('Starting settings_todos table setup...');
  try {
    // 1. Create table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings_todos (
        id SERIAL PRIMARY KEY,
        category VARCHAR(100) NOT NULL,
        priority INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        impact VARCHAR(255),
        description TEXT,
        completed BOOLEAN DEFAULT FALSE,
        is_custom BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ settings_todos table created or verified.');

    // 2. Check if empty
    const countRes = await pool.query('SELECT COUNT(*) as count FROM settings_todos');
    const count = parseInt(countRes.rows[0].count);

    if (count === 0) {
      console.log('Seeding initial 50 improvements...');
      for (const item of TODO_ITEMS) {
        await pool.query(
          `INSERT INTO settings_todos (category, priority, title, impact, description, completed, is_custom)
           VALUES ($1, $2, $3, $4, $5, false, false)`,
          [item.category, item.priority, item.title, item.impact, item.description]
        );
      }
      console.log('✅ Seeded 50 items successfully.');
    } else {
      console.log(`Table already contains ${count} items. Skipping seed to preserve user modifications.`);
    }

  } catch (err) {
    console.error('❌ Error during setup:', err);
  } finally {
    await pool.end();
  }
}

run();
