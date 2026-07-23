// scripts/backtest_bar6_early_exit.mjs
// Tests the natural complement to backtest_bar6_stop_width_sweep.mjs (which found
// LOOSENING the stop for DETERIORATING bar-6 touches fails badly): does CUTTING EARLIER
// help instead? Three arms, all reusing the exact bar6_worst_point_passed population/
// classification: Arm A (baseline, real actual_pnl, ride to original stop/target), Arm B
// (exit immediately at bar 6's close, mark-to-market), Arm C (tighten the stop to bar 6's
// close but keep the original target alive, walk forward from bar 6).
//
// RESULT (see RESEARCH_CLAIM bar6_early_exit_deteriorating_confirmed_recovering_inconclusive):
// SPLIT VERDICT, kept honest rather than blended into one answer:
//
// DETERIORATING: CONFIRMED, robust. Cutting early (Arm B or C) makes EV worse, not better,
// consistent across ALL/CONFLUENCE/NON-CONFLUENCE on the TEST split (the one that matters
// for generalization) -- Arm B underperforms baseline by $10.89/$4.98/$13.54 respectively
// in those 3 views. The per-setup_type replication check independently confirms this: the
// setup_types that looked best for cutting on train did WORSE on test than the setup_types
// that weren't selected (selected pool diff=-$17.03 vs held-out diff=-$5.19 for Arm B) --
// this combined with backtest_bar6_stop_width_sweep.mjs's finding (loosening also fails)
// means the CURRENT stop/target, ridden to its natural conclusion, is already close to
// optimal for this population. Neither direction (looser or tighter) improves it.
//
// RECOVERING: NOT VALIDATED, do not act on this. The first-pass pooled ("ALL") result made
// cutting early look like a clear win, but checking every view individually shows the sign
// FLIPS: CONFLUENCE/train favors cutting (+$4.31) while CONFLUENCE/test favors baseline
// (-$8.79 for cutting) -- a direct within-view train/test contradiction. NON-CONFLUENCE
// inverts the other way (train favors baseline, test favors cutting). A genuine, real replication
// check (added after the initial audit found the inconsistency, matching the same rigor
// DETERIORATING already got) confirms this is not a stable effect -- see the script's own
// RECOVERING replication section. Mechanically, Arm B trades a much smaller, much more
// frequent win (locking in whatever's true at bar 6) for a much larger, less frequent one
// (riding to the real target) -- whether that trade is "worth it" varies by sample in a way
// that doesn't generalize cleanly yet. This needs more real data before revisiting, not a
// verdict either way.

