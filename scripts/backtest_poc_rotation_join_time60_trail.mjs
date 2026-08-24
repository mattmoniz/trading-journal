// Add a real ratcheting trail to the JOIN/Time60/Stop20 winner, motivated directly by
// the MFE breakdown: trades that eventually stop out had already reached a median
// ~11-12pts of favorable room before reversing, and trades that survive to the
// 60-minute mark are sitting on a median ~44-54pts at some point during the hold --
// neither is currently captured by a plain stop/no-target design. User's follow-up,
// 2026-08-24: "Yes" (to testing a breakeven/trail mechanism).
//
// Mirrors server/services/breakevenTrailWalker.js's stepBreakevenTrail() semantics
// (arm on activation touch, same-bar-arm-stop handling, trail floored at breakeven,
// ratchet-only) with a REAL non-zero trailWidth this time -- the earlier
// "breakeven-at-mfe50" test in this thread used an effectively-zero-buffer snap
// (stop = exact entry, no further trailing) and it performed terribly (WR collapsed
// to ~1%) because a zero-buffer stop gets chopped at exactly $0 by ordinary noise
// before any trend has a chance to develop. This time the stop trails BEHIND the
// peak by a real trailWidth, not frozen at breakeven.
//
// Data-derived activation (no static thresholds): Stage 1 rebuilds the plain
// JOIN/Time60/Stop20 MFE distribution (no trail) and takes its p25 as the activation
// level, matching the exact discipline already used earlier in this thread
// (backtest_poc_rotation_fixed_stop_mfe25_target.mjs). Stage 2 sweeps trailWidth
// across {10, 15, 20} points against that same activation.
import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { detectSignalEvents, TICK, formatET, mean, percentile } from './backtest_poc_rotation_vbp.mjs';

const PATH = 'standard';
const R_PCT_REFERENCE_PRICE = 29547.75;
const R_PCT = 65 / R_PCT_REFERENCE_PRICE;
const STOP_PTS = 20;
const TIME_LIMIT_BARS = 60;
const TRAIL_WIDTHS = [10, 15, 20];

// Stage 1: plain stop + time-limit, no trail. Tracks MFE for activation derivation.
function runPlain(event, bars, entryOffset = 1) {
    const entryIdx = event.trigger_idx + entryOffset;
    if (entryIdx >= bars.length) return null;
    const entryPx = bars[entryIdx].open;
    const entryTime = bars[entryIdx].ts;
    const long = event.direction === 'UP'; // JOIN
    const trade_direction = long ? 'LONG' : 'SHORT';
    const stopPx = long ? entryPx - STOP_PTS : entryPx + STOP_PTS;

    let mfe = 0;
    let resolution = null, exitTime = null, exit_idx = entryIdx;
    for (let i = entryIdx; i < bars.length; i++) {
        exit_idx = i;
        const bar = bars[i];
        const favorable = long ? (bar.high - entryPx) : (entryPx - bar.low);
        if (favorable > mfe) mfe = favorable;
        if ((i - entryIdx) >= TIME_LIMIT_BARS) { resolution = { res: 'TIME_LIMIT', exitPx: bar.close }; exitTime = bar.ts; break; }
        const stopTouched = long ? bar.low <= stopPx : bar.high >= stopPx;
        if (stopTouched) { resolution = { res: 'STOP_HIT', exitPx: stopPx }; exitTime = bar.ts; break; }
    }
    if (!resolution) { resolution = { res: 'TIME_EXPIRED', exitPx: bars[bars.length - 1].close }; exitTime = bars[bars.length - 1].ts; }
    const pnl = long ? resolution.exitPx - entryPx : entryPx - resolution.exitPx;
    return { entryTime, trade_direction, entryPx, stopPx, exitTime, exitReason: resolution.res, bars_to_resolution: exit_idx - entryIdx + 1, mfe, pnl };
}

