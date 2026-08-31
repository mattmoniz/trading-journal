// Sweep target = mfe50 / mfe75 / mfe90 (same 10pt fixed stop), following up on the
// mfe25 result (EV negative in both constructions, -$1.83/-$1.50, because a target
// that small relative to a 10pt stop needs ~75% WR to break even and only got
// 62-65%). User's own follow-up, 2026-08-24: "lets go yea try mfe 50 75 and 90."
//
// Reuses runStopOnlyFixed/runStopTarget/summarize from
// backtest_poc_rotation_fixed_stop_mfe25_target.mjs verbatim -- same stop mechanism
// (10pt fixed, intrabar touch), same Stage-1-then-Stage-2 discipline (MFE measured
// under the ACTUAL 10pt stop, not reused from a different stop regime).
import fs from 'fs';
import { query } from '../server/db.js';
import { recordClaim } from './record_claim.mjs';
import { detectSignalEvents, TICK, percentile } from './backtest_poc_rotation_vbp.mjs';
// This file's EV=$ output is dollar-correct ONLY TRANSITIVELY, via the imported `summarize()`'s
// own dollarPnl conversion (OPEN_DECISION poc_rotation_thread_points_mislabeled_as_dollars, fixed
// 2026-08-30) -- this file has no LIVE_INSTRUMENT/dollarPnl of its own (DeepSeek code review
// round 4, finding S3). `runBreakevenAtMfe` below defines its OWN trade-sim function but still
// feeds its result through the SAME imported `summarize()` -- keep it that way; a future "this
// one's different, let me write a local summarize" edit would silently reintroduce the bug.
import { runStopOnlyFixed, runStopTarget, summarize } from './backtest_poc_rotation_fixed_stop_mfe25_target.mjs';

const PATH = 'standard';
const R_PCT_REFERENCE_PRICE = 29547.75;
const R_PCT = 65 / R_PCT_REFERENCE_PRICE;
const STOP_PTS = 10;
const MFE_PERCENTILES = [0.25, 0.50, 0.75, 0.90]; // include p25 again for a full, comparable table

// Breakeven-at-mfe50: same 10pt initial stop; once favorable excursion reaches the
// mfe50 activation distance, snap the stop to breakeven (one-time, not an ongoing
// trail) and let it ride until it comes back to breakeven or the session ends.
// User's own follow-up, 2026-08-24: "lets trail to break even once at mfe 50."
//
// Mirrors server/services/breakevenTrailWalker.js's stepBreakevenTrail() semantics
// (arm-on-t1-touch, snap to entry, same-bar-arm-stop handling) rather than calling it
// directly -- that function's isSessionEnd check is hardcoded to ET hour>=16 (4pm,
// correct for its RTH-only callers), but this construction runs the full 24hr
// Globex+RTH window, so a 4pm cutoff would wrongly force-close overnight-entered
// trades. Re-derived here with a bars.length-based termination instead, matching how
// every other trade function in this rotation-VBP thread already ends a session.
export function runBreakevenAtMfe(event, bars, stopPts, activationPts, entryOffset = 1) {
    const entryIdx = event.trigger_idx + entryOffset;
    if (entryIdx >= bars.length) return null;
    const entryPx = bars[entryIdx].open;
    const entryTime = bars[entryIdx].ts;
    const long = event.direction === 'DOWN';
    const trade_direction = long ? 'LONG' : 'SHORT';
    const initialStopPx = long ? entryPx - stopPts : entryPx + stopPts;
    const activationPx = long ? entryPx + activationPts : entryPx - activationPts;

    let armed = false;
    let currentStop = initialStopPx;
    let resolution = null, exitTime = null, exit_idx = entryIdx;

    for (let i = entryIdx; i < bars.length; i++) {
        exit_idx = i;
        const bar = bars[i];

        if (!armed) {
            const stopTouched = long ? bar.low <= currentStop : bar.high >= currentStop;
            if (stopTouched) { resolution = { res: 'STOP_HIT', exitPx: currentStop }; exitTime = bar.ts; break; }
            const activationTouched = long ? bar.high >= activationPx : bar.low <= activationPx;
            if (activationTouched) {
                armed = true;
                currentStop = entryPx;
                // Same-bar-arm-stop: the bar that triggers activation could also whip
                // back through breakeven within itself -- checked explicitly, matching
                // stepBreakevenTrail's own SAME_BAR_ARM_STOP handling, rather than
                // assuming the trade "escaped" a same-bar reversal for free.
                const sameBarBreach = long ? bar.low <= currentStop : bar.high >= currentStop;
                if (sameBarBreach) { resolution = { res: 'BREAKEVEN_STOP_HIT' }; resolution.exitPx = currentStop; exitTime = bar.ts; break; }
            }
        } else {
            const stopTouched = long ? bar.low <= currentStop : bar.high >= currentStop;
            if (stopTouched) { resolution = { res: 'BREAKEVEN_STOP_HIT', exitPx: currentStop }; exitTime = bar.ts; break; }
        }
    }
    if (!resolution) { resolution = { res: 'TIME_EXPIRED', exitPx: bars[bars.length - 1].close }; exitTime = bars[bars.length - 1].ts; }
    const pnl = long ? resolution.exitPx - entryPx : entryPx - resolution.exitPx;
    return { entryTime, trade_direction, entryPx, stopPx: initialStopPx, activationPx, exitTime, exitReason: resolution.res, bars_to_resolution: exit_idx - entryIdx + 1, armed, pnl };
}

