import { query } from '../server/db.js';
import fs from 'fs';

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
    let baselineSlices = [];
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
            results.push({
                idx: i,
                dir: breakoutLong ? 1 : -1,
                isCompressed,
                volZ,
                ts_str: bar.ts_str,
                mod: bar.mod,
                date: bar.ts_str.substring(0, 10)
            });
        }

        if (i % 15 === 0 && p20 !== null) {
             baselineSlices.push({
                 idx: i,
                 dir: 1, 
                 ts_str: bar.ts_str,
                 mod: bar.mod,
                 date: bar.ts_str.substring(0, 10)
             });
        }
    }
    
    console.log(`Found ${results.length} breakout events, ${baselineSlices.length} baseline samples.`);

    const horizons = [5, 10, 15, 20, 40, 60, 120, 180, 240];
    
    function evalForward(item) {
        let i = item.idx;
        let entryPrice = allBars[i].close;
        item.fwd = {};
        for (let h of horizons) {
            if (i + h < allBars.length) {
                item.fwd[h] = (allBars[i+h].close - entryPrice) * item.dir;
            }
        }
        
        let eodIdx = -1;
        let isRTH = item.mod >= 570 && item.mod <= 959;
        
        let maxSearch = i + 1500;
        for (let k = i + 1; k < Math.min(maxSearch, allBars.length); k++) {
            let bMod = allBars[k].mod;
            if (isRTH) {
                if (bMod >= 960 || bMod < 570) {
                    eodIdx = k - 1;
                    break;
                }
            } else {
                if (bMod >= 570 && bMod <= 959) {
                    eodIdx = k - 1;
                    break;
                }
            }
        }
        if (eodIdx !== -1 && eodIdx > i) {
            item.fwd['EOD'] = (allBars[eodIdx].close - entryPrice) * item.dir;
        }
    }

    results.forEach(evalForward);
    baselineSlices.forEach(evalForward);

    function getArm(item) {
        if (item.isCompressed && item.volZ >= 1.0) return 'SIGNAL';
        if (item.isCompressed && item.volZ <= 0.0) return 'FADE_CONTROL';
        if (!item.isCompressed && item.volZ >= 1.0) return 'UNCOMPRESSED_SIGNAL';
        if (!item.isCompressed && item.volZ <= 0.0) return 'UNCOMPRESSED_FADE';
        if (item.isCompressed && item.volZ > 0.0 && item.volZ < 1.0) return 'COMPRESSED_MID_VOL';
        if (!item.isCompressed && item.volZ > 0.0 && item.volZ < 1.0) return 'UNCOMPRESSED_MID_VOL';
        return 'OTHER';
    }

    const allBreakoutVolConfirmed = results.filter(r => r.volZ >= 1.0);
    const arms = {
        'SIGNAL': results.filter(r => getArm(r) === 'SIGNAL'),
        'FADE_CONTROL': results.filter(r => getArm(r) === 'FADE_CONTROL'),
        'NO_COMPRESSION_CONTROL': allBreakoutVolConfirmed,
        'UNCONDITIONAL': baselineSlices
    };
    
    const hKeys = [...horizons, 'EOD'];
    
    
    function analyze(arr, windowName) {
        let subset = arr.filter(r => {
            let isRTH = r.mod >= 570 && r.mod <= 959;
            return windowName === 'RTH' ? isRTH : !isRTH;
        });
        
        if (subset.length === 0) return null;
        
        let nLong = subset.filter(r => r.dir === 1).length;
        let nShort = subset.filter(r => r.dir === -1).length;
        let longFrac = nLong / subset.length;
        let shortFrac = nShort / subset.length;
        let meanMod = subset.reduce((a,b) => a + b.mod, 0) / subset.length;
        
        let datesMap = {};
        subset.forEach(s => datesMap[s.date] = (datesMap[s.date]||0)+1);
        let sortedDates = Object.entries(datesMap).sort((a,b)=>b[1]-a[1]);
        let top5Frac = sortedDates.slice(0,5).reduce((sum, kv) => sum + kv[1], 0) / subset.length;
        
        let stats = { 
            N: subset.length, 
            nLong, nShort, longFrac, shortFrac, meanMod,
            top5ClusterFrac: top5Frac, 
            fwd: {} 
        };
        
        for (let hk of hKeys) {
            let vals = subset.map(s => s.fwd[hk]).filter(v => v !== undefined);
            if (vals.length === 0) continue;
            let mean = vals.reduce((a,b)=>a+b, 0) / vals.length;
            
            // split into 3 chronologically
            let thirdLen = Math.floor(vals.length / 3);
            let m1 = vals.slice(0, thirdLen).reduce((a,b)=>a+b,0)/thirdLen;
            let m2 = vals.slice(thirdLen, 2*thirdLen).reduce((a,b)=>a+b,0)/thirdLen;
            let m3 = vals.slice(2*thirdLen).reduce((a,b)=>a+b,0)/(vals.length - 2*thirdLen);
            
            stats.fwd[hk] = { mean, m1, m2, m3 };
        }
        return stats;
    }

    const mdReportLines = [];
    mdReportLines.push("# Compression + Volume Breakout Backtest Stats");
    mdReportLines.push("");

    for (let w of ['RTH', 'GLOBEX']) {
        console.log(`\n--- ${w} ---`);
        mdReportLines.push(`## ${w} Window`);
        let baseStats = analyze(arms['UNCONDITIONAL'], w);
        if (baseStats) {
            console.log(`UNCONDITIONAL BASELINE: N=${baseStats.N} | meanMod=${baseStats.meanMod.toFixed(1)}`);
            mdReportLines.push(`**Baseline**: N=${baseStats.N}, Mean Time-of-Day (mod)=${baseStats.meanMod.toFixed(1)}`);
            mdReportLines.push("");
        }

        for (let armName of Object.keys(arms)) {
            if (armName === 'UNCONDITIONAL') continue;
            let st = analyze(arms[armName], w);
            if (!st) {
                console.log(`${armName}: N=0`);
                continue;
            }
            
            let lPct = (st.longFrac * 100).toFixed(1);
            let sPct = (st.shortFrac * 100).toFixed(1);
            console.log(`${armName} (N=${st.N}, Long:${lPct}% Short:${sPct}% | meanMod=${st.meanMod.toFixed(1)}): `);
            
            mdReportLines.push(`### ${armName}`);
            mdReportLines.push(`- **N**: ${st.N} (${st.nLong} Long [${lPct}%], ${st.nShort} Short [${sPct}%])`);
            mdReportLines.push(`- **Mean Time-of-Day (mod)**: ${st.meanMod.toFixed(1)} (Baseline: ${baseStats ? baseStats.meanMod.toFixed(1) : 'N/A'})`);
            mdReportLines.push(`- **Top 5 Dates Frac**: ${(st.top5ClusterFrac*100).toFixed(1)}%`);
            mdReportLines.push("");
            mdReportLines.push("| Horizon | Arm Mean | Flat Base Diff | Matched Base Diff | Stability |");
            mdReportLines.push("|---|---|---|---|---|");

            for (let hk of hKeys) {
                if (!st.fwd[hk]) continue;
                let mean = st.fwd[hk].mean;
                let baseMean = baseStats && baseStats.fwd[hk] ? baseStats.fwd[hk].mean : 0;
                
                // Flat (dir=1) baseline diff
                let flatDiff = mean - baseMean;
                
                // Direction-matched baseline diff
                let matchedBaseMean = (st.longFrac * baseMean) + (st.shortFrac * (-baseMean));
                let matchedDiff = mean - matchedBaseMean;
                
                let b_m1 = baseStats && baseStats.fwd[hk] ? baseStats.fwd[hk].m1 : 0;
                let b_m2 = baseStats && baseStats.fwd[hk] ? baseStats.fwd[hk].m2 : 0;
                let b_m3 = baseStats && baseStats.fwd[hk] ? baseStats.fwd[hk].m3 : 0;
                
                let matched_b_m1 = (st.longFrac * b_m1) + (st.shortFrac * (-b_m1));
                let matched_b_m2 = (st.longFrac * b_m2) + (st.shortFrac * (-b_m2));
                let matched_b_m3 = (st.longFrac * b_m3) + (st.shortFrac * (-b_m3));

                let t1 = st.fwd[hk].m1 - matched_b_m1;
                let t2 = st.fwd[hk].m2 - matched_b_m2;
                let t3 = st.fwd[hk].m3 - matched_b_m3;
                
                let signs = [t1, t2, t3].map(v => v > 0 ? '+' : '-').join('');
                let rigor = signs === '+++' || signs === '---' ? '(STABLE)' : '(MIXED)';
                
                console.log(`  Horizon ${hk}: mean=${mean.toFixed(2)} | flatBaseDiff=${flatDiff.toFixed(2)} | matchedBaseDiff=${matchedDiff.toFixed(2)} ${signs} ${rigor}`);
                
                mdReportLines.push(`| ${hk} | ${mean.toFixed(2)} | ${flatDiff.toFixed(2)} | ${matchedDiff.toFixed(2)} | ${signs} ${rigor} |`);
            }
            mdReportLines.push("");
        }
    }
    
    fs.writeFileSync('reports/compression_breakout_stats_2026-08-25.md', mdReportLines.join("\n"));
}

main().catch(console.error);
