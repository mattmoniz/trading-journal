// Entry-timing variant #2: no fixed target -- let each SIGNAL trade run under the
// structural stop ONLY (2 consecutive 1-min closes back through the converged level L),
// and report how far it actually goes (MFE, max favorable excursion) before stopping
// out or running out of session data. User's own follow-up, 2026-08-24: "no target,
// let's see how far they go" -- replaces the TARGET_SWEEP version, not an addition to it.
//
// Reuses detectSignalEvents() from backtest_poc_rotation_vbp.mjs verbatim (same leg
// segmentation, repainting-safety, convergence condition) -- only the exit mechanism
// changes (stop-only, no target) and the entry offset varies by delay.
import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { detectSignalEvents, TICK, formatET, mean, percentile } from './backtest_poc_rotation_vbp.mjs';

// R as a PERCENTAGE of the running extreme, not a fixed point value. Found 2026-08-24:
// NQ's price roughly doubled 2023->2026 (11,300-17,500 -> 23,000-31,000), so the
// original fixed R=65 was an increasingly loose threshold over the window -- events
// per session rose 2.5->5.7 2023->2026, tracking price growth almost exactly, not a
// real behavior change. R_PCT is calibrated off the current/recent price (the level
// the user was actually describing "60-65 points" against) so 65pts-at-current-price
// stays the real-world-equivalent threshold at every price level in the history.
const R_PCT_REFERENCE_PRICE = 29547.75; // 30-day median NQ close as of 2026-08-24
const R_PCT = 65 / R_PCT_REFERENCE_PRICE;
const PATH = 'standard';
const DELAYS_MIN = [0, 15, 30, 60]; // bars are 1-min, so delay minutes == delay bars

// Stop-only trade: no target. Walk forward from entry until 2 consecutive closes
// back through L (STOP_HIT) or bars run out (TIME_EXPIRED, mark-to-market). Tracks
// the running max favorable excursion (MFE) the whole way, regardless of exit reason.
function runTradeStopOnlyMFE(event, bars, entryOffset) {
    const entryIdx = event.trigger_idx + entryOffset;
    if (entryIdx >= bars.length) return null;

    const entryPx = bars[entryIdx].open;
    const entryTime = bars[entryIdx].ts;
    const L = event.L;
    const long = event.direction === 'DOWN';
    const trade_direction = long ? 'LONG' : 'SHORT';

    let wrongCloses = 0;
    let mfe = 0;
    let resolution = null, exitTime = null, exit_idx = entryIdx;

    for (let i = entryIdx; i < bars.length; i++) {
        exit_idx = i;
        const bar = bars[i];

        const favorable = long ? (bar.high - entryPx) : (entryPx - bar.low);
        if (favorable > mfe) mfe = favorable;

        const closedWrong = long ? bar.close < L : bar.close > L;
        wrongCloses = closedWrong ? wrongCloses + 1 : 0;

        if (wrongCloses >= 2) {
            resolution = { res: 'STOP_HIT', exitPx: bar.close };
            exitTime = bar.ts;
            break;
        }
    }

    if (!resolution) {
        resolution = { res: 'TIME_EXPIRED', exitPx: bars[bars.length - 1].close };
        exitTime = bars[bars.length - 1].ts;
    }

    const pnl = long ? resolution.exitPx - entryPx : entryPx - resolution.exitPx;
    return {
        entryTime, trade_direction, entryPx, stopPx: L, exitTime,
        exitReason: resolution.res,
        bars_to_resolution: exit_idx - entryIdx + 1,
        mfe, pnl,
    };
}

