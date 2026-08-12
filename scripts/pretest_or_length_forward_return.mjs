import { query } from '../server/db.js';
import { getOpeningRange } from '../server/services/acdBacktest.js';
import { getVolumeBaseline } from '../server/services/touchQuality.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const WINDOWS = [5, 10, 15, 30];
const LEVELS = ['HIGH', 'LOW', 'MID'];
const HORIZONS = [1, 3, 5, 10, 20];

// T-stat for difference from population mean
// Unconditional mean is treated as population mean since it has massive N.
function calcTStat(values, popMean) {
    const n = values.length;
    if (n < 2) return 0;
    const mean = values.reduce((sum, v) => sum + v, 0) / n;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (n - 1);
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    return (mean - popMean) / (std / Math.sqrt(n));
}

async function main() {
    console.log("Loading NQ bars from DB...");
    const res = await query(`
        SELECT ts::date::text as date,
               to_char(ts, 'HH24:MI') as time,
               EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as tod,
               open::float, high::float, low::float, close::float, COALESCE(bid_volume,0)::int as bid_volume, COALESCE(ask_volume,0)::int as ask_volume
        FROM price_bars_primary
        WHERE symbol = 'NQ' 
          AND ts::time >= '09:30' AND ts::time < '16:00'
        ORDER BY ts ASC
    `);
    console.log(`Loaded ${res.rows.length} bars.`);

    const allBars = res.rows;
    const barsByDate = new Map();
    for (let i = 0; i < allBars.length; i++) {
        const b = allBars[i];
        if (!barsByDate.has(b.date)) {
            barsByDate.set(b.date, []);
        }
        barsByDate.get(b.date).push(b);
    }

    console.log("Computing unconditional baselines...");
    const unconditionalReturns = {};
    for (const h of HORIZONS) {
        unconditionalReturns[h] = [];
    }

    for (const [date, bars] of barsByDate.entries()) {
        for (let i = 0; i < bars.length; i++) {
            for (const h of HORIZONS) {
                if (i + h < bars.length) {
                    unconditionalReturns[h].push(bars[i+h].close - bars[i].close);
                }
            }
        }
    }

    const unconditionalMeans = {};
    for (const h of HORIZONS) {
        const vals = unconditionalReturns[h];
        unconditionalMeans[h] = vals.reduce((sum, v) => sum + v, 0) / vals.length;
        console.log(`Unconditional h=${h}: ${(unconditionalMeans[h]).toFixed(4)} pt (N=${vals.length})`);
    }

    console.log("Detecting signal events (pass 1: collect volZ/OSR + forward returns per event)...");

    // Pass 1: collect every touch event's volZ/oneSidedRatio and per-horizon forward
    // return, WITHOUT bucketing yet — the bucket cutoff itself needs to be derived
    // from this population's own volZ distribution (no static threshold), not guessed.
    // (First attempt used a fixed volZ>=1 AND oneSidedRatio>=0.6 conjunction — real
    // STACK_VOL_BREAK_LIVE-style genuine-breakout bar, but far too strict for a generic
    // level-touch population: only 2-11 of ~300-380 touches per level cleared it,
    // every "confirmed" bucket came back N<20. Replaced with a data-derived median
    // split on volZ alone, guaranteeing a usable ~50/50 split by construction.)
    const events = [];
    for (const [date, bars] of barsByDate.entries()) {
        const baseline = await getVolumeBaseline(query, date);
        for (const w of WINDOWS) {
            const orInfo = getOpeningRange(bars, w);
            if (!orInfo) continue;

            const levels = {
                HIGH: orInfo.high,
                LOW: orInfo.low,
                MID: (orInfo.high + orInfo.low) / 2
            };

            const gateMin = 570 + w; // 9:30 is 570 mins
            const fired = new Set();

            for (let i = 5; i < bars.length; i++) {
                const b = bars[i];
                if (b.tod < gateMin) continue;

                for (const l of LEVELS) {
                    if (fired.has(l)) continue;
                    const lvl = levels[l];
                    if (lvl == null) continue;

                    if (Math.abs(b.close - lvl) <= 15) {
                        fired.add(l);

                        let direction = 'LONG';
                        if (i > 0 && bars[i-1].close > lvl) {
                            direction = 'SHORT';
                        }

                        const favorableVol = direction === 'LONG' ? b.ask_volume : b.bid_volume;
                        const adverseVol = direction === 'LONG' ? b.bid_volume : b.ask_volume;
                        const oneSidedRatio = (favorableVol + adverseVol) > 0 ? favorableVol / (favorableVol + adverseVol) : 0.5;

                        const totalVol = b.bid_volume + b.ask_volume;
                        const bl = baseline.get(Number(b.tod));
                        const volZ = (bl && bl.std_vol > 0) ? (totalVol - bl.avg_vol) / bl.std_vol : 0;

                        const returns = {};
                        for (const h of HORIZONS) {
                            if (i + h < bars.length) returns[h] = bars[i+h].close - bars[i].close;
                        }

                        events.push({ w, l, volZ, oneSidedRatio, returns });
                    }
                }
            }
        }
    }

    // Data-derived split: median volZ across ALL touch events (pooled across every
    // level/window — a per-level median would thin each cell further with no real
    // benefit for a screening pre-test). "high-vol" = at/above median.
    const allVolZ = events.map(e => e.volZ).sort((a, b) => a - b);
    const medianVolZ = allVolZ.length ? allVolZ[Math.floor(allVolZ.length / 2)] : 0;
    console.log(`Median volZ across ${events.length} touch events: ${medianVolZ.toFixed(3)} (data-derived split point, not a guessed threshold)`);

    console.log("Pass 2: bucketing by the data-derived median split...");
    const conditionalReturns = {};
    for (const w of WINDOWS) {
        conditionalReturns[w] = {};
        for (const l of LEVELS) {
            conditionalReturns[w][l] = {};
            for (const h of HORIZONS) {
                conditionalReturns[w][l][h] = { high_vol: [], low_vol: [] };
            }
        }
    }
    for (const e of events) {
        const bucket = e.volZ >= medianVolZ ? 'high_vol' : 'low_vol';
        for (const h of HORIZONS) {
            if (e.returns[h] !== undefined) conditionalReturns[e.w][e.l][h][bucket].push(e.returns[h]);
        }
    }

    console.log("Generating results table...");
    const results = [];
    
    for (const w of WINDOWS) {
        for (const l of LEVELS) {
            for (const h of HORIZONS) {
                for (const bucket of ['high_vol', 'low_vol']) {
                    const vals = conditionalReturns[w][l][h][bucket];
                    const n = vals.length;
                    let condMean = 0;
                    let edge = 0;
                    let tStat = 0;
                    
                    if (n > 0) {
                        condMean = vals.reduce((sum, v) => sum + v, 0) / n;
                        edge = condMean - unconditionalMeans[h];
                        tStat = calcTStat(vals, unconditionalMeans[h]);
                    }
                    
                    results.push({
                        level: `OR${w}_${l}`,
                        bucket,
                        n,
                        horizon: h,
                        condMean,
                        uncondMean: unconditionalMeans[h],
                        edge,
                        tStat
                    });
                }
            }
        }
    }

    let markdown = `# OR Length Forward-Return Pre-Test
**Methodology:** Conditional forward return AT the signal event (first bar after formation window whose close is within 15pt of the level) compared against the UNCONDITIONAL forward return of every bar over the same horizon in the RTH session (9:30-16:00 ET). Events are bucketed into "high_vol" (volZ >= the pooled median across all touch events, data-derived not guessed) vs "low_vol" (below median). Median volZ split point: ${medianVolZ.toFixed(3)} (N=${events.length} touch events).

| Level | Bucket | N | Horizon (bars) | Conditional (pt) | Unconditional (pt) | Edge (pt) | t-stat (vs baseline) |
|---|---|---|---|---|---|---|---|
`;

    for (const r of results) {
        if (r.n < 20) {
            markdown += `| ${r.level} | ${r.bucket} | ${r.n} | ${r.horizon} | - | - | - | N<20 (too thin) |\n`;
        } else {
            markdown += `| ${r.level} | ${r.bucket} | ${r.n} | ${r.horizon} | ${r.condMean.toFixed(2)} | ${r.uncondMean.toFixed(2)} | **${r.edge > 0 ? '+' : ''}${r.edge.toFixed(2)}** | ${r.tStat.toFixed(2)} |\n`;
        }
    }

    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync('reports/or_length_forward_return_pretest_2026-08-12.md', markdown);
    fs.writeFileSync('scratch/antigravity_response.md', markdown);
    
    // Combine findings for a claim
    await recordClaim({
        slug: 'or_length_forward_return_pretest',
        claimText: `Forward-return pre-test (1-20 bars) for OR 5/10/15/30 levels vs unconditional baseline, split by high_vol vs low_vol using a data-derived median volZ cutoff (${medianVolZ.toFixed(3)}, N=${events.length} touch events) -- a first attempt using a fixed volZ>=1 AND oneSidedRatio>=0.6 conjunction (the real STACK_VOL_BREAK_LIVE genuine-breakout threshold) was far too strict for a generic level-touch population, producing N<20 in every single confirmed bucket. Checks if signal event contains any intrinsic edge before position mechanics are applied, and if higher relative volume changes it.`,
        sourceFile: 'scripts/pretest_or_length_forward_return.mjs',
        sampleSize: Math.max(...results.map(r => r.n)),
        rigorStatus: 'volume_conditioned_baseline_comparison_pretest',
        status: 'PROVISIONAL'
    });

    console.log("Done.");
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
