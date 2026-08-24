// MFE for the JOIN/Time60_Stop20 winner (backtest_poc_rotation_join_fade_levels.mjs) --
// how far these trades actually ran in the favorable direction before/during their
// 60-minute hold, to see how much is being left on the table by the no-target design.
// User's follow-up, 2026-08-24.
import fs from 'fs';
import { query } from '../server/db.js';
import { mean, percentile } from './backtest_poc_rotation_vbp.mjs';
import { detectSignalEvents, TICK, formatET } from './backtest_poc_rotation_vbp.mjs';

const PATH = 'standard';
const R_PCT_REFERENCE_PRICE = 29547.75;
const R_PCT = 65 / R_PCT_REFERENCE_PRICE;
const STOP_PTS = 20;
const TIME_LIMIT_BARS = 60;

function runJoinTime60WithMfe(event, bars, entryOffset = 1) {
    const entryIdx = event.trigger_idx + entryOffset;
    if (entryIdx >= bars.length) return null;
    const entryPx = bars[entryIdx].open;
    const entryTime = bars[entryIdx].ts;
    const legIsUp = event.direction === 'UP';
    const long = legIsUp; // JOIN
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

async function runConstruction(label, R, rMode, sessions, csvChunks) {
    const resMed = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
    const THETA = Math.max(TICK, resMed.rows[0].median_range);
    const { all_signal } = detectSignalEvents(R, PATH, THETA, sessions, rMode);

    const results = all_signal.map(e => {
        const session = sessions.find(s => s.t === e.t);
        const res = runJoinTime60WithMfe(e, session.bars, 1);
        return res ? { e, res } : null;
    }).filter(Boolean);

    const mfes = results.map(r => r.res.mfe).sort((a, b) => a - b);
    const pnls = results.map(r => r.res.pnl);
    const N = results.length;
    const wr = (results.filter(r => r.res.pnl > 0).length / N * 100).toFixed(1);
    const ev = (pnls.reduce((s, x) => s + x, 0) / N).toFixed(2);
    const stopHitPct = (results.filter(r => r.res.exitReason === 'STOP_HIT').length / N * 100).toFixed(1);
    const timeLimitPct = (results.filter(r => r.res.exitReason === 'TIME_LIMIT').length / N * 100).toFixed(1);

    console.log(`\n=== ${label} (N=${N}) ===`);
    console.log(`  WR=${wr}% EV=$${ev} stopHit%=${stopHitPct} timeLimit%=${timeLimitPct}`);
    console.log(`  MFE: mean=${mean(mfes).toFixed(2)} p25=${percentile(mfes, 0.25).toFixed(2)} p50=${percentile(mfes, 0.5).toFixed(2)} p75=${percentile(mfes, 0.75).toFixed(2)} p90=${percentile(mfes, 0.9).toFixed(2)} max=${mfes[mfes.length - 1].toFixed(2)}`);
    // MFE split by how the trade actually exited, to see if stopped-out trades still had real room.
    const byExit = {};
    for (const r of results) {
        (byExit[r.res.exitReason] = byExit[r.res.exitReason] || []).push(r.res.mfe);
    }
    for (const [reason, arr] of Object.entries(byExit)) {
        const sorted = arr.sort((a, b) => a - b);
        console.log(`    ${reason} (N=${arr.length}): MFE mean=${mean(sorted).toFixed(2)} p50=${percentile(sorted, 0.5).toFixed(2)}`);
    }

    for (const { e, res } of results) {
        const session = sessions.find(s => s.t === e.t);
        const leg_ts = formatET(session.bars[e.leg_start].ts);
        csvChunks.push(`${label},${e.t},${leg_ts},${e.direction},${formatET(res.entryTime)},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${formatET(res.exitTime)},${res.exitReason},${res.bars_to_resolution},${res.mfe.toFixed(2)},${res.pnl.toFixed(2)}\n`);
    }

    return { N, wr, ev, stopHitPct, timeLimitPct, mfeMean: mean(mfes), mfeP25: percentile(mfes, 0.25), mfeP50: percentile(mfes, 0.5), mfeP75: percentile(mfes, 0.75), mfeP90: percentile(mfes, 0.9), mfeMax: mfes[mfes.length - 1] };
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
    console.log(`Loaded ${sessions.length} sessions. JOIN/Time60_Stop20 (stop=${STOP_PTS}pt, hold=${TIME_LIMIT_BARS}min).`);

    const csvChunks = [`construction,trade_date,leg_anchor_time,leg_direction,entry_time,direction,entry_price,stop_price,exit_time,exit_reason,bars_to_resolution,mfe,pnl\n`];
    const fixedResult = await runConstruction('FIXED_R65', 65, 'fixed', sessions, csvChunks);
    const pctResult = await runConstruction('PCT_R0.22pct', R_PCT, 'pct', sessions, csvChunks);

    if (!fs.existsSync('reports')) fs.mkdirSync('reports');
    fs.writeFileSync('reports/poc_rotation_join_time60_mfe_trades.csv', csvChunks.join(''));
    fs.writeFileSync('scratch/poc_rotation_join_time60_mfe_report.json', JSON.stringify({ fixedResult, pctResult }, null, 2));

    console.log('\nDONE');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
