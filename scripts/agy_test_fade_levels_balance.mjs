import pg from 'pg';
const pool = new pg.Pool({
    user: process.env.PGUSER || 'trader',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'trading_journal',
    password: process.env.PGPASSWORD || 'trader123',
    port: process.env.PGPORT || 5432,
});

async function run() {
    console.log("Fetching daily bars for balance areas...");
    const dailyRes = await pool.query(`
        SELECT date_trunc('day', ts) as day, MAX(high) as high, MIN(low) as low
        FROM price_bars_primary
        GROUP BY 1 ORDER BY 1 ASC
    `);
    const dailyBars = dailyRes.rows;

    function getBalanceAreas(d) {
        const prevBars = dailyBars.filter(b => new Date(b.day) < d);
        const results = {};
        const lookbacks = [20, 60, 90];
        for (const L of lookbacks) {
            if (prevBars.length < L) {
                results[L] = null;
                continue;
            }
            const slice = prevBars.slice(-L);
            const maxVal = Math.max(...slice.map(b => b.high));
            const minVal = Math.min(...slice.map(b => b.low));
            results[L] = { max: maxVal, min: minVal, range: maxVal - minVal };
        }
        return results;
    }

    console.log("Fetching all FADE setups from active_setups...");
    const setupRes = await pool.query(`
        SELECT setup_type, fired_at, price_at_detection, actual_pnl
        FROM active_setups 
        WHERE setup_type LIKE '%FADE%' 
        AND actual_pnl IS NOT NULL
        AND fired_at >= '2023-06-01'
    `);
    const setups = setupRes.rows;
    console.log(`Found ${setups.length} historical FADE setups.`);

    const lookbacks = [20, 60, 90];
    const statsByLevel = {};

    for (const s of setups) {
        if (!statsByLevel[s.setup_type]) {
            statsByLevel[s.setup_type] = {};
            for (const L of lookbacks) {
                statsByLevel[s.setup_type][L] = {
                    "Middle 50%": { count: 0, pnl: 0 },
                    "Edge (Top/Bottom 25%)": { count: 0, pnl: 0 }
                };
            }
        }

        const balances = getBalanceAreas(new Date(s.fired_at));
        for (const L of lookbacks) {
            const bal = balances[L];
            if (bal) {
                const pos = (s.price_at_detection - bal.min) / bal.range;
                let regime = "Edge (Top/Bottom 25%)";
                if (pos >= 0.25 && pos <= 0.75) regime = "Middle 50%";
                
                statsByLevel[s.setup_type][L][regime].count++;
                statsByLevel[s.setup_type][L][regime].pnl += (Number(s.actual_pnl) * 20); // NQ $20/pt
            }
        }
    }

    // Find the most interesting outliers (where Edge vastly outperforms Middle, or vice versa)
    console.log("\n--- NOTABLE FADE LEVEL INTERACTIONS ---");
    for (const [level, data] of Object.entries(statsByLevel)) {
        // Just print the 60-day macro analysis for each level to keep it clean
        const middleCount = data[60]["Middle 50%"].count;
        const middlePnl = data[60]["Middle 50%"].pnl;
        const edgeCount = data[60]["Edge (Top/Bottom 25%)"].count;
        const edgePnl = data[60]["Edge (Top/Bottom 25%)"].pnl;

        // Only print levels that have enough sample size
        if (middleCount + edgeCount > 50) {
            console.log(`\nLevel: ${level}`);
            console.log(`  60-Day Middle 50%  | Trades: ${middleCount.toString().padEnd(4)} | PnL: $${middlePnl.toFixed(2)}`);
            console.log(`  60-Day Edge        | Trades: ${edgeCount.toString().padEnd(4)} | PnL: $${edgePnl.toFixed(2)}`);
        }
    }

    pool.end();
}
run().catch(console.error);
