// scripts/backtest_worst_point_passed_entry_trigger.mjs
// Culminating test of this session's engagement-research thread: does "recognizing" the
// worst-point-passed pattern (found real and robust in backtest_bar6_worst_point_passed.mjs)
// work as an actual ENTRY trigger -- skip the original touch, wait 6 bars, and only engage
// if the recognizable pattern (worst adverse point already occurred bars 0-2) confirms --
// rather than just an informational read on a position already held from the original touch?
//
// Same 3-arm discipline as backtest_engagement_confirmation_entry.mjs (which found weak
// delta-based triggers don't beat a genuine blind delay): Arm A (original immediate entry,
// real actual_pnl), Arm B (genuine blind delay -- always wait 6 bars and enter regardless,
// no recognition check), Arm C (wait 6 bars, enter ONLY if worst point already passed by
// bar 2, skip otherwise, fresh entry price + re-anchored stop/target). Population
// restricted to touches still undecided at bar 6 under the ORIGINAL entry (resolutionBarIdx
// >= 6) -- the same "still fighting" population the recognition signal was found in; a
// touch that already cleanly resolved in the first 6 bars has no "still fighting" state to
// recognize.

import { query } from '../server/db.js';
import { directionFromType, replayBars } from '../server/services/maeMfeReplay.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';
import { loadPairProximityThresholds, PROXIMITY, PNL_PER_POINT, COMMISSION } from './backtest_confluence.js';

