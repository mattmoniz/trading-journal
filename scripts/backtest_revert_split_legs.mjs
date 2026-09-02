import pg from 'pg';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { makeBarIndex, WALK_WINDOW_BARS } from '../server/services/targetCalibrationService.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { precomputeCrossovers, computeEvAtStopTargetChronological, DEFAULT_DPP } from './update_optimal_stops.mjs';

const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'gemini_readonly', password: 'gemini_ro_2026' });

async function main() {
    console.log("Loading bars...");
    const barsRes = await pool.query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
    const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close }));
    const firstIndexAfter = makeBarIndex(allBars);

    console.log("Loading trades...");
    const tradesRes = await pool.query(`
        SELECT id, trade_date, setup_type, fired_at, origin_status, actual_pnl::float AS pnl,
               resolution, size_multiplier::float AS sm, is_rth, session,
               price_at_detection::float as entry, stop_level::float,
               resolution_bar_time, selected_over
        FROM active_setups
        WHERE trade_date >= '2026-08-03' AND trade_date <= '2026-09-01'
          AND origin_status IN ('ACTIVE','SHADOW')
          AND actual_pnl IS NOT NULL
          AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM'))
        ORDER BY fired_at
    `);
    const trades = tradesRes.rows.map(t => ({
        ...t,
        direction: inferDirection(t.setup_type),
        barIdx: firstIndexAfter(new Date(t.fired_at).getTime()),
        fired_ts: new Date(t.fired_at).getTime()
    }));

    console.log("\n=== Running Leg A ===");
    const osRes = await pool.query(`SELECT created_at, signal_name, p75_mae, p50_mfe FROM performance_audit WHERE signal_type='OPTIMAL_STOP' ORDER BY created_at`);
    const osHist = new Map();
    for (const row of osRes.rows) {
        if (!osHist.has(row.signal_name)) osHist.set(row.signal_name, []);
        osHist.get(row.signal_name).push({
            created_at: new Date(row.created_at).getTime(),
            p75_mae: row.p75_mae ? Math.round(parseFloat(row.p75_mae)) : null,
            p50_mfe: row.p50_mfe ? Math.round(parseFloat(row.p50_mfe)) : null
        });
    }

    let legADelta = 0;
    let legADeltaNoRefire = 0;
    let legAFlaggedCount = 0;
    let legATotalCount = 0;
    const lastSimRes = new Map();
    const legAResults = [];
    
    for (const t of trades) {
        if (t.origin_status !== 'ACTIVE') continue;
        if (!['TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED'].includes(t.resolution)) continue;
        
        const hist = osHist.get(t.setup_type);
        if (!hist) continue;
        let bestOs = null;
        for (const g of hist) { if (g.created_at < t.fired_ts) bestOs = g; else break; }
        
        if (!bestOs || bestOs.p75_mae == null || bestOs.p50_mfe == null) continue;
        
        const S = bestOs.p75_mae;
        const T = bestOs.p50_mfe;
        
        const crossovers = precomputeCrossovers(t, allBars, [S], [T], 390);
        if (!crossovers) continue;
        
        const ev = computeEvAtStopTargetChronological(crossovers, S, T, DEFAULT_DPP, DEFAULT_DPP, LIVE_INSTRUMENT.commissionPerRoundTrip);
        if (ev == null) continue;
        
        const simPnl = ev * t.sm; // multiply by real trade size multiplier
        const delta = simPnl - t.pnl;
        
        const stopRel = crossovers.stopHitAt[S];
        const targetRel = crossovers.targetHitAt[T];
        let simResRel = null;
        if (stopRel != null && (targetRel == null || stopRel <= targetRel)) simResRel = stopRel;
        else if (targetRel != null) simResRel = targetRel;
        
        const resIdx = simResRel != null ? Math.min(allBars.length - 1, t.barIdx + simResRel) : Math.min(allBars.length - 1, t.barIdx + 390);
        const simResTs = allBars[resIdx].ts;
        
        const lastRes = lastSimRes.get(t.setup_type) || 0;
        const isRefire = t.fired_ts <= lastRes + 15 * 60 * 1000;
        lastSimRes.set(t.setup_type, Math.max(lastRes, simResTs));
        
        legATotalCount++;
        legADelta += delta;
        if (isRefire) legAFlaggedCount++;
        else legADeltaNoRefire += delta;
        
        legAResults.push({ ...t, pnl: simPnl });
    }
    
    console.log(`Leg A N: ${legATotalCount}`);
    console.log(`Total P&L Delta: $${legADelta.toFixed(2)}`);
    console.log(`Refires Flagged: ${legAFlaggedCount}`);
    console.log(`Delta from first-touches: $${legADeltaNoRefire.toFixed(2)}`);
    console.log(`Delta from refires: $${(legADelta - legADeltaNoRefire).toFixed(2)}`);
    if (legATotalCount >= 20) {
        const rigor = computeRigor(legAResults, { dateField: 'trade_date', pnlFn: t => t.pnl });
        console.log(`Leg A Rigor: DistinctDates=${rigor.distinctDates}, Top5DayPct=${rigor.top5DayPct}%`);
    }

    console.log("\n=== Running Leg B ===");
    
    // Fetch all historical decisive trades to compute OLD formula stats
    const histTradesRes = await pool.query(`
        SELECT setup_type, trade_date, origin_status, actual_pnl::float as pnl, resolution, resolution_bar_time
        FROM active_setups
        WHERE resolution IN ('TARGET_HIT', 'STOP_HIT')
          AND actual_pnl IS NOT NULL
        ORDER BY resolution_bar_time ASC
    `);
    
    const allDecisive = histTradesRes.rows.map(t => ({
        ...t,
        trade_date_ts: new Date(t.trade_date).getTime(),
        res_ts: new Date(t.resolution_bar_time).getTime()
    }));
    
    // Fetch SETUP_STATUS audits
    const ssRes = await pool.query(`SELECT run_date, created_at, signal_name, recommendation, notes FROM performance_audit WHERE signal_type='SETUP_STATUS' ORDER BY created_at`);
    const ssHist = new Map();
    for (const row of ssRes.rows) {
        if (!ssHist.has(row.signal_name)) ssHist.set(row.signal_name, []);
        ssHist.get(row.signal_name).push({
            created_at: new Date(row.created_at).getTime(),
            run_date_ts: new Date(row.run_date).getTime(),
            oldRecommendation: null, // to be populated
            realRecommendation: row.recommendation
        });
    }

    // Compute OLD recommendation for each snapshot
    for (const [type, hist] of ssHist) {
        const typeTrades = allDecisive.filter(t => t.setup_type === type);
        let wasSuppressed = true; // Assume true initially
        
        for (const g of hist) {
            // Data available AT g.created_at
            const available = typeTrades.filter(t => t.res_ts < g.created_at);
            
            const n = available.length;
            const ev = n > 0 ? available.reduce((sum, t) => sum + t.pnl, 0) / n : 0;
            
            // rec90
            const cutoff = g.run_date_ts - 90 * 24 * 60 * 60 * 1000;
            const rec90Trades = available.filter(t => t.trade_date_ts >= cutoff);
            
            const rec90_n = rec90Trades.length;
            const rec90_ev = rec90_n > 0 ? rec90Trades.reduce((sum, t) => sum + t.pnl, 0) / rec90_n : 0;
            const rec90_wr = rec90_n > 0 ? rec90Trades.filter(t => t.resolution === 'TARGET_HIT').length / rec90_n : 0;
            const rec90_real_n = rec90Trades.filter(t => t.origin_status === 'ACTIVE' || t.origin_status === 'SHADOW').length;
            
            let rec = 'ACTIVE';
            
            if (wasSuppressed && rec90_n >= 15 && rec90_wr >= 0.52 && rec90_ev > 0 && rec90_real_n >= 5) {
                rec = 'PROMOTE';
            } else if (n >= 20 && ev < -5) {
                rec = 'SUPPRESS';
            } else if (n < 20) {
                rec = 'THIN_N';
            }
            
            g.oldRecommendation = rec;
            if (rec === 'SUPPRESS' || rec === 'THIN_N') wasSuppressed = true;
            if (rec === 'PROMOTE' || rec === 'ACTIVE') wasSuppressed = false;
        }
    }
    
    // Now evaluate Leg B P&L
    let legBDelta = 0;
    let keptAsIs = 0;
    let droppedWithSub = 0;
    let droppedNoSub = 0;
    let addedFromShadow = 0;
    
    let legBTotalCount = 0;
    const legBResults = [];
    
    // For substituting
    const allTradesLookup = new Map();
    for (const t of tradesRes.rows) {
        // use timestamp as precision for co-located
        const key = `${t.setup_type}_${new Date(t.fired_at).getTime()}`;
        allTradesLookup.set(key, t);
    }
    
    for (const t of trades) {
        if (!['TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED'].includes(t.resolution)) continue;
        
        const hist = ssHist.get(t.setup_type);
        let bestSs = null;
        if (hist) {
            for (const g of hist) { if (g.created_at < t.fired_ts) bestSs = g; else break; }
        }
        
        // If no hist, default to THIN_N (which behaves like SUPPRESS)
        const oldRec = bestSs ? bestSs.oldRecommendation : 'THIN_N';
        const isEligible = oldRec === 'ACTIVE' || oldRec === 'PROMOTE';
        
        if (t.origin_status === 'ACTIVE') {
            if (isEligible) {
                keptAsIs++;
                legBDelta += 0;
                legBTotalCount++;
                legBResults.push({ ...t, pnl: t.pnl });
            } else {
                let foundSub = false;
                if (t.selected_over && t.selected_over.length > 0) {
                    for (const siblingType of t.selected_over) {
                        const sHist = ssHist.get(siblingType);
                        let sBestSs = null;
                        if (sHist) {
                            for (const g of sHist) { if (g.created_at < t.fired_ts) sBestSs = g; else break; }
                        }
                        const sOldRec = sBestSs ? sBestSs.oldRecommendation : 'THIN_N';
                        if (sOldRec === 'ACTIVE' || sOldRec === 'PROMOTE') {
                            const sKey = `${siblingType}_${t.fired_ts}`;
                            const siblingTrade = allTradesLookup.get(sKey);
                            if (siblingTrade && siblingTrade.actual_pnl != null) {
                                droppedWithSub++;
                                const subPnl = siblingTrade.actual_pnl; // actual_pnl already scaled? Let's assume yes because we use t.pnl elsewhere which is actual_pnl
                                legBDelta += subPnl - t.pnl;
                                legBTotalCount++;
                                legBResults.push({ ...t, pnl: subPnl, setup_type: siblingType });
                                foundSub = true;
                                break;
                            }
                        }
                    }
                }
                if (!foundSub) {
                    droppedNoSub++;
                    legBDelta -= t.pnl;
                }
            }
        } else if (t.origin_status === 'SHADOW') {
            if (isEligible) {
                addedFromShadow++;
                legBDelta += t.pnl;
                legBTotalCount++;
                legBResults.push({ ...t, pnl: t.pnl });
            }
        }
    }
    
    console.log(`Leg B N: ${legBTotalCount} (excludes ${droppedNoSub} dropped without sub)`);
    console.log(`Total P&L Delta: $${legBDelta.toFixed(2)}`);
    console.log(`- Kept as-is: ${keptAsIs}`);
    console.log(`- Dropped (with substitute): ${droppedWithSub}`);
    console.log(`- Dropped (no substitute, flagged): ${droppedNoSub}`);
    console.log(`- Added from SHADOW: ${addedFromShadow}`);
    
    if (legBTotalCount >= 20) {
        const rigor = computeRigor(legBResults, { dateField: 'trade_date', pnlFn: t => t.pnl });
        console.log(`Leg B Rigor: DistinctDates=${rigor.distinctDates}, Top5DayPct=${rigor.top5DayPct}%`);
    } else {
        console.log("Leg B N < 20, rigor skipped.");
    }
}
main().then(() => pool.end()).catch(console.error);
