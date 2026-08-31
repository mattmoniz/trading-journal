import { query } from '../server/db.js';
import { getRollingATR } from '../server/services/levelProximityService.js';
import { findTradingDayGaps } from '../server/services/queries.js';
import fs from 'fs';

const configs = [
  { id: 'PD_VAH_TO_PD_VAL_GLOBEX', pair: 'PD_VAH_PD_VAL', A: 'PD_VAH', B: 'PD_VAL', window: 'GLOBEX', gateMin: 0 },
  { id: 'PD_VAL_TO_PD_VAH_GLOBEX', pair: 'PD_VAL_PD_VAH', A: 'PD_VAL', B: 'PD_VAH', window: 'GLOBEX', gateMin: 0 },
  { id: 'PD_VAH_TO_PD_VAL_RTH',    pair: 'PD_VAH_PD_VAL', A: 'PD_VAH', B: 'PD_VAL', window: 'RTH', gateMin: 570 },
  { id: 'PD_VAL_TO_PD_VAH_RTH',    pair: 'PD_VAL_PD_VAH', A: 'PD_VAL', B: 'PD_VAH', window: 'RTH', gateMin: 570 },
  { id: 'IB_HIGH_TO_IB_LOW_RTH',   pair: 'IB_HIGH_IB_LOW', A: 'IB_HIGH', B: 'IB_LOW', window: 'RTH', gateMin: 630 },
  { id: 'IB_LOW_TO_IB_HIGH_RTH',   pair: 'IB_LOW_IB_HIGH', A: 'IB_LOW', B: 'IB_HIGH', window: 'RTH', gateMin: 630 },
  { id: 'ONH_TO_ONL_RTH',          pair: 'ONH_ONL', A: 'ONH', B: 'ONL', window: 'RTH', gateMin: 570 },
  { id: 'ONL_TO_ONH_RTH',          pair: 'ONL_ONH', A: 'ONL', B: 'ONH', window: 'RTH', gateMin: 570 }
];

const Ks = [3, 5, 10, 20];
const REJECT_FRACs = [0.02, 0.05, 0.10];

function zTest(x1, n1, x2, n2) {
    if (n1 === 0 || n2 === 0) return 0;
    const p1 = x1 / n1;
    const p2 = x2 / n2;
    const p_pool = (x1 + x2) / (n1 + n2);
    if (p_pool === 0 || p_pool === 1) return 0;
    const se = Math.sqrt(p_pool * (1 - p_pool) * (1/n1 + 1/n2));
    if (se === 0) return 0;
    return (p1 - p2) / se;
}