function summarize(rows) {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: '0.0', ev: 'n/a', avgWin: 'n/a', avgLoss: 'n/a', maxWin: 'n/a' };
  const wins = rows.filter(r => r.actual_pnl > 0);
  const losses = rows.filter(r => r.actual_pnl <= 0);
  const wr = (wins.length / n * 100).toFixed(1);
  const ev = (rows.reduce((s, r) => s + r.actual_pnl, 0) / n).toFixed(2);
  const avgWin = wins.length ? (wins.reduce((s, r) => s + r.actual_pnl, 0) / wins.length).toFixed(2) : 'n/a';
  const avgLoss = losses.length ? (losses.reduce((s, r) => s + r.actual_pnl, 0) / losses.length).toFixed(2) : 'n/a';
  const maxWin = wins.length ? Math.max(...wins.map(r => r.actual_pnl)).toFixed(2) : 'n/a';
  const rigor = n >= 20 ? computeRigor(rows, { dateField: 'dateStr', pnlFn: x => x.actual_pnl }) : { clean: false, clustered: false };
  return { n, wr, ev, avgWin, avgLoss, maxWin, clean: rigor.clean, clustered: rigor.clustered };
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
  const levelPricesByDate = new Map();
  for (const r of levelPricesRes.rows) {
    const d = r.trade_date.slice(0, 10);
    if (!levelPricesByDate.has(d)) levelPricesByDate.set(d, new Map());
    levelPricesByDate.get(d).set(r.level_name, r.price);
  }

  const setupsRes = await query(`
    SELECT id, trade_date::text as trade_date, fired_at, resolution, actual_pnl::float, setup_type,
           entry_zone_low::float, COALESCE(entry_zone_high, entry_zone_low)::float as entry_zone_high,
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
      SELECT ts, open::float, high::float, low::float, close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
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
      if (forwardBars.length <= 6) continue; // need at least bar 6 to exist
      let resolutionBarIdx = -1;
      for (let i = 0; i < forwardBars.length; i++) {
        const bar = forwardBars[i];
        const stopHit = direction === 'LONG' ? bar.low <= s.stop_level : bar.high >= s.stop_level;
        const targetHit = direction === 'LONG' ? bar.high >= s.t1_level : bar.low <= s.t1_level;
        if (stopHit || targetHit) { resolutionBarIdx = i; break; }
      }
      if (resolutionBarIdx === -1) resolutionBarIdx = forwardBars.length - 1;
      if (resolutionBarIdx < 6) continue; // must still be undecided at bar 6 (real-time-knowable)

      const b0_6 = forwardBars.slice(0, 7);
      let worstPrice = direction === 'LONG' ? b0_6[0].low : b0_6[0].high;
      let worstBarIdx = 0;
      for (let i = 0; i <= 6; i++) {
        if (direction === 'LONG' && b0_6[i].low < worstPrice) { worstPrice = b0_6[i].low; worstBarIdx = i; }
        if (direction === 'SHORT' && b0_6[i].high > worstPrice) { worstPrice = b0_6[i].high; worstBarIdx = i; }
      }

      touches.push({ ...s, dateStr: date, direction, hasConfluence, forwardBars, worstBarIdx });
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

  const arms = { ALL: { A: [], B: [], C: [] }, CONF: { A: [], B: [], C: [] }, NOCONF: { A: [], B: [], C: [] } };
  const setupArms = {};

  for (const st of setupTypes) setupArms[st] = { A: [], B: [], C: [] };

  for (const t of [...trainTouches, ...testTouches]) {
    const isTrain = trainTouches.includes(t);
    const stopDist = Math.abs(t.entry_zone_low - t.stop_level);
    const targetDist = Math.abs(t.entry_zone_low - t.t1_level);

    // Arm A: original immediate entry, real ground truth
    const aObj = { id: t.id, actual_pnl: t.actual_pnl, dateStr: t.dateStr, setup_type: t.setup_type, isTrain };

    // Arm B: blind -- always wait to bar 6, enter regardless, re-anchored stop/target
    const bar6 = t.forwardBars[6];
    const bEntry = bar6.close;
    const bStop = t.direction === 'LONG' ? bEntry - stopDist : bEntry + stopDist;
    const bTarget = t.direction === 'LONG' ? bEntry + targetDist : bEntry - targetDist;
    const bRes = replayBars(t.forwardBars.slice(6), bEntry, bStop, bTarget, t.direction);
    const bPnl = bRes ? (bRes.replayResolution === 'TARGET_HIT' ? targetDist * PNL_PER_POINT - COMMISSION : bRes.replayResolution === 'STOP_HIT' ? -stopDist * PNL_PER_POINT - COMMISSION : 0) : null;
    const bObj = bPnl !== null ? { id: t.id, actual_pnl: bPnl, dateStr: t.dateStr, setup_type: t.setup_type, isTrain } : null;

    // Arm C: only if worst point already passed (bars 0-2) -- same entry mechanics as B
    let cObj = null;
    if (t.worstBarIdx <= 2 && bPnl !== null) {
      cObj = { id: t.id, actual_pnl: bPnl, dateStr: t.dateStr, setup_type: t.setup_type, isTrain };
    }

    const push = (group) => { group.A.push(aObj); if (bObj) group.B.push(bObj); if (cObj) group.C.push(cObj); };
    push(arms.ALL);
    push(t.hasConfluence ? arms.CONF : arms.NOCONF);
    push(setupArms[t.setup_type]);
  }

  console.log(`Population: ${touches.length} touches still undecided at bar 6.\n`);
  for (const [label, group] of Object.entries(arms)) {
    const aTrain = summarize(group.A.filter(x => x.isTrain)), bTrain = summarize(group.B.filter(x => x.isTrain)), cTrain = summarize(group.C.filter(x => x.isTrain));
    const aTest = summarize(group.A.filter(x => !x.isTrain)), bTest = summarize(group.B.filter(x => !x.isTrain)), cTest = summarize(group.C.filter(x => !x.isTrain));
    console.log(`-- ${label} TRAIN --`);
    console.log('A (original):', aTrain);
    console.log('B (blind delay to bar 6):', bTrain);
    console.log('C (worst-point-passed entry at bar 6):', cTrain);
    console.log(`-- ${label} TEST --`);
    console.log('A (original):', aTest);
    console.log('B (blind delay to bar 6):', bTest);
    console.log('C (worst-point-passed entry at bar 6):', cTest);
    console.log('');
  }

  // Replication: which setup_types show C beating both A and B on train?
  const replicated = [];
  for (const st of setupTypes) {
    const s = setupArms[st];
    const ev = (arr) => arr.length ? arr.reduce((sum, r) => sum + r.actual_pnl, 0) / arr.length : -9999;
    const trainA = s.A.filter(x => x.isTrain), trainB = s.B.filter(x => x.isTrain), trainC = s.C.filter(x => x.isTrain);
    if (trainC.length < 10) continue;
    if (ev(trainC) > ev(trainA) && ev(trainC) > ev(trainB)) replicated.push(st);
  }
  const testUnits = setupTypes.map(st => {
    const testC = setupArms[st].C.filter(x => !x.isTrain);
    return { setupType: st, n: testC.length, value: testC.length ? testC.reduce((s, x) => s + x.actual_pnl, 0) / testC.length : 0 };
  });
  if (replicated.length) {
    const rep = computeReplication(testUnits, { idFn: x => x.setupType, metricFn: x => ({ n: x.n, value: x.value }), selectedIds: replicated });
    console.log(`Replication: ${replicated.length} setup_types where C beat both A and B on train. Test: selected pool EV=$${rep.selectedPooled.value} (N=${rep.selectedPooled.n}) vs held-out EV=$${rep.heldOutPooled.value} (N=${rep.heldOutPooled.n}), replicates=${rep.replicates}`);
  } else {
    console.log('No setup_types where C beat both A and B on train (N>=10).');
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
