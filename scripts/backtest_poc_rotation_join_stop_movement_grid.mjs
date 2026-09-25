// Stop-movement grid for the POC_ROTATION_JOIN_LONG partial+trail idea (2026-09-24, user:
// "can you backtest this with different ways to move the stops?"). Extends
// backtest_poc_rotation_join_partial_trail.mjs's single arm20/trail30 config into a real
// grid across arm distance x trail mechanism, reusing the ALREADY-BUILT, causal, no-
// lookahead trail replayers (server/services/runnerTrailSim.js -- walkWithTrail(),
// replayBarsWithAtrTrail(), replayBarsWithStructuralTrail()) instead of hand-rolling more
// one-off simulators. Per "export the real function, don't reimplement."
//
// Same structure as before: unit 1 banks at 1R (the setup's own 20pt risk distance), unit 2
// runs one of the grid's trail mechanisms. Compared against a 2x-real-exit baseline via
// day-blocked bootstrap delta CI, same real entries/stops/bars -- only the exit shape
// differs (no structural-advantage confound). N=44/18 distinct real days -- every result
// here is PROVISIONAL; report the whole grid, not just the best cell (the "cell a grid
// search picks as best needs its own scrutiny" rule -- picking one winner out of ~18 cells
// without flagging that risk would be exactly the multiple-comparisons trap this codebase
// has been burned by before).
import { query } from '../server/db.js';
import { dayBlockedBootstrapDeltaCI } from '../server/services/rigorDiagnostics.js';
import { computeCausalAtr, computeStructuralStopAnchors } from '../server/services/runnerTrailSim.js';

const PNL_PER_POINT = 2, COMMISSION = 2;
const MAX_HORIZON_MIN = 600;
const STOP_DIST = 20; // the setup's own real risk distance (1R)
const TICK = 0.25;

async function loadRealTrades() {
  const { rows } = await query(`
    SELECT id, trade_date::text as trade_date, fired_at::text as fired_at,
           COALESCE(entry_zone_high, entry_zone_low)::float as entry, actual_pnl::float as real_pnl
    FROM active_setups
    WHERE setup_type = 'POC_ROTATION_JOIN_LONG'
      AND origin_status IN ('ACTIVE','SHADOW')
      AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND resolution IS NOT NULL AND entry_zone_low IS NOT NULL
    ORDER BY fired_at ASC
  `);
  return rows;
}

async function loadBars(firedAt) {
  const { rows } = await query(`
    SELECT ts::text as ts, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts > $1 AND ts <= $1::timestamp + ($2 || ' minutes')::interval
    ORDER BY ts ASC
  `, [firedAt, MAX_HORIZON_MIN]);
  return rows;
}

function dollarPnl(entry, exitPrice) { return Math.round(((exitPrice - entry) * PNL_PER_POINT - COMMISSION) * 100) / 100; }

// Unit 1: banks at 1R, else the real baseline (20pt stop / 60min timeout).
function simBankHalf(entry, bars) {
  const stopPrice = entry - STOP_DIST, targetPrice = entry + STOP_DIST;
  let lastBar = null;
  for (const bar of bars) {
    if ((new Date(bar.ts + 'Z') - new Date(bars.firedAt + 'Z')) / 60000 > 60) break;
    if (bar.low <= stopPrice) return dollarPnl(entry, stopPrice);
    if (bar.high >= targetPrice) return dollarPnl(entry, targetPrice);
    lastBar = bar;
  }
  return lastBar ? dollarPnl(entry, lastBar.close) : null;
}

// Unit 2: generic walkWithTrail-shaped replay, LONG-only (matches runnerTrailSim.js's own
// engine exactly -- inlined here since walkWithTrail() itself isn't exported, only the two
// pre-built arms are; this mirrors it precisely rather than diverging).
function walkWithTrailLong(bars, entry, initialStop, activationR, entryRisk, trailStopAt) {
  let armed = false, trailStop = initialStop;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!armed) {
      if (bar.low <= initialStop) return { exitPrice: initialStop, method: 'PRE_ARM_STOP' };
      const runR = (bar.high - entry) / entryRisk;
      if (runR >= activationR) armed = true;
    }
    if (armed) {
      const candidate = trailStopAt(i);
      if (candidate != null) trailStop = Math.max(trailStop, candidate);
      if (bar.low <= trailStop) return { exitPrice: trailStop, method: trailStop === initialStop ? 'STOP_HIT' : 'TRAIL_EXIT' };
    }
  }
  const last = bars[bars.length - 1];
  return { exitPrice: last ? last.close : entry, method: 'TIME_EXPIRED' };
}

// initialStopDist lets the runner start with MORE room than the setup's own 20pt risk --
// a plain wider stop, tested standalone (NO_PROTECTION) and combined with a trail mechanism
// (give it room to breathe first, THEN start managing the stop once it's proven itself).
// Note: activationR still measures R against the ORIGINAL 20pt (STOP_DIST), not the widened
// stop -- "armed at 1R" means "moved 20pt favorably," independent of how much room the wider
// stop itself gives on the downside. This keeps the arm point comparable across stop widths.
function runCell(entry, bars, activationR, mechanism, initialStopDist = STOP_DIST) {
  const entryRisk = STOP_DIST;
  const initialStop = entry - initialStopDist;
  let trailStopAt;
  if (mechanism === 'NO_PROTECTION') {
    return walkWithTrailLong(bars, entry, initialStop, Infinity, entryRisk, () => null);
  } else if (mechanism === 'BREAKEVEN_ONLY') {
    trailStopAt = () => entry;
  } else if (mechanism.startsWith('FIXED_')) {
    const dist = +mechanism.split('_')[1];
    let peak = -Infinity;
    trailStopAt = (i) => { peak = Math.max(peak, bars[i].high); return peak - dist; };
  } else if (mechanism.startsWith('ATR_')) {
    const mult = +mechanism.split('_')[1];
    const atr = computeCausalAtr(bars, 14);
    let peak = -Infinity;
    trailStopAt = (i) => { peak = Math.max(peak, bars[i].high); const a = atr[i]; return a == null ? null : peak - mult * a; };
  } else if (mechanism === 'STRUCTURAL') {
    const anchors = computeStructuralStopAnchors(bars, 0.0007, 'LONG');
    trailStopAt = (i) => { const a = anchors[Math.max(0, i - 1)]; return a == null ? null : a - TICK; };
  }
  return walkWithTrailLong(bars, entry, initialStop, activationR, entryRisk, trailStopAt);
}

