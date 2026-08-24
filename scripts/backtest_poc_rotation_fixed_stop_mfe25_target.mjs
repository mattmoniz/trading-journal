// Does actually taking profit change the rotation-VBP EV picture? User's own
// follow-up, 2026-08-24, after seeing that EV looks bad with no target because MFE
// (how far a trade COULD go) mostly evaporates by the time a stop-only trade
// actually resolves. Two-stage test, "to start":
//   1. Fixed 10-point stop (intrabar touch, NOT the old 2-close structural stop),
//      no target -- run this first just to build a real MFE distribution under
//      THIS stop (a tighter/different stop changes trade duration, so the MFE
//      distribution from the earlier structural-stop runs isn't reusable here).
//   2. target = p25 of that MFE distribution (a real, data-derived number, not a
//      guessed literal) -- then re-run the full trade with stop=10, target=mfe25.
// Tested on both rotation constructions already built this session (fixed R=65,
// percentage R=0.22%), delay=0 (immediate entry) only, unfiltered by delta intensity
// -- keeping this first pass to the one new variable (stop/target mechanism).
import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { detectSignalEvents, TICK, formatET, mean, percentile } from './backtest_poc_rotation_vbp.mjs';

const PATH = 'standard';
const R_PCT_REFERENCE_PRICE = 29547.75;
const R_PCT = 65 / R_PCT_REFERENCE_PRICE;
const STOP_PTS = 10;

// Stage 1: fixed-distance stop, intrabar touch, no target. Tracks MFE the whole way.
export function runStopOnlyFixed(event, bars, stopPts, entryOffset = 1) {
    const entryIdx = event.trigger_idx + entryOffset;
    if (entryIdx >= bars.length) return null;
    const entryPx = bars[entryIdx].open;
    const entryTime = bars[entryIdx].ts;
    const long = event.direction === 'DOWN';
    const trade_direction = long ? 'LONG' : 'SHORT';
    const stopPx = long ? entryPx - stopPts : entryPx + stopPts;

    let mfe = 0;
    let resolution = null, exitTime = null, exit_idx = entryIdx;
    for (let i = entryIdx; i < bars.length; i++) {
        exit_idx = i;
        const bar = bars[i];
        const favorable = long ? (bar.high - entryPx) : (entryPx - bar.low);
        if (favorable > mfe) mfe = favorable;
        const stopTouched = long ? bar.low <= stopPx : bar.high >= stopPx;
        if (stopTouched) { resolution = { res: 'STOP_HIT', exitPx: stopPx }; exitTime = bar.ts; break; }
    }
    if (!resolution) { resolution = { res: 'TIME_EXPIRED', exitPx: bars[bars.length - 1].close }; exitTime = bars[bars.length - 1].ts; }
    const pnl = long ? resolution.exitPx - entryPx : entryPx - resolution.exitPx;
    return { entryTime, trade_direction, entryPx, stopPx, exitTime, exitReason: resolution.res, bars_to_resolution: exit_idx - entryIdx + 1, mfe, pnl };
}

// Stage 2: fixed stop + fixed target (mfe25). Stop checked first if both trigger on
// the same bar (conservative, matches this codebase's existing tie-break convention).
export function runStopTarget(event, bars, stopPts, targetPts, entryOffset = 1) {
    const entryIdx = event.trigger_idx + entryOffset;
    if (entryIdx >= bars.length) return null;
    const entryPx = bars[entryIdx].open;
    const entryTime = bars[entryIdx].ts;
    const long = event.direction === 'DOWN';
    const trade_direction = long ? 'LONG' : 'SHORT';
    const stopPx = long ? entryPx - stopPts : entryPx + stopPts;
    const targetPx = long ? entryPx + targetPts : entryPx - targetPts;

    let resolution = null, exitTime = null, exit_idx = entryIdx;
    for (let i = entryIdx; i < bars.length; i++) {
        exit_idx = i;
        const bar = bars[i];
        const stopTouched = long ? bar.low <= stopPx : bar.high >= stopPx;
        if (stopTouched) { resolution = { res: 'STOP_HIT', exitPx: stopPx }; exitTime = bar.ts; break; }
        const targetTouched = long ? bar.high >= targetPx : bar.low <= targetPx;
        if (targetTouched) { resolution = { res: 'TARGET_HIT', exitPx: targetPx }; exitTime = bar.ts; break; }
    }
    if (!resolution) { resolution = { res: 'TIME_EXPIRED', exitPx: bars[bars.length - 1].close }; exitTime = bars[bars.length - 1].ts; }
    const pnl = long ? resolution.exitPx - entryPx : entryPx - resolution.exitPx;
    return { entryTime, trade_direction, entryPx, stopPx, targetPx, exitTime, exitReason: resolution.res, bars_to_resolution: exit_idx - entryIdx + 1, pnl };
}

export function summarize(results, hasTarget) {
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
    const out = { N, distinctDates, wr, ev, valEV: Number(ev), rigorStr, exitBreakdown };
    if (!hasTarget) {
        const mfes = results.map(r => r.res.mfe).sort((a, b) => a - b);
        out.mfe_p25 = percentile(mfes, 0.25);
        out.mfe_mean = mean(mfes).toFixed(2);
        out.mfe_p50 = percentile(mfes, 0.5).toFixed(2);
    }
    return out;
}

