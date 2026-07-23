// scripts/backtest_engagement_confirmation_entry.mjs
// One-off (not scheduled — see result below for why) test of whether WAITING for the
// buyer/seller "tussle" to resolve before entering (user's own discretionary framework:
// watch volume/delta engagement at a level, only enter once one side visibly wins) beats
// entering immediately on first touch. Built 2026-07-23, Gemini-authored + Claude-audited
// (2 rounds — round 1 had a real invalidating bug: Arm B's "blind delay" reused the
// trigger's own fire bar as its delay point, making it identical to Arm C1 by
// construction, not an actual blind control; fixed in round 2, verified by direct SQL
// cross-check of Arm A's real actual_pnl matching this script's number almost exactly).
//
// Two distinct steps, never conflated: Step A characterizes the "pivot bar" (point of
// worst adverse excursion before recovery) using hindsight across real resolved touches —
// answers "what's the typical price/bar movement before the move is made," never used as
// a live input. Step B builds real-time-computable confirmation triggers (only rolling
// bar-by-bar features up through the current bar) and tests them as a genuine 3-arm
// comparison: Arm A (immediate entry, real actual_pnl), Arm B (blind mechanical delay —
// fixed number of bars per setup_type, independent of any trigger firing on that specific
// touch — isolates the "later entry is structurally cheaper" confound that already burned
// pilot_overshoot_control_check.mjs once), Arm C (only enters if/when a trigger fires,
// skips otherwise). Re-anchors Arm B/C's stop/target to their own delayed entry price
// (same point distance, not re-optimized) rather than reusing Arm A's numbers — avoids the
// baseline-mismatch bug class from backtest_scaleout_runner.mjs.
//
// RESULT (see RESEARCH_CLAIM engagement_confirmation_entry_timing): both tested trigger
// definitions (C1: delta favorable 2 consecutive bars; C2: C1 + volume above the
// population's own rolling median) underperformed BOTH Arm A and the genuine Arm B blind
// delay, across all 3 pooled views (ALL/CONFLUENCE/NON-CONFLUENCE). The 36/35 setup_types
// where C1/C2 looked like a train-data winner failed computeReplication() on held-out test
// data (selected-pool test EV was not better than the never-selected pool) — pure
// overfitting, not a real generalizable edge. This does NOT prove "watching the tussle
// never helps" — it specifically debunks these two simple delta-based mechanical proxies.
// A different trigger definition (stronger delta magnitude, requiring price to reclaim
// some fraction of its own adverse excursion, per-setup-type wait windows instead of one
// pooled window) has not been tested and remains open.

import { query } from '../server/db.js';
import { directionFromType, replayBars } from '../server/services/maeMfeReplay.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';
import { loadPairProximityThresholds, PROXIMITY, PNL_PER_POINT, COMMISSION } from './backtest_confluence.js';
import fs from 'fs';

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarizeDistribution(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return { p25: percentile(sorted, 0.25), p50: percentile(sorted, 0.50), p75: percentile(sorted, 0.75), p90: percentile(sorted, 0.90) };
}

