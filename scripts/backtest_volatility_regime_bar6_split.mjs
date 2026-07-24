// Does the volatility regime (N=5 percentile split, reusing backtest_volatility_squeeze_bigmove.mjs's
// exact no-lookahead methodology) sharpen the RECOVERING/DETERIORATING bar-6 split or the frozen
// target-distance-fraction<0.873 exit rule (backtest_recovering_exit_predictor_confirmatory.mjs)?
//
// Result 2026-07-23 (RESEARCH_CLAIM bar6_volatility_regime_neutral): neutral / null.
// DETERIORATING stays negative in both regimes; RECOVERING stays positive in both; the frozen exit
// rule reconfirms cleanly on the dominant HIGH_VOL population (test lift +$4.32/trade, consistent
// with the already-confirmed uniform +$3.98). LOW_VOL cells are too thin (test N=10-25) to trust.
// A secondary per-setup_type selection layer looking for EXTRA lift beyond the uniform rule does not
// broadly replicate in either regime (computeReplication()'s heldOutFavorableFrac<0.5 both times) --
// real, structural, not a bug: reaching bar 6 undecided already selects for higher-vol days (~88% of
// the population), leaving too few genuine low-vol bar-6 survivors to discriminate against.
//
// IMPORTANT when reading computeReplication() output: `replicates` checks whether >=50% of INDIVIDUAL
// held-out setup_types (by count) are themselves positive on test -- it is a stricter, narrower check
// than "does the pooled dollar-weighted average beat held-out." HIGH_VOL here has selectedPooled=$5.82
// > heldOutPooled=$3.06 (both positive, selected genuinely ahead) yet replicates=false, because that
// held-out positive average is carried by a minority of higher-N setup_types while most individual
// setup_types are flat/negative on test. Always read selectedPooled/heldOutPooled directly -- never
// trust the boolean alone in either direction (see this session's other false-positive/false-negative
// instances).

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeReplication } from '../server/services/rigorDiagnostics.js';
import { COMMISSION, PNL_PER_POINT } from './backtest_confluence.js';
import fs from 'fs';

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

const FROZEN_CUTOFF = 0.873;