async function runConstruction(label, R, rMode, sessions, csvChunks) {
    const resMed = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
    const THETA = Math.max(TICK, resMed.rows[0].median_range);
    const { all_signal, legCount } = detectSignalEvents(R, PATH, THETA, sessions, rMode);

    // Stage 1: MFE distribution under the actual 10pt stop (once, reused for every target percentile).
    const stage1 = all_signal.map(e => {
        const session = sessions.find(s => s.t === e.t);
        const res = runStopOnlyFixed(e, session.bars, STOP_PTS, 1);
        return res ? { e, res } : null;
    }).filter(Boolean);
    const mfes = stage1.map(r => r.res.mfe).sort((a, b) => a - b);

    console.log(`\n=== ${label} (legCount=${legCount}, signal=${all_signal.length}, stage1 N=${stage1.length}) ===`);

    const variants = [];
    for (const p of MFE_PERCENTILES) {
        const targetPts = percentile(mfes, p);
        const stage2 = all_signal.map(e => {
            const session = sessions.find(s => s.t === e.t);
            const res = runStopTarget(e, session.bars, STOP_PTS, targetPts, 1);
            return res ? { e, res } : null;
        }).filter(Boolean);
        const summary = summarize(stage2, true);
        const breakevenWR = (STOP_PTS / (STOP_PTS + targetPts) * 100).toFixed(1);
        variants.push({ pctile: p, targetPts, summary, breakevenWR });
        console.log(`  mfe${Math.round(p * 100)}=${targetPts.toFixed(2)}pt (breakeven WR=${breakevenWR}%): N=${summary.N} WR=${summary.wr}% EV=$${summary.ev} exits=${JSON.stringify(summary.exitBreakdown)} (${summary.rigorStr})`);

        for (const { e, res } of stage2) {
            csvChunks.push(`${label},TARGET_mfe${Math.round(p * 100)},${e.t},${e.direction},${res.entryTime},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${res.targetPx.toFixed(2)},${res.exitTime},${res.exitReason},${res.bars_to_resolution},${res.pnl.toFixed(2)}\n`);
        }
    }

    // Breakeven-at-mfe50: same 10pt stop, activation = the same mfe50 distance used
    // above as a fixed target, but here it snaps the stop to breakeven instead of
    // exiting, then lets the trade ride with no further cap.
    const mfe50 = variants.find(v => v.pctile === 0.50).targetPts;
    const stageBE = all_signal.map(e => {
        const session = sessions.find(s => s.t === e.t);
        const res = runBreakevenAtMfe(e, session.bars, STOP_PTS, mfe50, 1);
        return res ? { e, res } : null;
    }).filter(Boolean);
    const beSummary = summarize(stageBE, true);
    console.log(`  BREAKEVEN_AT_MFE50 (activation=${mfe50.toFixed(2)}pt, stop=10pt then breakeven): N=${beSummary.N} WR=${beSummary.wr}% EV=$${beSummary.ev} exits=${JSON.stringify(beSummary.exitBreakdown)} armed=${stageBE.filter(x => x.res.armed).length}/${stageBE.length} (${beSummary.rigorStr})`);
    for (const { e, res } of stageBE) {
        csvChunks.push(`${label},BREAKEVEN_AT_MFE50,${e.t},${e.direction},${res.entryTime},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${res.activationPx.toFixed(2)},${res.exitTime},${res.exitReason},${res.bars_to_resolution},${res.pnl.toFixed(2)}\n`);
    }

    return { label, R, rMode, THETA, legCount, variants, mfe50, beSummary, armedCount: stageBE.filter(x => x.res.armed).length, beN: stageBE.length };
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
    console.log(`Loaded ${sessions.length} sessions. Stop=${STOP_PTS}pts fixed (intrabar touch).`);

    const csvChunks = [`construction,variant,trade_date,leg_direction,entry_time,direction,entry_price,stop_price,target_or_activation_price,exit_time,exit_reason,bars_to_resolution,pnl\n`];

    const fixedResult = await runConstruction('FIXED_R65', 65, 'fixed', sessions, csvChunks);
    const pctResult = await runConstruction('PCT_R0.22pct', R_PCT, 'pct', sessions, csvChunks);

    if (!fs.existsSync('reports')) fs.mkdirSync('reports');
    fs.writeFileSync('reports/poc_rotation_fixed_stop_mfe_sweep_trades.csv', csvChunks.join(''));
    fs.writeFileSync('scratch/poc_rotation_fixed_stop_mfe_sweep_report.json', JSON.stringify({ STOP_PTS, fixedResult, pctResult }, null, 2));

    for (const result of [fixedResult, pctResult]) {
        const lines = result.variants.map(v =>
            `  mfe${Math.round(v.pctile * 100)}=${v.targetPts.toFixed(2)}pt (breakeven WR=${v.breakevenWR}%): N=${v.summary.N} (days=${v.summary.distinctDates}) WR=${v.summary.wr}% EV=$${v.summary.ev} exits=${JSON.stringify(v.summary.exitBreakdown)} (${v.summary.rigorStr})`
        ).join('\n');
        const beLine = `  BREAKEVEN_AT_MFE50 (stop=${STOP_PTS}pt, activation=${result.mfe50.toFixed(2)}pt then snap stop to breakeven, ride to breakeven-stop-out or session end): N=${result.beSummary.N} (days=${result.beSummary.distinctDates}) WR=${result.beSummary.wr}% EV=$${result.beSummary.ev} exits=${JSON.stringify(result.beSummary.exitBreakdown)} armed=${result.armedCount}/${result.beN} (${result.beSummary.rigorStr})`;
        const claimText = `Fixed stop=${STOP_PTS}pt (intrabar touch), target swept across mfe25/50/75/90 (percentiles of the MFE distribution measured under this SAME 10pt stop) PLUS a breakeven-at-mfe50 variant (activate at mfe50, snap stop to breakeven, no fixed target), rotation-VBP SIGNAL population, ${result.label} construction (R=${result.R}, mode=${result.rMode}, THETA=${result.THETA.toFixed(2)}). delay=0, unfiltered by delta intensity. Follow-up to poc_rotation_fixed10_mfe25_target_${result.rMode} (mfe25 alone, both EV negative).
${lines}
${beLine}`;

        const allCandidates = [...result.variants.map(v => v.summary), result.beSummary].filter(s => s.N >= 20);
        const best = allCandidates.sort((a, b) => b.valEV - a.valEV)[0];
        if (best) {
            await recordClaim({
                slug: `poc_rotation_fixed10_mfe_sweep_${result.rMode}`,
                claimText,
                sourceFile: 'scripts/backtest_poc_rotation_fixed_stop_mfe_sweep.mjs',
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