async function main() {
    console.log("Loading dates...");
    const datesRes = await query(`SELECT DISTINCT trade_date::text as td FROM acd_daily_log ORDER BY td`);
    const dates = datesRes.rows.map(r => r.td);

    // FIXED 2026-08-31 (OPEN_DECISION price_bars_primary_systemic_quarterly_data_gap): this is
    // one of the two scripts whose audit surfaced the bug (DeepSeek found 7 days with abnormally
    // large Globex bar windows here, 1606-1898 bars vs 989 median). Root cause confirmed: the
    // bars query below bounds `ts > prev_trade_date+16h AND ts <= trade_date+16h` -- when
    // dates[i-1]/dates[i] straddle one of the real ~63-day contract-rollover gaps in
    // price_bars_dedup_hist (Dec2023-May2025, see server/services/queries.js's header comment),
    // that "since yesterday" window silently becomes "since 2 months ago" instead, inflating bar
    // counts and corrupting whatever this loop computes for that date. Skip any (prev,curr) pair
    // that straddles a known gap rather than silently processing an inflated window.
    // NOTE (DeepSeek code review round 5, finding T7): this guard checks `dates` built from
    // acd_daily_log's own distinct trade_date list, but the bars query a few lines down reads
    // price_bars_primary -- correctness here assumes the two share the same gap boundaries.
    // True today (acd_daily_log itself has no rows for the same historically-dataless windows),
    // but if they were ever to diverge (e.g. acd_daily_log backfilled independently of the raw
    // price data), this guard would be checking the wrong array for what the bars query
    // actually returns. Not asserted in code -- cheap to add if this ever becomes a real risk.
    const dayGaps = findTradingDayGaps(dates, 5);
    const gapAfterIndex = new Set(dayGaps.map(g => g.fromIndex));
    if (dayGaps.length > 0) {
      console.log(`${dayGaps.length} real trading-day gap(s) > 5 days found (quarterly-contract-rollover-related, expected): ${dayGaps.map(g => `${g.fromDate}->${g.toDate}(${g.gapDays}d)`).join(', ')} -- dates straddling these will be skipped below.`);
    }

    const baselines = {}; // configId -> [{date, hitB}]
    const tmBaselineStats = {}; // configId -> { m: { total: 0, hits: 0 } }
    for (const c of configs) {
        baselines[c.id] = [];
        tmBaselineStats[c.id] = {};
    }
    
    const cells = {}; // configId -> K -> frac -> []
    for (const c of configs) {
        cells[c.id] = {};
        for (const K of Ks) {
            cells[c.id][K] = {};
            for (const frac of REJECT_FRACs) {
                cells[c.id][K][frac] = [];
            }
        }
    }

    console.log(`Processing ${dates.length} dates...`);
    for (let i = 1; i < dates.length; i++) {
        if (gapAfterIndex.has(i - 1)) continue; // dates[i-1]->dates[i] straddles a real gap -- see fix note above
        const trade_date = dates[i];
        const prev_trade_date = dates[i-1];

        const levelsRes = await query(`SELECT level_name, price::float as price FROM level_prices WHERE trade_date=$1`, [trade_date]);
        const levels = {};
        for (const r of levelsRes.rows) levels[r.level_name] = r.price;
        
        const atr = await getRollingATR(trade_date);
        if (!atr) continue;
        
        const barsRes = await query(`
            SELECT TO_CHAR(ts, 'YYYY-MM-DD HH24:MI:SS') as ts_str, open::float, high::float, low::float, close::float,
                   (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
            FROM price_bars_primary
            WHERE symbol='NQ'
              AND ts > $1::timestamp + INTERVAL '16 hours'
              AND ts <= $2::timestamp + INTERVAL '16 hours'
            ORDER BY ts ASC
        `, [prev_trade_date, trade_date]);
        const allBars = barsRes.rows;
        if (allBars.length === 0) continue;
        
        const globexBars = [];
        const rthBars = [];
        for (const b of allBars) {
            if (b.ts_str < `${trade_date} 09:30:00`) {
                globexBars.push(b);
            } else if (b.ts_str >= `${trade_date} 09:30:00` && b.ts_str < `${trade_date} 16:00:00`) {
                rthBars.push(b);
            }
        }
        
        for (const cfg of configs) {
            if (levels[cfg.A] == null || levels[cfg.B] == null) continue;
            
            let windowBars = cfg.window === 'GLOBEX' ? globexBars : rthBars;
            windowBars = windowBars.filter(b => {
               if (cfg.window === 'GLOBEX') return true;
               return b.mod >= cfg.gateMin;
            });
            
            if (windowBars.length === 0) continue;
            
            const B = levels[cfg.B];
            let baselineHitB = false;
            let lastTouchIdxB = -1;
            for (let j = 0; j < windowBars.length; j++) {
                const b = windowBars[j];
                if (b.low <= B + 15 && b.high >= B - 15) {
                    baselineHitB = true; 
                    lastTouchIdxB = j;
                }
            }
            baselines[cfg.id].push({ date: trade_date, hitB: baselineHitB });
            
            // Build Time-Matched baseline stats
            for (let m = 0; m <= windowBars.length; m++) {
                if (!tmBaselineStats[cfg.id][m]) tmBaselineStats[cfg.id][m] = { total: 0, hits: 0 };
                tmBaselineStats[cfg.id][m].total++;
                if (m <= lastTouchIdxB) {
                    tmBaselineStats[cfg.id][m].hits++;
                }
            }
            
            const A = levels[cfg.A];
            let touchIdx = -1;
            for (let j = 0; j < windowBars.length; j++) {
                const b = windowBars[j];
                if (b.low <= A + 15 && b.high >= A - 15) {
                    touchIdx = j; break;
                }
            }
            
            if (touchIdx === -1) continue;
            
            const touchBar = windowBars[touchIdx];
            const isLong = touchBar.open > A;
            
            for (const K of Ks) {
                if (touchIdx + K > windowBars.length) continue;
                
                const kBars = windowBars.slice(touchIdx, touchIdx + K);
                let adverse = 0;
                if (isLong) {
                    const minLow = Math.min(...kBars.map(b => b.low));
                    adverse = Math.max(0, A - minLow);
                } else {
                    const maxHigh = Math.max(...kBars.map(b => b.high));
                    adverse = Math.max(0, maxHigh - A);
                }
                
                let hitBAfterK = false;
                for (let j = touchIdx + K; j < windowBars.length; j++) {
                    const b = windowBars[j];
                    if (b.low <= B + 15 && b.high >= B - 15) {
                        hitBAfterK = true; break;
                    }
                }
                
                for (const frac of REJECT_FRACs) {
                    const rejectThreshold = frac * atr;
                    const isReject = adverse <= rejectThreshold;
                    
                    cells[cfg.id][K][frac].push({
                        date: trade_date,
                        is_reject: isReject,
                        hit_B: hitBAfterK,
                        m: touchIdx + K
                    });
                }
            }
        }
    }

    // Process and output results
    const csvRows = ['Config,K,RejectFrac,FlatBaseN,FlatBaseRate,SigN,SigRate,SigTMBaseRate,SameSelN,SameSelRate,SameSelTMBaseRate,Z_SigVsFlatBase,Z_SigVsTMBase,Z_SigVsSame,ThirdsStable'];

    for (const c of configs) {
        const bl = baselines[c.id];
        const base_n = bl.length;
        const base_hits = bl.filter(x => x.hitB).length;
        const base_rate = base_n > 0 ? base_hits / base_n : 0;
        
        for (const K of Ks) {
            for (const frac of REJECT_FRACs) {
                const events = cells[c.id][K][frac];
                const sigs = events.filter(e => e.is_reject);
                const sames = events.filter(e => !e.is_reject);
                
                const sig_n = sigs.length;
                const sig_hits = sigs.filter(e => e.hit_B).length;
                const sig_rate = sig_n > 0 ? sig_hits / sig_n : 0;
                
                const same_n = sames.length;
                const same_hits = sames.filter(e => e.hit_B).length;
                const same_rate = same_n > 0 ? same_hits / same_n : 0;
                
                let sig_tm_prob_sum = 0;
                for (const e of sigs) {
                    const stats = tmBaselineStats[c.id][e.m];
                    sig_tm_prob_sum += stats ? (stats.hits / stats.total) : 0;
                }
                const sig_tm_rate = sig_n > 0 ? sig_tm_prob_sum / sig_n : 0;

                let same_tm_prob_sum = 0;
                for (const e of sames) {
                    const stats = tmBaselineStats[c.id][e.m];
                    same_tm_prob_sum += stats ? (stats.hits / stats.total) : 0;
                }
                const same_tm_rate = same_n > 0 ? same_tm_prob_sum / same_n : 0;

                let z_base = 0;
                let z_tm_base = 0;
                let z_same = 0;
                let stable = 'N/A';
                
                if (sig_n >= 20) {
                    z_base = zTest(sig_hits, sig_n, base_hits, base_n);
                    z_same = zTest(sig_hits, sig_n, same_hits, same_n);
                    
                    const p0 = sig_tm_rate;
                    const se_tm = Math.sqrt(p0 * (1 - p0) / sig_n);
                    z_tm_base = se_tm > 0 ? (sig_rate - p0) / se_tm : 0;
                    
                    // Chronological stability using Time-Matched baseline
                    sigs.sort((a,b) => a.date.localeCompare(b.date));
                    const t1 = sigs.slice(0, Math.floor(sig_n/3));
                    const t2 = sigs.slice(Math.floor(sig_n/3), Math.floor(2*sig_n/3));
                    const t3 = sigs.slice(Math.floor(2*sig_n/3));
                    
                    const signs = [t1, t2, t3].map(t => {
                        if (t.length === 0) return 0;
                        const r = t.filter(e => e.hit_B).length / t.length;
                        const t_tm_sum = t.reduce((sum, e) => sum + (tmBaselineStats[c.id][e.m].hits / tmBaselineStats[c.id][e.m].total), 0);
                        const t_tm = t_tm_sum / t.length;
                        return Math.sign(r - t_tm);
                    });
                    
                    if (signs[0] === signs[1] && signs[1] === signs[2] && signs[0] !== 0) {
                        stable = signs[0] > 0 ? 'YES_POS' : 'YES_NEG';
                    } else {
                        stable = 'NO';
                    }
                }
                
                csvRows.push([
                    c.id, K, frac, 
                    base_n, (base_rate*100).toFixed(1)+'%',
                    sig_n, (sig_rate*100).toFixed(1)+'%', (sig_tm_rate*100).toFixed(1)+'%',
                    same_n, (same_rate*100).toFixed(1)+'%', (same_tm_rate*100).toFixed(1)+'%',
                    z_base.toFixed(2), z_tm_base.toFixed(2), z_same.toFixed(2), stable
                ].join(','));
            }
        }
    }
    
    fs.mkdirSync('reports', { recursive: true });
    const outPath = 'reports/range_boundary_rejection_2026-08-25.csv';
    fs.writeFileSync(outPath, csvRows.join('\n'));
    console.log(`Wrote full results to ${outPath}`);
    process.exit(0);
}

main().catch(console.error);