function summarizeMFE(results) {
    const N = results.length;
    if (N === 0) return { N: 0 };
    const distinctDates = new Set(results.map(r => r.e.t)).size;
    const wins = results.filter(r => r.res.pnl > 0).length;
    const wr = (wins / N * 100).toFixed(1);
    const ev = (results.reduce((s, r) => s + r.res.pnl, 0) / N).toFixed(2);
    const mfes = results.map(r => r.res.mfe).sort((a, b) => a - b);
    const bars = results.map(r => r.res.bars_to_resolution).sort((a, b) => a - b);
    const stopHitPct = (results.filter(r => r.res.exitReason === 'STOP_HIT').length / N * 100).toFixed(1);
    const rigor = computeRigor(results.map(r => ({ t: r.e.t, pnl: r.res.pnl })), { dateField: 't', pnlFn: r => r.pnl });
    return {
        N, distinctDates, wr, ev, valEV: Number(ev), stopHitPct,
        rigorStr: `stable=${rigor.stable} cluster=${rigor.clustered}`,
        mfe_mean: mean(mfes).toFixed(2),
        mfe_p50: percentile(mfes, 0.5).toFixed(2),
        mfe_p75: percentile(mfes, 0.75).toFixed(2),
        mfe_p90: percentile(mfes, 0.9).toFixed(2),
        mfe_max: mfes[mfes.length - 1].toFixed(2),
        bars_p50: percentile(bars, 0.5),
        bars_p90: percentile(bars, 0.9),
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

    const { all_signal, legCount, pctBelowFloor } = detectSignalEvents(R_PCT, PATH, THETA, sessions, 'pct');
    console.log(`R_PCT=${(R_PCT * 100).toFixed(4)}% (= 65pts at ${R_PCT_REFERENCE_PRICE}). Detected ${all_signal.length} SIGNAL events. legCount=${legCount} (${pctBelowFloor}% below B_FLOOR).`);

    // Stationarity check -- did percentage mode actually flatten the events/session
    // trend across years, vs the fixed-point version's 2.5->5.7 rise 2023->2026?
    const byYear = {};
    for (const e of all_signal) {
        const yr = e.t.slice(0, 4);
        byYear[yr] = (byYear[yr] || 0) + 1;
    }
    const sessionsByYear = {};
    for (const s of sessions) {
        const yr = s.t.slice(0, 4);
        sessionsByYear[yr] = (sessionsByYear[yr] || 0) + 1;
    }
    console.log('Events/session by year (pct mode):');
    for (const yr of Object.keys(byYear).sort()) {
        console.log(`  ${yr}: ${byYear[yr]} events / ${sessionsByYear[yr]} sessions = ${(byYear[yr] / sessionsByYear[yr]).toFixed(2)}/session`);
    }

    const variants = [];
    let csv = `delay_min,trade_date,leg_anchor_time,leg_direction,entry_time,direction,entry_price,stop_price,exit_time,exit_reason,bars_to_resolution,mfe,pnl\n`;
    for (const d of DELAYS_MIN) {
        const entryOffset = 1 + d;
        const results = all_signal
            .map(e => ({ e, res: runTradeStopOnlyMFE(e, sessions.find(s => s.t === e.t).bars, entryOffset) }))
            .filter(x => x.res);
        const summary = summarizeMFE(results);
        variants.push({ delayMin: d, ...summary });
        console.log(`delay=${d}min: N=${summary.N} WR=${summary.wr}% EV=$${summary.ev} stopHit=${summary.stopHitPct}% MFE(mean/p50/p75/p90/max)=${summary.mfe_mean}/${summary.mfe_p50}/${summary.mfe_p75}/${summary.mfe_p90}/${summary.mfe_max} bars(p50/p90)=${summary.bars_p50}/${summary.bars_p90} (${summary.rigorStr})`);
        for (const { e, res } of results) {
            const session = sessions.find(s => s.t === e.t);
            const leg_ts = formatET(session.bars[e.leg_start].ts);
            const entry_ts = formatET(res.entryTime);
            const exit_ts = formatET(res.exitTime);
            csv += `${d},${e.t},${leg_ts},${e.direction},${entry_ts},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${exit_ts},${res.exitReason},${res.bars_to_resolution},${res.mfe.toFixed(2)},${res.pnl.toFixed(2)}\n`;
        }
    }
    if (!fs.existsSync('reports')) fs.mkdirSync('reports');
    fs.writeFileSync('reports/poc_rotation_vbp_entry_delay_mfe_pct_trades.csv', csv);
    fs.writeFileSync('scratch/poc_rotation_entry_delay_mfe_pct_report.json', JSON.stringify({ R_PCT, R_PCT_REFERENCE_PRICE, THETA, legCount, pctBelowFloor, variants }, null, 2));

    const claimLines = variants.map(v =>
        `  delay=${v.delayMin}min: N=${v.N} (days=${v.distinctDates}) WR=${v.wr}% EV=$${v.ev} stopHit%=${v.stopHitPct} MFE mean/p50/p75/p90/max=${v.mfe_mean}/${v.mfe_p50}/${v.mfe_p75}/${v.mfe_p90}/${v.mfe_max} bars-to-resolution p50/p90=${v.bars_p50}/${v.bars_p90} (${v.rigorStr})`
    ).join('\n');
    const claimText = `Rotation VBP, stop-only exit (no fixed target) -- does waiting N minutes after POC convergence before firing change how far the trade actually runs (MFE) or its realized P&L? Full population (all SIGNAL events, no train/test split -- no parameter is being fit/selected here). Structural stop = 2 consecutive 1-min closes back through the converged 24hr-median level L, fixed at trigger, non-trailing.
${claimLines}
Note: EV here is the realized mark-to-market/stop P&L with NO target cap -- not comparable to the earlier TARGET_SWEEP-based poc_rotation_vbp_mechanism_check numbers, which capped upside at a swept target.`;

    await recordClaim({
        slug: 'poc_rotation_vbp_entry_delay_mfe_pct_test',
        claimText,
        sourceFile: 'scripts/backtest_poc_rotation_vbp_entry_delay_mfe.mjs',
        sampleSize: variants[0].N,
        winRate: variants[0].wr / 100,
        evPerTrade: variants[0].valEV,
        rigorStatus: variants[0].rigorStr,
        status: 'PROVISIONAL',
    });

    console.log('DONE');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