async function runConstruction(label, R, rMode, sessions, csvChunks) {
    const resMed = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
    const THETA = Math.max(TICK, resMed.rows[0].median_range);
    const { all_signal, legCount } = detectSignalEvents(R, PATH, THETA, sessions, rMode);

    // Stage 1: build the MFE distribution under the ACTUAL stop being used (10pt
    // fixed) -- not reusing the old structural-stop MFE numbers, since a different
    // stop changes how long trades survive and therefore how far they can run.
    const stage1 = all_signal.map(e => {
        const session = sessions.find(s => s.t === e.t);
        const res = runStopOnlyFixed(e, session.bars, STOP_PTS, 1);
        return res ? { e, res } : null;
    }).filter(Boolean);
    const stage1Summary = summarize(stage1, false);
    const mfe25 = stage1Summary.mfe_p25;

    // Stage 2: real trade with stop=10, target=mfe25.
    const stage2 = all_signal.map(e => {
        const session = sessions.find(s => s.t === e.t);
        const res = runStopTarget(e, session.bars, STOP_PTS, mfe25, 1);
        return res ? { e, res } : null;
    }).filter(Boolean);
    const stage2Summary = summarize(stage2, true);

    console.log(`\n=== ${label} (legCount=${legCount}, signal=${all_signal.length}) ===`);
    console.log(`  Stage 1 (stop=${STOP_PTS}pt, no target): N=${stage1Summary.N} WR=${stage1Summary.wr}% EV=$${stage1Summary.ev} MFE(p25/mean/p50)=${mfe25.toFixed(2)}/${stage1Summary.mfe_mean}/${stage1Summary.mfe_p50} exits=${JSON.stringify(stage1Summary.exitBreakdown)} (${stage1Summary.rigorStr})`);
    console.log(`  Stage 2 (stop=${STOP_PTS}pt, target=mfe25=${mfe25.toFixed(2)}pt): N=${stage2Summary.N} WR=${stage2Summary.wr}% EV=$${stage2Summary.ev} exits=${JSON.stringify(stage2Summary.exitBreakdown)} (${stage2Summary.rigorStr})`);

    for (const { e, res } of stage2) {
        const session = sessions.find(s => s.t === e.t);
        const leg_ts = formatET(session.bars[e.leg_start].ts);
        const entry_ts = formatET(res.entryTime);
        const exit_ts = formatET(res.exitTime);
        csvChunks.push(`${label},${e.t},${leg_ts},${e.direction},${entry_ts},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${res.targetPx.toFixed(2)},${exit_ts},${res.exitReason},${res.bars_to_resolution},${res.pnl.toFixed(2)}\n`);
    }

    return { label, R, rMode, THETA, legCount, mfe25, stage1Summary, stage2Summary };
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
    console.log(`Loaded ${sessions.length} sessions. Stop=${STOP_PTS}pts fixed (intrabar touch, not the structural 2-close stop).`);

    const csvChunks = [`construction,trade_date,leg_anchor_time,leg_direction,entry_time,direction,entry_price,stop_price,target_price,exit_time,exit_reason,bars_to_resolution,pnl\n`];

    const fixedResult = await runConstruction('FIXED_R65', 65, 'fixed', sessions, csvChunks);
    const pctResult = await runConstruction('PCT_R0.22pct', R_PCT, 'pct', sessions, csvChunks);

    if (!fs.existsSync('reports')) fs.mkdirSync('reports');
    fs.writeFileSync('reports/poc_rotation_fixed_stop_mfe25_target_trades.csv', csvChunks.join(''));
    fs.writeFileSync('scratch/poc_rotation_fixed_stop_mfe25_report.json', JSON.stringify({ STOP_PTS, fixedResult, pctResult }, null, 2));

    for (const result of [fixedResult, pctResult]) {
        const s2 = result.stage2Summary, s1 = result.stage1Summary;
        const claimText = `Fixed stop=${STOP_PTS}pt (intrabar touch) + target=mfe25 (${result.mfe25.toFixed(2)}pt, the p25 of the MFE distribution measured under this SAME 10pt stop, not the old structural-stop MFE numbers) on the rotation-VBP SIGNAL population, ${result.label} construction (R=${result.R}, mode=${result.rMode}, THETA=${result.THETA.toFixed(2)}). delay=0, unfiltered by delta intensity.
  Stage 1 (stop-only, no target, for reference): N=${s1.N} WR=${s1.wr}% EV=$${s1.ev} MFE p25/mean/p50=${result.mfe25.toFixed(2)}/${s1.mfe_mean}/${s1.mfe_p50} exits=${JSON.stringify(s1.exitBreakdown)} (${s1.rigorStr})
  Stage 2 (stop=${STOP_PTS}, target=${result.mfe25.toFixed(2)}): N=${s2.N} (days=${s2.distinctDates}) WR=${s2.wr}% EV=$${s2.ev} exits=${JSON.stringify(s2.exitBreakdown)} (${s2.rigorStr})
Note: "to start" per direct instruction -- p25 was chosen as a first, conservative (easy-to-reach) target; other percentiles (p50/p75) may be worth testing as a follow-up.`;

        if (s2.N >= 20) {
            await recordClaim({
                slug: `poc_rotation_fixed10_mfe25_target_${result.rMode}`,
                claimText,
                sourceFile: 'scripts/backtest_poc_rotation_fixed_stop_mfe25_target.mjs',
                sampleSize: s2.N,
                winRate: s2.wr / 100,
                evPerTrade: s2.valEV,
                rigorStatus: s2.rigorStr,
                status: 'PROVISIONAL',
            });
        }
    }

    console.log('\nDONE');
    process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(e => { console.error(e); process.exit(1); });
}
