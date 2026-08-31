import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

// FIXED 2026-08-30 (OPEN_DECISION poc_rotation_thread_points_mislabeled_as_dollars): every
// EV/WR figure this whole thread's foundational script reports used to be a raw price-point
// difference printed with a "$" prefix, never applying MNQ's real $2/pt or the $2 round-trip
// commission (LIVE_INSTRUMENT, server/config/instruments.js). runTrade()'s own `.pnl` field
// stays in points (the T-sweep below picks the same argmax T under either scaling -- a
// positive affine transform shared by every candidate -- so it's untouched); only the
// aggregated EV/WR/recordClaim conversion in summarizeArm() below changed.
const PPT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const dollarPnl = r => r.res.pnl * PPT - COMM;

export const TICK = 0.25;
const RTH_START = 570, RTH_END = 959;
export const TARGET_SWEEP = [10, 15, 20, 30, 40, 50, 60];
export const B_FLOOR = 10;

const round = p => Math.floor(p / TICK + 0.5) * TICK;

export class IncrementalProfile {
    constructor() {
        this.volMap = new Map();
        this.totalVol = 0;
    }
    addBar(b) {
        const h = b.high, l = b.low, v = b.volume;
        if (!(h >= l)) return;
        const levels = Math.max(1, Math.round((h - l) / TICK) + 1);
        const vpl = v / levels;
        for (let p = l; p <= h + TICK / 2; p += TICK) {
            const lvl = round(p);
            this.volMap.set(lvl, (this.volMap.get(lvl) || 0) + vpl);
        }
        this.totalVol += v;
    }
    getMed50() {
        if (this.totalVol === 0) return 0;
        const prices = Array.from(this.volMap.keys()).sort((a,b)=>a-b);
        const half = this.totalVol / 2;
        let cum = 0;
        for (const p of prices) {
            cum += this.volMap.get(p);
            if (cum >= half) return p;
        }
        return prices[prices.length - 1];
    }
    getPoc() {
        if (this.totalVol === 0) return 0;
        let maxV = -1, poc = 0;
        const prices = Array.from(this.volMap.keys()).sort((a,b)=>a-b);
        for (const p of prices) {
            const v = this.volMap.get(p);
            if (v > maxV) { maxV = v; poc = p; }
        }
        return poc;
    }
}

export function subPoints(bar, convention = 'standard') {
  let path;
  if (convention === 'standard') {
    path = bar.close >= bar.open ? [bar.open, bar.low, bar.high, bar.close] : [bar.open, bar.high, bar.low, bar.close];
  } else {
    path = bar.close >= bar.open ? [bar.open, bar.high, bar.low, bar.close] : [bar.open, bar.low, bar.high, bar.close];
  }
  const segVol = bar.volume / 3, steps = 5, out = [];
  for (let s = 0; s < 3; s++) {
    const p0 = path[s], p1 = path[s + 1];
    for (let i = 1; i <= steps; i++) {
        const price = p0 + (p1 - p0) * (i / steps);
        const vol = segVol / steps;
        out.push({ price, vol, ts: bar.ts, closePx: bar.close, high: price, low: price, volume: vol });
    }
  }
  return out;
}

export function buildProfile(points) {
    const prof = new IncrementalProfile();
    for (const pt of points) prof.addBar(pt);
    return prof;
}

export function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
export function percentile(sorted, p) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
function etMinuteOfDay(ts) { const d = new Date(ts); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
export function formatET(ts) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts)).replace(', ', ' '); }

