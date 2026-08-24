// Does "Delta Intensity" (a filter concept from docs/Holy_Grail_Breakout_Spec.md and
// docs/Sniper_Reversal_Spec.md -- external, untracked docs, NOT built or validated by
// this codebase's own pipeline) improve the rotation-VBP construction? User's own
// follow-up, 2026-08-24.
//
// Definition, taken directly from those specs: Delta Intensity = |Net Delta| / Total
// Volume, where Net Delta = ask_volume - bid_volume (an existing, already-populated
// pair of columns on price_bars_primary, ~99.9% coverage across the full history).
// This exact formula already exists once in this codebase, independently, in
// scripts/archive/backtest_delta_divergence.js's deltaIntensity computation --
// confirms this isn't a novel/unverifiable concept, just not yet tested against this
// specific construction.
//
// IMPORTANT: the Strategy Playbook docs' own headline numbers (62% WR, $72k profit,
// etc.) are NOT trusted here -- they were produced outside this codebase's rigor
// pipeline (no recordClaim, no computeRigor, no train/test discipline visible, hand-
// typed dollar figures) and are exactly the kind of unaudited claim CLAUDE.md's
// standing rules exist to catch. Only the FILTER DEFINITION is borrowed from them.
//
// Applied at the SIGNAL trigger bar (the bar where the two POCs converge), matching
// how the docs describe it as evaluated "tick-by-tick" at the moment of the trigger --
// the most literal single-bar reading, with the docs' own composite condition
// (Sniper Reversal spec): net delta SIGN must match the trade direction, AND
// |net delta|/volume must clear the intensity threshold. Tested at both the doc-
// literal thresholds (0.25, 0.50) and a data-derived median split (no-static-
// thresholds convention) as a robustness check, since CLAUDE.md's standing "no static
// thresholds" rule prefers a rolling/data-derived cutoff over a borrowed literal.
//
// Tested against BOTH rotation constructions already built this session: fixed R=65
// (the original) and percentage R=0.22% (the price-drift-corrected version). Stop-
// only/MFE exit (no target), delay=0 (immediate entry) -- matching the user's most
// recent redirect away from the fixed-target version.
import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { detectSignalEvents, TICK, formatET, mean, percentile } from './backtest_poc_rotation_vbp.mjs';

const PATH = 'standard';
const R_PCT_REFERENCE_PRICE = 29547.75;
const R_PCT = 65 / R_PCT_REFERENCE_PRICE;

function runTradeStopOnlyMFE(event, bars, entryOffset = 1) {
    const entryIdx = event.trigger_idx + entryOffset;
    if (entryIdx >= bars.length) return null;
    const entryPx = bars[entryIdx].open;
    const entryTime = bars[entryIdx].ts;
    const L = event.L;
    const long = event.direction === 'DOWN';
    const trade_direction = long ? 'LONG' : 'SHORT';
    let wrongCloses = 0, mfe = 0;
    let resolution = null, exitTime = null, exit_idx = entryIdx;
    for (let i = entryIdx; i < bars.length; i++) {
        exit_idx = i;
        const bar = bars[i];
        const favorable = long ? (bar.high - entryPx) : (entryPx - bar.low);
        if (favorable > mfe) mfe = favorable;
        const closedWrong = long ? bar.close < L : bar.close > L;
        wrongCloses = closedWrong ? wrongCloses + 1 : 0;
        if (wrongCloses >= 2) { resolution = { res: 'STOP_HIT', exitPx: bar.close }; exitTime = bar.ts; break; }
    }
    if (!resolution) { resolution = { res: 'TIME_EXPIRED', exitPx: bars[bars.length - 1].close }; exitTime = bars[bars.length - 1].ts; }
    const pnl = long ? resolution.exitPx - entryPx : entryPx - resolution.exitPx;
    return { entryTime, trade_direction, entryPx, stopPx: L, exitTime, exitReason: resolution.res, bars_to_resolution: exit_idx - entryIdx + 1, mfe, pnl };
}

