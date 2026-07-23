// scripts/backtest_bar6_volume_trajectory.mjs
// Tests whether volume TRAJECTORY over bars 0-6 (BUILDING: bars 4-6 avg volRatio > bars
// 0-2 avg; FADING otherwise) sharpens the already-validated bar6_checkpoint split
// (backtest_bar6_worst_point_passed.mjs's RECOVERING/DETERIORATING classification).
// Direct follow-up connecting that finding to the separate volume-lifecycle-by-decile
// result in backtest_big_moves_rolling_window.mjs, per the user's own request to keep
// testing connections between today's findings rather than stopping at the first result.
//
// RESULT (see RESEARCH_CLAIM bar6_volume_trajectory_no_added_value): NEGATIVE -- volume
// trajectory does not sharpen the split. RECOVERING+BUILDING looked promising on train
// (N=289, EV=$46.24, avg loss shrinks to -$71.67) but failed on test (N=62, EV=$16.48,
// flagged CLUSTERED by computeRigor -- day-clustered/unstable) -- actually WORSE than the
// plain RECOVERING+FADING slice on the same test data (N=494, EV=$26.61, CLEAN). DETERIORATING
// touches show no difference between BUILDING/FADING at all (train -$35.33 vs -$34.12, test
// -$34.79 vs -$33.30) -- toxic regardless of volume trajectory.
//
// Audit note: Gemini's own narrative claimed "replicates=true... the structural lift IS
// real at the setup-type level" for RECOVERING+BUILDING. This is misleading taken at face
// value -- computeReplication()'s `replicates` flag only checks same-sign + held-out
// majority-favorable, NOT that the selected group beats held-out. The actual numbers:
// selected-pool test diff=$20.09 vs held-out (non-selected) diff=$52.86 -- the "selected"
// setup_types did WORSE than the ones the selection process didn't pick, meaning the
// selection added no real value. Same misreading pattern already caught once today
// (worst_point_passed_as_entry_trigger) -- always check selected-vs-held-out directly,
// never trust the `replicates` boolean alone.
//
// Practical conclusion: bar6_checkpoint's RECOVERING/DETERIORATING split is doing all the
// real work on its own. No change to the live signal or its wiring.

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';
import { loadPairProximityThresholds, PROXIMITY } from './backtest_confluence.js';

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
    const barsRes = await query(`SELECT ts, high::float, low::float, COALESCE(volume,0)::int as volume FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts`, [date]);
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

      const volRatios = [];
      for (let i = 0; i <= 6; i++) {
        let sumVol = 0;
        for (let j = 1; j <= 20; j++) sumVol += allBars[entryIdx + i - j]?.volume || 0;
        const meanVol = sumVol / 20;
        volRatios.push(meanVol > 0 ? (allBars[entryIdx + i].volume || 0) / meanVol : 0);
      }
      const earlyAvg = (volRatios[0] + volRatios[1] + volRatios[2]) / 3;
      const lateAvg = (volRatios[4] + volRatios[5] + volRatios[6]) / 3;
      const volTrend = lateAvg > earlyAvg ? 'BUILDING' : 'FADING';

      touches.push({ ...s, dateStr: date, direction, hasConfluence, worstBarIdx, volTrend });
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

  console.log(`Population: ${touches.length} touches still undecided at bar 6.\n`);
  for (const state of ['RECOVERING', 'DETERIORATING']) {
    for (const trend of ['BUILDING', 'FADING']) {
      const isRec = state === 'RECOVERING';
      const trainMatch = trainTouches.filter(t => (isRec ? t.worstBarIdx <= 2 : t.worstBarIdx > 2) && t.volTrend === trend);
      const testMatch = testTouches.filter(t => (isRec ? t.worstBarIdx <= 2 : t.worstBarIdx > 2) && t.volTrend === trend);
      console.log(`${state}+${trend}: TRAIN`, summarize(trainMatch), 'TEST', summarize(testMatch));
    }
  }

  console.log('\n-- Replication (selected-vs-held-out, not just the replicates boolean) --');
  for (const state of ['RECOVERING', 'DETERIORATING']) {
    for (const trend of ['BUILDING', 'FADING']) {
      const isRec = state === 'RECOVERING';
      const testUnits = setupTypes.map(st => {
        const myTrain = trainTouches.filter(x => x.setup_type === st && (isRec ? x.worstBarIdx <= 2 : x.worstBarIdx > 2) && x.volTrend === trend);
        const myTest = testTouches.filter(x => x.setup_type === st && (isRec ? x.worstBarIdx <= 2 : x.worstBarIdx > 2) && x.volTrend === trend);
        const myTestUncond = testTouches.filter(x => x.setup_type === st);
        const trainEv = myTrain.length ? myTrain.reduce((s, x) => s + x.actual_pnl, 0) / myTrain.length : 0;
        const testEv = myTest.length ? myTest.reduce((s, x) => s + x.actual_pnl, 0) / myTest.length : 0;
        const testUncondEv = myTestUncond.length ? myTestUncond.reduce((s, x) => s + x.actual_pnl, 0) / myTestUncond.length : 0;
        return { setupType: st, trainEv, n: myTest.length, value: testEv - testUncondEv };
      });
      const selected = testUnits.filter(x => x.trainEv > 0).map(x => x.setupType);
      if (selected.length) {
        const rep = computeReplication(testUnits, { idFn: x => x.setupType, metricFn: x => ({ n: x.n, value: x.value }), selectedIds: selected });
        console.log(`${state}+${trend}: ${selected.length} selected on train. selected pool test diff=$${rep.selectedPooled.value} vs held-out diff=$${rep.heldOutPooled.value} (replicates flag=${rep.replicates} -- selected beats held-out: ${rep.selectedPooled.value > rep.heldOutPooled.value})`);
      }
    }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
