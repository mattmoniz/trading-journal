// scripts/backtest_bar6_stop_width_sweep.mjs
// Tests the user's direct hypothesis ("dial in execution timing or loosen up stops"):
// given the market makes >=400pt moves roughly 35-40% of days (backtest_big_moves_rolling_window.mjs)
// and volume keeps building well into a real move, does the CURRENT calibrated stop cut
// DETERIORATING bar-6 touches (backtest_bar6_worst_point_passed.mjs's toxic bucket) off
// too early, before the real move has a chance to arrive? Sweeps stop width at 1.0x
// (baseline, real actual_pnl), 1.5x, 2.0x, 3.0x, and NO_STOP (ride to session end,
// mark-to-market) -- entry and target stay fixed, only the stop widens.
//
// RESULT (see RESEARCH_CLAIM bar6_stop_widening_no_rescue): NEGATIVE, and doubly confirmed
// (train AND test show the same pattern, not just one). DETERIORATING EV gets WORSE as the
// stop widens: train -$34.43 (1.0x) -> -$37.45 (1.5x) -> -$37.84 (2.0x) -> -$38.78 (3.0x)
// -> -$38.51 (NO_STOP); test -$33.67 -> -$30.99 -> -$31.60 -> -$34.28 -> -$46.10. Win rate
// climbs dramatically (train 43.0% -> 64.2%, test 46.8% -> 74.1%) but this is a mechanical
// illusion: average loss balloons in lockstep (train -$131 -> -$282, test -$152 -> -$470)
// and max loss explodes (train -$609 -> -$2119, test -$455 -> -$2431) -- giving a still-
// deteriorating trade more room lets a few more of them recover, but the ones that don't
// get dramatically more expensive, wiping out any EV gain. No widening multiplier beat the
// 1.0x baseline on TRAIN for the DETERIORATING population, so no per-setup_type replication
// check was even run (correctly -- nothing to validate).
//
// RECOVERING touches: EV stays roughly flat across widths while avg loss still increases
// meaningfully -- widening doesn't help there either, just adds unnecessary risk.
//
// Practical conclusion: the current calibrated stops are doing their job. If a touch is
// still actively making new lows at bar 6, giving it more room is not a rescue -- it's
// substituting a small, contained loss for a real chance at a catastrophic one. The
// genuine edge is in the RECOVERING/DETERIORATING classification itself (has the worst
// point already passed), not in loosening risk tolerance for the ones that haven't turned
// yet. No change to CLAUDE.md's no-static-thresholds-derived OPTIMAL_STOP calibration or
// to the live bar6_checkpoint wiring.

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeReplication } from '../server/services/rigorDiagnostics.js';
import { loadPairProximityThresholds, PROXIMITY } from './backtest_confluence.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

function replayWithWiderStop(bars, entry, origStop, target, direction, stopMultiplier) {
  let stop;
  if (stopMultiplier === 'NO_STOP') {
    stop = direction === 'LONG' ? -999999 : 999999;
  } else {
    const origRisk = Math.abs(entry - origStop);
    stop = direction === 'LONG' ? entry - (origRisk * stopMultiplier) : entry + (origRisk * stopMultiplier);
  }

  let resolution = 'EXPIRED';
  const closePrice = bars.length > 0 ? bars[bars.length - 1].close : entry;
  let pnlPoints = 0;

  for (const bar of bars) {
    const stopHit = direction === 'LONG' ? bar.low <= stop : bar.high >= stop;
    const targetHit = direction === 'LONG' ? bar.high >= target : bar.low <= target;
    if (stopHit) {
      resolution = 'STOP_HIT';
      pnlPoints = direction === 'LONG' ? stop - entry : entry - stop;
      break;
    } else if (targetHit) {
      resolution = 'TARGET_HIT';
      pnlPoints = direction === 'LONG' ? target - entry : entry - target;
      break;
    }
  }
  if (resolution === 'EXPIRED') pnlPoints = direction === 'LONG' ? closePrice - entry : entry - closePrice;

  return (pnlPoints * PNL_PER_POINT) - COMMISSION;
}

