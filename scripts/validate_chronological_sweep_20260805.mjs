// One-off validation script (NOT wired into any cron) -- compares the existing order-blind
// sweepOptimalStopAndTarget() against the new sweepOptimalStopAndTargetChronological() for
// every currently-live setup_type, to produce the diff DeepSeek's design review called for
// before this ships (scratch/deepseek_response.md, 2026-08-05). Writes nothing to the DB.
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { makeBarIndex } from '../server/services/targetCalibrationService.js';
import {
  sweepOptimalStopAndTarget,
  sweepOptimalStopAndTargetChronological,
} from './update_optimal_stops.mjs';

const DEFAULT_DPP = LIVE_INSTRUMENT.dollarsPerPoint;

const { rows: liveTypes } = await query(`
  SELECT DISTINCT ON (signal_name) signal_name
  FROM performance_audit WHERE signal_type = 'SETUP_STATUS'
  ORDER BY signal_name, run_date DESC
`);
// Only the ones NOT suppressed matter for real live comparison, but pull recommendation too
const { rows: statusRows } = await query(`
  SELECT DISTINCT ON (signal_name) signal_name, recommendation
  FROM performance_audit WHERE signal_type = 'SETUP_STATUS'
  ORDER BY signal_name, run_date DESC
`);
const liveNames = statusRows.filter(r => !['SUPPRESS', 'THIN_N'].includes(r.recommendation)).map(r => r.signal_name);
console.log(`${liveNames.length} live (non-SUPPRESS/THIN_N) setup_types to compare.`);

const { rows: maeRows } = await query(`
  SELECT setup_type,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY mae_points) AS p25_mae,
    PERCENTILE_CONT(0.40) WITHIN GROUP (ORDER BY mae_points) AS p40_mae,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mae_points) AS p50_mae,
    PERCENTILE_CONT(0.60) WITHIN GROUP (ORDER BY mae_points) AS p60_mae,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mae_points) AS p75_mae,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mfe_points) AS p75_mfe
  FROM active_setups
  WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND mae_points <= 300 AND mfe_points <= 300
    AND status = 'RESOLVED' AND replay_resolution IN ('TARGET_HIT','STOP_HIT')
  GROUP BY setup_type
`);
const maeByType = Object.fromEntries(maeRows.map(r => [r.setup_type, r]));

const { rows: rawRows } = await query(`
  SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float,
    fired_at, entry_zone_low::float, entry_zone_high::float
  FROM active_setups
  WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
    AND mae_points <= 300 AND mfe_points <= 300
    AND status = 'RESOLVED' AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
`);
const rawByType = {};
for (const t of rawRows) (rawByType[t.setup_type] ||= []).push(t);

console.log('Loading NQ bars...');
const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close }));
console.log(`${allBars.length} bars loaded.`);
const firstIndexAfter = makeBarIndex(allBars);

let comparedCount = 0, insufficientBarData = 0;
const results = [];
for (const type of liveNames) {
  const mr = maeByType[type];
  const trades = rawByType[type] || [];
  if (!mr || trades.length < 20) continue;

  const maeCandidates = [
    { value: mr.p25_mae, pct: 0.25 }, { value: mr.p40_mae, pct: 0.40 },
    { value: mr.p50_mae, pct: 0.50 }, { value: mr.p60_mae, pct: 0.60 },
    { value: mr.p75_mae, pct: 0.75 },
  ].map(c => ({ ...c, value: parseFloat(c.value) })).filter(c => !isNaN(c.value) && c.value > 0);
  const p75mfe = Math.round(parseFloat(mr.p75_mfe)) || 35;

  const oldSwept = sweepOptimalStopAndTarget(trades, maeCandidates, p75mfe, DEFAULT_DPP, DEFAULT_DPP);

  const direction = inferDirection(type);
  const tradesWithBars = trades.map(t => {
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    const barIdx = firstIndexAfter(new Date(t.fired_at).getTime());
    return { ...t, entry, barIdx, direction };
  });
  const newSwept = sweepOptimalStopAndTargetChronological(tradesWithBars, allBars, maeCandidates, p75mfe, DEFAULT_DPP, DEFAULT_DPP);

  if (!newSwept || newSwept.insufficientBarData) {
    insufficientBarData++;
    results.push({ type, oldSwept, newSwept: null, note: 'insufficient bar data for chronological walk' });
    continue;
  }
  comparedCount++;
  const stopDelta = newSwept.stop - (oldSwept?.stop ?? 0);
  const targetDelta = newSwept.target - (oldSwept?.target ?? 0);
  const evDelta = newSwept.ev - (oldSwept?.ev ?? 0);
  results.push({ type, oldSwept, newSwept, stopDelta, targetDelta, evDelta });
}

results.sort((a, b) => Math.abs(b.evDelta ?? 0) - Math.abs(a.evDelta ?? 0));
console.log(`\n${comparedCount} types compared, ${insufficientBarData} skipped (insufficient bar data).\n`);
console.log('type | old(stop/target/ev) | new(stop/target/ev,n) | evDelta');
for (const r of results) {
  if (!r.newSwept) { console.log(`${r.type}: ${r.note}`); continue; }
  const o = r.oldSwept ? `${r.oldSwept.stop}/${r.oldSwept.target}/$${r.oldSwept.ev.toFixed(2)}` : 'null';
  const n = `${r.newSwept.stop}/${r.newSwept.target}/$${r.newSwept.ev.toFixed(2)} (n=${r.newSwept.n})`;
  console.log(`${r.type}: OLD=${o} NEW=${n} evDelta=$${r.evDelta.toFixed(2)}`);
}

const meanEvDelta = results.filter(r => r.newSwept).reduce((s, r) => s + r.evDelta, 0) / comparedCount;
const worseCount = results.filter(r => r.newSwept && r.evDelta < 0).length;
const betterCount = results.filter(r => r.newSwept && r.evDelta > 0).length;
console.log(`\nMean EV delta (new - old): $${meanEvDelta.toFixed(2)}/trade`);
console.log(`${worseCount} types show LOWER EV under honest chronological ordering, ${betterCount} show higher.`);

process.exit(0);