async function main() {
  console.log('Fetching all bars to establish volatility regimes...');
  const barsRes = await query(`
    SELECT ts, high::float, low::float, close::float, open::float,
           COALESCE(volume,0)::int as volume
    FROM price_bars_primary WHERE symbol='NQ'
    ORDER BY ts
  `);
  const bars = barsRes.rows;

  const GAP_HOURS_CUTOFF = 60;
  const sessions = [];
  let currentBars = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (currentBars.length > 0) {
      const prevBar = currentBars[currentBars.length - 1];
      const gapHours = (bar.ts.getTime() - prevBar.ts.getTime()) / 3600000;
      if (gapHours > 0.75) {
        sessions.push({ bars: currentBars });
        currentBars = [];
      }
    }
    currentBars.push(bar);
  }
  if (currentBars.length > 0) sessions.push({ bars: currentBars });

  function getMaxGapHours(windowBars) {
    let maxGap = 0;
    for (let i = 0; i < windowBars.length - 1; i++) {
      const gap = (windowBars[i + 1].ts.getTime() - windowBars[i].ts.getTime()) / 3600000;
      if (gap > maxGap) maxGap = gap;
    }
    return maxGap;
  }

  const validSessions = [];
  for (let i = 0; i < sessions.length; i++) {
    const windowBars = sessions[i].bars;
    const maxGap = getMaxGapHours(windowBars);
    if (maxGap < GAP_HOURS_CUTOFF) {
      let high = -Infinity, low = Infinity;
      for (const b of windowBars) {
        if (b.high > high) high = b.high;
        if (b.low < low) low = b.low;
      }
      validSessions.push({
        dateStr: windowBars[0].ts.toISOString().slice(0, 10),
        range: high - low
      });
    }
  }

  const nWindow = 5;
  const validRanges = validSessions.map(s => s.range);
  const priorNDayMeans = [];
  const dateToVolPct = new Map();

  for (let i = 0; i < validSessions.length; i++) {
    const dStr = validSessions[i].dateStr;
    if (i < nWindow) {
      continue;
    }
    const priorN = validRanges.slice(i - nWindow, i);
    const meanRange = mean(priorN);

    let percentile = 0;
    if (priorNDayMeans.length > 0) {
      const sortedHistory = [...priorNDayMeans].sort((a, b) => a - b);
      let countBelow = 0;
      for (const v of sortedHistory) {
        if (v <= meanRange) countBelow++;
        else break;
      }
      percentile = countBelow / sortedHistory.length;
    } else {
      percentile = 0.5;
    }

    dateToVolPct.set(dStr, percentile);
    priorNDayMeans.push(meanRange);
  }

  console.log("Computed volatility regimes for " + dateToVolPct.size + " days.");

  console.log('Fetching touches...');
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
  let datesProcessed = 0;
  for (const [date, dateSetups] of setupsByDate) {
    datesProcessed++;
    if (datesProcessed % 100 === 0) console.log("Processed " + datesProcessed + " dates...");

    const volPct = dateToVolPct.get(date);
    if (volPct == null) continue;
    const volRegime = volPct >= 0.5 ? 'HIGH_VOL' : 'LOW_VOL';

    const dayBarsRes = await query("SELECT ts, high::float, low::float, close::float, COALESCE(volume,0)::int as volume FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts", [date]);
    const allBars = dayBarsRes.rows;
    if (allBars.length < 25) continue;

    for (const s of dateSetups) {
      const direction = directionFromType(s.setup_type);
      if (!direction) continue;
      let entryIdx = -1;
      for (let i = allBars.length - 1; i >= 0; i--) { if (allBars[i].ts <= s.fired_at) { entryIdx = i; break; } }
      if (entryIdx < 20) continue;

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

      const status = worstBarIdx <= 2 ? 'RECOVERING' : 'DETERIORATING';

      const hi = s.entry_zone_high != null ? s.entry_zone_high : s.entry_zone_low;
      const entry = (s.entry_zone_low + hi) / 2;
      const bar6Close = b0_6[6].close;

      const pnlA = s.actual_pnl;
      const pointsB = direction === 'LONG' ? (bar6Close - entry) : (entry - bar6Close);
      const pnlB = pointsB * PNL_PER_POINT - COMMISSION;

      const distToTarget = direction === 'LONG' ? (s.t1_level - bar6Close) : (bar6Close - s.t1_level);
      const distEntryToTarget = direction === 'LONG' ? (s.t1_level - entry) : (entry - s.t1_level);
      const targetDistFraction = distEntryToTarget !== 0 ? (distToTarget / distEntryToTarget) : 0;

      const gatedPnl = targetDistFraction < FROZEN_CUTOFF ? pnlB : pnlA;

      touches.push({
        ...s, dateStr: date, direction, pnlA, gatedPnl,
        worstBarIdx, status, volPct, volRegime
      });
    }
  }

  function summarize(rows, field) {
    const n = rows.length;
    if (n === 0) return { n: 0, wr: '0.0', ev: '0.00', avgWin: 'n/a', avgLoss: 'n/a', maxWin: 'n/a', maxLoss: 'n/a' };
    const wins = rows.filter(r => r[field] > 0);
    const losses = rows.filter(r => r[field] <= 0);
    const wr = (wins.length / n * 100).toFixed(1);
    const ev = (rows.reduce((s, r) => s + r[field], 0) / n).toFixed(2);
    const avgWin = wins.length ? (wins.reduce((s, r) => s + r[field], 0) / wins.length).toFixed(2) : 'n/a';
    const avgLoss = losses.length ? (losses.reduce((s, r) => s + r[field], 0) / losses.length).toFixed(2) : 'n/a';
    const maxWin = wins.length ? Math.max(...wins.map(r => r[field])).toFixed(2) : 'n/a';
    const maxLoss = losses.length ? Math.min(...losses.map(r => r[field])).toFixed(2) : 'n/a';
    return { n, wr, ev, avgWin, avgLoss, maxWin, maxLoss };
  }

  function printSummary(label, sum) {
    return label + " (N=" + sum.n + "): WR=" + sum.wr + "%, EV=$" + sum.ev + " | avgWin=$" + sum.avgWin + ", avgLoss=$" + sum.avgLoss + ", maxWin=$" + sum.maxWin;
  }

  const setupTypes = [...new Set(touches.map(x => x.setup_type))];
  const trainTouches = [], testTouches = [];
  for (const st of setupTypes) {
    const my = touches.filter(x => x.setup_type === st).sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    const splitIdx = Math.floor(my.length * 0.8);
    trainTouches.push(...my.slice(0, splitIdx));
    testTouches.push(...my.slice(splitIdx));
  }

  const md = [];
  md.push('# Bar 6 Volatility Regime Analysis Results\n');
  md.push("Total qualifying bar 6 touches: " + touches.length + " (" + trainTouches.length + " train, " + testTouches.length + " test)\n");

  md.push('## 1. Does DETERIORATING badness vary by regime?');
  for (const [splitName, data] of [['TRAIN', trainTouches], ['TEST', testTouches]]) {
    const det = data.filter(t => t.status === 'DETERIORATING');
    const highVol = det.filter(t => t.volRegime === 'HIGH_VOL');
    const lowVol = det.filter(t => t.volRegime === 'LOW_VOL');
    md.push("### " + splitName);
    md.push('- ' + printSummary('DETERIORATING + HIGH_VOL', summarize(highVol, 'pnlA')));
    md.push('- ' + printSummary('DETERIORATING + LOW_VOL ', summarize(lowVol, 'pnlA')));
  }
  md.push('');

  md.push('## 2. Does RECOVERING edge vary by regime?');
  for (const [splitName, data] of [['TRAIN', trainTouches], ['TEST', testTouches]]) {
    const rec = data.filter(t => t.status === 'RECOVERING');
    const highVol = rec.filter(t => t.volRegime === 'HIGH_VOL');
    const lowVol = rec.filter(t => t.volRegime === 'LOW_VOL');
    md.push("### " + splitName);
    md.push('- ' + printSummary('RECOVERING + HIGH_VOL', summarize(highVol, 'pnlA')));
    md.push('- ' + printSummary('RECOVERING + LOW_VOL ', summarize(lowVol, 'pnlA')));
  }
  md.push('');

  md.push('## 3. Does the target-distance-fraction exit rule lift vary by regime?');
  md.push('Using frozen rule: targetDistFraction < 0.873 -> exit at bar 6; else hold to original outcome. Baseline is always hold.\n');

  for (const [splitName, data] of [['TRAIN', trainTouches], ['TEST', testTouches]]) {
    const rec = data.filter(t => t.status === 'RECOVERING');
    const highVol = rec.filter(t => t.volRegime === 'HIGH_VOL');
    const lowVol = rec.filter(t => t.volRegime === 'LOW_VOL');

    const sumBaseHigh = summarize(highVol, 'pnlA');
    const sumGatedHigh = summarize(highVol, 'gatedPnl');
    const sumBaseLow = summarize(lowVol, 'pnlA');
    const sumGatedLow = summarize(lowVol, 'gatedPnl');

    md.push("### " + splitName);
    md.push('#### RECOVERING + HIGH_VOL');
    md.push('- ' + printSummary('Baseline', sumBaseHigh));
    md.push('- ' + printSummary('Gated   ', sumGatedHigh));
    md.push("- Lift: $" + (sumGatedHigh.ev - sumBaseHigh.ev).toFixed(2));

    md.push('#### RECOVERING + LOW_VOL');
    md.push('- ' + printSummary('Baseline', sumBaseLow));
    md.push('- ' + printSummary('Gated   ', sumGatedLow));
    md.push("- Lift: $" + (sumGatedLow.ev - sumBaseLow.ev).toFixed(2));
  }

  md.push('\n## Replication Checks (Exit Rule Lift)');

  for (const regime of ['HIGH_VOL', 'LOW_VOL']) {
    const testUnits = setupTypes.map(st => {
      const myTrain = trainTouches.filter(x => x.setup_type === st && x.status === 'RECOVERING' && x.volRegime === regime);
      const myTest = testTouches.filter(x => x.setup_type === st && x.status === 'RECOVERING' && x.volRegime === regime);

      const trainEvBase = myTrain.length ? myTrain.reduce((s, x) => s + x.pnlA, 0) / myTrain.length : 0;
      const trainEvGated = myTrain.length ? myTrain.reduce((s, x) => s + x.gatedPnl, 0) / myTrain.length : 0;
      const trainLift = trainEvGated - trainEvBase;

      const testEvBase = myTest.length ? myTest.reduce((s, x) => s + x.pnlA, 0) / myTest.length : 0;
      const testEvGated = myTest.length ? myTest.reduce((s, x) => s + x.gatedPnl, 0) / myTest.length : 0;

      return { setupType: st, trainLift, n: myTest.length, value: testEvGated - testEvBase };
    });

    const selected = testUnits.filter(x => x.trainLift > 0).map(x => x.setupType);
    if (selected.length) {
      const rep = computeReplication(testUnits, { idFn: x => x.setupType, metricFn: x => ({ n: x.n, value: x.value }), selectedIds: selected });
      md.push("- " + regime + " exit lift replication: " + selected.length + " setups selected on train. Test: selected pool diff=$" + rep.selectedPooled.value.toFixed(2) + " vs held-out diff=$" + rep.heldOutPooled.value.toFixed(2) + " (replicates=" + rep.replicates + ", heldOutFavorableFrac=" + rep.heldOutFavorableFrac + ")");
    } else {
      md.push("- " + regime + " exit lift replication: 0 setups selected on train.");
    }
  }

  fs.writeFileSync('scratch/bar6_volatility_regime_RESULTS.md', md.join('\n'));
  console.log('Done, wrote results to scratch/bar6_volatility_regime_RESULTS.md');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
