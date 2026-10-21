// Recomputes the hard-drive cutoff used by server/services/sweepReversalMerged.js (docs/SWEEP_PRIOR_MOVE_SELECTOR_PREREG_20261021.md, OPEN_DECISION
// reversal_sweep_stopsweep_merge_into_one_setup_20261021). Replays the joined sweep trigger (the FAILED_SWEEP_REVERSAL form over the union of both old
// rules' levels, edge-triggered, thinned to one event per direction per 10 minutes) over the trailing TRAILING_DAYS, measures each event's drive with the
// SAME function the live detector uses (computeDriveAtrUnits), and stores the PERCENTILE-th percentile in performance_audit
// (signal_type 'SWEEP_DRIVE_CUTOFF', signal_name 'M60_P80_POOLED'). The percentile is the one calibrated to the user's described frequency (the
// first-per-direction-per-day tight event rate is stored too, so drift away from 1-2 a day is visible). Weekly via run_weekly_backtests.sh.
import { query } from '../server/db.js';
import { loadBars, sessionIndex, lb } from './lib/pocJoinLoader.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { computeDriveAtrUnits, SWEEP_LEVEL_PRIORITY, SWEEP_POKE_POINTS, SWEEP_LOOKBACK_BARS } from '../server/services/sweepReversalMerged.js';
const TRAILING_DAYS = 730, PERCENTILE = 0.8, MIN_BARS = 30, TABLE = ['PD_POC', 'PD_VAH', 'PD_VAL', 'FLOOR_PIVOT', 'FLOOR_R1', 'FLOOR_S1', 'OR5_HIGH', 'OR5_LOW'];
async function main() {
  const today = (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d;
  const from = (await query(`SELECT (CURRENT_DATE - $1::int)::text d`, [TRAILING_DAYS])).rows[0].d;
  const D = await loadBars(from, today), S = sessionIndex(D); const idxOf = new Map(); for (let i = 0; i < D.TS.length; i++) idxOf.set(D.TS[i], i);
  const lvl = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE level_name = ANY($1) AND trade_date >= $2 AND trade_date < $3`, [TABLE, from, today])).rows) { if (!lvl.has(r.d)) lvl.set(r.d, {}); lvl.get(r.d)[r.n] = r.p; }
  const sessions = S.dates.filter((d) => d >= from && d < today && lvl.has(d) && !isInsideNqRollWeek(d) && !(d >= '2025-09-28' && d <= '2025-11-19'));
  for (const d of sessions) { const [a] = S.rth.get(d), o = lb(D.TS, d + ' 00:00:00'); let onl = Infinity, onh = -Infinity; for (let k = o; k < a; k++) { if (D.L[k] < onl) onl = D.L[k]; if (D.H[k] > onh) onh = D.H[k]; } const L0 = lvl.get(d); if (onl < Infinity) { L0.ONL = onl; L0.ONH = onh; }
    const j = S.dates.indexOf(d); if (j > 0) { const [pa, pb] = S.rth.get(S.dates[j - 1]); let lo = Infinity, hi = -Infinity; for (let k = pa; k < pb; k++) { if (D.L[k] < lo) lo = D.L[k]; if (D.H[k] > hi) hi = D.H[k]; } L0.PD_LOW = lo; L0.PD_HIGH = hi; }
    let il = Infinity, ih = -Infinity; for (let k = a; k < a + 60; k++) { if (D.L[k] < il) il = D.L[k]; if (D.H[k] > ih) ih = D.H[k]; } L0.IB_LOW = il; L0.IB_HIGH = ih; }
  const events = [];
  for (const d of sessions) { const [a] = S.rth.get(d), L = lvl.get(d), atr = S.atr20(d); if (!(atr > 0)) continue; const end = idxOf.get(d + ' 15:55:00') ?? lb(D.TS, d + ' 15:55:00'), exitIdx = idxOf.get(d + ' 15:58:00') ?? 0, ibStart = idxOf.get(d + ' 10:31:00') ?? lb(D.TS, d + ' 10:31:00'), prev = {}, lastMin = {};
    for (let i = a + MIN_BARS; i <= end; i++) { let lo = Infinity, loI = i, hi = -Infinity, hiI = i; for (let k = i - SWEEP_LOOKBACK_BARS + 1; k <= i; k++) { if (D.L[k] < lo) { lo = D.L[k]; loI = k; } if (D.H[k] > hi) { hi = D.H[k]; hiI = k; } }
      const now = {}; let fired = null; for (const n of SWEEP_LEVEL_PRIORITY) { const p = L[n]; if (p == null) continue; if ((n === 'IB_LOW' || n === 'IB_HIGH') && i < ibStart) { now[n] = null; continue; }
        let key = null, long = null; if (lo < p - SWEEP_POKE_POINTS && D.C[i] > p) { key = n + 'L'; long = true; } else if (hi > p + SWEEP_POKE_POINTS && D.C[i] < p) { key = n + 'S'; long = false; } now[n] = key; if (key && !fired && prev[n] !== key) fired = { long }; }
      for (const n of SWEEP_LEVEL_PRIORITY) prev[n] = now[n] ?? null; if (!fired || exitIdx <= i) continue;
      const mins = +D.TS[i].slice(11, 13) * 60 + +D.TS[i].slice(14, 16), dk = d + fired.long; if (lastMin[dk] != null && mins - lastMin[dk] < 10) continue; lastMin[dk] = mins;
      const w0 = Math.max(0, i - 80), bars = []; for (let k = w0; k <= i; k++) bars.push({ high: D.H[k], low: D.L[k] }); const extIdx = (fired.long ? loI : hiI) - w0;
      const drive = computeDriveAtrUnits(bars, extIdx, fired.long, fired.long ? lo : hi, atr); if (drive != null) events.push({ d, long: fired.long, mins, drive }); } }
  if (events.length < 500) throw new Error(`only ${events.length} events, refusing to write a cutoff`);
  const sorted = events.map((e) => e.drive).sort((x, y) => x - y), cutoff = sorted[Math.min(sorted.length - 1, Math.floor(PERCENTILE * sorted.length))];
  const first = {}; let firsts = 0; for (const e of events.filter((x) => x.drive >= cutoff).sort((p, q) => (p.d < q.d ? -1 : p.d > q.d ? 1 : p.mins - q.mins))) { const k = e.d + e.long; if (!first[k]) { first[k] = 1; firsts++; } }
  const nDays = new Set(events.map((e) => e.d)).size;
  await query(`INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes) VALUES (CURRENT_DATE, $1, 'SWEEP_DRIVE_CUTOFF', 'M60_P80_POOLED', $2, $3)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET notes = EXCLUDED.notes, sample_size = EXCLUDED.sample_size`, [TRAILING_DAYS, events.length, JSON.stringify({ cutoff, percentile: PERCENTILE, trailing_days: TRAILING_DAYS, events: events.length, days: nDays, first_per_direction_per_day_per_day: +(firsts / nDays).toFixed(2), events_per_day: +(events.length / nDays).toFixed(1), source: 'scripts/calibrate_sweep_drive_cutoff.mjs' })]);
  console.log(`SWEEP_DRIVE_CUTOFF written: cutoff ${cutoff.toFixed(3)} ATR20 (p${PERCENTILE * 100} of ${events.length} events over ${nDays} days); first-per-direction-per-day tight rate ${(firsts / nDays).toFixed(2)}/day`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
