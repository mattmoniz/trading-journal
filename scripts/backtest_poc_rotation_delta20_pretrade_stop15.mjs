// Delta Intensity as a PRE-TRADE trigger (not a post-hoc bucket) -- user's correction,
// 2026-08-24: "using an intensity of 20... it is a trigger... a pre trade
// filter/trigger. Why would you use it post trade?" Correct distinction: the earlier
// test (backtest_poc_rotation_delta_intensity_filter.mjs) bucketed ALREADY-FIRED
// SIGNAL events by intensity after the fact -- descriptive, not a gate. This script
// instead filters the population to intensity>=0.20 (sign-aligned) BEFORE any
// simulation runs, so the reported EV reflects "the strategy WITH this gate," not
// "how do high-intensity trades compare to low-intensity ones."
//
// Also: stop widened from 10pt to 15pt per direct instruction. MFE distribution is
// rebuilt from scratch under BOTH the new stop AND the filtered population (a
// different stop width and a different population both change how far trades run --
// reusing the old 10pt/unfiltered MFE numbers here would be wrong).
import fs from 'fs';
import { query } from '../server/db.js';
import { detectSignalEvents, TICK, percentile } from './backtest_poc_rotation_vbp.mjs';
// This file's EV=$ output is dollar-correct ONLY TRANSITIVELY, via the imported `summarize()`'s
// own dollarPnl conversion (OPEN_DECISION poc_rotation_thread_points_mislabeled_as_dollars, fixed
// 2026-08-30) -- this file has no LIVE_INSTRUMENT/dollarPnl of its own (DeepSeek code review
// round 4, finding S3). Do not write a local summarize()/EV computation here without reusing the
// import above, or this silently reintroduces the exact points-as-dollars bug.
import { runStopOnlyFixed, runStopTarget, summarize } from './backtest_poc_rotation_fixed_stop_mfe25_target.mjs';
import { recordClaim } from './record_claim.mjs';

const PATH = 'standard';
const R_PCT_REFERENCE_PRICE = 29547.75;
const R_PCT = 65 / R_PCT_REFERENCE_PRICE;
const STOP_PTS = 15;
const DELTA_INTENSITY_THRESHOLDS = [0.20, 0.30, 0.40]; // swept per user's follow-up
const MFE_PERCENTILES = [0.25, 0.50, 0.75, 0.90];

function deltaIntensityAt(event, bars) {
    const bar = bars[event.trigger_idx];
    const vol = bar.volume;
    if (!vol) return null;
    const netDelta = bar.ask_volume - bar.bid_volume;
    const intensity = Math.abs(netDelta) / vol;
    const long = event.direction === 'DOWN';
    const signAligned = long ? netDelta > 0 : netDelta < 0;
    return { intensity, signAligned };
}

async function runConstruction(label, R, rMode, sessions, csvChunks) {
    const resMed = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
    const THETA = Math.max(TICK, resMed.rows[0].median_range);
    const { all_signal, legCount } = detectSignalEvents(R, PATH, THETA, sessions, rMode);
    console.log(`\n=== ${label} (legCount=${legCount}, all SIGNAL=${all_signal.length}) ===`);

    const byThreshold = [];
    for (const threshold of DELTA_INTENSITY_THRESHOLDS) {
        // PRE-TRADE GATE: only events passing sign-aligned + intensity>=threshold even
        // exist in the population being simulated -- everything downstream (MFE
        // distribution, target derivation, final EV) is computed on this filtered set.
        const gated = all_signal.filter(e => {
            const session = sessions.find(s => s.t === e.t);
            const di = deltaIntensityAt(e, session.bars);
            return di && di.signAligned && di.intensity >= threshold;
        });
        console.log(`  --- Delta Intensity gate >=${threshold} (sign-aligned): passed=${gated.length}/${all_signal.length} ---`);

        // Stage 1: MFE under the actual stop (15pt) AND this threshold's gated population.
        const stage1 = gated.map(e => {
            const session = sessions.find(s => s.t === e.t);
            const res = runStopOnlyFixed(e, session.bars, STOP_PTS, 1);
            return res ? { e, res } : null;
        }).filter(Boolean);
        const mfes = stage1.map(r => r.res.mfe).sort((a, b) => a - b);
        const stage1Summary = summarize(stage1, false);
        console.log(`    Stage 1 (stop=${STOP_PTS}pt, no target): N=${stage1Summary.N} WR=${stage1Summary.wr}% EV=$${stage1Summary.ev} (${stage1Summary.rigorStr})`);

        const variants = [];
        for (const p of MFE_PERCENTILES) {
            if (mfes.length === 0) { variants.push({ pctile: p, targetPts: null, summary: { N: 0 }, breakevenWR: null }); continue; }
            const targetPts = percentile(mfes, p);
            const stage2 = gated.map(e => {
                const session = sessions.find(s => s.t === e.t);
                const res = runStopTarget(e, session.bars, STOP_PTS, targetPts, 1);
                return res ? { e, res } : null;
            }).filter(Boolean);
            const summary = summarize(stage2, true);
            const breakevenWR = (STOP_PTS / (STOP_PTS + targetPts) * 100).toFixed(1);
            variants.push({ pctile: p, targetPts, summary, breakevenWR });
            console.log(`    mfe${Math.round(p * 100)}=${targetPts.toFixed(2)}pt (breakeven WR=${breakevenWR}%): N=${summary.N} WR=${summary.wr}% EV=$${summary.ev} exits=${JSON.stringify(summary.exitBreakdown)} (${summary.rigorStr})`);

            for (const { e, res } of stage2) {
                const session = sessions.find(s => s.t === e.t);
                const di = deltaIntensityAt(e, session.bars);
                csvChunks.push(`${label},${threshold},mfe${Math.round(p * 100)},${e.t},${e.direction},${res.entryTime},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${res.targetPx.toFixed(2)},${res.exitTime},${res.exitReason},${res.bars_to_resolution},${res.pnl.toFixed(2)},${di.intensity.toFixed(3)}\n`);
            }
        }
        byThreshold.push({ threshold, gatedN: gated.length, stage1Summary, variants });
    }

    return { label, R, rMode, THETA, legCount, allSignalN: all_signal.length, byThreshold };
}