function summarizeBucket(results) {
    const N = results.length;
    if (N === 0) return { N: 0 };
    const distinctDates = new Set(results.map(r => r.e.t)).size;
    const wins = results.filter(r => r.res.pnl > 0).length;
    const wr = (wins / N * 100).toFixed(1);
    const ev = (results.reduce((s, r) => s + r.res.pnl, 0) / N).toFixed(2);
    const mfes = results.map(r => r.res.mfe).sort((a, b) => a - b);
    let rigorStr = 'n/a (N<20)';
    if (N >= 20) {
        const rigor = computeRigor(results.map(r => ({ t: r.e.t, pnl: r.res.pnl })), { dateField: 't', pnlFn: r => r.pnl });
        rigorStr = `stable=${rigor.stable} cluster=${rigor.clustered}`;
    }
    return { N, distinctDates, wr, ev, valEV: Number(ev), rigorStr, mfe_mean: mean(mfes).toFixed(2), mfe_p50: percentile(mfes, 0.5).toFixed(2) };
}

// Delta Intensity at the trigger bar, plus sign-alignment with the trade's own
// direction (per the Sniper Reversal spec's composite condition).
function deltaIntensityAt(event, bars) {
    const bar = bars[event.trigger_idx];
    const vol = bar.volume;
    if (!vol) return null;
    const netDelta = bar.ask_volume - bar.bid_volume;
    const intensity = Math.abs(netDelta) / vol;
    const long = event.direction === 'DOWN'; // matches runTradeStopOnlyMFE's own mapping
    const signAligned = long ? netDelta > 0 : netDelta < 0;
    return { intensity, signAligned, netDelta };
}