async function main() {
  const pairsRes = await query(`SELECT signal_name FROM performance_audit WHERE signal_type='CONFLUENCE_AUDIT' AND recommendation='VALIDATED_PAIR'`);
  const validPairs = new Set();
  const validLevels = new Set();
  for (const row of pairsRes.rows) {
    const pairStr = row.signal_name.replace('PAIR:', '');
    validPairs.add(pairStr);
    const [a, b] = pairStr.split('+');
    validLevels.add(a); validLevels.add(b);
  }
  const pairThresholds = await loadPairProximityThresholds();

  const levelPricesRes = await query(`SELECT trade_date::text as trade_date, level_name, price::float as price FROM level_prices WHERE price IS NOT NULL`);
  const lpByDate = new Map();
  for (const r of levelPricesRes.rows) {
    const d = r.trade_date.slice(0, 10);
    if (!lpByDate.has(d)) lpByDate.set(d, new Map());
    lpByDate.get(d).set(r.level_name, r.price);
  }

  const setupsRes = await query(`
    SELECT id, trade_date::text as trade_date, fired_at, resolution, actual_pnl::float, setup_type,
           entry_zone_low::float, entry_zone_high::float, stop_level::float, t1_level::float
    FROM active_setups
    WHERE resolution IN ('STOP_HIT', 'TARGET_HIT', 'TIME_EXPIRED') AND actual_pnl IS NOT NULL
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND mae_points IS NOT NULL AND mae_points <= 300 AND mfe_points IS NOT NULL AND mfe_points <= 300
    ORDER BY trade_date, fired_at
  `);

  const setupsByDate = new Map();
  for (const s of setupsRes.rows) {
    const d = s.trade_date.slice(0, 10);
    if (!setupsByDate.has(d)) setupsByDate.set(d, []);
    setupsByDate.get(d).push(s);
  }

  const touches = [];
  for (const [date, dateSetups] of setupsByDate) {
    const barsRes = await query(`SELECT ts, open::float, high::float, low::float, close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts`, [date]);
    const allBars = barsRes.rows;
    if (allBars.length < 25) continue;
    const lp = lpByDate.get(date) || new Map();

    for (const s of dateSetups) {
      const direction = directionFromType(s.setup_type);
      if (!direction) continue;
      let entryIdx = -1;
      for (let i = allBars.length - 1; i >= 0; i--) { if (allBars[i].ts <= s.fired_at) { entryIdx = i; break; } }
      if (entryIdx < 20) continue;

      const underlying = s.setup_type.replace('_FADE_LONG', '').replace('_FADE_SHORT', '');
      let hasConfluence = false;
      const myPrice = lp.get(underlying);
      if (myPrice != null) {
        for (const partner of validLevels) {
          if (partner === underlying) continue;
          const k1 = `${underlying}+${partner}`, k2 = `${partner}+${underlying}`;
          if (validPairs.has(k1) || validPairs.has(k2)) {
            const partnerPrice = lp.get(partner);
            if (partnerPrice != null) {
              const key = underlying < partner ? k1 : k2;
              const threshold = pairThresholds.get(key) ?? (2 * PROXIMITY);
              if (Math.abs(myPrice - partnerPrice) <= threshold) { hasConfluence = true; break; }
            }
          }
        }
      }

      const forwardBars = allBars.slice(entryIdx);
      let resolutionBarIdx = -1;
      for (let i = 0; i < forwardBars.length; i++) {
        const bar = forwardBars[i];
        const stopHit = direction === 'LONG' ? bar.low <= s.stop_level : bar.high >= s.stop_level;
        const targetHit = direction === 'LONG' ? bar.high >= s.t1_level : bar.low <= s.t1_level;
        if (stopHit || targetHit) { resolutionBarIdx = i; break; }
      }
      if (resolutionBarIdx === -1) resolutionBarIdx = forwardBars.length - 1;
      if (resolutionBarIdx < 6) continue;

      const b0_6 = forwardBars.slice(0, 7);
      let worstPrice = direction === 'LONG' ? b0_6[0].low : b0_6[0].high;
      let worstBarIdx = 0;
      for (let i = 0; i <= 6; i++) {
        if (direction === 'LONG' && b0_6[i].low < worstPrice) { worstPrice = b0_6[i].low; worstBarIdx = i; }
        if (direction === 'SHORT' && b0_6[i].high > worstPrice) { worstPrice = b0_6[i].high; worstBarIdx = i; }
      }

      const hi = s.entry_zone_high != null ? s.entry_zone_high : s.entry_zone_low;
      const entryPrice = (s.entry_zone_low + hi) / 2;

      touches.push({ ...s, dateStr: date, direction, hasConfluence, worstBarIdx, forwardBars, entryPrice });
    }
  }

  function summarize(rows, multiplier) {
    const n = rows.length;
    const pnls = rows.map(t => multiplier === 1.0 ? t.actual_pnl : replayWithWiderStop(t.forwardBars, t.entryPrice, t.stop_level, t.t1_level, t.direction, multiplier));
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p <= 0);
    const wr = n ? (wins.length / n * 100).toFixed(1) : '0.0';
    const ev = n ? (pnls.reduce((s, p) => s + p, 0) / n).toFixed(2) : 'n/a';
    const avgWin = wins.length ? (wins.reduce((s, p) => s + p, 0) / wins.length).toFixed(2) : 'n/a';
    const avgLoss = losses.length ? (losses.reduce((s, p) => s + p, 0) / losses.length).toFixed(2) : 'n/a';
    const maxWin = wins.length ? Math.max(...wins).toFixed(2) : 'n/a';
    const maxLoss = losses.length ? Math.min(...losses).toFixed(2) : 'n/a';
    return { n, wr, ev, avgWin, avgLoss, maxWin, maxLoss, rows };
  }

  const setupTypes = [...new Set(touches.map(x => x.setup_type))];
  const trainTouches = [], testTouches = [];
  for (const st of setupTypes) {
    const my = touches.filter(x => x.setup_type === st).sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    const splitIdx = Math.floor(my.length * 0.8);
    trainTouches.push(...my.slice(0, splitIdx));
    testTouches.push(...my.slice(splitIdx));
  }

  const multipliers = [1.0, 1.5, 2.0, 3.0, 'NO_STOP'];
  console.log(`Population: ${touches.length} touches still undecided at bar 6.\n`);
  for (const mult of multipliers) {
    const trainEarly = summarize(trainTouches.filter(t => t.worstBarIdx <= 2), mult);
    const trainLate = summarize(trainTouches.filter(t => t.worstBarIdx > 2), mult);
    const testEarly = summarize(testTouches.filter(t => t.worstBarIdx <= 2), mult);
    const testLate = summarize(testTouches.filter(t => t.worstBarIdx > 2), mult);
    console.log(`-- Multiplier: ${mult} --`);
    console.log(`RECOVERING   TRAIN: N=${trainEarly.n} EV=$${trainEarly.ev} WR=${trainEarly.wr}% avgWin=$${trainEarly.avgWin} avgLoss=$${trainEarly.avgLoss} maxLoss=$${trainEarly.maxLoss}`);
    console.log(`RECOVERING   TEST : N=${testEarly.n} EV=$${testEarly.ev} WR=${testEarly.wr}% avgWin=$${testEarly.avgWin} avgLoss=$${testEarly.avgLoss} maxLoss=$${testEarly.maxLoss}`);
    console.log(`DETERIORATING TRAIN: N=${trainLate.n} EV=$${trainLate.ev} WR=${trainLate.wr}% avgWin=$${trainLate.avgWin} avgLoss=$${trainLate.avgLoss} maxLoss=$${trainLate.maxLoss}`);
    console.log(`DETERIORATING TEST : N=${testLate.n} EV=$${testLate.ev} WR=${testLate.wr}% avgWin=$${testLate.avgWin} avgLoss=$${testLate.avgLoss} maxLoss=$${testLate.maxLoss}\n`);
  }

  const trainLateBaseline = summarize(trainTouches.filter(t => t.worstBarIdx > 2), 1.0);
  let bestTrainEv = parseFloat(trainLateBaseline.ev);
  let bestMult = null;
  for (const mult of [1.5, 2.0, 3.0, 'NO_STOP']) {
    const tr = summarize(trainTouches.filter(t => t.worstBarIdx > 2), mult);
    const evNum = parseFloat(tr.ev);
    if (evNum > bestTrainEv) { bestTrainEv = evNum; bestMult = mult; }
  }

  if (bestMult === null) {
    console.log(`No widening multiplier beat the 1.0x baseline EV ($${trainLateBaseline.ev}) for DETERIORATING on train -- no replication check needed, nothing to validate.`);
  } else {
    const testUnits = setupTypes.map(st => {
      const myTrainBaseline = trainTouches.filter(x => x.setup_type === st && x.worstBarIdx > 2);
      const trainBaselineEv = myTrainBaseline.length ? myTrainBaseline.reduce((s, x) => s + x.actual_pnl, 0) / myTrainBaseline.length : 0;
      const myTrainMult = trainTouches.filter(x => x.setup_type === st && x.worstBarIdx > 2);
      const trainMultEv = myTrainMult.length ? myTrainMult.map(x => replayWithWiderStop(x.forwardBars, x.entryPrice, x.stop_level, x.t1_level, x.direction, bestMult)).reduce((s, p) => s + p, 0) / myTrainMult.length : 0;
      const myTestBaseline = testTouches.filter(x => x.setup_type === st && x.worstBarIdx > 2);
      const testBaselineEv = myTestBaseline.length ? myTestBaseline.reduce((s, x) => s + x.actual_pnl, 0) / myTestBaseline.length : 0;
      const myTestMult = testTouches.filter(x => x.setup_type === st && x.worstBarIdx > 2);
      const testMultEv = myTestMult.length ? myTestMult.map(x => replayWithWiderStop(x.forwardBars, x.entryPrice, x.stop_level, x.t1_level, x.direction, bestMult)).reduce((s, p) => s + p, 0) / myTestMult.length : 0;
      return { setupType: st, trainLift: trainMultEv - trainBaselineEv, n: myTestMult.length, value: testMultEv - testBaselineEv };
    });
    const selected = testUnits.filter(x => x.trainLift > 0).map(x => x.setupType);
    if (selected.length) {
      const rep = computeReplication(testUnits, { idFn: x => x.setupType, metricFn: x => ({ n: x.n, value: x.value }), selectedIds: selected });
      console.log(`Best multiplier ${bestMult}: ${selected.length} setup_types selected on train. Selected pool test diff=$${rep.selectedPooled.value} vs held-out diff=$${rep.heldOutPooled.value} (selected beats held-out: ${rep.selectedPooled.value > rep.heldOutPooled.value})`);
    }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
