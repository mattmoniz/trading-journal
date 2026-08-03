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

    const setupRes = await pool.query(`
        SELECT setup_type, fired_at, price_at_detection, actual_pnl, touch_quality_vol_z, hivol_lopace_at_detection
        FROM active_setups 
        WHERE (setup_type LIKE '%BREAKOUT%' OR setup_type LIKE '%DRIVE%' OR setup_type LIKE '%CONTINUATION%')
        AND actual_pnl IS NOT NULL
        AND fired_at >= '2023-06-01'
    `);
    const setups = setupRes.rows;

    const stats = {};

    for (const s of setups) {
        if (!stats[s.setup_type]) {
            stats[s.setup_type] = {
                "Middle 50%": { "High Vol": { count: 0, pnl: 0 }, "Low Vol": { count: 0, pnl: 0 } },
                "Edge (Top/Bottom 25%)": { "High Vol": { count: 0, pnl: 0 }, "Low Vol": { count: 0, pnl: 0 } }
            };
        }

        const bal = get60DayBalance(new Date(s.fired_at));
        if (bal) {
            const pos = (s.price_at_detection - bal.min) / bal.range;
            let regime = "Edge (Top/Bottom 25%)";
            if (pos >= 0.25 && pos <= 0.75) regime = "Middle 50%";
            
            // Volatility/Volume proxy
            let volRegime = "Low Vol";
            if (s.touch_quality_vol_z > 1.0 || s.hivol_lopace_at_detection) {
                volRegime = "High Vol";
            }

            stats[s.setup_type][regime][volRegime].count++;
            stats[s.setup_type][regime][volRegime].pnl += (Number(s.actual_pnl) * 20);
        }
    }

    console.log("\n--- BREAKOUTS & VOLATILITY vs 60-DAY REGIME ---");
    for (const [level, data] of Object.entries(stats)) {
        let totalCount = data["Middle 50%"]["High Vol"].count + data["Middle 50%"]["Low Vol"].count + 
                         data["Edge (Top/Bottom 25%)"]["High Vol"].count + data["Edge (Top/Bottom 25%)"]["Low Vol"].count;
        
        if (totalCount > 30) {
            console.log(`\nSetup: ${level}`);
            for (const regime of ["Middle 50%", "Edge (Top/Bottom 25%)"]) {
                for (const vol of ["High Vol", "Low Vol"]) {
                    const c = data[regime][vol].count;
                    const p = data[regime][vol].pnl;
                    if (c > 0) {
                        console.log(`  ${regime.padEnd(25)} | ${vol.padEnd(10)} | Trades: ${c.toString().padEnd(3)} | PnL: $${p.toFixed(2)}`);
                    }
                }
            }
        }
    }

    pool.end();
}
run().catch(console.error);
