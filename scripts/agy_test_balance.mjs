import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
    user: process.env.PGUSER || 'trader',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'trading_journal',
    password: process.env.PGPASSWORD || 'trader123',
    port: process.env.PGPORT || 5432,
});

function calculateEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    const emas = [ema];
    for (let i = 1; i < prices.length; i++) {
        ema = (prices[i] - ema) * k + ema;
        emas.push(ema);
    }
    return emas;
}

async function run() {
    const dailyRes = await pool.query(`
        SELECT date_trunc('day', ts) as day, MAX(high) as high, MIN(low) as low
        FROM price_bars_primary
        GROUP BY 1 ORDER BY 1 ASC
    `);
    const dailyBars = dailyRes.rows;

    function getBalanceAreas(d) {
        const prevBars = dailyBars.filter(b => new Date(b.day) < d);
        const results = {};
        const lookbacks = [20, 30, 45, 60, 90, 180];
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

    const res = await pool.query(`
        SELECT ts, open::float, high::float, low::float, close::float
        FROM price_bars_primary
        ORDER BY ts ASC
    `);
    const bars1m = res.rows;
    const bars5m = [];
    let current5m = null;

    for (const b of bars1m) {
        const d = new Date(b.ts);
        const coeff = 1000 * 60 * 5;
        const rounded = new Date(Math.floor(d.getTime() / coeff) * coeff);
        if (!current5m) {
            current5m = { ts: rounded, open: b.open, high: b.high, low: b.low, close: b.close };
        } else if (rounded.getTime() === current5m.ts.getTime()) {
            current5m.high = Math.max(current5m.high, b.high);
            current5m.low = Math.min(current5m.low, b.low);
            current5m.close = b.close;
        } else {
            bars5m.push(current5m);
            current5m = { ts: rounded, open: b.open, high: b.high, low: b.low, close: b.close };
        }
    }
    if (current5m) bars5m.push(current5m);

    const closes = bars5m.map(b => b.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);

    const trades = [];
    for (let i = 21; i < bars5m.length; i++) {
        const b = bars5m[i];
        const dt = new Date(b.ts);
        const etHour = (dt.getUTCHours() - 4 + 24) % 24;
        if (etHour !== 2 && etHour !== 3 && etHour !== 4 && etHour !== 7) continue;

        const crossUp = ema9[i-1] <= ema21[i-1] && ema9[i] > ema21[i];
        const crossDown = ema9[i-1] >= ema21[i-1] && ema9[i] < ema21[i];

        if (crossUp) trades.push({ type: 'LONG', entryIndex: i, entryPrice: b.close, ts: b.ts });
        else if (crossDown) trades.push({ type: 'SHORT', entryIndex: i, entryPrice: b.close, ts: b.ts });
    }

    const lookbacks = [20, 30, 45, 60, 90, 180];
    const allStats = {};
    for (const L of lookbacks) {
        allStats[L] = {
            "In Balance (Middle 50%)": { count: 0, pnl: 0 },
            "On the Edge (Top/Bottom 25%)": { count: 0, pnl: 0 },
            "Outside": { count: 0, pnl: 0 },
            "Unknown": { count: 0, pnl: 0 }
        };
    }

    for (const t of trades) {
        const isLong = t.type === 'LONG';
        let pnl = 0;
        for (let i = t.entryIndex + 1; i < bars5m.length; i++) {
            const b = bars5m[i];
            const gap = b.ts.getTime() - bars5m[i-1].ts.getTime();
            const isEod = gap > 45 * 60 * 1000;
            const crossUp = ema9[i-1] <= ema21[i-1] && ema9[i] > ema21[i];
            const crossDown = ema9[i-1] >= ema21[i-1] && ema9[i] < ema21[i];
            const reverseCross = (isLong && crossDown) || (!isLong && crossUp);

            if (isEod) { pnl = isLong ? bars5m[i-1].close - t.entryPrice : t.entryPrice - bars5m[i-1].close; break; }
            if (isLong && b.low <= t.entryPrice - 60) { pnl = -60; break; }
            else if (!isLong && b.high >= t.entryPrice + 60) { pnl = -60; break; }
            if (reverseCross) { pnl = isLong ? b.close - t.entryPrice : t.entryPrice - b.close; break; }
        }
        t.pnl = pnl;
        
        const balances = getBalanceAreas(new Date(t.ts));
        for (const L of lookbacks) {
            const bal = balances[L];
            let regime = "Unknown";
            if (bal) {
                const pos = (t.entryPrice - bal.min) / bal.range;
                if (pos >= 0.25 && pos <= 0.75) regime = "In Balance (Middle 50%)";
                else if (pos > 1.0 || pos < 0.0) regime = "Outside";
                else regime = "On the Edge (Top/Bottom 25%)";
            }
            allStats[L][regime].count++;
            allStats[L][regime].pnl += (t.pnl * 2);
        }
    }

    for (const L of lookbacks) {
        console.log(`\n--- ${L}-DAY BALANCE AREA ---`);
        for (const [regime, data] of Object.entries(allStats[L])) {
            if (data.count > 0) {
                console.log(`${regime.padEnd(30)} | Trades: ${data.count.toString().padEnd(4)} | PnL: $${data.pnl.toFixed(2)}`);
            }
        }
    }
    
    console.log("\n--- COMBINED MATRIX FILTER (ALL TIME) ---");
    let matrixPnl = 0;
    let matrixCount = 0;
    
    let currentEquityPts = 0;
    let maxEquityPts = 0;
    let maxDrawdownPts = 0;

    for (const t of trades) {
        const balances = getBalanceAreas(new Date(t.ts));
        if (balances[20] && balances[60]) {
            const pos20 = (t.entryPrice - balances[20].min) / balances[20].range;
            const pos60 = (t.entryPrice - balances[60].min) / balances[60].range;
            
            const middle20 = (pos20 >= 0.25 && pos20 <= 0.75);
            const edge60 = (pos60 < 0.25 || pos60 > 0.75);
            
            if (middle20 && edge60) {
                matrixCount++;
                matrixPnl += (t.pnl * 2);
                
                currentEquityPts += t.pnl;
                if (currentEquityPts > maxEquityPts) {
                    maxEquityPts = currentEquityPts;
                }
                const currentDrawdownPts = maxEquityPts - currentEquityPts;
                if (currentDrawdownPts > maxDrawdownPts) {
                    maxDrawdownPts = currentDrawdownPts;
                }
            }
        }
    }
    console.log(`Trades: ${matrixCount} | Matrix PnL (MNQ): $${matrixPnl.toFixed(2)}`);
    console.log(`Max Drawdown (Points): ${maxDrawdownPts.toFixed(2)}`);
    console.log(`Max Drawdown (NQ): $${(maxDrawdownPts * 20).toFixed(2)}`);
    console.log(`Max Drawdown (MNQ): $${(maxDrawdownPts * 2).toFixed(2)}`);
    
    pool.end();
}
run().catch(console.error);
