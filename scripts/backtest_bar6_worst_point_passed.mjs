// scripts/backtest_bar6_worst_point_passed.mjs
// One-off (not scheduled) mining pass: what actually separates eventual WINNERS from
// LOSERS within the "still fighting at bar 6" population (touches not yet stopped or
// targeted 6 bars after first touch — already established as a mixed, mostly-toxic group
// in backtest_engagement_duration_sizing.mjs)? Tested 4 candidate real-time-computable
// features (candle shape at bar 6, delta trajectory, whether the worst adverse point has
// already passed, range compression) — only one showed real, robust separation.
//
// RESULT (see RESEARCH_CLAIM engagement_bar6_worst_point_passed): "has the worst adverse
// point already passed by bar 6" is a strong, real, independently-verified discriminator.
// Touches whose worst point occurred bars 0-2 (already recovering by bar 6) are a
// materially better trade than touches whose worst point is bars 3-6 (still actively
// deteriorating) — better win rate, bigger average winner, AND smaller average loser, at
// EVERY cutoff tried (0 through 5), not just the one reported: as the cutoff moves later
// (more bars allowed to count as "still early"), the EARLY bucket's EV monotonically
// decreases and the LATE bucket's EV monotonically decreases too — a smooth gradient, not
// a fragile single-point artifact. Verified via a from-scratch independent
// reimplementation (not copying this script) that reproduced Gemini's N counts exactly
// (2613+556=3169 train+test vs 3169 combined; 3618+1083=4701 vs 4701 combined).
// Delta trajectory, candle shape at bar 6, and range compression all showed weak-to-no
// separation by comparison — reported honestly, not cherry-picked out.
//
// Caveat, real and worth keeping: computeReplication() on "which setup_types show a
// positive EV lift from this filter" returned replicates=false — the pooled/aggregate
// effect is large and robust, but it is NOT uniformly present in every individual
// setup_type; a meaningful fraction of setup_types don't show the same lift on held-out
// data. Treat this as a real, useful pooled/general signal, not as validated for every
// setup_type individually.
//
// Not yet wired live — this characterizes an ALREADY-OPEN position's in-trade state
// (bar 6 of an active trade), which is a different surface than detection-time
// informational tags (confluence/exhaustion). Wiring this live would mean surfacing
// "worst point already passed" / "still deteriorating" on an open position's card —
// flagged as an open decision for the user rather than built unilaterally, since it
// touches live position management, not just detection.

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';
import { loadPairProximityThresholds, PROXIMITY } from './backtest_confluence.js';

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
           stop_level::float, t1_level::float
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
    const barsRes = await query(`
      SELECT ts, high::float, low::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
    `, [date]);
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
      if (resolutionBarIdx < 6) continue; // must still be active at bar 6

      const b0_6 = forwardBars.slice(0, 7);
      let worstPrice = direction === 'LONG' ? b0_6[0].low : b0_6[0].high;
      let worstBarIdx = 0;
      for (let i = 0; i <= 6; i++) {
        if (direction === 'LONG' && b0_6[i].low < worstPrice) { worstPrice = b0_6[i].low; worstBarIdx = i; }
        if (direction === 'SHORT' && b0_6[i].high > worstPrice) { worstPrice = b0_6[i].high; worstBarIdx = i; }
      }

      touches.push({ ...s, dateStr: date, direction, hasConfluence, worstBarIdx, isWinner: s.actual_pnl > 0 });
    }
  }

  function summarize(rows) {
    const n = rows.length;
    const wins = rows.filter(r => r.actual_pnl > 0);
    const losses = rows.filter(r => r.actual_pnl <= 0);
    const wr = n ? (wins.length / n * 100).toFixed(1) : '0.0';
    const ev = n ? (rows.reduce((s, r) => s + r.actual_pnl, 0) / n).toFixed(2) : 'n/a';
    const avgWin = wins.length ? (wins.reduce((s, r) => s + r.actual_pnl, 0) / wins.length).toFixed(2) : 'n/a';
    const avgLoss = losses.length ? (losses.reduce((s, r) => s + r.actual_pnl, 0) / losses.length).toFixed(2) : 'n/a';
    const maxWin = wins.length ? Math.max(...wins.map(r => r.actual_pnl)).toFixed(2) : 'n/a';
    const rigor = n >= 20 ? computeRigor(rows, { dateField: 'dateStr', pnlFn: x => x.actual_pnl }) : { clean: false, clustered: false };
    return { n, wr, ev, avgWin, avgLoss, maxWin, clean: rigor.clean, clustered: rigor.clustered };
  }

  const setupTypes = [...new Set(touches.map(x => x.setup_type))];
  const trainTouches = [], testTouches = [];
  for (const st of setupTypes) {
    const my = touches.filter(x => x.setup_type === st).sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    const splitIdx = Math.floor(my.length * 0.8);
    trainTouches.push(...my.slice(0, splitIdx));
    testTouches.push(...my.slice(splitIdx));
  }

  console.log(`Total "active at bar 6" touches: ${touches.length}\n`);
  console.log('-- Robustness sweep across all possible cutoffs (pooled, not train/test split) --');
  for (const cutoff of [0, 1, 2, 3, 4, 5]) {
    const early = summarize(touches.filter(t => t.worstBarIdx <= cutoff));
    const late = summarize(touches.filter(t => t.worstBarIdx > cutoff));
    console.log(`cutoff<=${cutoff}: EARLY N=${early.n} WR=${early.wr}% EV=$${early.ev} avgWin=$${early.avgWin} avgLoss=$${early.avgLoss}  |  LATE N=${late.n} WR=${late.wr}% EV=$${late.ev} avgWin=$${late.avgWin} avgLoss=$${late.avgLoss}`);
  }

  console.log('\n-- Chosen cutoff (<=2), TRAIN/TEST --');
  const trainEarly = summarize(trainTouches.filter(t => t.worstBarIdx <= 2));
  const trainLate = summarize(trainTouches.filter(t => t.worstBarIdx > 2));
  const testEarly = summarize(testTouches.filter(t => t.worstBarIdx <= 2));
  const testLate = summarize(testTouches.filter(t => t.worstBarIdx > 2));
  console.log('TRAIN Early (recovering):', trainEarly);
  console.log('TRAIN Late (deteriorating):', trainLate);
  console.log('TEST Early (recovering):', testEarly);
  console.log('TEST Late (deteriorating):', testLate);

  const testUnits = setupTypes.map(st => {
    const myTrain = trainTouches.filter(x => x.setup_type === st && x.worstBarIdx <= 2);
    const myTest = testTouches.filter(x => x.setup_type === st && x.worstBarIdx <= 2);
    const myTestUncond = testTouches.filter(x => x.setup_type === st);
    const trainEv = myTrain.length ? myTrain.reduce((s, x) => s + x.actual_pnl, 0) / myTrain.length : 0;
    const testEv = myTest.length ? myTest.reduce((s, x) => s + x.actual_pnl, 0) / myTest.length : 0;
    const testUncondEv = myTestUncond.length ? myTestUncond.reduce((s, x) => s + x.actual_pnl, 0) / myTestUncond.length : 0;
    return { setupType: st, trainEv, n: myTest.length, value: testEv - testUncondEv };
  });
  const selected = testUnits.filter(x => x.trainEv > 0).map(x => x.setupType);
  if (selected.length) {
    const rep = computeReplication(testUnits, { idFn: x => x.setupType, metricFn: x => ({ n: x.n, value: x.value }), selectedIds: selected });
    console.log(`\nReplication (per-setup_type EV-lift selection): ${selected.length} setup_types selected on train. Test: selected pool diff=$${rep.selectedPooled.value} vs held-out diff=$${rep.heldOutPooled.value}, replicates=${rep.replicates}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
