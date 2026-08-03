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
        SELECT setup_type, fired_at, price_at_detection, actual_pnl, t1_level, stop_level
        FROM active_setups 
        WHERE actual_pnl IS NOT NULL
        AND fired_at >= '2023-06-01'
    `);
    const setups = setupRes.rows;

    const stats = {};

    for (const s of setups) {
        if (!stats[s.setup_type]) {
            stats[s.setup_type] = {
                "Middle 50%": { count: 0, pnl: 0, target_pts: 0, stop_pts: 0 },
                "Edge": { count: 0, pnl: 0, target_pts: 0, stop_pts: 0 }
            };
        }

        const bal = get60DayBalance(new Date(s.fired_at));
        if (bal) {
            const pos = (s.price_at_detection - bal.min) / bal.range;
            let regime = "Edge";
            if (pos >= 0.25 && pos <= 0.75) regime = "Middle 50%";
            
            stats[s.setup_type][regime].count++;
            stats[s.setup_type][regime].pnl += (Number(s.actual_pnl) * 2);
            
            if (s.t1_level && s.price_at_detection) {
                stats[s.setup_type][regime].target_pts += Math.abs(Number(s.t1_level) - Number(s.price_at_detection));
            }
            if (s.stop_level && s.price_at_detection) {
                stats[s.setup_type][regime].stop_pts += Math.abs(Number(s.stop_level) - Number(s.price_at_detection));
            }
        }
    }

    console.log("Setup|Regime|Trades|PnL|EV|AvgTarget|AvgStop");
    for (const [level, data] of Object.entries(stats)) {
        for (const regime of ["Middle 50%", "Edge"]) {
            const c = data[regime].count;
            if (c >= 20) { // filter out very low sample sizes
                const pnl = data[regime].pnl;
                const ev = pnl / c;
                const avgTgt = data[regime].target_pts / c;
                const avgStop = data[regime].stop_pts / c;
                console.log(`${level}|${regime}|${c}|${pnl.toFixed(2)}|${ev.toFixed(2)}|${avgTgt.toFixed(1)}|${avgStop.toFixed(1)}`);
            }
        }
    }

    pool.end();
}
run().catch(console.error);
