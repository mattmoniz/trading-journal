// Entry-timing variant of the rotation-VBP mechanism check: does waiting N minutes
// after the two POCs (rotation-leg med50 vs 24hr med50) converge, before firing,
// improve results over immediate (next-bar) entry? User's own idea, 2026-08-24.
//
// Reuses detectSignalEvents()/runTrade() from backtest_poc_rotation_vbp.mjs verbatim
// (same leg segmentation, repainting-safety, convergence condition, structural stop)
// -- only the entry offset after the trigger bar changes. This is a BLIND delay (wait
// N minutes, then enter regardless of what happened in between), not a re-confirmation
// -- matching how this codebase's engagement_confirmation_entry_timing thread already
// separates "blind delay" from "confirm" as distinct hypotheses.
//
// Same chronological 70/30 train/test discipline as the parent script: target swept
// on TRAIN only per delay variant, headline stats reported on held-out TEST only.
import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { detectSignalEvents, runTrade, TICK, TARGET_SWEEP, formatET, mean } from './backtest_poc_rotation_vbp.mjs';

const R = 65, PATH = 'standard';
const DELAYS_MIN = [0, 15, 30, 60]; // bars are 1-min, so delay minutes == delay bars

function summarizeArm(results, split) {
    const filtered = split ? results.filter(r => r.split === split) : results;
    const N = filtered.length;
    if (N === 0) return { N: 0 };
    const distinctDates = new Set(filtered.map(r => r.e.t)).size;
    const wins = filtered.filter(r => r.res.pnl > 0).length;
    const wr = (wins / N * 100).toFixed(1);
    const ev = (filtered.reduce((s, r) => s + r.res.pnl, 0) / N).toFixed(2);
    let rigorStr = 'n/a (N<20)';
    if (N >= 20) {
        const rigor = computeRigor(filtered.map(r => ({ t: r.e.t, pnl: r.res.pnl })), { dateField: 't', pnlFn: r => r.pnl });
        rigorStr = `stable=${rigor.stable} cluster=${rigor.clustered}`;
    }
    return { N, distinctDates, wr, ev, rigorStr, valEV: Number(ev) };
}

async function runDelayVariant(delayMin, all_signal, all_control, all_never, sessions, trainDates) {
    const entryOffset = 1 + delayMin; // baseline (delay=0) is entryOffset=1, matching the parent script's immediate-entry convention

    const trainSignal = all_signal.filter(e => trainDates.has(e.t));
    let bestT = null, bestEV = -Infinity;
    for (const T of TARGET_SWEEP) {
        let evSum = 0, count = 0;
        for (const e of trainSignal) {
            const sess = sessions.find(s => s.t === e.t);
            const res = runTrade(e, sess.bars, T, entryOffset);
            if (res) { evSum += res.pnl; count++; }
        }
        const ev = count ? evSum / count : -Infinity;
        if (ev > bestEV) { bestEV = ev; bestT = T; }
    }
    if (bestT === null) bestT = 20;

    const withSplit = (arm, events) => events
        .map(e => ({ arm, split: trainDates.has(e.t) ? 'TRAIN' : 'TEST', e, res: runTrade(e, sessions.find(s => s.t === e.t).bars, bestT, entryOffset) }))
        .filter(x => x.res);

    const results_signal = withSplit('SIGNAL', all_signal);
    const results_control = withSplit('SAME_SELECTION_NO_SIGNAL', all_control);
    const results_never = withSplit('NEVER_SELECTED', all_never);

    return {
        delayMin, bestT,
        signal: summarizeArm(results_signal, 'TEST'),
        control: summarizeArm(results_control, 'TEST'),
        never: summarizeArm(results_never, 'TEST'),
        signal_train: summarizeArm(results_signal, 'TRAIN'),
        results_signal, // kept for CSV export
    };
}

