// Canonical POC-rotation-JOIN leg/pivot detector. Moved here 2026-09-01 from
// scripts/backtest_poc_rotation_vbp.mjs (where it was originally developed and
// audited across a multi-week research thread -- repainting-safety per real-tick
// review, price-field pinning, B_FLOOR bar-count floor, SAME_SELECTION_NO_SIGNAL
// matched-elapsed-bars control) so acd.js's live poll loop can import the SAME
// function the backtest validated, per CLAUDE.md's "export the real function,
// never reimplement live-derived classification logic inline" rule.
// scripts/backtest_poc_rotation_vbp.mjs now re-exports these unchanged so its 14
// existing importers (other backtest_poc_rotation_*.mjs scripts) keep working
// without modification.

export const TICK = 0.25;
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

// R can be a fixed point value (legacy, rMode='fixed', the original R=65/60 runs) or,
// when rMode='pct', a fraction of the running extreme (e.g. 0.0022 = 0.22%). See
// scripts/backtest_poc_rotation_vbp.mjs's original comment (2026-08-24) for why
// percentage mode exists -- NQ's price growth makes a fixed R an increasingly loose
// threshold over a multi-year backtest. The live poller only ever evaluates "today,"
// so this doesn't matter for live use, but rMode='fixed', R=65 is the validated
// construction (poc_rotation_join_fade_levels_med50_fixed) and is what the live path
// should pass.
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
