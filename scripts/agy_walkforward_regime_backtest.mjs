import pg from 'pg';
const pool = new pg.Pool({
    user: process.env.PGUSER || 'trader',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'trading_journal',
    password: process.env.PGPASSWORD || 'trader123',
    port: process.env.PGPORT || 5432,
});

async function run() {
    const dailyRes = await pool.query(`
        SELECT date_trunc('day', ts) as day, MAX(high) as high, MIN(low) as low
        FROM price_bars_primary WHERE symbol = 'NQ'
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

    const setupRes = await pool.query(`
        SELECT setup_type, fired_at, resolved_at, actual_pnl, price_at_detection
        FROM active_setups
        WHERE actual_pnl IS NOT NULL
        AND fired_at >= '2023-06-01'
        ORDER BY fired_at ASC
    `);
    const setups = setupRes.rows;

    const splitDate = new Date('2025-01-01').getTime();
    const isSetups = setups.filter(s => s.fired_at.getTime() < splitDate);
    const oosSetups = setups.filter(s => s.fired_at.getTime() >= splitDate);

    console.log(`Training In-Sample (IS): ${isSetups.length} setups`);
    console.log(`Testing Out-Of-Sample (OOS): ${oosSetups.length} setups`);

    // 1. Build IS EV Matrix
    const stats = {};
    for (const s of isSetups) {
        if (!stats[s.setup_type]) {
            stats[s.setup_type] = { "Middle 50%": { count: 0, pnl: 0 }, "Edge": { count: 0, pnl: 0 } };
        }
        const bal = get60DayBalance(new Date(s.fired_at));
        if (!bal) continue;
        const pos = (s.price_at_detection - bal.min) / bal.range;
        let regime = "Edge";
        if (pos >= 0.25 && pos <= 0.75) regime = "Middle 50%";
        stats[s.setup_type][regime].count++;
        stats[s.setup_type][regime].pnl += (Number(s.actual_pnl) * 2);
    }

    const evMap = {};
    for (const [setup, data] of Object.entries(stats)) {
        evMap[setup] = {};
        for (const regime of ["Middle 50%", "Edge"]) {
            if (data[regime].count >= 10) {
                evMap[setup][regime] = data[regime].pnl / data[regime].count;
            }
        }
    }

    // 2. Run OOS Simulator
    const setupsByTime = {};
    for (const s of oosSetups) {
        const ts = s.fired_at.getTime();
        if (!setupsByTime[ts]) setupsByTime[ts] = [];
        setupsByTime[ts].push(s);
    }
    const timestamps = Object.keys(setupsByTime).sort((a,b) => a - b);

    let currentPositionEnd = null;
    let simTrades = 0;
    let simPnl = 0;
    let peakPnl = 0;
    let maxDrawdown = 0;
    let equityCurve = 0;

    for (const ts of timestamps) {
        const timeNum = Number(ts);
        if (currentPositionEnd && timeNum < currentPositionEnd) continue;

        const concurrent = setupsByTime[ts];
        const bal = get60DayBalance(new Date(timeNum));
        if (!bal) continue;
        const pos = (concurrent[0].price_at_detection - bal.min) / bal.range;
        let regime = "Edge";
        if (pos >= 0.25 && pos <= 0.75) regime = "Middle 50%";

        let bestSetup = null;
        let highestEV = 0;

        for (const s of concurrent) {
            if (s.setup_type.includes('DAILY_OPEN')) continue; // Exclude lookahead
            if (evMap[s.setup_type] && evMap[s.setup_type][regime]) {
                const ev = evMap[s.setup_type][regime];
                if (ev > highestEV) {
                    highestEV = ev;
                    bestSetup = s;
                }
            }
        }

        if (bestSetup) {
            simTrades++;
            const pnlMNQ = Number(bestSetup.actual_pnl) * 2;
            simPnl += pnlMNQ;
            equityCurve += pnlMNQ;
            
            if (equityCurve > peakPnl) peakPnl = equityCurve;
            const drawdown = peakPnl - equityCurve;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
            if (bestSetup.resolved_at) {
                currentPositionEnd = new Date(bestSetup.resolved_at).getTime();
            }
        }
    }

    console.log(`\n--- OUT-OF-SAMPLE (OOS) PORTFOLIO BACKTEST (2025-Present) ---`);
    console.log(`Total Trades Executed: ${simTrades}`);
    console.log(`Total PnL (MNQ): $${simPnl.toFixed(2)}`);
    console.log(`Max Drawdown (MNQ): -$${maxDrawdown.toFixed(2)}`);
    if (maxDrawdown > 0) {
        console.log(`Return-to-Drawdown Ratio: ${(simPnl / maxDrawdown).toFixed(2)}x`);
    }
    
    pool.end();
}
run().catch(console.error);