import { query } from '../server/db.js';
import { directionFromType, replayBars } from '../server/services/maeMfeReplay.js';
import { computeReplication } from '../server/services/rigorDiagnostics.js';
import { loadPairProximityThresholds, PROXIMITY, COMMISSION, PNL_PER_POINT } from './backtest_confluence.js';

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
  const levelPricesByDate = new Map();
  for (const r of levelPricesRes.rows) {
    const d = r.trade_date.slice(0, 10);
    if (!levelPricesByDate.has(d)) levelPricesByDate.set(d, new Map());
    levelPricesByDate.get(d).set(r.level_name, r.price);
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
    const barsRes = await query(`SELECT ts, high::float, low::float, close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts`, [date]);
    const allBars = barsRes.rows;
    if (allBars.length < 25) continue;
    const lp = levelPricesByDate.get(date) || new Map();

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
      const entry = (s.entry_zone_low + hi) / 2;
      const bar6Close = b0_6[6].close;

      const pnlA = s.actual_pnl;
      const pointsB = direction === 'LONG' ? (bar6Close - entry) : (entry - bar6Close);
      const pnlB = pointsB * PNL_PER_POINT - COMMISSION;

      const barsFrom6 = forwardBars.slice(6);
      const replayResult = replayBars(barsFrom6, entry, bar6Close, s.t1_level, direction);
      let pnlC = pnlA;
      if (replayResult) {
        let exitPrice;
        if (replayResult.replayResolution === 'TARGET_HIT') exitPrice = s.t1_level;
        else if (replayResult.replayResolution === 'STOP_HIT') exitPrice = bar6Close;
        else exitPrice = barsFrom6[barsFrom6.length - 1].close;
        const pointsC = direction === 'LONG' ? (exitPrice - entry) : (entry - exitPrice);
        pnlC = pointsC * PNL_PER_POINT - COMMISSION;
      }

      touches.push({ ...s, dateStr: date, direction, hasConfluence, worstBarIdx, pnlA, pnlB, pnlC });
    }
  }

  const setupTypes = [...new Set(touches.map(x => x.setup_type))];
  const trainTouches = [], testTouches = [];
  for (const st of setupTypes) {
    const my = touches.filter(x => x.setup_type === st).sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    const splitIdx = Math.floor(my.length * 0.8);
    trainTouches.push(...my.slice(0, splitIdx));
    testTouches.push(...my.slice(splitIdx));
  }

  function report(name, subset) {
    const n = subset.length;
    if (n === 0) return `${name.padEnd(20)} | N=0`;
    const formatArm = (pnlField) => {
      const wins = subset.filter(r => r[pnlField] > 0);
      const losses = subset.filter(r => r[pnlField] <= 0);
      const avgWin = wins.length ? (wins.reduce((s, r) => s + r[pnlField], 0) / wins.length).toFixed(2) : 'n/a';
      const avgLoss = losses.length ? (losses.reduce((s, r) => s + r[pnlField], 0) / losses.length).toFixed(2) : 'n/a';
      const wr = (wins.length / n * 100).toFixed(1);
      const ev = (subset.reduce((s, r) => s + r[pnlField], 0) / n).toFixed(2);
      return `avgWin=$${avgWin} avgLoss=$${avgLoss} WR=${wr}% EV=$${ev}`;
    };
    return `${name} (N=${n}): A[${formatArm('pnlA')}] B[${formatArm('pnlB')}] C[${formatArm('pnlC')}]`;
  }

  function doView(touchesSubset, title) {
    console.log(`\n=== ${title} ===`);
    console.log('TRAIN:');
    console.log(report('  Recovering', touchesSubset.filter(t => t.worstBarIdx <= 2 && trainTouches.includes(t))));
    console.log(report('  Deteriorating', touchesSubset.filter(t => t.worstBarIdx > 2 && trainTouches.includes(t))));
    console.log('TEST:');
    console.log(report('  Recovering', touchesSubset.filter(t => t.worstBarIdx <= 2 && testTouches.includes(t))));
    console.log(report('  Deteriorating', touchesSubset.filter(t => t.worstBarIdx > 2 && testTouches.includes(t))));
  }

  doView(touches, 'ALL TOUCHES');
  doView(touches.filter(t => t.hasConfluence), 'CONFLUENCE ONLY');
  doView(touches.filter(t => !t.hasConfluence), 'NON-CONFLUENCE ONLY');

  function replicationCheck(label, filterFn, armField) {
    const trainSubset = trainTouches.filter(filterFn);
    const evA = trainSubset.reduce((s, t) => s + t.pnlA, 0) / trainSubset.length;
    const evArm = trainSubset.reduce((s, t) => s + t[armField], 0) / trainSubset.length;
    console.log(`\n${label} (Train EV_A=$${evA.toFixed(2)}, EV_${armField}=$${evArm.toFixed(2)}):`);
    const testUnits = setupTypes.map(st => {
      const myTrain = trainTouches.filter(x => x.setup_type === st && filterFn(x));
      const myTest = testTouches.filter(x => x.setup_type === st && filterFn(x));
      const trainEvA = myTrain.length ? myTrain.reduce((s, x) => s + x.pnlA, 0) / myTrain.length : 0;
      const trainEvArm = myTrain.length ? myTrain.reduce((s, x) => s + x[armField], 0) / myTrain.length : 0;
      const testEvA = myTest.length ? myTest.reduce((s, x) => s + x.pnlA, 0) / myTest.length : 0;
      const testEvArm = myTest.length ? myTest.reduce((s, x) => s + x[armField], 0) / myTest.length : 0;
      return { setupType: st, trainEvDiff: trainEvArm - trainEvA, n: myTest.length, value: testEvArm - testEvA };
    });
    const selected = testUnits.filter(x => x.trainEvDiff > 0).map(x => x.setupType);
    if (selected.length) {
      const rep = computeReplication(testUnits, { idFn: x => x.setupType, metricFn: x => ({ n: x.n, value: x.value }), selectedIds: selected });
      console.log(`  ${selected.length} setup_types selected on train. Selected pool test diff=$${rep.selectedPooled.value.toFixed(2)} vs held-out diff=$${rep.heldOutPooled.value.toFixed(2)} (selected beats held-out: ${rep.selectedPooled.value > rep.heldOutPooled.value})`);
    } else {
      console.log('  0 setup_types selected on train.');
    }
  }

  replicationCheck('DETERIORATING Arm B (Cut@Bar6) Replication', t => t.worstBarIdx > 2, 'pnlB');
  replicationCheck('DETERIORATING Arm C (Tighten) Replication', t => t.worstBarIdx > 2, 'pnlC');
  replicationCheck('RECOVERING Arm B (Cut@Bar6) Replication', t => t.worstBarIdx <= 2, 'pnlB');
  replicationCheck('RECOVERING Arm C (Tighten) Replication', t => t.worstBarIdx <= 2, 'pnlC');

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
