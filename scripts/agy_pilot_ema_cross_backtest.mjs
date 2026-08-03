import pg from 'pg';
import fs from 'fs';

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
    const barQuery = `
        SELECT ts, open::float, high::float, low::float, close::float
        FROM price_bars_primary
        WHERE ts >= '2025-01-01 00:00:00'
        ORDER BY ts ASC
    `;
    const res = await pool.query(barQuery);
    const bars1m = res.rows;
    if (bars1m.length === 0) return pool.end();

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
        const prev9 = ema9[i-1];
        const prev21 = ema21[i-1];
        const curr9 = ema9[i];
        const curr21 = ema21[i];

        const dt = new Date(b.ts);
        const etHour = (dt.getUTCHours() - 4 + 24) % 24;

        if (etHour !== 2 && etHour !== 3 && etHour !== 4 && etHour !== 7) continue;

        const crossUp = prev9 <= prev21 && curr9 > curr21;
        const crossDown = prev9 >= prev21 && curr9 < curr21;
        const month = dt.toISOString().slice(0, 7);

        if (crossUp) trades.push({ type: 'LONG', entryIndex: i, entryPrice: b.close, hour: etHour, month, ts: b.ts });
        else if (crossDown) trades.push({ type: 'SHORT', entryIndex: i, entryPrice: b.close, hour: etHour, month, ts: b.ts });
    }

    for (const t of trades) {
        const isLong = t.type === 'LONG';
        let done = false;
        let pnl = 0;

        for (let i = t.entryIndex + 1; i < bars5m.length; i++) {
            const b = bars5m[i];
            const gap = b.ts.getTime() - bars5m[i-1].ts.getTime();
            const isEod = gap > 45 * 60 * 1000;
            
            const crossUp = ema9[i-1] <= ema21[i-1] && ema9[i] > ema21[i];
            const crossDown = ema9[i-1] >= ema21[i-1] && ema9[i] < ema21[i];
            const reverseCross = (isLong && crossDown) || (!isLong && crossUp);

            if (isEod) {
                pnl = isLong ? bars5m[i-1].close - t.entryPrice : t.entryPrice - bars5m[i-1].close;
                t.exitTs = bars5m[i-1].ts;
                t.exitPrice = bars5m[i-1].close;
                done = true;
                break;
            }

            if (isLong && b.low <= t.entryPrice - 60) { pnl = -60; t.exitTs = b.ts; t.exitPrice = t.entryPrice - 60; done = true; break; }
            else if (!isLong && b.high >= t.entryPrice + 60) { pnl = -60; t.exitTs = b.ts; t.exitPrice = t.entryPrice + 60; done = true; break; }
            
            if (reverseCross) {
                pnl = isLong ? b.close - t.entryPrice : t.entryPrice - b.close;
                t.exitTs = b.ts;
                t.exitPrice = b.close;
                done = true;
                break;
            }
        }
        t.pnl = pnl;
    }

    const monthlyStats = {};
    let totalPnl = 0;
    
    for (const t of trades) {
        if (!monthlyStats[t.month]) {
            monthlyStats[t.month] = { count: 0, pnl: 0 };
        }
        monthlyStats[t.month].count++;
        monthlyStats[t.month].pnl += (t.pnl * 2);
        totalPnl += (t.pnl * 2);
    }

    let mdContent = "# All-Time EMA Trade Log\n\n## Monthly Summary\n\n| Month | Trades | Gross PnL ($) |\n|---|---|---|\n";
    const sortedMonths = Object.keys(monthlyStats).sort();
    for (const m of sortedMonths) {
        mdContent += `| ${m} | ${monthlyStats[m].count} | $${monthlyStats[m].pnl.toFixed(2)} |\n`;
    }
    mdContent += `| **TOTAL** | **${trades.length}** | **$${totalPnl.toFixed(2)}** |\n\n`;

    mdContent += "## All Individual Trades\n\n| Entry Time (EST) | Type | Entry Price | PnL (Points) | Gross PnL ($) | Exit Time (EST) | Exit Price |\n|---|---|---|---|---|---|---|\n";
    
    const options = { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
    const formatter = new Intl.DateTimeFormat('sv-SE', options);

    for (const t of trades) {
        const entryDtStr = formatter.format(new Date(t.ts));
        const exitDtStr = t.exitTs ? formatter.format(new Date(t.exitTs)) : "N/A";
        const exitPriceStr = t.exitPrice ? t.exitPrice.toFixed(2) : "N/A";
        const pnlDollars = (t.pnl * 2).toFixed(2);
        mdContent += `| ${entryDtStr} | **${t.type}** | ${t.entryPrice.toFixed(2)} | ${t.pnl.toFixed(2)} | $${pnlDollars} | ${exitDtStr} | ${exitPriceStr} |\n`;
    }

    const artifactPath = '/home/mmoniz/.gemini/antigravity-cli/brain/ff59245c-8dd6-4ac5-a900-d77b7b779f15/ema_all_time_trades.md';
    fs.writeFileSync(artifactPath, mdContent);
    console.log(`Wrote ${trades.length} trades to ${artifactPath}`);
    console.log(`Total All-Time Gross PnL: $${totalPnl.toFixed(2)}`);

    pool.end();
}

run().catch(console.error);
