import { query } from '../server/db.js';
import fs from 'fs';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

async function main() {
    console.log("Loading daily ranges for ATR calculation...");
    const dailyRes = await query(`
        SELECT 
            TO_CHAR(ts::date, 'YYYY-MM-DD') as date_str, 
            (MAX(high) - MIN(low)) as range
        FROM price_bars_primary
        WHERE symbol='NQ' 
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        GROUP BY ts::date
        ORDER BY ts::date ASC
    `);
    const dailyRanges = dailyRes.rows.map(r => ({
        date: r.date_str,
        range: parseFloat(r.range)
    }));
    console.log(`Loaded ${dailyRanges.length} daily RTH ranges`);

    const shortWindows = [3, 5, 10];
    const longWindows = [20, 50, 100];
    const thresholds = [0.20, 0.30];

    const pairs = [];
    for (let s of shortWindows) {
        for (let l of longWindows) {
            if (s < l) pairs.push({s, l});
        }
    }
    console.log(`Generated ${pairs.length} valid short/long pairs (S < L) -> ${pairs.length * thresholds.length} total cells`);

    // Precalculate ratios and percentiles for each day and each pair
    // Pair key: "S_L"
    const dayCompression = {}; // date -> { cellKey -> boolean }
    
    for (let p of pairs) {
        const pairKey = `${p.s}_${p.l}`;
        const ratios = []; // prior ratios
        for (let i = 0; i < dailyRanges.length; i++) {
            const date = dailyRanges[i].date;
            if (!dayCompression[date]) dayCompression[date] = {};

            if (i >= p.l) {
                // We have enough history for the long window
                let shortSum = 0;
                for (let j = i - p.s; j < i; j++) shortSum += dailyRanges[j].range;
                let shortATR = shortSum / p.s;

                let longSum = 0;
                for (let j = i - p.l; j < i; j++) longSum += dailyRanges[j].range;
                let longATR = longSum / p.l;

                let ratio = (longATR > 0) ? shortATR / longATR : null;

                if (ratio !== null) {
                    for (let th of thresholds) {
                        const cellKey = `${pairKey}_${th}`;
                        if (ratios.length >= 100) { // Require some history to form a trailing distribution
                            let sorted = [...ratios].sort((a,b) => a-b);
                            let pValue = sorted[Math.floor(sorted.length * th)];
                            dayCompression[date][cellKey] = (ratio < pValue);
                        } else {
                            dayCompression[date][cellKey] = false;
                        }
                    }
                    ratios.push(ratio);
                }
            }
        }
    }

    console.log("Loading intraday bars for event generation...");
    const barsRes = await query(`
        SELECT 
            TO_CHAR(ts, 'YYYY-MM-DD HH24:MI:SS') as ts_str,
            open::float, high::float, low::float, close::float,
            COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume,
            (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
        FROM price_bars_primary
        WHERE symbol='NQ'
        ORDER BY ts ASC
    `);
    const allBars = barsRes.rows;
    console.log(`Loaded ${allBars.length} intraday bars`);

    let modQueues = Array.from({length: 1440}, () => []);
    let barsSinceLongBreakout = 100;
    let barsSinceShortBreakout = 100;
    let highQueue = [];
    let lowQueue = [];
    const MAX_HIGH_LOW_WINDOW = 30;
    const results = []; // To hold NO_COMPRESSION_CONTROL events

    for (let i = 0; i < allBars.length; i++) {
        const bar = allBars[i];

        highQueue.push(bar.high);
        lowQueue.push(bar.low);
        if (highQueue.length > MAX_HIGH_LOW_WINDOW + 1) {
            highQueue.shift();
            lowQueue.shift();
        }

        let breakoutLong = false;
        let breakoutShort = false;

        if (highQueue.length === MAX_HIGH_LOW_WINDOW + 1) {
            let maxHigh30 = -Infinity;
            let minLow30 = Infinity;
            for (let j = 0; j < MAX_HIGH_LOW_WINDOW; j++) {
                if (highQueue[j] > maxHigh30) maxHigh30 = highQueue[j];
                if (lowQueue[j] < minLow30) minLow30 = lowQueue[j];
            }
            
            if (bar.close > maxHigh30) {
                if (barsSinceLongBreakout >= 15) {
                    breakoutLong = true;
                    barsSinceLongBreakout = 0;
                } else barsSinceLongBreakout++;
            } else barsSinceLongBreakout++;

            if (bar.close < minLow30) {
                if (barsSinceShortBreakout >= 15) {
                    breakoutShort = true;
                    barsSinceShortBreakout = 0;
                } else barsSinceShortBreakout++;
            } else barsSinceShortBreakout++;
        } else {
            barsSinceLongBreakout++;
            barsSinceShortBreakout++;
        }

        let q = modQueues[bar.mod];
        let volZ = null;
        if (q.length >= 30) {
            let sum = 0;
            for (let j = 0; j < q.length; j++) sum += q[j];
            let mean = sum / q.length;
            let sumSq = 0;
            for (let j = 0; j < q.length; j++) sumSq += (q[j] - mean) * (q[j] - mean);
            let std = Math.sqrt(sumSq / q.length);
            if (std > 0) volZ = (bar.volume - mean) / std;
        }
        
        q.push(bar.volume);
        if (q.length > 90) q.shift();

        if (volZ !== null && (breakoutLong || breakoutShort) && volZ >= 1.0) {
            // RTH only
            if (bar.mod >= 570 && bar.mod <= 959) {
                results.push({
                    idx: i,
                    dir: breakoutLong ? 1 : -1,
                    volZ,
                    ts_str: bar.ts_str,
                    mod: bar.mod,
                    date: bar.ts_str.substring(0, 10),
                    entryPrice: bar.close
                });
            }
        }
    }

    console.log(`Found ${results.length} NO_COMPRESSION_CONTROL events`);

    const S = 138;
    const T = 102;

    // Simulate all events
    for (let item of results) {
        item.tradeDir = item.dir;
        
        let maxBars = 0;
        for (let k = item.idx + 1; k < allBars.length; k++) {
            let b = allBars[k];
            if (b.mod >= 960 || b.mod < 570) break;
            maxBars++;
        }
        
        let pnl = 0;
        let hitStop = false;
        let hitTarget = false;
        let lastClose = item.entryPrice;

        for (let k = item.idx + 1; k <= item.idx + maxBars && k < allBars.length; k++) {
            let b = allBars[k];
            lastClose = b.close;
            let adverse = item.tradeDir === 1 ? item.entryPrice - b.low : b.high - item.entryPrice;
            let favorable = item.tradeDir === 1 ? b.high - item.entryPrice : item.entryPrice - b.low;
            
            if (adverse > S) {
                hitStop = true;
                pnl = -S;
                break;
            }
            if (favorable >= T) {
                hitTarget = true;
                pnl = T;
                break;
            }
        }
        
        if (!hitStop && !hitTarget) {
            pnl = item.tradeDir === 1 ? lastClose - item.entryPrice : item.entryPrice - lastClose;
        }
        
        item.dollars = pnl * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip;
    }

    function evaluateSubset(subset) {
        if (subset.length === 0) return { N: 0 };
        let wins = subset.filter(e => e.dollars > 0).length;
        let sum = subset.reduce((acc, curr) => acc + curr.dollars, 0);
        let ev = sum / subset.length;
        
        let thirdLen = Math.floor(subset.length / 3);
        if (thirdLen === 0) return { N: subset.length, winRate: wins/subset.length, ev, stable: false, signs: 'N/A' };
        
        let p1 = subset.slice(0, thirdLen).reduce((acc, curr) => acc + curr.dollars, 0) / thirdLen;
        let p2 = subset.slice(thirdLen, 2*thirdLen).reduce((acc, curr) => acc + curr.dollars, 0) / thirdLen;
        let p3 = subset.slice(2*thirdLen).reduce((acc, curr) => acc + curr.dollars, 0) / (subset.length - 2*thirdLen);
        let signs = [p1, p2, p3].map(v => v > 0 ? '+' : '-').join('');
        let stable = (signs === '+++' || signs === '---');
        
        return { N: subset.length, winRate: wins/subset.length, ev, stable, signs };
    }

    const pooledStats = evaluateSubset(results);
    console.log(`POOLED: N=${pooledStats.N}, EV=${pooledStats.ev.toFixed(2)}, WR=${(pooledStats.winRate*100).toFixed(1)}%, Stability=${pooledStats.signs} ${pooledStats.stable?'(STABLE)':'(MIXED)'}`);

    const gridResults = [];
    
    for (let p of pairs) {
        for (let th of thresholds) {
            const cellKey = `${p.s}_${p.l}_${th}`;
            const compEvents = [];
            const notCompEvents = [];
            
            for (let ev of results) {
                let compMap = dayCompression[ev.date];
                if (compMap && compMap[cellKey]) {
                    compEvents.push(ev);
                } else {
                    notCompEvents.push(ev);
                }
            }
            
            let compStats = evaluateSubset(compEvents);
            let notCompStats = evaluateSubset(notCompEvents);
            
            gridResults.push({
                s: p.s, l: p.l, th: th,
                comp: compStats,
                notComp: notCompStats
            });
        }
    }

    let mdOutput = `# Day-Scale ATR Compression Filter Backtest\n\n`;
    mdOutput += `## Executive Summary\n`;
    
    // Evaluate if any cell is promising
    let promisingCells = gridResults.filter(r => 
        r.comp.N >= 20 && 
        r.comp.ev > pooledStats.ev && 
        r.comp.stable
    );

    if (promisingCells.length > 0) {
        mdOutput += `Found ${promisingCells.length} promising cell(s) where COMPRESSED beat POOLED, N>=20, and result was stable.\n`;
        let best = promisingCells.sort((a,b) => b.comp.ev - a.comp.ev)[0];
        mdOutput += `Best configuration: Short=${best.s}, Long=${best.l}, Threshold=${best.th} (EV=$${best.comp.ev.toFixed(2)}, N=${best.comp.N}).\n`;
        mdOutput += `This represents a genuine improvement and should be flagged for a follow-up stop/target resweep.\n\n`;
    } else {
        mdOutput += `No cells cleared the bar. None of the ${gridResults.length} configurations had a COMPRESSED subset that beat the POOLED baseline (EV=$${pooledStats.ev.toFixed(2)}) with N>=20 and chronological stability. This is a consistent third negative for compression as an independent filter. The already-validated baseline remains the strongest edge.\n\n`;
    }

    mdOutput += `## Methodology\n`;
    mdOutput += `- **Population**: ${pooledStats.N} RTH breakout events (volZ >= 1.0, 30-bar high/low).\n`;
    mdOutput += `- **Stop/Target**: Fixed at 138pt stop, 102pt target for all cells to measure standalone filter value.\n`;
    mdOutput += `- **Day-Scale ATR**: Trailing N-day RTH ranges (strictly prior days, expanding window percentile).\n`;
    mdOutput += `- ${pairs.length * thresholds.length} valid Short/Long pairs (Short < Long) × Thresholds were evaluated.\n\n`;

    mdOutput += `## POOLED Reference (No Compression Filter)\n`;
    mdOutput += `**N**: ${pooledStats.N} | **EV**: $${pooledStats.ev.toFixed(2)} | **Win Rate**: ${(pooledStats.winRate*100).toFixed(1)}% | **Stability**: ${pooledStats.signs} ${pooledStats.stable?'(STABLE)':'(MIXED)'}\n\n`;

    mdOutput += `## Grid Results\n`;
    mdOutput += `| Short | Long | Thresh | Subset | N | EV/Trade | Win Rate | Stability |\n`;
    mdOutput += `|---|---|---|---|---|---|---|---|\n`;

    for (let r of gridResults) {
        mdOutput += `| ${r.s} | ${r.l} | ${r.th} | COMPRESSED | ${r.comp.N} | $${r.comp.ev?r.comp.ev.toFixed(2):'0.00'} | ${r.comp.N>0?(r.comp.winRate*100).toFixed(1):'0.0'}% | ${r.comp.signs} |\n`;
        mdOutput += `| ${r.s} | ${r.l} | ${r.th} | NOT_COMPRESSED | ${r.notComp.N} | $${r.notComp.ev?r.notComp.ev.toFixed(2):'0.00'} | ${r.notComp.N>0?(r.notComp.winRate*100).toFixed(1):'0.0'}% | ${r.notComp.signs} |\n`;
    }

    fs.writeFileSync('reports/dayscale_compression_breakout_filter.md', mdOutput);
    console.log("Wrote reports/dayscale_compression_breakout_filter.md");
}

main().catch(console.error);