async function runConstruction(label, R, rMode, sessions, csvChunks) {
    const resMed = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
    const THETA = Math.max(TICK, resMed.rows[0].median_range);
    const { all_signal, legCount } = detectSignalEvents(R, PATH, THETA, sessions, rMode);

    const enriched = all_signal.map(e => {
        const session = sessions.find(s => s.t === e.t);
        const di = deltaIntensityAt(e, session.bars);
        return { e, di };
    }).filter(x => x.di !== null);

    const withResult = enriched.map(({ e, di }) => {
        const session = sessions.find(s => s.t === e.t);
        const res = runTradeStopOnlyMFE(e, session.bars, 1);
        return res ? { e, di, res } : null;
    }).filter(Boolean);

    const alignedIntensities = withResult.filter(x => x.di.signAligned).map(x => x.di.intensity).sort((a, b) => a - b);
    const medianAligned = alignedIntensities.length ? percentile(alignedIntensities, 0.5) : null;

    const buckets = {
        ALL: withResult,
        SIGN_ALIGNED_ONLY: withResult.filter(x => x.di.signAligned),
        PASS_25: withResult.filter(x => x.di.signAligned && x.di.intensity >= 0.25),
        PASS_50: withResult.filter(x => x.di.signAligned && x.di.intensity >= 0.50),
        MEDIAN_SPLIT_HIGH: medianAligned != null ? withResult.filter(x => x.di.signAligned && x.di.intensity >= medianAligned) : [],
        MEDIAN_SPLIT_LOW: medianAligned != null ? withResult.filter(x => x.di.signAligned && x.di.intensity < medianAligned) : [],
    };

    console.log(`\n=== ${label} (legCount=${legCount}, signal=${all_signal.length}, with bar data=${withResult.length}) ===`);
    console.log(`  median Delta Intensity among sign-aligned events: ${medianAligned != null ? medianAligned.toFixed(3) : 'n/a'}`);
    const summary = {};
    for (const [name, group] of Object.entries(buckets)) {
        const s = summarizeBucket(group);
        summary[name] = s;
        console.log(`  ${name}: N=${s.N}${s.N ? ` (days=${s.distinctDates}) WR=${s.wr}% EV=$${s.ev} MFE(mean/p50)=${s.mfe_mean}/${s.mfe_p50} (${s.rigorStr})` : ''}`);
    }

    for (const { e, di, res } of withResult) {
        const session = sessions.find(s => s.t === e.t);
        const leg_ts = formatET(session.bars[e.leg_start].ts);
        const entry_ts = formatET(res.entryTime);
        const exit_ts = formatET(res.exitTime);
        csvChunks.push(`${label},${e.t},${leg_ts},${e.direction},${entry_ts},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${exit_ts},${res.exitReason},${res.bars_to_resolution},${res.mfe.toFixed(2)},${res.pnl.toFixed(2)},${di.intensity.toFixed(3)},${di.signAligned}\n`);
    }

    return { label, R, rMode, THETA, legCount, medianAligned, summary };
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
    console.log(`Loaded ${sessions.length} sessions.`);

    const csvChunks = [`construction,trade_date,leg_anchor_time,leg_direction,entry_time,direction,entry_price,stop_price,exit_time,exit_reason,bars_to_resolution,mfe,pnl,delta_intensity,sign_aligned\n`];

    const fixedResult = await runConstruction('FIXED_R65', 65, 'fixed', sessions, csvChunks);
    const pctResult = await runConstruction('PCT_R0.22pct', R_PCT, 'pct', sessions, csvChunks);

    if (!fs.existsSync('reports')) fs.mkdirSync('reports');
    fs.writeFileSync('reports/poc_rotation_delta_intensity_filter_trades.csv', csvChunks.join(''));
    fs.writeFileSync('scratch/poc_rotation_delta_intensity_filter_report.json', JSON.stringify({ fixedResult, pctResult }, null, 2));

    for (const result of [fixedResult, pctResult]) {
        const s = result.summary;
        const claimText = `Delta Intensity filter (|ask_volume-bid_volume|/volume at trigger bar, sign-aligned with trade direction -- definition borrowed from docs/Sniper_Reversal_Spec.md / docs/Holy_Grail_Breakout_Spec.md, NOT their unaudited performance numbers) applied to the rotation-VBP SIGNAL population, ${result.label} construction (R=${result.R}, mode=${result.rMode}, THETA=${result.THETA.toFixed(2)}). Stop-only/MFE exit, delay=0.
  ALL (unfiltered): N=${s.ALL.N} WR=${s.ALL.wr}% EV=$${s.ALL.ev} (${s.ALL.rigorStr})
  SIGN_ALIGNED_ONLY (delta direction matches trade direction, no intensity cutoff): N=${s.SIGN_ALIGNED_ONLY.N} WR=${s.SIGN_ALIGNED_ONLY.wr}% EV=$${s.SIGN_ALIGNED_ONLY.ev} (${s.SIGN_ALIGNED_ONLY.rigorStr})
  PASS_25 (sign-aligned + intensity>=0.25, Sniper Reversal spec's literal threshold): N=${s.PASS_25.N} WR=${s.PASS_25.wr}% EV=$${s.PASS_25.ev} (${s.PASS_25.rigorStr})
  PASS_50 (sign-aligned + intensity>=0.50, Holy Grail spec's literal threshold): N=${s.PASS_50.N} WR=${s.PASS_50.wr}% EV=$${s.PASS_50.ev} (${s.PASS_50.rigorStr})
  MEDIAN_SPLIT_HIGH (sign-aligned, top half by intensity, data-derived threshold=${result.medianAligned?.toFixed(3)}): N=${s.MEDIAN_SPLIT_HIGH.N} WR=${s.MEDIAN_SPLIT_HIGH.wr}% EV=$${s.MEDIAN_SPLIT_HIGH.ev} (${s.MEDIAN_SPLIT_HIGH.rigorStr})
  MEDIAN_SPLIT_LOW (sign-aligned, bottom half): N=${s.MEDIAN_SPLIT_LOW.N} WR=${s.MEDIAN_SPLIT_LOW.wr}% EV=$${s.MEDIAN_SPLIT_LOW.ev} (${s.MEDIAN_SPLIT_LOW.rigorStr})`;

        if (s.PASS_25.N >= 20 || s.MEDIAN_SPLIT_HIGH.N >= 20) {
            const best = s.PASS_25.N >= 20 ? s.PASS_25 : s.MEDIAN_SPLIT_HIGH;
            await recordClaim({
                slug: `poc_rotation_delta_intensity_filter_${result.rMode}`,
                claimText,
                sourceFile: 'scripts/backtest_poc_rotation_delta_intensity_filter.mjs',
                sampleSize: best.N,
                winRate: best.wr / 100,
                evPerTrade: best.valEV,
                rigorStatus: best.rigorStr,
                status: 'PROVISIONAL',
            });
        } else {
            console.log(`${result.label}: no bucket cleared N>=20, skipping recordClaim.`);
        }
    }

    console.log('\nDONE');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
