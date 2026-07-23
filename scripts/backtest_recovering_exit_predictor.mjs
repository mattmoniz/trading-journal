// scripts/backtest_recovering_exit_predictor.mjs
// Follow-up to backtest_bar6_early_exit.mjs's finding that exiting RECOVERING touches at
// bar 6 beats holding to target in ~71 of ~150 setup_types (real, replicated) but not
// universally. Instead of a static per-setup_type list, mines for a real-time-computable
// FEATURE that predicts, for an individual touch, whether EXIT_BETTER (pnlB>pnlA) or
// HOLD_BETTER (pnlA>=pnlB) — per the user's own framing ("it won't be a uniform answer,
// that's where volume and price movement steps in").
//
// RESULT (see RESEARCH_CLAIM recovering_exit_predictor_target_distance_provisional):
// GENUINELY OPEN, not confirmed, not rejected — audited carefully because Gemini's own
// conclusion ("fails replication, none of the features work") was too pessimistic in a
// way that mirrors, in reverse, the misreadings caught twice earlier today.
//
// Of 5 candidate features (volume trajectory, volume magnitude at bar 6, recovery
// fraction, delta at bar 6, delta bars 4-6), TARGET DISTANCE FRACTION (how far price has
// already traveled toward the original target by bar 6, as a fraction of entry-to-target
// distance) showed real, intuitive separation: EXIT_BETTER touches median 0.86 (only ~14%
// of the way to target), HOLD_BETTER touches median 0.72 (~28% of the way) — touches
// already making real progress toward target by bar 6 tend to complete the journey.
//
// Gemini ran computeReplication() on the best train-derived cutoff and reported "FAILS
// REPLICATION" because the `replicates` boolean requires SAME-SIGN agreement between the
// selected and held-out pools. Here selected showed +$11.20 (real, positive) while
// held-out showed -$1.64 (negative) — OPPOSITE signs, which fails the boolean by
// definition, but is arguably a CLEANER signal of real discrimination (the policy
// correctly separates a group that benefits from one that doesn't/is hurt), not weaker
// evidence. `replicates` tests "is this effect broadly universal," not "did the selection
// process find something real" — those are different questions, and this session has
// already learned (twice) not to trust that boolean literally without checking the raw
// selected-vs-held-out numbers directly.
//
// HOWEVER — not accepting this as confirmed either: the feature (F4 of 5) and its cutoff
// (best of 9 deciles) were BOTH chosen by searching the same train data before the
// per-setup_type selection layer was even applied — a nested, two-level nested selection
// with meaningfully more researcher/model degrees of freedom than any single-hypothesis
// test earlier today. A real follow-up would pre-register just this one rule (target
// distance fraction, no re-selection) and validate it on a genuinely fresh holdout, not
// reuse the same exploratory pass's own selection. Flagged as PROVISIONAL, not CONFIRMED.
import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeReplication } from '../server/services/rigorDiagnostics.js';
import { loadPairProximityThresholds, PROXIMITY, COMMISSION, PNL_PER_POINT } from './backtest_confluence.js';
import fs from 'fs';

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
    const barsRes = await query(`
      SELECT ts, high::float, low::float, close::float, COALESCE(volume,0)::int as volume,
             COALESCE(bid_volume,0)::int as bid_volume, COALESCE(ask_volume,0)::int as ask_volume
      FROM price_bars_primary 
      WHERE symbol='NQ' AND ts::date = $1 
      ORDER BY ts
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
      
      if (resolutionBarIdx < 6) continue;

      const b0_6 = forwardBars.slice(0, 7);
      let worstPrice = direction === 'LONG' ? b0_6[0].low : b0_6[0].high;
      let worstBarIdx = 0;
      for (let i = 0; i <= 6; i++) {
        if (direction === 'LONG' && b0_6[i].low < worstPrice) { worstPrice = b0_6[i].low; worstBarIdx = i; }
        if (direction === 'SHORT' && b0_6[i].high > worstPrice) { worstPrice = b0_6[i].high; worstBarIdx = i; }
      }

      if (worstBarIdx > 2) continue; // Only RECOVERING

      const hi = s.entry_zone_high != null ? s.entry_zone_high : s.entry_zone_low;
      const entry = (s.entry_zone_low + hi) / 2;
      const bar6Close = b0_6[6].close;

      const pnlA = s.actual_pnl;
      const pointsB = direction === 'LONG' ? (bar6Close - entry) : (entry - bar6Close);
      const pnlB = pointsB * PNL_PER_POINT - COMMISSION;
      
      const label = pnlB > pnlA ? 'EXIT_BETTER' : 'HOLD_BETTER';

      let volRatios = [];
      for (let i = 0; i <= 6; i++) {
        let sumVol = 0;
        for (let j = 1; j <= 20; j++) {
           sumVol += allBars[entryIdx + i - j].volume || 0;
        }
        let meanVol = sumVol / 20;
        let vr = meanVol > 0 ? (allBars[entryIdx + i].volume || 0) / meanVol : 0;
        volRatios.push(vr);
      }
      let earlyAvg = (volRatios[0] + volRatios[1] + volRatios[2]) / 3;
      let lateAvg = (volRatios[4] + volRatios[5] + volRatios[6]) / 3;
      let f1_volTrajectory = (lateAvg > earlyAvg) ? 'BUILDING' : 'FADING';
      let f2_volBar6 = volRatios[6];
      
      let distFromWorst = direction === 'LONG' ? (bar6Close - worstPrice) : (worstPrice - bar6Close);
      let distWorstToEntry = direction === 'LONG' ? (entry - worstPrice) : (worstPrice - entry);
      let f3_recoveryFraction = distWorstToEntry !== 0 ? (distFromWorst / distWorstToEntry) : (distFromWorst > 0 ? 1.5 : 0);

      let distToTarget = direction === 'LONG' ? (s.t1_level - bar6Close) : (bar6Close - s.t1_level);
      let distEntryToTarget = direction === 'LONG' ? (s.t1_level - entry) : (entry - s.t1_level);
      let f4_targetDistFraction = distEntryToTarget !== 0 ? (distToTarget / distEntryToTarget) : 0;
      
      let deltaBar6 = allBars[entryIdx + 6].ask_volume - allBars[entryIdx + 6].bid_volume;
      let delta46 = 0;
      for (let i = 4; i <= 6; i++) {
         delta46 += (allBars[entryIdx + i].ask_volume - allBars[entryIdx + i].bid_volume);
      }
      if (direction === 'SHORT') {
         deltaBar6 = -deltaBar6;
         delta46 = -delta46;
      }
      let f5_deltaBar6 = deltaBar6;
      let f5_delta46 = delta46;

      touches.push({ 
        ...s, dateStr: date, direction, hasConfluence, worstBarIdx, label,
        pnlA, pnlB,
        f1_volTrajectory, f2_volBar6, f3_recoveryFraction, f4_targetDistFraction, f5_deltaBar6, f5_delta46
      });
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

  function getPercentiles(arr, pctls) {
    if (arr.length === 0) return pctls.map(() => 'n/a');
    const sorted = [...arr].sort((a,b) => a - b);
    return pctls.map(p => {
       const idx = Math.max(0, Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1))));
       return sorted[idx].toFixed(2);
    });
  }

  function analyzeFeature(name, key, isCategorical=false) {
     let res = `\n### Feature: ${name}\n`;
     for (const view of ['ALL', 'CONFLUENCE', 'NON-CONFLUENCE']) {
        let subset = trainTouches;
        if (view === 'CONFLUENCE') subset = trainTouches.filter(t => t.hasConfluence);
        if (view === 'NON-CONFLUENCE') subset = trainTouches.filter(t => !t.hasConfluence);
        
        let exitBetter = subset.filter(t => t.label === 'EXIT_BETTER');
        let holdBetter = subset.filter(t => t.label === 'HOLD_BETTER');
        
        if (isCategorical) {
           const countMatches = (arr, val) => arr.filter(t => t[key] === val).length;
           res += `- **${view}** (N_EXIT=${exitBetter.length}, N_HOLD=${holdBetter.length}):\n`;
           const cats = [...new Set(subset.map(t => t[key]))];
           for (const cat of cats) {
              const exC = countMatches(exitBetter, cat);
              const hoC = countMatches(holdBetter, cat);
              const exPct = exitBetter.length ? ((exC/exitBetter.length)*100).toFixed(1) : 0;
              const hoPct = holdBetter.length ? ((hoC/holdBetter.length)*100).toFixed(1) : 0;
              res += `  - ${cat}: EXIT_BETTER=${exPct}% | HOLD_BETTER=${hoPct}%\n`;
           }
        } else {
           const exVals = exitBetter.map(t => t[key]);
           const hoVals = holdBetter.map(t => t[key]);
           const pctls = [0.25, 0.50, 0.75];
           const exP = getPercentiles(exVals, pctls);
           const hoP = getPercentiles(hoVals, pctls);
           res += `- **${view}** (N_EXIT=${exitBetter.length}, N_HOLD=${holdBetter.length}):\n`;
           res += `  - EXIT_BETTER: P25=${exP[0]}, Median=${exP[1]}, P75=${exP[2]}\n`;
           res += `  - HOLD_BETTER: P25=${hoP[0]}, Median=${hoP[1]}, P75=${hoP[2]}\n`;
        }
     }
     return res;
  }

  let out = [];
  out.push('# Recovering Touches: Feature Separation for Exit vs Hold\n');
  out.push(analyzeFeature('F1: Volume Trajectory (Categorical)', 'f1_volTrajectory', true));
  out.push(analyzeFeature('F2: Volume Magnitude at Bar 6', 'f2_volBar6'));
  out.push(analyzeFeature('F3: Recovery Fraction', 'f3_recoveryFraction'));
  out.push(analyzeFeature('F4: Target Distance Fraction', 'f4_targetDistFraction'));
  out.push(analyzeFeature('F5A: Delta at Bar 6', 'f5_deltaBar6'));
  out.push(analyzeFeature('F5B: Delta Bars 4-6', 'f5_delta46'));

  function findBestCutoff(feature, isGreaterThan) {
    const vals = [...new Set(trainTouches.map(t => t[feature]))].sort((a,b) => a - b);
    let bestCutoff = 0;
    let bestEV = -Infinity;
    let nSelected = 0;
    
    const deciles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map(p => {
       const idx = Math.floor(p * (vals.length - 1));
       return vals[idx];
    });

    for (const c of deciles) {
       let totalEV = 0;
       let countB = 0;
       for (const t of trainTouches) {
          const condition = isGreaterThan ? (t[feature] > c) : (t[feature] < c);
          if (condition) {
             totalEV += t.pnlB;
             countB++;
          } else {
             totalEV += t.pnlA;
          }
       }
       if (totalEV > bestEV) {
          bestEV = totalEV;
          bestCutoff = c;
          nSelected = countB;
       }
    }
    return { bestCutoff, bestEV: bestEV/trainTouches.length, nSelected };
  }

  out.push('\n## Policy Threshold Search (Train Set)');
  const policies = [
    { name: 'F2 Vol > C', f: 'f2_volBar6', dir: true },
    { name: 'F2 Vol < C', f: 'f2_volBar6', dir: false },
    { name: 'F3 Recov > C', f: 'f3_recoveryFraction', dir: true },
    { name: 'F3 Recov < C', f: 'f3_recoveryFraction', dir: false },
    { name: 'F4 TgtDist > C', f: 'f4_targetDistFraction', dir: true },
    { name: 'F4 TgtDist < C', f: 'f4_targetDistFraction', dir: false },
    { name: 'F5A Delta6 > C', f: 'f5_deltaBar6', dir: true },
    { name: 'F5A Delta6 < C', f: 'f5_deltaBar6', dir: false },
    { name: 'F5B Delta46 > C', f: 'f5_delta46', dir: true },
    { name: 'F5B Delta46 < C', f: 'f5_delta46', dir: false }
  ];

  let baselineEVTrain = trainTouches.reduce((s,t)=>s+t.pnlA,0) / trainTouches.length;
  out.push(`Baseline Arm A EV: $${baselineEVTrain.toFixed(2)}\n`);

  let bestPolicy = null;
  let bestPolicyLift = -Infinity;

  for (const pol of policies) {
     const res = findBestCutoff(pol.f, pol.dir);
     const lift = res.bestEV - baselineEVTrain;
     out.push(`- ${pol.name}: Cutoff=${res.bestCutoff.toFixed(3)}, EV=$${res.bestEV.toFixed(2)} (Lift=$${lift.toFixed(2)}), Arm B chosen ${res.nSelected}/${trainTouches.length} times`);
     if (lift > bestPolicyLift) {
        bestPolicyLift = lift;
        bestPolicy = { ...pol, cutoff: res.bestCutoff };
     }
  }
  
  if (bestPolicy) {
     out.push(`\n### Selected Best Feature for 3-Arm Comparison: ${bestPolicy.name} (Cutoff: ${bestPolicy.cutoff.toFixed(3)})`);
     
     const runPolicy = (subset) => {
        let pnlArr = [];
        let aPnl = [];
        let wins = 0, losses = 0;
        let armA_wins = 0, armA_losses = 0;
        let sumA = 0;
        for (const t of subset) {
           const condition = bestPolicy.dir ? (t[bestPolicy.f] > bestPolicy.cutoff) : (t[bestPolicy.f] < bestPolicy.cutoff);
           const pnl = condition ? t.pnlB : t.pnlA;
           pnlArr.push(pnl);
           aPnl.push(t.pnlA);
        }
        return {
           n: subset.length,
           avgWin: pnlArr.filter(x=>x>0).length ? (pnlArr.filter(x=>x>0).reduce((s,x)=>s+x,0) / pnlArr.filter(x=>x>0).length).toFixed(2) : 'n/a',
           avgLoss: pnlArr.filter(x=>x<=0).length ? (pnlArr.filter(x=>x<=0).reduce((s,x)=>s+x,0) / pnlArr.filter(x=>x<=0).length).toFixed(2) : 'n/a',
           maxWin: pnlArr.filter(x=>x>0).length ? Math.max(...pnlArr).toFixed(2) : 'n/a',
           wr: (pnlArr.filter(x=>x>0).length / subset.length * 100).toFixed(1),
           ev: (pnlArr.reduce((s,x)=>s+x,0) / subset.length).toFixed(2),
           baseEv: (aPnl.reduce((s,x)=>s+x,0) / subset.length).toFixed(2)
        };
     };

     for (const view of ['ALL', 'CONFLUENCE', 'NON-CONFLUENCE']) {
        let trainSub = trainTouches; let testSub = testTouches;
        if (view === 'CONFLUENCE') { trainSub = trainTouches.filter(t=>t.hasConfluence); testSub = testTouches.filter(t=>t.hasConfluence); }
        if (view === 'NON-CONFLUENCE') { trainSub = trainTouches.filter(t=>!t.hasConfluence); testSub = testTouches.filter(t=>!t.hasConfluence); }
        
        let trainRes = runPolicy(trainSub);
        let testRes = runPolicy(testSub);
        
        out.push(`\n#### ${view}`);
        out.push(`- TRAIN (N=${trainSub.length}): Gated EV=$${trainRes.ev} (Base A=$${trainRes.baseEv}) | AvgWin=$${trainRes.avgWin} AvgLoss=$${trainRes.avgLoss} MaxWin=$${trainRes.maxWin} WR=${trainRes.wr}%`);
        out.push(`- TEST (N=${testSub.length}): Gated EV=$${testRes.ev} (Base A=$${testRes.baseEv}) | AvgWin=$${testRes.avgWin} AvgLoss=$${testRes.avgLoss} MaxWin=$${testRes.maxWin} WR=${testRes.wr}%`);
     }

     // Replication Check
     out.push('\n### Replication Check (Test Set)');
     const testUnits = setupTypes.map(st => {
       const myTrain = trainTouches.filter(x => x.setup_type === st);
       const myTest = testTouches.filter(x => x.setup_type === st);
       
       let trainGatedSum = 0; let trainBaseSum = 0;
       for (const t of myTrain) {
          const condition = bestPolicy.dir ? (t[bestPolicy.f] > bestPolicy.cutoff) : (t[bestPolicy.f] < bestPolicy.cutoff);
          trainGatedSum += condition ? t.pnlB : t.pnlA;
          trainBaseSum += t.pnlA;
       }
       let testGatedSum = 0; let testBaseSum = 0;
       for (const t of myTest) {
          const condition = bestPolicy.dir ? (t[bestPolicy.f] > bestPolicy.cutoff) : (t[bestPolicy.f] < bestPolicy.cutoff);
          testGatedSum += condition ? t.pnlB : t.pnlA;
          testBaseSum += t.pnlA;
       }
       
       const trainEvDiff = myTrain.length ? (trainGatedSum - trainBaseSum)/myTrain.length : 0;
       const testEvDiff = myTest.length ? (testGatedSum - testBaseSum)/myTest.length : 0;
       
       return { setupType: st, trainEvDiff, n: myTest.length, value: testEvDiff };
     });
     
     const selected = testUnits.filter(x => x.trainEvDiff > 0).map(x => x.setupType);
     if (selected.length) {
       const rep = computeReplication(testUnits, { idFn: x => x.setupType, metricFn: x => ({ n: x.n, value: x.value }), selectedIds: selected });
       out.push(`${selected.length} setup_types favored the feature policy on train.`);
       out.push(`Selected pool TEST diff: $${rep.selectedPooled.value.toFixed(2)} vs Held-out TEST diff: $${rep.heldOutPooled.value.toFixed(2)}`);
       out.push(`(Feature Policy beats Held-out? ${rep.selectedPooled.value > rep.heldOutPooled.value})`);
       if (rep.replicates) {
          out.push(`**REPLICATES** according to boolean check.`);
       } else {
          out.push(`**FAILS REPLICATION** according to boolean check.`);
       }
     } else {
       out.push(`0 setup_types favored the feature policy on train (no lift anywhere).`);
     }
  }

  fs.writeFileSync('scratch/recovering_exit_predictor_RESULTS.md', out.join('\n'));
  console.log('Done.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
