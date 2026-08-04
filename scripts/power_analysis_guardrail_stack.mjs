// power_analysis_guardrail_stack.mjs — INCONCLUSIVE, 2026-08-04. Do not trust either past result.
//
// Built to answer "data-limited vs gate-limited" for the guarded chronological calibration
// path's guardrail stack (thin-tail + OOS + computeRigor), per an Opus-proposed planted-effect
// Monte Carlo power analysis. Two attempts, both invalidated by OPPOSITE methodological flaws:
//
// Attempt 1: assigned every synthetic trade a fabricated, perfectly uniform date (exactly
// 2/day) — computeRigor's day-clustering check passes by construction under this scheme,
// producing an artificially optimistic "N=45 crossing, data-limited" result that directly
// contradicted the already-established real finding (0/9 live types pass even at real N up to
// 125 — see scripts/diagnose_chronological_stop_target_bias.mjs).
//
// Attempt 2 (corrected to bootstrap real fired_at dates): packed all N synthetic trades into the
// SAME small fixed historical date range the base type's real ~87-125 trades span, regardless of
// how large N was set (`fired_at.getTime() + i`, millisecond jitter only, never a calendar-day
// extension) — this guarantees catastrophic artificial over-clustering at any N (0% pass rate at
// every N up to 1500 for both base types), the opposite failure mode, equally invalidating.
//
// A THIRD, separate, uncorrected issue found while documenting this (not chased further given a
// session usage-budget note): DEFAULT_DPP=20 / COMM=4.14 below are NQ-scale constants, not this
// codebase's real MNQ $2/pt + $1 commission convention used everywhere else (LIVE_INSTRUMENT in
// server/config/instruments.js) — see CLAUDE.md's standing "never copy a $/pt constant without
// checking it matches this" rule, now a 5th documented instance of exactly that bug class.
//
// The real question — would this guardrail stack pass a genuine effect once real trade
// populations grow organically over the NEXT several months/years, spread over a realistically
// LONGER calendar window at the observed real accumulation rate — remains genuinely open.
// RESEARCH_CLAIM power_analysis_guardrail_stack_inconclusive_20260804. Do not re-run this exact
// script and trust its numbers without first fixing the date-bootstrapping AND the $/pt constant.

import { query } from '../server/db.js';
import { computeCorrectedTarget } from '../server/services/targetCalibrationService.js';

const TYPES_TO_TEST = ['GLOBEX_VWAP_MAGNET_LONG', 'IB_BEARISH'];
const OLD_TARGET = 20;
const OLD_STOP = 20;
const CANDIDATE_TARGET = 22;
const DEFAULT_DPP = 20;
const COMM = 4.14;

