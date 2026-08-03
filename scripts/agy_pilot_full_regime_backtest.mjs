import fs from 'fs';
import pg from 'pg';

const pool = new pg.Pool({
    user: process.env.PGUSER || 'trader',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'trading_journal',
    password: process.env.PGPASSWORD || 'trader123',
    port: process.env.PGPORT || 5432,
});

async function run() {
    console.log("Loading Regime EV Matrix from CSV...");
    const csv = fs.readFileSync('scripts/agy_setups_regime_output.csv', 'utf8');
    const lines = csv.trim().split('\n');
    const evMap = {};
    for (let i = 1; i < lines.length; i++) {
        const [setup, regime, trades, pnl, ev] = lines[i].split('|');
        if (!evMap[setup]) evMap[setup] = {};
        evMap[setup][regime] = Number(ev); // Remember, this EV was output using the $20 NQ multiplier in the csv (which got overwritten, wait no, my previous run overwrote it with $2 EV. Let's just use the raw Number(ev) for relative ranking!).
    }

    console.log("Fetching daily bars for regime calculation...");
    const dailyRes = await pool.query(`
        SELECT date_trunc('day', ts) as day, MAX(high) as high, MIN(low) as low
        FROM price_bars_primary
        GROUP BY 1 ORDER BY 1 ASC
    `);
    const dailyBars = dailyRes.rows;

    function get60DayBalance(d) {
        const prevBars = dailyBars.filter(b => new Date(b.day) < d);
        if (prevBars.length < 60) return null;
        const slice = prevBars.slice(-60);
        const maxVal = Math.max(...slice.map(b => b.high));
        const minVal = Math.min(...slice.map(b => b.low));
        return { max: maxVal, min: minVal, range: maxVal - minVal };
    }

    console.log("Loading all historical setups...");
    const setupRes = await pool.query(`
        SELECT setup_type, fired_at, resolved_at, actual_pnl, price_at_detection
        FROM active_setups
        WHERE actual_pnl IS NOT NULL
        AND fired_at >= '2023-06-01'
        ORDER BY fired_at ASC
    `);
    const setups = setupRes.rows;

    console.log(`Loaded ${setups.length} setups. Grouping by time to handle confluence...`);
    const setupsByTime = {};
    for (const s of setups) {
        const ts = s.fired_at.getTime();
        if (!setupsByTime[ts]) setupsByTime[ts] = [];
        setupsByTime[ts].push(s);
    }
    const timestamps = Object.keys(setupsByTime).sort((a,b) => a - b);

    let currentPositionEnd = null;
    let simTrades = 0;
    let simPnl = 0;
    let confluenceTies = 0;
    
    // Drawdown tracking
    let peakPnl = 0;
    let maxDrawdown = 0;
    let equityCurve = 0;

    const selectedCounts = {};

    for (const ts of timestamps) {
        const timeNum = Number(ts);
        // Single-threaded portfolio: if we are in a trade, we cannot take another one.
        if (currentPositionEnd && timeNum < currentPositionEnd) {
            continue;
        }

        const concurrent = setupsByTime[ts];
        
        const bal = get60DayBalance(new Date(timeNum));
        if (!bal) continue;
        const pos = (concurrent[0].price_at_detection - bal.min) / bal.range;
        let regime = "Edge";
        if (pos >= 0.25 && pos <= 0.75) regime = "Middle 50%";

        let bestSetup = null;
        let highestEV = 0; // Must be strictly positive EV to take the trade

        if (concurrent.length > 1) {
            confluenceTies++;
        }

        for (const s of concurrent) {
            if (evMap[s.setup_type] && evMap[s.setup_type][regime]) {
                const ev = evMap[s.setup_type][regime];
                // We only permit trades that have historical positive expectation in this regime
                if (ev > highestEV) {
                    highestEV = ev;
                    bestSetup = s;
                }
            }
        }

        if (bestSetup) {
            simTrades++;
            const pnlMNQ = Number(bestSetup.actual_pnl) * 2; // MNQ sizing
            simPnl += pnlMNQ;
            equityCurve += pnlMNQ;
            
            if (equityCurve > peakPnl) peakPnl = equityCurve;
            const drawdown = peakPnl - equityCurve;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;

            // Advance the cursor so we don't take overlapping trades
            if (bestSetup.resolved_at) {
                currentPositionEnd = new Date(bestSetup.resolved_at).getTime();
            }

            if (!selectedCounts[bestSetup.setup_type]) selectedCounts[bestSetup.setup_type] = 0;
            selectedCounts[bestSetup.setup_type]++;
        }
    }

    console.log(`\n--- FULL REGIME PORTFOLIO BACKTEST (MNQ) ---`);
    console.log(`Total Trades Executed: ${simTrades}`);
    console.log(`Times Confluence Tie-Breaker Used: ${confluenceTies}`);
    console.log(`Total PnL (MNQ): $${simPnl.toFixed(2)}`);
    console.log(`Max Drawdown (MNQ): -$${maxDrawdown.toFixed(2)}`);
    console.log(`Return-to-Drawdown Ratio: ${(simPnl / maxDrawdown).toFixed(2)}x`);
    
    console.log(`\nTop 5 Most Executed Setups in the Portfolio:`);
    const sorted = Object.entries(selectedCounts).sort((a,b) => b[1] - a[1]);
    for (let i = 0; i < Math.min(5, sorted.length); i++) {
        console.log(`${sorted[i][0].padEnd(30)} | ${sorted[i][1]} trades`);
    }

    pool.end();
}
run().catch(console.error);