// entryOffset: bars after the confirming (trigger) bar before entering (default 1 =
// next bar's open, the standard no-lookahead convention). A larger offset simulates
// waiting N minutes after convergence confirms before firing.
export function runTrade(event, bars, T, entryOffset = 1) {
    const entryIdx = event.trigger_idx + entryOffset;
    if (entryIdx >= bars.length) return null;

    const entryPx = bars[entryIdx].open;
    event = { ...event, entry_idx: entryIdx };
    const entryTime = bars[event.entry_idx].ts;
    const L = event.L;
    const long = event.direction === 'DOWN'; 
    const trade_direction = long ? 'LONG' : 'SHORT';
    const targetPx = long ? entryPx + T : entryPx - T;
    
    let state = { wrongCloses: 0, long, entry: entryPx, L, T };
    let resolution = null;
    let exitTime = null;
    let exit_idx = event.entry_idx;
    
    for (let i = event.entry_idx; i < bars.length; i++) {
        exit_idx = i;
        const bar = bars[i];
        
        let hitTarget = false;
        if (T != null) {
            if (long && bar.high >= targetPx) hitTarget = true;
            if (!long && bar.low <= targetPx) hitTarget = true;
        }
        
        let closedWrong = long ? bar.close < L : bar.close > L;
        if (closedWrong) state.wrongCloses++;
        else state.wrongCloses = 0;
        
        if (state.wrongCloses >= 2) {
            resolution = { res: 'STOP_HIT', exitPx: bar.close };
            exitTime = bar.ts;
            break;
        } else if (hitTarget) {
            resolution = { res: 'TARGET_HIT', exitPx: targetPx };
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
        entryTime,
        trade_direction,
        entryPx,
        stopPx: L,
        targetPx,
        exitTime,
        exitReason: resolution.res,
        bars_to_resolution: exit_idx - event.entry_idx + 1,
        pnl
    };
}

// Reversal/ZigZag segmentation + convergence detection -- the audited core of this
// construction (repainting-safety per real-tick review §7.2, price-field pinning,
// B_FLOOR bar-count floor, SAME_SELECTION_NO_SIGNAL matched-elapsed-bars control).
// Extracted so other scripts (e.g. the entry-delay variant) reuse this exact logic
// rather than re-deriving it -- CLAUDE.md's standing "export the real function" rule.
//
// R can be a fixed point value (legacy, rMode='fixed', the original R=65/60 runs) or,
// when rMode='pct', a fraction of the running extreme (e.g. 0.0022 = 0.22%). Found
// 2026-08-24: NQ's price roughly doubled 2023->2026 (11,300-17,500 -> 23,000-31,000),
// so a fixed R=65 points was an increasingly loose (more frequently triggered)
// threshold over the same window -- events/session rose 2.5->5.7 2023->2026, tracking
// the price growth almost exactly, not a real change in market behavior. Percentage
// mode keeps the threshold's real-world significance constant across the full history.
export function detectSignalEvents(R, path_convention, THETA, sessions, rMode = 'fixed') {
    let all_signal = [];
    let all_never = [];
    let all_leg_records = [];

    for (const session of sessions) {
        const { bars, t } = session;
        const m24_history = new Float32Array(bars.length);
        const p24 = new IncrementalProfile();
        let anchor_idx = 0;
        let pivot_is_low = null;
        let running_high = bars[0].high, running_high_idx = 0;
        let running_low = bars[0].low, running_low_idx = 0;

        const leg_records = [];
        let current_leg = { start_idx: 0, direction: null, converged_idx: null, length_at_convergence: null };

        for (let i = 0; i < bars.length; i++) {
            const bar = bars[i];
            const pts = subPoints(bar, path_convention);
            for (const pt of pts) p24.addBar(pt);
            const m24 = p24.getMed50();
            m24_history[i] = m24;

            if (bar.high > running_high) { running_high = bar.high; running_high_idx = i; }
            if (bar.low < running_low) { running_low = bar.low; running_low_idx = i; }

            // Effective reversal distance: fixed point value, or R% of the running
            // extreme being tracked (standard percentage-ZigZag convention -- the
            // threshold scales with the price level at the extreme itself).
            const rDown = rMode === 'pct' ? R * running_high : R;
            const rUp = rMode === 'pct' ? R * running_low : R;

            let leg_confirmed = false;
            let old_direction = current_leg.direction;

            if (pivot_is_low === null) {
                if (running_high - bar.low >= rDown) {
                    anchor_idx = running_high_idx;
                    running_high = bar.high; running_low = bar.low;
                    running_high_idx = i; running_low_idx = i;
                    pivot_is_low = false; leg_confirmed = true;
                    current_leg.direction = 'UP';
                    old_direction = 'UP';
                } else if (bar.high - running_low >= rUp) {
                    anchor_idx = running_low_idx;
                    running_high = bar.high; running_low = bar.low;
                    running_high_idx = i; running_low_idx = i;
                    pivot_is_low = true; leg_confirmed = true;
                    current_leg.direction = 'DOWN';
                    old_direction = 'DOWN';
                }
            } else if (pivot_is_low === true) {
                if (running_high - bar.low >= rDown) {
                    anchor_idx = running_high_idx;
                    running_high = bar.high; running_low = bar.low;
                    running_high_idx = i; running_low_idx = i;
                    pivot_is_low = false; leg_confirmed = true;
                }
            } else {
                if (bar.high - running_low >= rUp) {
                    anchor_idx = running_low_idx;
                    running_high = bar.high; running_low = bar.low;
                    running_high_idx = i; running_low_idx = i;
                    pivot_is_low = true; leg_confirmed = true;
                }
            }
            
            if (leg_confirmed) {
                current_leg.end_idx = anchor_idx;
                const old_len = anchor_idx - current_leg.start_idx + 1;
                if (old_len >= B_FLOOR && old_direction !== null) {
                    all_never.push({
                        t,
                        leg_start: current_leg.start_idx,
                        direction: old_direction,
                        trigger_idx: i,
                        entry_idx: i + 1 < bars.length ? i + 1 : null,
                        L: m24
                    });
                }
                leg_records.push({ ...current_leg });
                current_leg = {
                    start_idx: anchor_idx,
                    direction: pivot_is_low ? 'UP' : 'DOWN',
                    converged_idx: null,
                    length_at_convergence: null
                };
            }
            
            if (current_leg.direction !== null && current_leg.converged_idx === null) {
                const len = i - current_leg.start_idx + 1;
                if (len >= B_FLOOR) {
                    const rotPts = [];
                    for (let j = current_leg.start_idx; j <= i; j++) rotPts.push(...subPoints(bars[j], path_convention));
                    const pRot = buildProfile(rotPts);
                    const mRot = pRot.getMed50();
                    const d50 = Math.abs(mRot - m24);
                    
                    if (d50 <= THETA) {
                        current_leg.converged_idx = i;
                        current_leg.length_at_convergence = len;
                        current_leg.converged_d50 = d50;
                        current_leg.converged_poc_dist = Math.abs(pRot.getPoc() - p24.getPoc());
                        
                        all_signal.push({
                            t,
                            leg_start: current_leg.start_idx,
                            direction: current_leg.direction,
                            trigger_idx: i,
                            entry_idx: i + 1 < bars.length ? i + 1 : null,
                            L: m24, d50, poc_dist: current_leg.converged_poc_dist, len
                        });
                    }
                }
            }
        }
        leg_records.push({ ...current_leg, end_idx: bars.length - 1 });
        session.m24_history = m24_history;
        all_leg_records.push(...leg_records.map(r => ({...r, t})));
    }
    
    const signal_len_UP = all_signal.filter(s => s.direction === 'UP').map(s => s.len).sort((a,b)=>a-b);
    const signal_len_DOWN = all_signal.filter(s => s.direction === 'DOWN').map(s => s.len).sort((a,b)=>a-b);
    const med_len_UP = signal_len_UP.length ? percentile(signal_len_UP, 0.5) : B_FLOOR;
    const med_len_DOWN = signal_len_DOWN.length ? percentile(signal_len_DOWN, 0.5) : B_FLOOR;
    
    let all_control = [];
    for (const leg of all_leg_records) {
        if (leg.converged_idx !== null) continue;
        if (leg.direction === null) continue;
        
        const med_len = Math.round(leg.direction === 'UP' ? med_len_UP : med_len_DOWN);
        if (leg.end_idx - leg.start_idx + 1 >= med_len) {
            const trigger_idx = leg.start_idx + med_len - 1;
            const session = sessions.find(s => s.t === leg.t);
            all_control.push({
                t: leg.t, leg_start: leg.start_idx, direction: leg.direction,
                trigger_idx: trigger_idx,
                entry_idx: trigger_idx + 1 < session.bars.length ? trigger_idx + 1 : null,
                L: session.m24_history[trigger_idx]
            });
        }
    }

    const legLengths = all_leg_records.map(l => l.end_idx - l.start_idx + 1);
    const pctBelowFloor = (legLengths.filter(l => l < B_FLOOR).length / legLengths.length * 100).toFixed(1);
    const avg_d50 = mean(all_signal.map(s => s.d50)) || 0;
    const avg_poc = mean(all_signal.map(s => s.poc_dist)) || 0;

    return { all_signal, all_control, all_never, all_leg_records, med_len_UP, med_len_DOWN, legCount: all_leg_records.length, pctBelowFloor, avg_d50, avg_poc };
}

async function runScenario(R, path_convention, THETA, sessions, isPrimary, trainDates) {
    const { all_signal, all_control, all_never, legCount, pctBelowFloor, avg_d50, avg_poc, med_len_UP, med_len_DOWN } = detectSignalEvents(R, path_convention, THETA, sessions);

    // Chronological train/test split for the target sweep (matches
    // backtest_poc_convergence_directional_and_trade.mjs's discipline exactly --
    // sweep T on TRAIN only, report the headline arm stats on held-out TEST only.
    // The original dispatch swept T over the FULL all_signal population with no
    // holdout, which in-sample-optimizes T specifically for the SIGNAL arm and
    // inflates its reported EV -- caught on audit before trusting the +5.65pt
    // headline, fixed here.
    const trainSignal = all_signal.filter(e => trainDates.has(e.t));
    let bestT = null, bestEV = -Infinity;
    for (const T of TARGET_SWEEP) {
        let evSum = 0, count = 0;
        for (const e of trainSignal) {
            const sess = sessions.find(s => s.t === e.t);
            const res = runTrade(e, sess.bars, T);
            if (res) { evSum += res.pnl; count++; }
        }
        const ev = count ? evSum / count : -Infinity;
        if (ev > bestEV) { bestEV = ev; bestT = T; }
    }
    if (bestT === null) bestT = 20;

    const results_signal = all_signal.map(e => ({ arm: 'SIGNAL', split: trainDates.has(e.t) ? 'TRAIN' : 'TEST', e, res: runTrade(e, sessions.find(s=>s.t===e.t).bars, bestT) })).filter(x => x.res);
    const results_control = all_control.map(e => ({ arm: 'SAME_SELECTION_NO_SIGNAL', split: trainDates.has(e.t) ? 'TRAIN' : 'TEST', e, res: runTrade(e, sessions.find(s=>s.t===e.t).bars, bestT) })).filter(x => x.res);
    const results_never = all_never.map(e => ({ arm: 'NEVER_SELECTED', split: trainDates.has(e.t) ? 'TRAIN' : 'TEST', e, res: runTrade(e, sessions.find(s=>s.t===e.t).bars, bestT) })).filter(x => x.res);

    if (isPrimary) {
        let csv = `split,arm,trade_date,leg_anchor_time,leg_direction,entry_time,direction,entry_price,stop_price,target_price,exit_time,exit_reason,bars_to_resolution,pnl\n`;
        for (const group of [results_signal, results_control, results_never]) {
            for (const item of group) {
                const { arm, split, e, res } = item;
                const session = sessions.find(s => s.t === e.t);
                const leg_ts = formatET(session.bars[e.leg_start].ts);
                const entry_ts = formatET(res.entryTime);
                const exit_ts = formatET(res.exitTime);
                csv += `${split},${arm},${e.t},${leg_ts},${e.direction},${entry_ts},${res.trade_direction},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${res.targetPx.toFixed(2)},${exit_ts},${res.exitReason},${res.bars_to_resolution},${res.pnl.toFixed(2)}\n`;
            }
        }
        if (!fs.existsSync('reports')) fs.mkdirSync('reports');
        fs.writeFileSync('reports/poc_rotation_vbp_trades.csv', csv);
    }

    function summarizeArm(name, results, split) {
        const filtered = split ? results.filter(r => r.split === split) : results;
        const N = filtered.length;
        if (N === 0) return { N: 0 };
        const distinctDates = new Set(filtered.map(r => r.e.t)).size;
        const wins = filtered.filter(r => dollarPnl(r) > 0).length;
        const wr = (wins / N * 100).toFixed(1);
        const ev = (filtered.reduce((s, r) => s + dollarPnl(r), 0) / N).toFixed(2);
        let rigorStr = '';
        if (N >= 20) {
            const rigor = computeRigor(filtered.map(r => ({ t: r.e.t, pnl: dollarPnl(r) })), { dateField: 't', pnlFn: r => r.pnl });
            rigorStr = `stable=${rigor.stable} cluster=${rigor.clustered}`;
        }
        return { N, distinctDates, wr, ev, rigorStr, valEV: Number(ev) };
    }

    return {
        R, path_convention, THETA, bestT,
        legCount,
        pctBelowFloor,
        med_len_UP, med_len_DOWN,
        avg_d50, avg_poc,
        // Headline = TEST split only (held-out, T was never optimized against these).
        signal: summarizeArm('SIGNAL', results_signal, 'TEST'),
        control: summarizeArm('SAME_SELECTION_NO_SIGNAL', results_control, 'TEST'),
        never: summarizeArm('NEVER_SELECTED', results_never, 'TEST'),
        // In-sample (TRAIN) reported alongside for transparency, never as the finding.
        signal_train: summarizeArm('SIGNAL', results_signal, 'TRAIN'),
        control_train: summarizeArm('SAME_SELECTION_NO_SIGNAL', results_control, 'TRAIN'),
    };
}

async function main() {
    const resMed = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
    const med_range = resMed.rows[0].median_range;
    const THETA = Math.max(TICK, med_range);
    
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

    // Chronological 70/30 split (same discipline as
    // backtest_poc_convergence_directional_and_trade.mjs) -- the target sweep below
    // only ever sees TRAIN; every headline arm stat is TEST (held-out), never the
    // in-sample-optimized population.
    const splitIdx = Math.floor(sessions.length * 0.7);
    const trainDates = new Set(sessions.slice(0, splitIdx).map(s => s.t));

    const out_pri = await runScenario(65, 'standard', THETA, sessions, true, trainDates);
    const out_60 = await runScenario(60, 'standard', THETA, sessions, false, trainDates);
    const out_rev = await runScenario(65, 'reverse', THETA, sessions, false, trainDates);

    const report = { THETA, trainSessions: splitIdx, testSessions: sessions.length - splitIdx, primary: out_pri, sens_60: out_60, sens_rev: out_rev };
    fs.writeFileSync('scratch/poc_rotation_raw_report.json', JSON.stringify(report, null, 2));

    // Evaluate if there is a claim -- all figures below are TEST (held-out), T was
    // swept on TRAIN only.
    const dEV = out_pri.signal.valEV - out_pri.control.valEV;
    const claimText = `Rotation VBP (Pinch 65pt reversal) vs 24hr POC -- mechanism check, TEST split only (T swept on TRAIN, ${splitIdx} train / ${sessions.length - splitIdx} test sessions, chronological 70/30).
- THETA=${THETA.toFixed(2)} (median 1-min range).
- N_legs=${out_pri.legCount} (${out_pri.pctBelowFloor}% skipped below B=10 floor).
- 3-way test (Target=${out_pri.bestT}, chosen on TRAIN only):
  SIGNAL (test): N=${out_pri.signal.N} (days=${out_pri.signal.distinctDates}) WR=${out_pri.signal.wr}% EV=$${out_pri.signal.ev} (${out_pri.signal.rigorStr})
  SAME_SELECTION_NO_SIGNAL (test, control): N=${out_pri.control.N} (days=${out_pri.control.distinctDates}) WR=${out_pri.control.wr}% EV=$${out_pri.control.ev}
  NEVER_SELECTED (test, baseline): N=${out_pri.never.N} (days=${out_pri.never.distinctDates}) WR=${out_pri.never.wr}% EV=$${out_pri.never.ev}
  For reference, TRAIN (in-sample, do not treat as a finding): SIGNAL EV=$${out_pri.signal_train.ev} (N=${out_pri.signal_train.N}), control EV=$${out_pri.control_train.ev} (N=${out_pri.control_train.N}).
- SIGNAL minus Control EV Delta (TEST): $${(dEV).toFixed(2)}.
- Sensitivities (also TEST split, same T-selection discipline):
  R=60 EV Delta = $${(out_60.signal.valEV - out_60.control.valEV).toFixed(2)}.
  Reverse path EV Delta = $${(out_rev.signal.valEV - out_rev.control.valEV).toFixed(2)}.
  med50 vs argmax: average med50_dist=${out_pri.avg_d50.toFixed(2)}, avg poc_dist=${out_pri.avg_poc.toFixed(2)} at convergence events (full population, not split).
KNOWN LIMITATION: rotation-leg tracking resets at each session's 24hr-profile boundary (6PM ET) rather than running continuously across the full ~3yr history -- a real in-progress leg spanning a session boundary is artificially truncated and restarted. This affects absolute event count/specific dates but not the SIGNAL-vs-control comparison, since both arms are drawn from the same segmentation.`;

    if (out_pri.signal.N >= 20 && out_pri.control.N >= 20) {
        await recordClaim({
            slug: 'poc_rotation_vbp_mechanism_check',
            claimText,
            sourceFile: 'scripts/backtest_poc_rotation_vbp.mjs',
            sampleSize: out_pri.signal.N,
            winRate: out_pri.signal.wr / 100,
            evPerTrade: out_pri.signal.valEV,
            rigorStatus: out_pri.signal.rigorStr || 'n/a',
            status: 'PROVISIONAL'
        });
    } else {
        console.log("Not enough events to record claim, skipping.");
    }
    
    console.log("DONE");
    process.exit(0);
}

// Guard so importing this module (e.g. for detectSignalEvents/runTrade reuse in the
// entry-delay variant scripts) doesn't also trigger a full extra backtest run as a
// side effect -- found 2026-08-24 when a sanity-check import silently kicked off this
// entire script's main() in the background.
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(e => { console.error(e); process.exit(1); });
}