async function main() {
    const resMed = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
    const THETA = Math.max(TICK, resMed.rows[0].median_range);

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

    const splitIdx = Math.floor(sessions.length * 0.7);
    const trainDates = new Set(sessions.slice(0, splitIdx).map(s => s.t));

    // Detect events ONCE (leg segmentation/convergence doesn't depend on entry delay,
    // only which bar we enter on after the trigger) -- reuse across all delay variants.
    const { all_signal, all_control, all_never, legCount, pctBelowFloor } = detectSignalEvents(R, PATH, THETA, sessions);
    console.log(`Detected ${all_signal.length} SIGNAL events, ${all_control.length} control, ${all_never.length} never-selected. legCount=${legCount} (${pctBelowFloor}% below B_FLOOR).`);

    const variants = [];
    for (const d of DELAYS_MIN) {
        console.log(`Running delay=${d}min ...`);
        variants.push(await runDelayVariant(d, all_signal, all_control, all_never, sessions, trainDates));
    }

    // CSV: SIGNAL-arm trades only, across all 4 delay variants, TRAIN+TEST tagged.
    let csv = `delay_min,split,trade_date,leg_anchor_time,leg_direction,entry_time,direction,entry_price,stop_price,target_price,exit_time,exit_reason,bars_to_resolution,pnl\n`;
    for (const v of variants) {
        for (const item of v.results_signal) {
            const { split, e, res } = item;
            const session = sessions.find(s => s.t === e.t);
            const leg_ts = formatET(session.bars[e.leg_start].ts);
            const entry_ts = formatET(res.entryTime);
            const exit_ts = formatET(res.exitTime);
            csv += `${v.delayMin},${split},${e.t},${leg_ts},${e.direction},${entry_ts},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${res.targetPx.toFixed(2)},${exit_ts},${res.exitReason},${res.bars_to_resolution},${res.pnl.toFixed(2)}\n`;
        }
    }
    if (!fs.existsSync('reports')) fs.mkdirSync('reports');
    fs.writeFileSync('reports/poc_rotation_vbp_entry_delay_trades.csv', csv);

    const report = { THETA, trainSessions: splitIdx, testSessions: sessions.length - splitIdx, legCount, pctBelowFloor, variants: variants.map(v => ({ delayMin: v.delayMin, bestT: v.bestT, signal: v.signal, control: v.control, never: v.never, signal_train: v.signal_train })) };
    fs.writeFileSync('scratch/poc_rotation_entry_delay_report.json', JSON.stringify(report, null, 2));

    const baseline = variants.find(v => v.delayMin === 0);
    const claimLines = variants.map(v =>
        `  delay=${v.delayMin}min (T=${v.bestT}): SIGNAL N=${v.signal.N} (days=${v.signal.distinctDates}) WR=${v.signal.wr}% EV=$${v.signal.ev} (${v.signal.rigorStr}) | control EV=$${v.control.ev} | never EV=$${v.never.ev}`
    ).join('\n');
    const claimText = `Rotation VBP entry-timing test: does waiting N minutes after POC convergence before firing (blind delay, not re-confirmation) change results, vs immediate (delay=0) entry? Same leg segmentation/convergence/structural-stop as poc_rotation_vbp_mechanism_check, TEST split only (T swept on TRAIN per delay variant, ${splitIdx} train / ${sessions.length - splitIdx} test sessions).
${claimLines}
Baseline (delay=0) SIGNAL EV=$${baseline.signal.ev}, minus-control delta=$${(baseline.signal.valEV - baseline.control.valEV).toFixed(2)}.`;

    const anyEligible = variants.some(v => v.signal.N >= 20);
    if (anyEligible) {
        const best = variants.filter(v => v.signal.N >= 20).sort((a, b) => b.signal.valEV - a.signal.valEV)[0];
        await recordClaim({
            slug: 'poc_rotation_vbp_entry_delay_test',
            claimText,
            sourceFile: 'scripts/backtest_poc_rotation_vbp_entry_delay.mjs',
            sampleSize: best.signal.N,
            winRate: best.signal.wr / 100,
            evPerTrade: best.signal.valEV,
            rigorStatus: best.signal.rigorStr,
            status: 'PROVISIONAL',
        });
    } else {
        console.log('No delay variant cleared N>=20, skipping recordClaim.');
    }

    console.log('\n=== SUMMARY (TEST split) ===');
    for (const v of variants) {
        console.log(`delay=${v.delayMin}min T=${v.bestT}: SIGNAL N=${v.signal.N} WR=${v.signal.wr}% EV=$${v.signal.ev} (${v.signal.rigorStr}) | control EV=$${v.control.ev} | never EV=$${v.never.ev}`);
    }
    console.log('DONE');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