async function runAnalysisForType(TYPE) {
  console.log(`\n===========================================`);
  console.log(`Starting analysis for ${TYPE}`);
  const LONG = !TYPE.includes('BEARISH');
  
  const res = await query(`SELECT fired_at, mae_points, mfe_points, actual_pnl FROM active_setups WHERE setup_type = $1 AND origin_status IN ('ACTIVE', 'SHADOW') AND mae_points IS NOT NULL AND mfe_points IS NOT NULL`, [TYPE]);
  const realTrades = res.rows.map(r => ({
    fired_at: new Date(r.fired_at),
    mae: parseFloat(r.mae_points),
    mfe: parseFloat(r.mfe_points),
    actual_pnl: parseFloat(r.actual_pnl)
  }));

  if (realTrades.length === 0) {
    console.log(`No trades found for ${TYPE}`);
    return;
  }

  // Calculate real EV for baseline and candidate
  let pnlBase = 0, pnlCand = 0;
  for (const t of realTrades) {
    pnlBase += (t.mfe >= OLD_TARGET) ? (OLD_TARGET * 20 - COMM) : -(OLD_STOP * 20 + COMM);
    pnlCand += (t.mfe >= CANDIDATE_TARGET) ? (CANDIDATE_TARGET * 20 - COMM) : -(OLD_STOP * 20 + COMM);
  }
  const evBaseReal = pnlBase / realTrades.length;
  const evCandReal = pnlCand / realTrades.length;
  
  const N_VALUES = [20, 50, 100, 200, 350, 500, 750, 1000, 1500];
  const REPS = 200;
  
  console.log(`Real EV Base: $${evBaseReal.toFixed(2)}, Cand: $${evCandReal.toFixed(2)}`);
  
  const deficit = 5 - (evCandReal - evBaseReal);
  
  const frac_20_22 = realTrades.filter(t => t.mfe >= 20 && t.mfe < 22).length / realTrades.length;
  const frac_0_20 = realTrades.filter(t => t.mfe < 20).length / realTrades.length;
  const expectedDiffPerPlant = (frac_20_22 * 840 + frac_0_20 * 40) / (frac_20_22 + frac_0_20);
  
  const probToConvertMissed = (frac_20_22 + frac_0_20) > 0 ? (deficit / expectedDiffPerPlant / (frac_20_22 + frac_0_20)) : 0;
  console.log(`To get +$5 edge, we convert ${probToConvertMissed * 100}% of missed trades to exactly T=22.0.`);

  const resultsPlanted = {};
  const resultsNull = {};
  
  for (const N of N_VALUES) {
    let plantedPasses = 0;
    let nullPasses = 0;
    
    for (let rep = 0; rep < REPS; rep++) {
      for (const isPlanted of [false, true]) {
        // Resample N trades
        const sampledTrades = [];
        for (let i = 0; i < N; i++) {
          const baseTrade = realTrades[Math.floor(Math.random() * realTrades.length)];
          const t = { ...baseTrade };
          // Slightly jitter the timestamp to avoid exact duplicates causing bar lookup issues
          t.fired_at = new Date(t.fired_at.getTime() + i); 
          if (isPlanted && t.mfe < CANDIDATE_TARGET && Math.random() < probToConvertMissed) {
            t.mfe = CANDIDATE_TARGET;
            t.mae = 0;
          }
          sampledTrades.push(t);
        }
        
        const syntheticTrades = [];
        const allBars = [];
        
        for (let i = 0; i < N; i++) {
          const t = sampledTrades[i];
          const mappedFiredAt = t.fired_at;
          
          const entry = 10000 + i * 1000;
          syntheticTrades.push({
            fired_at: mappedFiredAt,
            entry_zone_high: entry,
            entry_zone_low: entry,
            actual_pnl: t.actual_pnl
          });
          
          const ts = mappedFiredAt.getTime();
          let high = entry, low = entry;
          if (!LONG) {
            high = entry + t.mae;
            low = entry - t.mfe;
          } else {
            high = entry + t.mfe;
            low = entry - t.mae;
          }
          allBars.push({ ts: ts + 1000, high, low });
          
          for (let j = 1; j <= 390; j++) {
            allBars.push({ ts: ts + 1000 + j * 60000, high: entry, low: entry });
          }
        }
        
        allBars.sort((a, b) => a.ts - b.ts);
        
        const resObj = computeCorrectedTarget({
          trades: syntheticTrades,
          allBars,
          stop: OLD_STOP,
          oldTarget: OLD_TARGET,
          long: LONG,
          pnlPerPoint: DEFAULT_DPP,
          commission: COMM
        });
        
        const passed = resObj && resObj.bestTarget === CANDIDATE_TARGET && !resObj.exclusionReason;
        
        if (isPlanted) {
          if (passed) { plantedPasses++; }
        } else {
          if (passed) { nullPasses++; }
        }
      }
    }
    
    resultsPlanted[N] = plantedPasses / REPS;
    resultsNull[N] = nullPasses / REPS;
    console.log(`N=${N}: Planted: ${(resultsPlanted[N]*100).toFixed(1)}%, Null: ${(resultsNull[N]*100).toFixed(1)}%`);
  }
  
  console.log(`=== FINAL RESULTS FOR ${TYPE} ===`);
  console.log("N\tPlanted\tNull");
  for (const N of N_VALUES) {
    console.log(`${N}\t${(resultsPlanted[N]*100).toFixed(1)}%\t${(resultsNull[N]*100).toFixed(1)}%`);
  }
}

async function main() {
  for (const t of TYPES_TO_TEST) {
    await runAnalysisForType(t);
  }
  process.exit(0);
}

main().catch(console.error);
