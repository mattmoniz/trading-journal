// BLIND-DELAY CONTROL (2026-08-24, DeepSeek-caught confound in the 2-consecutive-close
// confirmation gate): the gate scripts compare `wait=0, ALL events, entry now` against
// `wait=N, GATED events, entry N bars later` -- two things change at once (which events,
// and when you enter), so the reported EV drop can't be attributed to the level condition
// at all. This script isolates the entry-timing cost alone: ALL events (no gate filter),
// same delayed entryOffset=waitBars+1 as the gated version. Diff this against wait=0 to
// get the pure cost of delay; diff the GATED script's own numbers against THIS to get the
// gate's actual selection value, properly controlled -- CLAUDE.md confound checklist item
// 1 (does the "smarter" arm still win with the intelligence stripped out).
//
// JOIN direction (trade WITH the leg) and the 20pt stop / 60min hold are this thread's
// already-established winner (backtest_poc_rotation_join_fade_levels.mjs).
import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { detectSignalEvents, TICK, formatET, mean, percentile } from './backtest_poc_rotation_vbp.mjs';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

// FIXED 2026-08-30 (OPEN_DECISION poc_rotation_thread_points_mislabeled_as_dollars): EV/WR
// below used to be raw price points printed with a "$" prefix. res.pnl stays in points
// (trade-sim/CSV/MFE distances unaffected); only summarize()'s EV/WR/recordClaim conversion
// changed.
const PPT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const dollarPnl = r => r.res.pnl * PPT - COMM;

const PATH = 'standard';
const R_PCT_REFERENCE_PRICE = 29547.75;
const R_PCT = 65 / R_PCT_REFERENCE_PRICE;
const STOP_PTS = 20;
const TIME_LIMIT_BARS = 60;
const WAIT_MINUTES = [0, 2, 3, 5]; // 0 = baseline, no confirmation wait

// Does the level hold during the wait window (bars trigger_idx+1 .. trigger_idx+waitBars)?
// long trade: level acts as support -> no bar may CLOSE below L. short trade: resistance
// -> no bar may CLOSE above L. Uses closes (not intrabar touches) to match the "2
// consecutive closes" convention already established for this level elsewhere in this
// thread, just checked as a single-close-fails gate here (stricter, deliberately -- a
// single close through during the wait is read as the level having already failed).
function levelHeldDuringWait(event, bars, waitBars, long) {
    let wrongCloses = 0;
    for (let i = event.trigger_idx + 1; i <= event.trigger_idx + waitBars && i < bars.length; i++) {
        const closedWrong = long ? bars[i].close < event.L : bars[i].close > event.L;
        if (closedWrong) wrongCloses++;
        else wrongCloses = 0;
        
        if (wrongCloses >= 2) return false;
    }
    return true;
}

function runTrade(event, bars, entryOffset, targetPts) {
    const entryIdx = event.trigger_idx + entryOffset;
    if (entryIdx >= bars.length) return null;
    const entryPx = bars[entryIdx].open;
    const entryTime = bars[entryIdx].ts;
    const long = event.direction === 'UP'; // JOIN
    const trade_direction = long ? 'LONG' : 'SHORT';
    const stopPx = long ? entryPx - STOP_PTS : entryPx + STOP_PTS;
    const targetPx = targetPts != null ? (long ? entryPx + targetPts : entryPx - targetPts) : null;

    let mfe = 0;
    let resolution = null, exitTime = null, exit_idx = entryIdx;
    for (let i = entryIdx; i < bars.length; i++) {
        exit_idx = i;
        const bar = bars[i];
        const favorable = long ? (bar.high - entryPx) : (entryPx - bar.low);
        if (favorable > mfe) mfe = favorable;
        if (targetPts == null && (i - entryIdx) >= TIME_LIMIT_BARS) { resolution = { res: 'TIME_LIMIT', exitPx: bar.close }; exitTime = bar.ts; break; }
        const stopTouched = long ? bar.low <= stopPx : bar.high >= stopPx;
        if (stopTouched) { resolution = { res: 'STOP_HIT', exitPx: stopPx }; exitTime = bar.ts; break; }
        if (targetPx != null) {
            const targetTouched = long ? bar.high >= targetPx : bar.low <= targetPx;
            if (targetTouched) { resolution = { res: 'TARGET_HIT', exitPx: targetPx }; exitTime = bar.ts; break; }
        }
    }
    if (!resolution) { resolution = { res: 'TIME_EXPIRED', exitPx: bars[bars.length - 1].close }; exitTime = bars[bars.length - 1].ts; }
    const pnl = long ? resolution.exitPx - entryPx : entryPx - resolution.exitPx;
    return { entryTime, trade_direction, entryPx, stopPx, targetPx, exitTime, exitReason: resolution.res, bars_to_resolution: exit_idx - entryIdx + 1, mfe, pnl };
}

