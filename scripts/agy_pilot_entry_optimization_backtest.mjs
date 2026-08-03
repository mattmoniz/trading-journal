import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
    user: process.env.PGUSER || 'trader',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'trading_journal',
    password: process.env.PGPASSWORD || 'trader123',
    port: process.env.PGPORT || 5432,
});

async function run() {
    console.log("Starting 1-Year Entry Optimization Backtest...");
    
    // 1. Fetch FADE setups
    const setupQuery = `
        SELECT id, setup_type, trade_date, fired_at
        FROM active_setups
        WHERE trade_date >= CURRENT_DATE - INTERVAL '1 year'
        AND origin_status IN ('BACKFILL', 'ACTIVE', 'SHADOW')
        ORDER BY trade_date, fired_at
    `;
    const setupRes = await pool.query(setupQuery);
    const setups = setupRes.rows;

    const byDate = new Map();
    for (const s of setups) {
        const d = s.trade_date.toISOString().split('T')[0];
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push(s);
    }

    const trades = [];

    for (const [dateStr, dateSetups] of byDate) {
        const barQuery = `
            SELECT ts, open::float, high::float, low::float, close::float, volume, num_trades
            FROM price_bars_primary
            WHERE ts >= $1::date - INTERVAL '1 day' AND ts <= $1::date + INTERVAL '1 day'
            ORDER BY ts ASC
        `;
        const barRes = await pool.query(barQuery, [dateStr]);
        const bars = barRes.rows;
        if (bars.length === 0) continue;

        for (const setup of dateSetups) {
            const entryIndex = bars.findIndex(b => b.ts >= setup.fired_at);
            if (entryIndex < 200 || entryIndex >= bars.length - 1) continue;

            const entryBar = bars[entryIndex];
            const entryPrice = entryBar.close;
            const isLong = setup.setup_type.includes('LONG');
            const dt = new Date(setup.fired_at);
            
            // --- EXTRACT ENTRY FEATURES ---
            
            // 1. Time of Day (ET approximation)
            const utcHour = dt.getUTCHours();
            const etHour = (utcHour - 4 + 24) % 24; 
            let todCategory = 'GLOBEX';
            if (etHour >= 9 && etHour < 11) todCategory = 'MORNING_RUSH (9-11)';
            else if (etHour >= 11 && etHour < 14) todCategory = 'LUNCH_CHOP (11-14)';
            else if (etHour >= 14 && etHour < 16) todCategory = 'AFTERNOON (14-16)';
            
            // 2. Trend Alignment (200-period SMA)
            let sumClose = 0;
            for(let i = entryIndex - 200; i < entryIndex; i++) {
                sumClose += bars[i].close;
            }
            const sma200 = sumClose / 200;
            const isWithTrend = (isLong && entryPrice > sma200) || (!isLong && entryPrice < sma200);

            // 3. Volatility (14-period ATR)
            let sumTr = 0;
            for(let i = entryIndex - 14; i < entryIndex; i++) {
                const tr = Math.max(
                    bars[i].high - bars[i].low,
                    Math.abs(bars[i].high - bars[i-1].close),
                    Math.abs(bars[i].low - bars[i-1].close)
                );
                sumTr += tr;
            }
            const atr14 = sumTr / 14;
            let volCat = 'LOW_VOL (ATR < 3)';
            if (atr14 >= 5) volCat = 'HIGH_VOL (ATR > 5)';
            else if (atr14 >= 3) volCat = 'MED_VOL (ATR 3-5)';

            // --- SIMULATE 40/40 EXIT ---
            const target = isLong ? entryPrice + 40 : entryPrice - 40;
            const stop = isLong ? entryPrice - 40 : entryPrice + 40;
            let pnl = 0;
            
            for (let i = entryIndex + 1; i < bars.length; i++) {
                const b = bars[i];
                if (new Date(b.ts).getTime() - new Date(bars[i-1].ts).getTime() > 45 * 60 * 1000) {
                    pnl = isLong ? b.open - entryPrice : entryPrice - b.open;
                    break;
                }
                if (isLong) {
                    if (b.low <= stop) { pnl = -40; break; }
                    else if (b.high >= target) { pnl = 40; break; }
                } else {
                    if (b.high >= stop) { pnl = -40; break; }
                    else if (b.low <= target) { pnl = 40; break; }
                }
            }

            trades.push({ pnl, todCategory, volCat, isWithTrend });
        }
    }

    // --- AGGREGATE RESULTS ---
    function printStats(label, filterFn) {
        const filtered = trades.filter(filterFn);
        if (filtered.length === 0) return;
        let wins = 0, totalPnl = 0;
        for (const t of filtered) {
            totalPnl += t.pnl;
            if (t.pnl > 0) wins++;
        }
        const winRate = (wins / filtered.length) * 100;
        const ev = (totalPnl / filtered.length) * 2;
        console.log(`${label.padEnd(46)} | N=${filtered.length.toString().padEnd(4)} | WR: ${winRate.toFixed(1)}% | EV: $${ev.toFixed(2)}`);
    }

    console.log(`\n=================================================`);
    console.log(` ENTRY OPTIMIZATION REPORT (Baseline 40/40 Exits)`);
    console.log(`=================================================\n`);
    
    console.log(`--- BASELINE ---`);
    printStats("ALL TRADES", t => true);

    console.log(`\n--- TIME OF DAY ---`);
    printStats("MORNING_RUSH (9-11)", t => t.todCategory === 'MORNING_RUSH (9-11)');
    printStats("LUNCH_CHOP (11-14)", t => t.todCategory === 'LUNCH_CHOP (11-14)');
    printStats("AFTERNOON (14-16)", t => t.todCategory === 'AFTERNOON (14-16)');
    printStats("GLOBEX", t => t.todCategory === 'GLOBEX');

    console.log(`\n--- MACRO TREND (200 SMA) ---`);
    printStats("WITH TREND (Fading off support in uptrend)", t => t.isWithTrend === true);
    printStats("COUNTER TREND (Fading into downtrend)", t => t.isWithTrend === false);

    console.log(`\n--- VOLATILITY (14-min ATR) ---`);
    printStats("LOW VOLATILITY (ATR < 3)", t => t.volCat === 'LOW_VOL (ATR < 3)');
    printStats("MED VOLATILITY (ATR 3-5)", t => t.volCat === 'MED_VOL (ATR 3-5)');
    printStats("HIGH VOLATILITY (ATR > 5)", t => t.volCat === 'HIGH_VOL (ATR > 5)');
    
    // --- COMBINED EDGE ---
    console.log(`\n--- THE APEX FILTER (Combined Edges) ---`);
    printStats("TREND + NO LUNCH + HI VOL", t => t.isWithTrend === true && t.todCategory !== 'LUNCH_CHOP (11-14)' && t.volCat === 'HIGH_VOL (ATR > 5)');

    pool.end();
}

run().catch(console.error);