function summarizeArm(name, rows) {
  const n = rows.length;
  if (n === 0) return { label: name, n: 0, wr: '0.0', ev: 'n/a', rigorStr: '' };
  const wins = rows.filter(r => r.actual_pnl > 0).length;
  const wr = ((wins / n) * 100).toFixed(1);
  const ev = (rows.reduce((s, r) => s + r.actual_pnl, 0) / n).toFixed(2);
  const rigorStr = n >= 20
    ? (() => { const r = computeRigor(rows, { dateField: 'dateStr', pnlFn: x => x.actual_pnl }); return `clustered=${r.clustered} clean=${r.clean}`; })()
    : '(N<20)';
  return { label: name, n, wr, ev, rigorStr };
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

  const allTouches = [];
  for (const [date, dateSetups] of setupsByDate) {
    const barsRes = await query(`
      SELECT ts, open::float, high::float, low::float, close::float, COALESCE(volume,0)::int AS volume,
             COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
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

      const priorBars = allBars.slice(entryIdx - 20, entryIdx);
      const meanVol = priorBars.reduce((a, b) => a + b.volume, 0) / priorBars.length;

      const forwardBars = allBars.slice(entryIdx);
      const originalEntry = (s.entry_zone_low + s.entry_zone_high) / 2;
      let pivotBarIdx = 0, pivotExcursion = 0;
      for (let i = 0; i < forwardBars.length; i++) {
        const bar = forwardBars[i];
        const adverse = direction === 'LONG' ? originalEntry - bar.low : bar.high - originalEntry;
        if (adverse > pivotExcursion) { pivotExcursion = adverse; pivotBarIdx = i; }
        const stopHit = direction === 'LONG' ? bar.low <= s.stop_level : bar.high >= s.stop_level;
        const targetHit = direction === 'LONG' ? bar.high >= s.t1_level : bar.low <= s.t1_level;
        if (stopHit || targetHit) break;
      }

      allTouches.push({ ...s, dateStr: date, direction, hasConfluence, meanVol, originalEntry, pivotBarIdx, pivotExcursion, forwardBars });
    }
  }

  // STEP A: descriptive pivot-bar characterization (hindsight, for description only)
  const statAll = { barsToPivot: summarizeDistribution(allTouches.map(x => x.pivotBarIdx)), excursion: summarizeDistribution(allTouches.map(x => x.pivotExcursion)) };
  const confTouches = allTouches.filter(x => x.hasConfluence);
  const statConf = { barsToPivot: summarizeDistribution(confTouches.map(x => x.pivotBarIdx)), excursion: summarizeDistribution(confTouches.map(x => x.pivotExcursion)) };
  const noConfTouches = allTouches.filter(x => !x.hasConfluence);
  const statNoConf = { barsToPivot: summarizeDistribution(noConfTouches.map(x => x.pivotBarIdx)), excursion: summarizeDistribution(noConfTouches.map(x => x.pivotExcursion)) };

  const setupTypes = [...new Set(allTouches.map(x => x.setup_type))];
  const optStopRes = await query(`SELECT p75_mae FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND signal_name = ANY($1) AND p75_mae IS NOT NULL`, [setupTypes]);
  const avgP75Mae = optStopRes.rows.length ? optStopRes.rows.reduce((s, r) => s + Number(r.p75_mae), 0) / optStopRes.rows.length : null;

  console.log(`ALL (N=${allTouches.length}): bars-to-pivot p75=${statAll.barsToPivot.p75}, excursion p75=${statAll.excursion.p75.toFixed(2)}pt`);
  console.log(`CONFLUENCE (N=${confTouches.length}): bars-to-pivot p75=${statConf.barsToPivot.p75}, excursion p75=${statConf.excursion.p75.toFixed(2)}pt`);
  console.log(`NON-CONFLUENCE (N=${noConfTouches.length}): bars-to-pivot p75=${statNoConf.barsToPivot.p75}, excursion p75=${statNoConf.excursion.p75.toFixed(2)}pt`);
  console.log(`Cross-check vs OPTIMAL_STOP avg p75_mae: ${avgP75Mae?.toFixed(2)}pt`);

  // STEP B: 3-arm confirmed-entry test
  const arms = { ALL: { A: [], B: [], C1: [], C2: [] }, CONF: { A: [], B: [], C1: [], C2: [] }, NOCONF: { A: [], B: [], C1: [], C2: [] } };
  const setupArms = {};
  const waitWindow = Math.ceil(statAll.barsToPivot.p75);

  for (const st of setupTypes) {
    const myTouches = allTouches.filter(x => x.setup_type === st).sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    const splitIdx = Math.floor(myTouches.length * 0.8);
    const train = myTouches.slice(0, splitIdx);
    const test = myTouches.slice(splitIdx);

    const trainVolRatios = [];
    const trainC1Delays = [];
    for (const t of train) {
      let favDeltaStreak = 0, c1Bar = -1;
      for (let i = 0; i < Math.min(waitWindow, t.forwardBars.length); i++) {
        const bar = t.forwardBars[i];
        const deltaFav = t.direction === 'LONG' ? bar.ask_volume > bar.bid_volume : bar.bid_volume > bar.ask_volume;
        if (deltaFav) favDeltaStreak++; else favDeltaStreak = 0;
        if (favDeltaStreak >= 2) { c1Bar = i; break; }
      }
      if (c1Bar !== -1) trainC1Delays.push(c1Bar);
      for (let i = 0; i < Math.min(waitWindow, t.forwardBars.length); i++) trainVolRatios.push(t.forwardBars[i].volume / t.meanVol);
    }
    const volRatioP50 = trainVolRatios.length ? percentile([...trainVolRatios].sort((a, b) => a - b), 0.50) : 1.0;
    const bDelay = trainC1Delays.length ? Math.floor(percentile([...trainC1Delays].sort((a, b) => a - b), 0.50)) : -1;

    setupArms[st] = { A: [], B: [], C1: [], C2: [] };

    for (const t of [...train, ...test]) {
      const stopDist = Math.abs(t.originalEntry - t.stop_level);
      const targetDist = Math.abs(t.originalEntry - t.t1_level);
      const isTrain = train.includes(t);

      const aObj = { id: t.id, actual_pnl: t.actual_pnl, dateStr: t.dateStr, setup_type: t.setup_type, isTrain };

      let trigger1Bar = -1, trigger2Bar = -1;
      let favDeltaStreak = 0, favDeltaVolStreak = 0;
      for (let i = 0; i < Math.min(waitWindow, t.forwardBars.length); i++) {
        const bar = t.forwardBars[i];
        const deltaFav = t.direction === 'LONG' ? bar.ask_volume > bar.bid_volume : bar.bid_volume > bar.ask_volume;
        const volRatio = bar.volume / t.meanVol;
        if (deltaFav) favDeltaStreak++; else favDeltaStreak = 0;
        if (deltaFav && volRatio > volRatioP50) favDeltaVolStreak++; else favDeltaVolStreak = 0;
        if (trigger1Bar === -1 && favDeltaStreak >= 2) trigger1Bar = i;
        if (trigger2Bar === -1 && favDeltaVolStreak >= 2) trigger2Bar = i;
        if (trigger1Bar !== -1 && trigger2Bar !== -1) break;
      }

      const processTrigger = (trigBarIdx) => {
        if (trigBarIdx === -1) return null;
        const entryBar = t.forwardBars[trigBarIdx];
        const newEntry = entryBar.close;
        const newStop = t.direction === 'LONG' ? newEntry - stopDist : newEntry + stopDist;
        const newTarget = t.direction === 'LONG' ? newEntry + targetDist : newEntry - targetDist;
        const res = replayBars(t.forwardBars.slice(trigBarIdx), newEntry, newStop, newTarget, t.direction);
        if (!res) return null;
        const pnl = res.replayResolution === 'TARGET_HIT' ? targetDist * PNL_PER_POINT - COMMISSION : res.replayResolution === 'STOP_HIT' ? -stopDist * PNL_PER_POINT - COMMISSION : 0;
        return { id: t.id, actual_pnl: pnl, dateStr: t.dateStr, setup_type: t.setup_type, isTrain };
      };

      const c1Obj = processTrigger(trigger1Bar);
      const c2Obj = processTrigger(trigger2Bar);

      let bObj = null;
      if (bDelay !== -1 && t.forwardBars.length > bDelay) {
        const entryBar = t.forwardBars[bDelay];
        const newEntry = entryBar.close;
        const newStop = t.direction === 'LONG' ? newEntry - stopDist : newEntry + stopDist;
        const newTarget = t.direction === 'LONG' ? newEntry + targetDist : newEntry - targetDist;
        const res = replayBars(t.forwardBars.slice(bDelay), newEntry, newStop, newTarget, t.direction);
        if (res) {
          const pnl = res.replayResolution === 'TARGET_HIT' ? targetDist * PNL_PER_POINT - COMMISSION : res.replayResolution === 'STOP_HIT' ? -stopDist * PNL_PER_POINT - COMMISSION : 0;
          bObj = { id: t.id, actual_pnl: pnl, dateStr: t.dateStr, setup_type: t.setup_type, isTrain };
        }
      }

      const pushToGroup = (group) => { group.A.push(aObj); if (bObj) group.B.push(bObj); if (c1Obj) group.C1.push(c1Obj); if (c2Obj) group.C2.push(c2Obj); };
      pushToGroup(arms.ALL);
      pushToGroup(t.hasConfluence ? arms.CONF : arms.NOCONF);
      pushToGroup(setupArms[st]);
    }
  }

  console.log('\n-- Pooled results --');
  for (const [label, group] of Object.entries(arms)) {
    console.log(label, { A: summarizeArm('A', group.A), B: summarizeArm('B', group.B), C1: summarizeArm('C1', group.C1), C2: summarizeArm('C2', group.C2) });
  }

  // Replication: does a per-setup_type train "win" for C1/C2 survive on held-out test?
  const replicatedC1 = [], replicatedC2 = [];
  for (const st of setupTypes) {
    const s = setupArms[st];
    const ev = (arr) => arr.length ? arr.reduce((sum, r) => sum + r.actual_pnl, 0) / arr.length : -9999;
    const trainA = s.A.filter(x => x.isTrain), trainB = s.B.filter(x => x.isTrain), trainC1 = s.C1.filter(x => x.isTrain), trainC2 = s.C2.filter(x => x.isTrain);
    if (trainA.length < 20) continue;
    if (ev(trainC1) > ev(trainA) && ev(trainC1) > ev(trainB)) replicatedC1.push(st);
    if (ev(trainC2) > ev(trainA) && ev(trainC2) > ev(trainB)) replicatedC2.push(st);
  }
  const testUnits = (armKey) => setupTypes.map(st => {
    const testRows = setupArms[st][armKey].filter(x => !x.isTrain);
    return { setupType: st, n: testRows.length, value: testRows.length ? testRows.reduce((s, x) => s + x.actual_pnl, 0) / testRows.length : 0 };
  });

  let repC1 = null, repC2 = null;
  if (replicatedC1.length) repC1 = computeReplication(testUnits('C1'), { idFn: x => x.setupType, metricFn: x => ({ n: x.n, value: x.value }), selectedIds: replicatedC1 });
  if (replicatedC2.length) repC2 = computeReplication(testUnits('C2'), { idFn: x => x.setupType, metricFn: x => ({ n: x.n, value: x.value }), selectedIds: replicatedC2 });

  console.log(`\nC1: ${replicatedC1.length} setup_types beat A+B on train. Replication: selected test EV=${repC1?.selectedPooled.value} (N=${repC1?.selectedPooled.n}) vs held-out test EV=${repC1?.heldOutPooled.value} (N=${repC1?.heldOutPooled.n}), replicates=${repC1?.replicates}`);
  console.log(`C2: ${replicatedC2.length} setup_types beat A+B on train. Replication: selected test EV=${repC2?.selectedPooled.value} (N=${repC2?.selectedPooled.n}) vs held-out test EV=${repC2?.heldOutPooled.value} (N=${repC2?.heldOutPooled.n}), replicates=${repC2?.replicates}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