function summarize(results) {
    const N = results.length;
    if (N === 0) return { N: 0 };
    const distinctDates = new Set(results.map(r => r.e.t)).size;
    const wins = results.filter(r => dollarPnl(r) > 0).length;
    const wr = (wins / N * 100).toFixed(1);
    const ev = (results.reduce((s, r) => s + dollarPnl(r), 0) / N).toFixed(2);
    let rigorStr = 'n/a (N<20)';
    if (N >= 20) {
        const rigor = computeRigor(results.map(r => ({ t: r.e.t, pnl: dollarPnl(r) })), { dateField: 't', pnlFn: r => r.pnl });
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

    const byWait = {};
    for (const waitBars of WAIT_MINUTES) {
        // BLIND CONTROL: no gate filter at all, ALL events pass through regardless of
        // whether the level held during the wait -- only the entry timing changes.
        const gated = all_signal;
        console.log(`  --- wait=${waitBars}min (BLIND, no gate): gated=${gated.length}/${all_signal.length} (100.0%) ---`);

        // Section 1: SAME plain 20pt-stop/Time60 structure as the established winner --
        // isolates whether waiting for confirmation changes WR/EV at all, holding the
        // exit mechanism fixed.
        const entryOffset = waitBars + 1;
        const plainResults = gated.map(e => {
            const session = sessions.find(s => s.t === e.t);
            const res = runTrade(e, session.bars, entryOffset, null);
            return res ? { e, res } : null;
        }).filter(Boolean);
        const plainSummary = summarize(plainResults);
        console.log(`    Section1 (plain Stop20/Time60): N=${plainSummary.N} WR=${plainSummary.wr}% EV=$${plainSummary.ev} (${plainSummary.rigorStr})`);

        // Section 2: wider targets derived from THIS gated population's own MFE
        // distribution under the plain stop (no static thresholds).
        const mfes = plainResults.map(r => r.res.mfe).sort((a, b) => a - b);
        const targetVariants = {};
        if (mfes.length > 0) {
            for (const pct of [0.50, 0.75]) {
                const targetPts = percentile(mfes, pct);
                const results = gated.map(e => {
                    const session = sessions.find(s => s.t === e.t);
                    const res = runTrade(e, session.bars, entryOffset, targetPts);
                    return res ? { e, res } : null;
                }).filter(Boolean);
                const summary = summarize(results);
                targetVariants[`mfe${Math.round(pct * 100)}`] = { targetPts, summary };
                console.log(`    Section2 target=mfe${Math.round(pct * 100)}=${targetPts.toFixed(2)}pt: N=${summary.N} WR=${summary.wr}% EV=$${summary.ev} exits=${JSON.stringify(summary.exitBreakdown)} (${summary.rigorStr})`);
                for (const { e, res } of results) {
                    const session = sessions.find(s => s.t === e.t);
                    csvChunks.push(`${label},wait${waitBars}_mfe${Math.round(pct * 100)},${e.t},${e.direction},${formatET(res.entryTime)},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${res.targetPx != null ? res.targetPx.toFixed(2) : ''},${formatET(res.exitTime)},${res.exitReason},${res.bars_to_resolution},${res.pnl.toFixed(2)}\n`);
                }
            }
        }
        for (const { e, res } of plainResults) {
            const session = sessions.find(s => s.t === e.t);
            csvChunks.push(`${label},wait${waitBars}_plain,${e.t},${e.direction},${formatET(res.entryTime)},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},,${formatET(res.exitTime)},${res.exitReason},${res.bars_to_resolution},${res.pnl.toFixed(2)}\n`);
        }

        byWait[waitBars] = { gatedN: gated.length, plainSummary, targetVariants };
    }

    return { label, allSignalN: all_signal.length, byWait };
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
    console.log(`Loaded ${sessions.length} sessions. Confirmation waits: ${WAIT_MINUTES.join('/')}min.`);

    const csvChunks = [`construction,variant,trade_date,leg_direction,entry_time,direction,entry_price,stop_price,target_price,exit_time,exit_reason,bars_to_resolution,pnl\n`];
    const fixedResult = await runConstruction('FIXED_R65', 65, 'fixed', sessions, csvChunks);
    const pctResult = await runConstruction('PCT_R0.22pct', R_PCT, 'pct', sessions, csvChunks);

    if (!fs.existsSync('reports')) fs.mkdirSync('reports');
    // FIXED 2026-08-30 (DeepSeek code review round 4, finding S2): this used to write the SAME
    // two paths as backtest_poc_rotation_join_confirm_2close.mjs (copy-paste from that script,
    // same commit) -- identical CSV header + identical wait{0,2,3,5}_{plain,mfe50,mfe75} variant
    // labels made the two scripts' output files indistinguishable, and whichever ran second
    // silently clobbered the other's data. Confirmed real damage: this script's own fresh JSON
    // was overwritten 5 minutes later by confirm_2close.mjs during the 2026-08-30 poc_rotation
    // dollar-fix re-run, and the only surviving record of this run's real numbers was its own
    // stdout log (scratch/poc_rotation_rerun_logs/backtest_poc_rotation_join_blind_delay_control.log).
    fs.writeFileSync('reports/poc_rotation_join_blind_delay_control_trades.csv', csvChunks.join(''));
    fs.writeFileSync('scratch/poc_rotation_join_blind_delay_control_report.json', JSON.stringify({ fixedResult, pctResult }, null, 2));

    for (const result of [fixedResult, pctResult]) {
        const lines = Object.entries(result.byWait).map(([wb, v]) => {
            const tvLines = Object.entries(v.targetVariants).map(([k, t]) => `      ${k}=${t.targetPts.toFixed(2)}pt: N=${t.summary.N} WR=${t.summary.wr}% EV=$${t.summary.ev} (${t.summary.rigorStr})`).join('\n');
            return `  wait=${wb}min: gated=${v.gatedN}/${result.allSignalN}\n    plain Stop20/Time60: N=${v.plainSummary.N} (days=${v.plainSummary.distinctDates}) WR=${v.plainSummary.wr}% EV=$${v.plainSummary.ev} (${v.plainSummary.rigorStr})\n${tvLines}`;
        }).join('\n');
        const claimText = `BLIND-DELAY CONTROL (no gate, all events pass, only entry timing changes) for the confirmation-gate confound check (DeepSeek audit, 2026-08-24). Diff against poc_rotation_join_confirm_2close_${result.label === 'FIXED_R65' ? 'fixed' : 'pct'}'s own gated numbers to isolate the gate's real selection value from the entry-price-shift cost. ${result.label} construction.
${lines}`;
        const wait0 = result.byWait[0].plainSummary;
        const bestGated = [2, 3, 5].flatMap(wb => [result.byWait[wb].plainSummary, ...Object.values(result.byWait[wb].targetVariants).map(t => t.summary)])
            .filter(s => s.N >= 20).sort((a, b) => b.valEV - a.valEV)[0];
        if (bestGated) {
            await recordClaim({
                slug: `poc_rotation_join_blind_delay_control_${result.label === 'FIXED_R65' ? 'fixed' : 'pct'}`,
                claimText,
                sourceFile: 'scripts/backtest_poc_rotation_join_blind_delay_control.mjs',
                sampleSize: bestGated.N,
                winRate: bestGated.wr / 100,
                evPerTrade: bestGated.valEV,
                rigorStatus: bestGated.rigorStr,
                status: 'PROVISIONAL',
            });
        }
        console.log(`\n${result.label} baseline (wait=0) WR=${wait0.wr}% EV=$${wait0.ev}`);
    }

    console.log('\nDONE');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