// Stage 2: real ratcheting trail. Arm on activation touch (same-bar-arm-stop handled),
// then trail the stop behind the peak by trailWidth, floored at breakeven, ratchet-only
// (never loosens). 60-minute time limit still caps the hold regardless of arm state.
function runWithTrail(event, bars, activationPts, trailWidth, entryOffset = 1) {
    const entryIdx = event.trigger_idx + entryOffset;
    if (entryIdx >= bars.length) return null;
    const entryPx = bars[entryIdx].open;
    const entryTime = bars[entryIdx].ts;
    const long = event.direction === 'UP';
    const trade_direction = long ? 'LONG' : 'SHORT';
    const initialStopPx = long ? entryPx - STOP_PTS : entryPx + STOP_PTS;
    const activationPx = long ? entryPx + activationPts : entryPx - activationPts;

    let armed = false;
    let peak = null;
    let trailStopPx = initialStopPx;
    let resolution = null, exitTime = null, exit_idx = entryIdx;

    for (let i = entryIdx; i < bars.length; i++) {
        exit_idx = i;
        const bar = bars[i];

        if ((i - entryIdx) >= TIME_LIMIT_BARS) { resolution = { res: 'TIME_LIMIT', exitPx: bar.close }; exitTime = bar.ts; break; }

        if (!armed) {
            const activationTouched = long ? bar.high >= activationPx : bar.low <= activationPx;
            const stopTouched = long ? bar.low <= initialStopPx : bar.high >= initialStopPx;
            if (activationTouched && stopTouched) { resolution = { res: 'STOP_HIT', exitPx: initialStopPx, method: 'SAME_BAR_STOP_FIRST' }; exitTime = bar.ts; break; }
            if (activationTouched) {
                armed = true;
                peak = long ? bar.high : bar.low;
                const rawTrail = long ? peak - trailWidth : peak + trailWidth;
                trailStopPx = long ? Math.max(entryPx, rawTrail) : Math.min(entryPx, rawTrail);
                const sameBarBreach = long ? bar.low <= trailStopPx : bar.high >= trailStopPx;
                if (sameBarBreach) { resolution = { res: 'TRAIL_EXIT', exitPx: trailStopPx, method: 'SAME_BAR_ARM' }; exitTime = bar.ts; break; }
            } else if (stopTouched) {
                resolution = { res: 'STOP_HIT', exitPx: initialStopPx }; exitTime = bar.ts; break;
            }
        } else {
            if (long && bar.high > peak) peak = bar.high;
            if (!long && bar.low < peak) peak = bar.low;
            const rawTrail = long ? peak - trailWidth : peak + trailWidth;
            const candidateStop = long ? Math.max(entryPx, rawTrail) : Math.min(entryPx, rawTrail);
            if (long && candidateStop > trailStopPx) trailStopPx = candidateStop;
            if (!long && candidateStop < trailStopPx) trailStopPx = candidateStop;
            const trailHit = long ? bar.low <= trailStopPx : bar.high >= trailStopPx;
            if (trailHit) { resolution = { res: 'TRAIL_EXIT', exitPx: trailStopPx }; exitTime = bar.ts; break; }
        }
    }
    if (!resolution) { resolution = { res: 'TIME_EXPIRED', exitPx: bars[bars.length - 1].close }; exitTime = bars[bars.length - 1].ts; }
    const pnl = long ? resolution.exitPx - entryPx : entryPx - resolution.exitPx;
    return { entryTime, trade_direction, entryPx, stopPx: initialStopPx, activationPx, exitTime, exitReason: resolution.res, bars_to_resolution: exit_idx - entryIdx + 1, armed, pnl };
}

function summarize(results) {
    const N = results.length;
    if (N === 0) return { N: 0 };
    const distinctDates = new Set(results.map(r => r.e.t)).size;
    const wins = results.filter(r => r.res.pnl > 0).length;
    const wr = (wins / N * 100).toFixed(1);
    const ev = (results.reduce((s, r) => s + r.res.pnl, 0) / N).toFixed(2);
    let rigorStr = 'n/a (N<20)';
    if (N >= 20) {
        const rigor = computeRigor(results.map(r => ({ t: r.e.t, pnl: r.res.pnl })), { dateField: 't', pnlFn: r => r.pnl });
        rigorStr = `stable=${rigor.stable} cluster=${rigor.clustered}`;
    }
    const exitBreakdown = {};
    for (const r of results) exitBreakdown[r.res.exitReason] = (exitBreakdown[r.res.exitReason] || 0) + 1;
    return { N, distinctDates, wr, ev, valEV: Number(ev), rigorStr, exitBreakdown };
}

