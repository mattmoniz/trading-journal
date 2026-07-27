// scripts/backtest_pm_poc_short_reverify_20260727.mjs
// ═══════════════════════════════════════════════════════════════════════
// Follow-up to OPEN_DECISION `pm_poc_rth_inclusion_stale_exclusion_found`.
// PM_POC_FADE_SHORT was excluded from acd.js's live keepLevelsAll array on 2026-07-02
// for looking like a loser (WR=44.4%, stop=93pt, EV=-$54.9) — computed on level_prices
// data later confirmed corrupted by the volume-profile bucketing bug (fixed 2026-07-17,
// CLAUDE.md hard rule). A flat-90/40-stop re-check (docs/WIDER_WINDOW_BACKTEST_20260720.md)
// on corrected data found RTH-only PM_POC_SHORT N=29 WR=74.1% EV=+$9.41 — but that used
// backtest_unified.js's blanket stop/target, not a real per-type EV sweep.
//
// This script re-derives PM_POC_SHORT (and LONG, for completeness) using the REAL
// pipeline: detectLevelFades()/resolve() imported unmodified from backtest_unified.js
// (never reimplemented — same convention as every other re-verification in this repo),
// then sweepOptimalStopAndTarget() imported unmodified from update_optimal_stops.mjs
// (the actual production stop/target optimizer, not a hand-copied formula), then
// computeRigor() for chronological stability + day-clustering.
//
// Methodology note: mae_points/mfe_points/actual_pnl for the sweep's candidate
// population are captured by resolving each fire at detectLevelFades()'s OWN flat
// stop/target (90/40 RTH, 60/30 Monday) — i.e. "what would have really happened under
// the standard rule" — exactly mirroring what a real active_setups row's MAE/MFE would
// look like for a setup_type that has never had its own calibrated stop/target yet
// (the same convention every other setup_type's very first OPTIMAL_STOP calibration
// started from). This is the same order-blind-tail-percentile limitation documented in
// CLAUDE.md for update_optimal_stops.mjs generally — real MAE/MFE can only be known up
// to whatever stop/target was actually live at the time, not beyond it.
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import {
  resolve, loadData, detectLevelFades,
} from './backtest_unified.js';
import { sweepOptimalStopAndTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';

const DPP = DEFAULT_DPP;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function main() {
  const { barsByDate, acdByDate, dates } = await loadData();

  const lpResult = await query(
    `SELECT trade_date::text, price::float FROM level_prices WHERE level_name = 'PM_POC' AND trade_date >= $1 AND trade_date <= $2`,
    [dates[0], dates[dates.length - 1]]
  );
  const pmPocByDate = new Map(lpResult.rows.map(r => [r.trade_date, r.price]));
  console.log(`PM_POC level_prices rows: ${pmPocByDate.size}`);

  function detectAndResolve(dir) {
    const trades = [];
    for (let di = 5; di < dates.length; di++) {
      const date = dates[di];
      const bars = barsByDate.get(date);
      const acd = acdByDate.get(date);
      if (!bars || !acd || !bars.length) continue;
      const pmPoc = pmPocByDate.get(date);
      if (pmPoc == null) continue;
      const isMonday = new Date(date + 'T12:00:00').getDay() === 1;
      const fires = detectLevelFades(bars, { PM_POC: pmPoc }, isMonday).filter(f => f.direction === dir);
      for (const f of fires) {
        const r = resolve(bars, f.entryIdx, f.direction, f.entry, f.stop, f.target, 240);
        trades.push({ date, entry: f.entry, mae_points: r.mae, mfe_points: r.mfe, actual_pnl: r.pnl, result: r.result });
      }
    }
    return trades;
  }

  for (const dir of ['SHORT', 'LONG']) {
    const allFires = detectAndResolve(dir);
    console.log(`\n── PM_POC_FADE_${dir} (all fires N=${allFires.length}) ──────────────────────────`);
    if (allFires.length < 20) { console.log('  N<20, cannot sweep.'); continue; }

    // Percentile candidates + sweep population: TARGET_HIT/STOP_HIT only, matching
    // update_optimal_stops.mjs's own statsRes query (EXPIRED trades inflate MAE/MFE).
    const decided = allFires.filter(t => t.result === 'TARGET_HIT' || t.result === 'STOP_HIT');
    console.log(`  Decided (TARGET_HIT/STOP_HIT) N=${decided.length}`);
    if (decided.length < 20) { console.log('  Decided N<20, cannot sweep.'); continue; }

    const maeSorted = [...decided.map(t => t.mae_points)].sort((a, b) => a - b);
    const mfeSorted = [...decided.map(t => t.mfe_points)].sort((a, b) => a - b);
    const maeCandidates = [25, 40, 50, 60, 75, 90].map(p => ({ value: percentile(maeSorted, p), pct: p / 100 }));
    const maxT = percentile(mfeSorted, 75);

    const best = sweepOptimalStopAndTarget(decided, maeCandidates, maxT, DPP, DPP, COMM);
    if (!best) { console.log('  Sweep returned null (thin tail).'); continue; }
    console.log(`  Optimal stop=${best.stop}pt target=${best.target}pt sweep-EV=$${best.ev.toFixed(2)}/trade`);

    // Re-resolve every fire (not just decided ones) at the winning stop/target for a
    // real, order-aware N/WR/EV + rigor/stability check — this is the number that
    // actually matters, the sweep's own EV is an approximation over the candidate grid.
    const final = [];
    for (let di = 5; di < dates.length; di++) {
      const date = dates[di];
      const bars = barsByDate.get(date);
      const acd = acdByDate.get(date);
      if (!bars || !acd || !bars.length) continue;
      const pmPoc = pmPocByDate.get(date);
      if (pmPoc == null) continue;
      const isMonday = new Date(date + 'T12:00:00').getDay() === 1;
      const fires = detectLevelFades(bars, { PM_POC: pmPoc }, isMonday).filter(f => f.direction === dir);
      for (const f of fires) {
        const stopPx = dir === 'LONG' ? f.entry - best.stop : f.entry + best.stop;
        const targetPx = dir === 'LONG' ? f.entry + best.target : f.entry - best.target;
        const r = resolve(bars, f.entryIdx, dir, f.entry, stopPx, targetPx, 240);
        final.push({ date, pnl: r.pnl, result: r.result });
      }
    }
    const wr = final.filter(t => t.pnl > 0).length / final.length * 100;
    const ev = final.reduce((s, t) => s + t.pnl, 0) / final.length;
    console.log(`  Re-simulated at winning stop/target: N=${final.length} WR=${wr.toFixed(1)}% EV=$${ev.toFixed(2)}/trade`);

    const rigor = computeRigor(final, { dateField: 'date', pnlFn: t => t.pnl });
    console.log(`  Rigor: distinctDates=${rigor.distinctDates} top5DayPct=${rigor.top5DayPct}% clustered=${rigor.clustered} stable=${rigor.stable} thirds=${JSON.stringify(rigor.thirds)} clean=${rigor.clean}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