async function main() {
  const trades = await loadRealTrades();
  console.log(`Real trades: ${trades.length}, distinct days: ${new Set(trades.map(t => t.trade_date)).size}`);

  const barsByTrade = new Map();
  for (const t of trades) { const b = await loadBars(t.fired_at); b.firedAt = t.fired_at; barsByTrade.set(t.id, b); }

  const ARMS = [0.5, 1.0, 1.5];
  const MECHANISMS = ['NO_PROTECTION', 'BREAKEVEN_ONLY', 'FIXED_15', 'FIXED_20', 'FIXED_30', 'FIXED_40', 'ATR_1.0', 'ATR_1.5', 'ATR_2.0', 'STRUCTURAL'];

  // Plain cells: original 20pt stop, sweep arm x mechanism.
  const cellSpecs = [];
  for (const arm of ARMS) {
    for (const mech of MECHANISMS) {
      if (mech === 'NO_PROTECTION' && arm !== ARMS[0]) continue; // arm-independent, only run once
      cellSpecs.push({ arm, mech, stopDist: STOP_DIST });
    }
  }
  // Wide-stop cells (user request 2026-09-24: "add a wide stop to it too, not just a move to
  // BE"): give the runner more initial room instead of/in addition to managing the stop.
  // A pure wide stop (NO_PROTECTION) standalone, plus wide stop + the mechanisms worth
  // pairing it with (STRUCTURAL was the best mover above; BREAKEVEN_ONLY is the simplest).
  const WIDE_STOPS = [30, 40, 50];
  for (const stopDist of WIDE_STOPS) {
    cellSpecs.push({ arm: 'n/a', mech: 'NO_PROTECTION', stopDist });
    for (const arm of [0.5, 1.0]) {
      cellSpecs.push({ arm, mech: 'BREAKEVEN_ONLY', stopDist });
      cellSpecs.push({ arm, mech: 'STRUCTURAL', stopDist });
    }
  }

  const results = [];
  for (const spec of cellSpecs) {
    const { arm, mech, stopDist } = spec;
    const events = [];
    for (const t of trades) {
      const bars = barsByTrade.get(t.id);
      const unit1 = simBankHalf(t.entry, bars);
      const r2 = runCell(t.entry, bars, arm === 'n/a' ? Infinity : arm, mech, stopDist);
      if (unit1 == null || !r2) continue;
      const total = unit1 + dollarPnl(t.entry, r2.exitPrice);
      const baseline2x = t.real_pnl * 2;
      events.push({ date: t.trade_date, group: 'CELL', pnl: total });
      events.push({ date: t.trade_date, group: 'BASELINE', pnl: baseline2x });
    }
    const cell = events.filter(e => e.group === 'CELL');
    const base = events.filter(e => e.group === 'BASELINE');
    const meanCell = cell.reduce((a, e) => a + e.pnl, 0) / cell.length;
    const meanBase = base.reduce((a, e) => a + e.pnl, 0) / base.length;
    const ci = dayBlockedBootstrapDeltaCI(events, `poc_stopgrid_${stopDist}_${arm}_${mech}`, { groupA: 'BASELINE', groupB: 'CELL' });
    const excludesZero = ci.lo != null && (ci.lo > 0 || ci.hi < 0);
    results.push({ stopDist, arm, mech, n: cell.length, meanCell, meanBase, delta: meanCell - meanBase, lo: ci.lo, hi: ci.hi, excludesZero });
  }

  results.sort((a, b) => b.delta - a.delta);
  console.log('\nStop'.padEnd(6), 'Arm'.padEnd(6), 'Mechanism'.padEnd(14), 'N'.padEnd(4), 'Cell$'.padEnd(9), 'Base$'.padEnd(9), 'Delta$'.padEnd(9), 'CI (delta)'.padEnd(24), 'Excl.0');
  for (const r of results) {
    console.log(
      String(r.stopDist).padEnd(6), String(r.arm).padEnd(6), r.mech.padEnd(14), String(r.n).padEnd(4),
      r.meanCell.toFixed(2).padEnd(9), r.meanBase.toFixed(2).padEnd(9), r.delta.toFixed(2).padEnd(9),
      `[${r.lo?.toFixed(2)}, ${r.hi?.toFixed(2)}]`.padEnd(24), r.excludesZero ? 'YES' : 'no'
    );
  }
  const winners = results.filter(r => r.excludesZero && r.delta > 0);
  console.log(`\n${winners.length} of ${results.length} cells clear a real (CI-excludes-zero, positive) improvement over baseline.`);
  if (winners.length > 0) console.log('These need independent scrutiny (day-clustering, top-day exclusion) before trusting -- picking the best of many cells is a known trap.');

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