async function runConstruction(label, R, rMode, sessions, csvChunks) {
    const resMed = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
    const THETA = Math.max(TICK, resMed.rows[0].median_range);
    const { all_signal } = detectSignalEvents(R, PATH, THETA, sessions, rMode);
    console.log(`\n=== ${label} (signal=${all_signal.length}) ===`);

    const stage1 = all_signal.map(e => {
        const session = sessions.find(s => s.t === e.t);
        const res = runPlain(e, session.bars, 1);
        return res ? { e, res } : null;
    }).filter(Boolean);
    const mfes = stage1.map(r => r.res.mfe).sort((a, b) => a - b);
    const activation = percentile(mfes, 0.25);
    const baseline = summarize(stage1);
    console.log(`  Baseline (no trail): N=${baseline.N} WR=${baseline.wr}% EV=$${baseline.ev} (${baseline.rigorStr})`);
    console.log(`  Activation (mfe25) = ${activation.toFixed(2)}pt`);

    const trailResults = {};
    for (const trailWidth of TRAIL_WIDTHS) {
        const results = all_signal.map(e => {
            const session = sessions.find(s => s.t === e.t);
            const res = runWithTrail(e, session.bars, activation, trailWidth, 1);
            return res ? { e, res } : null;
        }).filter(Boolean);
        const summary = summarize(results);
        trailResults[trailWidth] = summary;
        console.log(`  Trail=${trailWidth}pt: N=${summary.N} WR=${summary.wr}% EV=$${summary.ev} exits=${JSON.stringify(summary.exitBreakdown)} armed=${results.filter(r => r.res.armed).length}/${results.length} (${summary.rigorStr})`);

        for (const { e, res } of results) {
            const session = sessions.find(s => s.t === e.t);
            csvChunks.push(`${label},trail${trailWidth},${e.t},${e.direction},${formatET(res.entryTime)},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${res.activationPx.toFixed(2)},${formatET(res.exitTime)},${res.exitReason},${res.bars_to_resolution},${res.pnl.toFixed(2)}\n`);
        }
    }

    return { label, activation, baseline, trailResults };
}

async function main() {
    const dvl = (await query(`SELECT trade_date::text as t FROM developing_value_log ORDER BY trade_date DESC`)).rows.reverse();
    const sessions = [];
    for (const row of dvl) {
        const bars = (await query(`
          SELECT ts, ts::date::text as d, high::float, low::float, close::float, open::float, volume::float as volume
          FROM price_bars_primary WHERE symbol='NQ' AND (
            (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
            (ts::date = $1 AND EXTRACT(hour FROM ts) < 17)
          ) ORDER BY ts`, [row.t])).rows;
        if (bars.length < 300) continue;
        sessions.push({ t: row.t, bars });
    }
    console.log(`Loaded ${sessions.length} sessions. JOIN/Stop20/60min, trail widths ${TRAIL_WIDTHS.join('/')}.`);

    const csvChunks = [`construction,variant,trade_date,leg_direction,entry_time,direction,entry_price,stop_price,activation_price,exit_time,exit_reason,bars_to_resolution,pnl\n`];
    const fixedResult = await runConstruction('FIXED_R65', 65, 'fixed', sessions, csvChunks);
    const pctResult = await runConstruction('PCT_R0.22pct', R_PCT, 'pct', sessions, csvChunks);

    if (!fs.existsSync('reports')) fs.mkdirSync('reports');
    fs.writeFileSync('reports/poc_rotation_join_time60_trail_trades.csv', csvChunks.join(''));
    fs.writeFileSync('scratch/poc_rotation_join_time60_trail_report.json', JSON.stringify({ fixedResult, pctResult }, null, 2));

    for (const result of [fixedResult, pctResult]) {
        const lines = Object.entries(result.trailResults).map(([tw, v]) =>
            `  trail=${tw}pt: N=${v.N} (days=${v.distinctDates}) WR=${v.wr}% EV=$${v.ev} exits=${JSON.stringify(v.exitBreakdown)} (${v.rigorStr})`
        ).join('\n');
        const claimText = `JOIN/Time60/Stop20 + a real ratcheting trail (activation=mfe25=${result.activation.toFixed(2)}pt derived from the plain-stop MFE distribution, trail floored at breakeven, ratchet-only -- NOT the earlier flawed zero-buffer breakeven-once snap). ${result.label} construction.
Baseline (no trail): N=${result.baseline.N} WR=${result.baseline.wr}% EV=$${result.baseline.ev} (${result.baseline.rigorStr})
${lines}`;
        const best = Object.values(result.trailResults).filter(v => v.N >= 20).sort((a, b) => b.valEV - a.valEV)[0];
        if (best) {
            await recordClaim({
                slug: `poc_rotation_join_time60_trail_${result.label === 'FIXED_R65' ? 'fixed' : 'pct'}`,
                claimText,
                sourceFile: 'scripts/backtest_poc_rotation_join_time60_trail.mjs',
                sampleSize: best.N,
                winRate: best.wr / 100,
                evPerTrade: best.valEV,
                rigorStatus: best.rigorStr,
                status: 'PROVISIONAL',
            });
        }
    }

    console.log('\nDONE');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