async function main() {
    const dvl = (await query(`SELECT trade_date::text as t FROM developing_value_log ORDER BY trade_date DESC`)).rows.reverse();
    const sessions = [];
    for (const row of dvl) {
        const bars = (await query(`
          SELECT ts, ts::date::text as d, high::float, low::float, close::float, open::float,
                 volume::float as volume, bid_volume::float as bid_volume, ask_volume::float as ask_volume
          FROM price_bars_primary WHERE symbol='NQ' AND (
            (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
            (ts::date = $1 AND EXTRACT(hour FROM ts) < 17)
          ) ORDER BY ts`, [row.t])).rows;
        if (bars.length < 300) continue;
        sessions.push({ t: row.t, bars });
    }
    console.log(`Loaded ${sessions.length} sessions. Stop=${STOP_PTS}pts, Delta Intensity thresholds ${DELTA_INTENSITY_THRESHOLDS.join('/')} (sign-aligned) as PRE-TRADE gate.`);

    const csvChunks = [`construction,delta_threshold,variant,trade_date,leg_direction,entry_time,direction,entry_price,stop_price,target_price,exit_time,exit_reason,bars_to_resolution,pnl,delta_intensity\n`];

    const fixedResult = await runConstruction('FIXED_R65', 65, 'fixed', sessions, csvChunks);
    const pctResult = await runConstruction('PCT_R0.22pct', R_PCT, 'pct', sessions, csvChunks);

    if (!fs.existsSync('reports')) fs.mkdirSync('reports');
    fs.writeFileSync('reports/poc_rotation_delta20_pretrade_stop15_trades.csv', csvChunks.join(''));
    fs.writeFileSync('scratch/poc_rotation_delta20_pretrade_stop15_report.json', JSON.stringify({ STOP_PTS, DELTA_INTENSITY_THRESHOLDS, fixedResult, pctResult }, null, 2));

    for (const result of [fixedResult, pctResult]) {
        const thresholdBlocks = result.byThreshold.map(bt => {
            const lines = bt.variants.map(v =>
                v.summary.N ? `    mfe${Math.round(v.pctile * 100)}=${v.targetPts.toFixed(2)}pt (breakeven WR=${v.breakevenWR}%): N=${v.summary.N} (days=${v.summary.distinctDates}) WR=${v.summary.wr}% EV=$${v.summary.ev} exits=${JSON.stringify(v.summary.exitBreakdown)} (${v.summary.rigorStr})` : `    mfe${Math.round(v.pctile * 100)}: N=0 (gate too thin)`
            ).join('\n');
            return `  Delta Intensity>=${bt.threshold}: gated=${bt.gatedN}/${result.allSignalN} (${(bt.gatedN / result.allSignalN * 100).toFixed(1)}%)\n${lines}`;
        }).join('\n');
        const claimText = `Delta Intensity (sign-aligned with trade direction) applied as a PRE-TRADE gate (population filtered BEFORE simulation, not bucketed after) -- correction from the earlier post-hoc version (poc_rotation_delta_intensity_filter_${result.rMode}). Thresholds swept: ${DELTA_INTENSITY_THRESHOLDS.join('/')}. Stop=${STOP_PTS}pt fixed (intrabar touch, widened from 10pt), target swept mfe25/50/75/90 per threshold (measured under that threshold's own gated population + 15pt stop). ${result.label} construction (R=${result.R}, mode=${result.rMode}, THETA=${result.THETA.toFixed(2)}). delay=0.
${thresholdBlocks}`;

        const allCandidates = result.byThreshold.flatMap(bt => bt.variants.filter(v => v.summary.N >= 20).map(v => ({ ...v.summary, threshold: bt.threshold, pctile: v.pctile })));
        const best = allCandidates.sort((a, b) => b.valEV - a.valEV)[0];
        if (best) {
            await recordClaim({
                slug: `poc_rotation_delta_pretrade_stop15_${result.rMode}`,
                claimText,
                sourceFile: 'scripts/backtest_poc_rotation_delta20_pretrade_stop15.mjs',
                sampleSize: best.N,
                winRate: best.wr / 100,
                evPerTrade: best.valEV,
                rigorStatus: best.rigorStr,
                status: 'PROVISIONAL',
            });
        } else {
            console.log(`${result.label}: no variant cleared N>=20 (gated population may be too thin), skipping recordClaim.`);
        }
    }

    console.log('\nDONE');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
