import { query } from '../server/db.js';
import fs from 'fs';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

async function main() {
    console.log("Loading bars...");
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
    console.log(`Loaded ${allBars.length} bars`);

    const WINDOW_RATIO = 5000;
    const WINDOW_ATR1 = 5;
    const WINDOW_ATR2 = 100;
    const MAX_HIGH_LOW_WINDOW = 30;

    let trQueue = [];
    let sortedRatios = [];
    let ratioQueue = [];
    let modQueues = Array.from({length: 1440}, () => []);

    let barsSinceLongBreakout = 100;
    let barsSinceShortBreakout = 100;

    const results = [];
    let prevClose = null;
    let highQueue = [];
    let lowQueue = [];

    for (let i = 0; i < allBars.length; i++) {
        const bar = allBars[i];
        
        let tr = bar.high - bar.low;
        if (prevClose !== null) {
            tr = Math.max(tr, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
        }
        prevClose = bar.close;

        trQueue.push(tr);
        if (trQueue.length > WINDOW_ATR2) trQueue.shift();

        let ratio = null;
        if (trQueue.length === WINDOW_ATR2) {
            let sum5 = 0;
            for (let j = trQueue.length - WINDOW_ATR1; j < trQueue.length; j++) sum5 += trQueue[j];
            let sum100 = 0;
            for (let j = 0; j < trQueue.length; j++) sum100 += trQueue[j];
            const atr5 = sum5 / WINDOW_ATR1;
            const atr100 = sum100 / WINDOW_ATR2;
            if (atr100 > 0) ratio = atr5 / atr100;
        }

        let p20 = null;
        if (sortedRatios.length >= 1000) {
            let idx = Math.floor(sortedRatios.length * 0.20);
            p20 = sortedRatios[idx];
        }

        if (ratio !== null) {
            ratioQueue.push(ratio);
            let low = 0, high = sortedRatios.length;
            while(low < high) {
                let mid = (low + high) >>> 1;
                if (sortedRatios[mid] < ratio) low = mid + 1;
                else high = mid;
            }
            sortedRatios.splice(low, 0, ratio);

            if (ratioQueue.length > WINDOW_RATIO) {
                let oldRatio = ratioQueue.shift();
                let l = 0, h = sortedRatios.length;
                while(l < h) {
                    let mid = (l + h) >>> 1;
                    if (sortedRatios[mid] < oldRatio) l = mid + 1;
                    else h = mid;
                }
                if (sortedRatios[l] === oldRatio) {
                    sortedRatios.splice(l, 1);
                } else {
                    let idx = sortedRatios.indexOf(oldRatio);
                    if(idx !== -1) sortedRatios.splice(idx, 1);
                }
            }
        }

        let isCompressed = p20 !== null && ratio !== null && ratio < p20;

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

        if (volZ !== null && p20 !== null && (breakoutLong || breakoutShort)) {
            // RTH only
            if (bar.mod >= 570 && bar.mod <= 959) {
                results.push({
                    idx: i,
                    dir: breakoutLong ? 1 : -1,
                    isCompressed,
                    volZ,
                    ts_str: bar.ts_str,
                    mod: bar.mod,
                    date: bar.ts_str.substring(0, 10),
                    entryPrice: bar.close
                });
            }
        }
    }

    function getArm(item) {
        if (item.isCompressed && item.volZ >= 1.0) return 'SIGNAL';
        if (item.isCompressed && item.volZ <= 0.0) return 'FADE_CONTROL';
        if (!item.isCompressed && item.volZ >= 1.0) return 'UNCOMPRESSED_SIGNAL';
        if (!item.isCompressed && item.volZ <= 0.0) return 'UNCOMPRESSED_FADE';
        if (item.isCompressed && item.volZ > 0.0 && item.volZ < 1.0) return 'COMPRESSED_MID_VOL';
        if (!item.isCompressed && item.volZ > 0.0 && item.volZ < 1.0) return 'UNCOMPRESSED_MID_VOL';
        return 'OTHER';
    }

    const noCompressionControl = results.filter(r => r.volZ >= 1.0); // same as original script
    const fadeControl = results.filter(r => getArm(r) === 'FADE_CONTROL');

    console.log(`NO_COMPRESSION_CONTROL: ${noCompressionControl.length}`);
    console.log(`FADE_CONTROL: ${fadeControl.length}`);

    function getPercentile(arr, p) {
        if (!arr.length) return null;
        let sorted = [...arr].sort((a,b) => a-b);
        let idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
        return sorted[idx];
    }

    // Prepare events: define trade direction, compute max MAE/MFE up to 4pm ET
    function prepareEvents(events, tradeDirMultiplier) {
        for (let item of events) {
            item.tradeDir = item.dir * tradeDirMultiplier; // 1 for LONG, -1 for SHORT
            
            let maxBars = 0;
            // RTH ends at 959. So search until mod >= 960 or mod < 570
            for (let k = item.idx + 1; k < allBars.length; k++) {
                let b = allBars[k];
                if (b.mod >= 960 || b.mod < 570) break;
                maxBars++;
            }
            item.maxBars = maxBars;

            let mae = 0;
            let mfe = 0;
            let lastClose = item.entryPrice;
            
            for (let k = item.idx + 1; k <= item.idx + maxBars && k < allBars.length; k++) {
                let b = allBars[k];
                let adverse = item.tradeDir === 1 ? item.entryPrice - b.low : b.high - item.entryPrice;
                let favorable = item.tradeDir === 1 ? b.high - item.entryPrice : item.entryPrice - b.low;
                
                if (adverse > mae) mae = adverse;
                if (favorable > mfe) mfe = favorable;
                lastClose = b.close;
            }
            item.overallMae = mae;
            item.overallMfe = mfe;
            item.mtmPts = item.tradeDir === 1 ? lastClose - item.entryPrice : item.entryPrice - lastClose;
        }
    }

    prepareEvents(noCompressionControl, 1); // WITH breakout
    prepareEvents(fadeControl, -1); // AGAINST breakout

    const MAE_PCTS = [0.25, 0.40, 0.50, 0.60, 0.75, 0.90];
    const MFE_PCTS = [0.60, 0.75, 0.90];
    
    function simulatePopulation(name, events) {
        console.log(`\nSimulating ${name} (N=${events.length})`);
        
        let allMae = events.map(e => e.overallMae);
        let allMfe = events.map(e => e.overallMfe);
        
        let stopCandidates = MAE_PCTS.map(p => Math.round(getPercentile(allMae, p)));
        let targetCandidates = MFE_PCTS.map(p => Math.round(getPercentile(allMfe, p)));
        
        // Remove duplicates and sort
        stopCandidates = [...new Set(stopCandidates)].sort((a,b)=>a-b);
        targetCandidates = [...new Set(targetCandidates)].sort((a,b)=>a-b);
        
        console.log(`Stop candidates: ${stopCandidates.join(', ')}`);
        console.log(`Target candidates: ${targetCandidates.join(', ')}`);
        
        let combinations = [];
        
        for (let S of stopCandidates) {
            for (let T of targetCandidates) {
                let pnlSum = 0;
                let wins = 0;
                
                let pnlList = []; // for chronological stability
                
                for (let i = 0; i < events.length; i++) {
                    let ev = events[i];
                    let pnl = 0;
                    
                    let hitStop = false;
                    let hitTarget = false;
                    
                    for (let k = ev.idx + 1; k <= ev.idx + ev.maxBars && k < allBars.length; k++) {
                        let b = allBars[k];
                        let adverse = ev.tradeDir === 1 ? ev.entryPrice - b.low : b.high - ev.entryPrice;
                        let favorable = ev.tradeDir === 1 ? b.high - ev.entryPrice : ev.entryPrice - b.low;
                        
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
                        pnl = ev.mtmPts; // mark to market
                    }
                    
                    let dollars = pnl * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip;
                    pnlSum += dollars;
                    if (dollars > 0) wins++;
                    
                    pnlList.push({date: ev.date, dollars});
                }
                
                let winRate = wins / events.length;
                let evPerTrade = pnlSum / events.length;
                
                // Chronological stability
                let thirdLen = Math.floor(events.length / 3);
                let p1 = pnlList.slice(0, thirdLen).reduce((acc, curr) => acc + curr.dollars, 0) / thirdLen;
                let p2 = pnlList.slice(thirdLen, 2*thirdLen).reduce((acc, curr) => acc + curr.dollars, 0) / thirdLen;
                let p3 = pnlList.slice(2*thirdLen).reduce((acc, curr) => acc + curr.dollars, 0) / (events.length - 2*thirdLen);
                let signs = [p1, p2, p3].map(v => v > 0 ? '+' : '-').join('');
                let stable = (signs === '+++' || signs === '---');
                
                // Day clustering
                let dateCounts = {};
                events.forEach(e => dateCounts[e.date] = (dateCounts[e.date]||0) + 1);
                let sortedDates = Object.entries(dateCounts).sort((a,b)=>b[1]-a[1]);
                let top5Sum = sortedDates.slice(0,5).reduce((acc, curr) => acc + curr[1], 0);
                let top5Frac = top5Sum / events.length;
                
                combinations.push({
                    S, T, winRate, evPerTrade, totalPnl: pnlSum,
                    signs, stable, top5Frac, N: events.length
                });
            }
        }
        
        combinations.sort((a,b) => b.evPerTrade - a.evPerTrade);
        return combinations;
    }

    let noCompCombinations = simulatePopulation('NO_COMPRESSION_CONTROL', noCompressionControl);
    let fadeCombinations = simulatePopulation('FADE_CONTROL', fadeControl);

    let output = `# Compression Breakout Stop & Target Simulation

## Executive Summary
**NO_COMPRESSION_CONTROL (N=${noCompressionControl.length})**: (With Breakout) 
Recommended: S=${noCompCombinations[0]?.S}, T=${noCompCombinations[0]?.T} 
EV=$${noCompCombinations[0]?.evPerTrade.toFixed(2)}, Stability: ${noCompCombinations[0]?.signs}

**FADE_CONTROL (N=${fadeControl.length})**: (Against Breakout)
Recommended: S=${fadeCombinations[0]?.S}, T=${fadeCombinations[0]?.T}
EV=$${fadeCombinations[0]?.evPerTrade.toFixed(2)}, Stability: ${fadeCombinations[0]?.signs}

## Full Grids
### NO_COMPRESSION_CONTROL
| Stop | Target | EV/Trade | Total P&L | Win Rate | Stability | Top 5 Day Frac |
|---|---|---|---|---|---|---|
`;
    noCompCombinations.forEach(c => {
        output += `| ${c.S} | ${c.T} | $${c.evPerTrade.toFixed(2)} | $${c.totalPnl.toFixed(2)} | ${(c.winRate*100).toFixed(1)}% | ${c.signs} ${c.stable?'(STABLE)':'(MIXED)'} | ${(c.top5Frac*100).toFixed(1)}% |\n`;
    });

    output += `\n### FADE_CONTROL\n`;
    output += `| Stop | Target | EV/Trade | Total P&L | Win Rate | Stability | Top 5 Day Frac |
|---|---|---|---|---|---|---|\n`;
    fadeCombinations.forEach(c => {
        output += `| ${c.S} | ${c.T} | $${c.evPerTrade.toFixed(2)} | $${c.totalPnl.toFixed(2)} | ${(c.winRate*100).toFixed(1)}% | ${c.signs} ${c.stable?'(STABLE)':'(MIXED)'} | ${(c.top5Frac*100).toFixed(1)}% |\n`;
    });

    fs.writeFileSync('reports/compression_breakout_stop_target_sim.md', output);
    console.log("Wrote reports/compression_breakout_stop_target_sim.md");
}

main().catch(console.error);
