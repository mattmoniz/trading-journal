import { query } from '../server/db.js';
import { resolveDirection, getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { stepWiderTarget, MAX_BARS_TO_T1_FOR_WIDER } from '../server/services/widerTargetWalker.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
// 1.0x kept in the grid deliberately (2026-08-19 user-confirmed design decision, see
// OPEN_DECISION wider_target_calib_needs_deepseek_review): the mechanism only ever arms
// after a fast T1 hit (bars_to_resolution<=MAX_BARS_TO_T1_FOR_WIDER) -- once armed, there
// is no existing way to express "for THIS type, bank T1 immediately anyway instead of
// continuing to hold," since every other candidate implies holding for a wider level. A
// type that arms but loses money once held for ANY wider target (confirmed independently
// for VWAP_MAGNET_LONG, -$16.92 to -$24/trade) needs 1.0x to be selectable as the winning
// candidate, not just excluded from the grid.
const WIDER_MULTIPLIERS = [1.0, 1.2, 1.5, 1.8, 2.0, 2.5];

async function main() {
  console.log('Loading real resolved trades...');
  const tradesRes = await query(`
    SELECT id, setup_type, origin_status, status, 
      fired_at::text as fired_at,
      extract(epoch from (fired_at AT TIME ZONE 'America/New_York'))*1000 as fired_at_ms,
      trade_date::text as trade_date,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level
    FROM active_setups
    WHERE origin_status IN ('ACTIVE', 'SHADOW')
      AND status IN ('RESOLVED', 'EXPIRED')
      AND t1_level IS NOT NULL AND stop_level IS NOT NULL AND entry_zone_low IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const allTrades = tradesRes.rows;
  console.log(`Loaded ${allTrades.length} candidate real trades.`);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`
    SELECT to_char(ts AT TIME ZONE 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS') as ts_et,
           extract(epoch from (ts AT TIME ZONE 'America/New_York'))*1000 as ts_ms,
           high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;
  console.log(`Loaded ${allBars.length} price bars.`);

  function firstIndexAfter(tsMs) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts_ms <= tsMs) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function runSim(trade, direction, mult) {
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const stop = trade.stop_level;
    const t1 = trade.t1_level;
    const origDistance = Math.abs(t1 - entry);
    const widerTarget = +(long ? entry + origDistance * mult : entry - origDistance * mult).toFixed(2);
    
    let state = { widening: false };
    const startIdx = firstIndexAfter(trade.fired_at_ms);
    let resolution = null;
    let armed = false;
    
    for (let i = startIdx; i < allBars.length; i++) {
      const barCount = i - startIdx + 1;
      const b = allBars[i];
      const bar = { ts: b.ts_et, high: b.high, low: b.low, close: b.close };
      
      const stepRes = stepWiderTarget(state, bar, { entry, stop, t1, widerTarget, long, barCount, maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER });
      
      if (!state.widening && stepRes.state.widening) {
        armed = true;
      }
      state = stepRes.state;
      
      if (stepRes.resolution) {
        resolution = stepRes.resolution;
        break;
      }
    }
    
    // baseline is deterministic: if it armed, it would have banked T1.
    const baselinePnl = Math.round((origDistance * PNL_PER_POINT - COMMISSION) * 100) / 100;
    
    let simPnl = null;
    if (resolution) {
       const points = long ? resolution.priceAtRes - entry : entry - resolution.priceAtRes;
       simPnl = Math.round((points * PNL_PER_POINT - COMMISSION) * 100) / 100;
    }
    
    return { armed, resolution, baselinePnl, simPnl };
  }

  console.log('Simulating trades...');
  const eligibleTrades = [];
  let noDirection = 0, notArmed = 0, invalidSim = 0;

  for (const trade of allTrades) {
    const direction = resolveDirection(trade);
    if (!direction) { noDirection++; continue; }
    
    // Run with 1.5 to check if it arms. Arming depends only on T1 and maxBarsToT1.
    const dummySim = runSim(trade, direction, 1.5);
    if (!dummySim.armed) { notArmed++; continue; }
    
    if (dummySim.simPnl === null) { invalidSim++; continue; }

    const tradeResult = {
      trade, direction,
      trade_date: trade.trade_date,
      baselinePnl: dummySim.baselinePnl,
      multResults: {}
    };
    
    for (const mult of WIDER_MULTIPLIERS) {
      if (mult === 1.0) {
        // "Bank T1 immediately, don't hold for anything wider" -- deliberately NOT run
        // through stepWiderTarget(). DeepSeek code review (2026-08-19, blocking finding):
        // with widerTarget===t1, the walker's armed branch has no "bank now" case, so it
        // instead simulates "arm, then wait for a T1 RE-TOUCH with the original stop still
        // live" -- strictly worse than banking immediately (confirmed: 1.0x was the worst
        // row in every group in the pre-fix run, so it could never win argmax and the
        // candidate was structurally unable to express what it was added for). Matches the
        // predecessor script's convention (wider_target_backtest_1yr.mjs): 1.0x = baseline,
        // delta = 0.
        tradeResult.multResults[mult] = { armed: true, resolution: null, baselinePnl: dummySim.baselinePnl, simPnl: dummySim.baselinePnl };
        continue;
      }
      tradeResult.multResults[mult] = runSim(trade, direction, mult);
    }
    eligibleTrades.push(tradeResult);
  }

  console.log(`Eligible (armed) trades: ${eligibleTrades.length}. (no dir: ${noDirection}, not armed: ${notArmed}, invalid sim: ${invalidSim})`);

  function summarizeGroup(trades) {
    const summary = {};
    // Sort chronologically before building events -- DeepSeek code review (2026-08-19,
    // should-fix finding): computeRigor()'s 3-way "thirds" stability check slices by
    // ARRAY POSITION, assuming chronological order. The query itself is now ORDER BY
    // fired_at, but a bet_class-pooled group (thin setup_types merged via getBetClass())
    // is built by concatenating each setup_type's own chronological sub-array one after
    // another (trades.push(...typeTrades) per type) -- NOT globally chronological across
    // types. Sorting here, not just at the query, is what actually fixes it for those
    // groups.
    const sortedTrades = [...trades].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    for (const mult of WIDER_MULTIPLIERS) {
      const events = sortedTrades.map(t => ({
        date: t.trade_date,
        delta: t.multResults[mult].simPnl - t.baselinePnl,
        simPnl: t.multResults[mult].simPnl,
        baselinePnl: t.baselinePnl
      }));
      
      const meanDelta = events.reduce((s, e) => s + e.delta, 0) / events.length;
      const meanSimPnl = events.reduce((s, e) => s + e.simPnl, 0) / events.length;
      
      // WR = fraction of trades where simPnl > baselinePnl
      const wrVsBaseline = events.filter(e => e.delta > 0).length / events.length;
      // Absolute WR = fraction of trades where simPnl > 0
      const absWr = events.filter(e => e.simPnl > 0).length / events.length;

      const rigor = computeRigor(events, { dateField: 'date', pnlFn: e => e.delta });
      
      summary[mult] = {
        N: events.length,
        meanSimPnl,
        meanDelta,
        wrVsBaseline,
        absWr,
        rigor
      };
    }
    return summary;
  }

  const pooledSummary = summarizeGroup(eligibleTrades);
  
  const setupGroups = {};
  for (const t of eligibleTrades) {
    const st = t.trade.setup_type;
    if (!setupGroups[st]) setupGroups[st] = [];
    setupGroups[st].push(t);
  }
  
  const finalGroups = {};
  for (const [st, trades] of Object.entries(setupGroups)) {
    if (trades.length >= 20) {
      finalGroups[st] = { isBetClass: false, trades };
    } else {
      const bc = getBetClass(st);
      if (!finalGroups[bc]) finalGroups[bc] = { isBetClass: true, trades: [] };
      finalGroups[bc].trades.push(...trades);
    }
  }

  // Build the markdown report
  let md = '# Wider Target Multiplier Calibration Results\n\n';
  md += `## Pooled Results (All Armed Trades, N=${eligibleTrades.length})\n\n`;
  md += '| Multiplier | N | WR vs Baseline | Abs WR | Mean EV | EV Delta vs Baseline | Rigor Verdict |\n';
  md += '|---|---|---|---|---|---|---|\n';
  
  for (const mult of WIDER_MULTIPLIERS) {
    const s = pooledSummary[mult];
    let rigorVerdict = s.rigor.clean ? 'CLEAN' : 'UNSTABLE';
    if (s.rigor.clustered) rigorVerdict += ' (Clustered)';
    if (s.rigor.stable === false) rigorVerdict += ' (Degrading)';
    
    md += `| ${mult}x | ${s.N} | ${(s.wrVsBaseline*100).toFixed(1)}% | ${(s.absWr*100).toFixed(1)}% | $${s.meanSimPnl.toFixed(2)} | $${s.meanDelta.toFixed(2)} | ${rigorVerdict} |\n`;
  }
  
  md += '\n## Results by Setup Type / Bet Class\n\n';
  
  for (const [groupName, data] of Object.entries(finalGroups)) {
    const s = summarizeGroup(data.trades);
    const label = data.isBetClass ? `Bet Class: ${groupName}` : `Setup Type: ${groupName}`;
    md += `### ${label}\n\n`;
    md += '| Multiplier | N | WR vs Baseline | Mean EV | EV Delta vs Baseline | Rigor Verdict |\n';
    md += '|---|---|---|---|---|---|\n';
    
    for (const mult of WIDER_MULTIPLIERS) {
      const ds = s[mult];
      let rigorVerdict = 'THIN';
      if (ds.N >= 20) {
         rigorVerdict = ds.rigor.clean ? 'CLEAN' : 'UNSTABLE';
         if (ds.rigor.clustered) rigorVerdict += ' (Clustered)';
         if (ds.rigor.stable === false) rigorVerdict += ' (Degrading)';
      }
      
      md += `| ${mult}x | ${ds.N} | ${(ds.wrVsBaseline*100).toFixed(1)}% | $${ds.meanSimPnl.toFixed(2)} | $${ds.meanDelta.toFixed(2)} | ${rigorVerdict} |\n`;
    }
    md += '\n';
  }

  // Leading candidate per group -- argmax(meanDelta) among multipliers with N>=20, purely
  // descriptive (not a validated pick). 1.0x can win here, meaning "arms but loses money
  // once held for any wider target -- bank T1 immediately instead" (the exact case this
  // candidate was added to express, see the WIDER_MULTIPLIERS comment above).
  function leadingCandidate(summary) {
    let best = null;
    for (const mult of WIDER_MULTIPLIERS) {
      const s = summary[mult];
      if (s.N < 20) continue;
      if (!best || s.meanDelta > best.meanDelta) best = { mult, ...s };
    }
    return best;
  }

  const pooledLeading = leadingCandidate(pooledSummary);
  const groupLeading = {};
  for (const [groupName, data] of Object.entries(finalGroups)) {
    const s = summarizeGroup(data.trades);
    groupLeading[groupName] = { isBetClass: data.isBetClass, N: data.trades.length, leading: leadingCandidate(s) };
  }

  md += '\n## Recommendation\n';
  md += pooledLeading
    ? `Pooled leading candidate (argmax mean EV delta among N>=20 multipliers, NOT yet DeepSeek-reviewed): ${pooledLeading.mult}x, meanDelta=$${pooledLeading.meanDelta.toFixed(2)}, rigor.clean=${pooledLeading.rigor.clean}.\n`
    : 'Pooled: no multiplier clears N>=20.\n';
  md += 'Per-group leading candidates below are descriptive only -- none of this is wired live. See OPEN_DECISION wider_target_calib_needs_deepseek_review for review status.\n';

  fs.writeFileSync('scratch/wider_target_multiplier_calibration_RESULTS.md', md);
  console.log('Results written to scratch/wider_target_multiplier_calibration_RESULTS.md');

  // Persist per CLAUDE.md's no-dead-ends rule -- a computed calibration finding must be
  // queryable, not just a scratch/*.md file. PROVISIONAL: methodology has not yet had its
  // DeepSeek code review (OPEN_DECISION wider_target_calib_needs_deepseek_review), and no
  // per-group number here is wired to anything live.
  const { rows: todayRows } = await query(`SELECT CURRENT_DATE::text as today`);
  await recordClaim({
    slug: 'wider_target_multiplier_calibration',
    claimText: `Wider-target-mechanism multiplier calibration (candidates ${WIDER_MULTIPLIERS.join('/')}x, real armed trades only). Pooled N=${eligibleTrades.length}, leading candidate ${pooledLeading ? `${pooledLeading.mult}x (meanDelta=$${pooledLeading.meanDelta.toFixed(2)}, rigor.clean=${pooledLeading.rigor.clean})` : 'none clear N>=20'}. Per-group breakdown in extra. NOT DeepSeek-reviewed yet, NOT wired live -- descriptive only.`,
    sourceFile: 'scripts/backtest_calibrated_wider_target.mjs',
    sourceDate: todayRows[0].today,
    sampleSize: eligibleTrades.length,
    evPerTrade: pooledLeading ? +pooledLeading.meanDelta.toFixed(2) : null,
    rigorStatus: pooledLeading ? JSON.stringify(pooledLeading.rigor) : 'not_checked',
    status: 'PROVISIONAL',
    extra: {
      candidates: WIDER_MULTIPLIERS,
      pooled_leading: pooledLeading ? { mult: pooledLeading.mult, meanDelta: +pooledLeading.meanDelta.toFixed(2), rigorClean: pooledLeading.rigor.clean } : null,
      by_group: Object.fromEntries(Object.entries(groupLeading).map(([k, v]) => [k, {
        isBetClass: v.isBetClass, N: v.N,
        leading: v.leading ? { mult: v.leading.mult, meanDelta: +v.leading.meanDelta.toFixed(2), rigorClean: v.leading.rigor.clean } : null,
      }])),
    },
  });
  console.log('Recorded RESEARCH_CLAIM wider_target_multiplier_calibration (PROVISIONAL, pending DeepSeek review).');
}

main().catch(console.error);
