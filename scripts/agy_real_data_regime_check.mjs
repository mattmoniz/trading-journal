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
        SELECT setup_type, fired_at, actual_pnl, price_at_detection
        FROM active_setups
        WHERE actual_pnl IS NOT NULL
        AND origin_status IN ('ACTIVE', 'SHADOW')
        ORDER BY fired_at ASC
    `);
    const realSetups = setupRes.rows;
    console.log(`Found ${realSetups.length} total real forward-resolved trades.`);

    const stats = {};
    for (const s of realSetups) {
        if (!stats[s.setup_type]) {
            stats[s.setup_type] = { "Middle 50%": { count: 0, pnl: 0 }, "Edge": { count: 0, pnl: 0 } };
        }
        const bal = get60DayBalance(new Date(s.fired_at));
        if (!bal) continue;
        const pos = (s.price_at_detection - bal.min) / bal.range;
        let regime = "Edge";
        if (pos >= 0.25 && pos <= 0.75) regime = "Middle 50%";
        stats[s.setup_type][regime].count++;
        stats[s.setup_type][regime].pnl += (Number(s.actual_pnl) * 2); // MNQ $2/pt
    }

    console.log(`\n--- TASK 2: IB_BEARISH REAL-DATA REGIME SPLIT ---`);
    if (stats['IB_BEARISH']) {
        const m = stats['IB_BEARISH']['Middle 50%'];
        const e = stats['IB_BEARISH']['Edge'];
        console.log(`Middle 50%: N=${m.count}, EV=$${m.count > 0 ? (m.pnl/m.count).toFixed(2) : '0.00'}`);
        console.log(`Edge:      N=${e.count}, EV=$${e.count > 0 ? (e.pnl/e.count).toFixed(2) : '0.00'}`);
    } else {
        console.log(`No real IB_BEARISH trades found!`);
    }

    console.log(`\n--- TASK 3: REAL-N CENSUS BY REGIME (N >= 10 in either bucket) ---`);
    for (const [setup, data] of Object.entries(stats)) {
        const m = data['Middle 50%'];
        const e = data['Edge'];
        if (m.count >= 10 || e.count >= 10) {
            console.log(`${setup}:`);
            console.log(`  Middle 50% -> N=${m.count}, EV=$${m.count > 0 ? (m.pnl/m.count).toFixed(2) : '0.00'}`);
            console.log(`  Edge       -> N=${e.count}, EV=$${e.count > 0 ? (e.pnl/e.count).toFixed(2) : '0.00'}`);
        }
    }
    
    pool.end();
}
run().catch(console.error);
