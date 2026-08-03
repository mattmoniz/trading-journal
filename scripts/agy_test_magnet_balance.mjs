import pg from 'pg';
import { query } from '../server/db.js';
import { getTradingDays, getRTHBars } from './backtest_confluence.js';
import { resolve } from './backtest_unified.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { getTrailingVwapStd } from '../server/services/queries.js';

const pool = new pg.Pool({
    user: process.env.PGUSER || 'trader',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'trading_journal',
    password: process.env.PGPASSWORD || 'trader123',
    port: process.env.PGPORT || 5432,
});

async function run() {
    console.log("Fetching daily bars...");
    const dailyRes = await pool.query(`
        SELECT date_trunc('day', ts) as day, MAX(high) as high, MIN(low) as low
        FROM price_bars_primary
        GROUP BY 1 ORDER BY 1 ASC
    `);
    const dailyBars = dailyRes.rows;

    function getBalanceAreas(d) {
        const prevBars = dailyBars.filter(b => new Date(b.day) < d);
        const results = {};
        const lookbacks = [10, 20, 30, 45, 60, 90];
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

    const days = await getTradingDays();
    console.log(`Processing ${days.length} trading days for VWAP Magnet...`);

    const lookbacks = [10, 20, 30, 45, 60, 90];
    const allStats = {};
    for (const L of lookbacks) {
        allStats[L] = {
            "In Balance (Middle 50%)": { count: 0, pnl: 0 },
            "On the Edge (Top/Bottom 25%)": { count: 0, pnl: 0 },
            "Outside": { count: 0, pnl: 0 },
            "Unknown": { count: 0, pnl: 0 }
        };
    }

    let globalPnl = 0;
    let globalTrades = 0;

    for (const d of days) {
        if (new Date(d) < new Date('2023-01-01')) continue; // Skip early warmups to speed up

        const bars = await getRTHBars(d);
        if (bars.length < 30) continue;
        const vwapSeries = computeRunningVwapSeries(bars);
        const std = await getTrailingVwapStd(d, 30);

        let i = 2;
        while (i < bars.length) {
            const vwap = vwapSeries[i];
            if (vwap == null) { i++; continue; }
            const dist = bars[i].close - vwap;
            if (Math.abs(dist) < std.threshold) { i++; continue; }

            const isLong = dist < 0;
            const direction = isLong ? 'LONG' : 'SHORT';
            const entry = bars[i].close;
            const stop = isLong ? entry - 30 : entry + 30;
            const target = isLong ? entry + 20 : entry - 20;

            const res = resolve(bars, i, direction, entry, stop, target, 240);
            const pnl = res.result === 'EXPIRED' ? 0 : res.pnl;
            
            globalTrades++;
            globalPnl += (pnl * 20); // Standard NQ contract ($20/pt)

            const balances = getBalanceAreas(new Date(bars[i].ts));
            for (const L of lookbacks) {
                const bal = balances[L];
                let regime = "Unknown";
                if (bal) {
                    const pos = (entry - bal.min) / bal.range;
                    if (pos >= 0.25 && pos <= 0.75) regime = "In Balance (Middle 50%)";
                    else if (pos > 1.0 || pos < 0.0) regime = "Outside";
                    else regime = "On the Edge (Top/Bottom 25%)";
                }
                allStats[L][regime].count++;
                allStats[L][regime].pnl += (pnl * 20);
            }

            // advance i past resolution to match live behavior
            const resolvedIdx = Math.min(bars.length - 1, i + Math.max(1, res.barsHeld));
            i = resolvedIdx + 1;
        }
    }

    console.log(`\nOverall VWAP Magnet Strategy: ${globalTrades} trades, Total PnL: $${globalPnl.toFixed(2)}`);

    for (const L of lookbacks) {
        console.log(`\n--- ${L}-DAY BALANCE AREA ---`);
        for (const [regime, data] of Object.entries(allStats[L])) {
            if (data.count > 0) {
                console.log(`${regime.padEnd(30)} | Trades: ${data.count.toString().padEnd(4)} | PnL (NQ): $${data.pnl.toFixed(2)}`);
            }
        }
    }

    pool.end();
    process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
