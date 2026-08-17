// diagnose_chronological_stop_target_bias.mjs — one-off diagnostic (not scheduled), 2026-08-04.
//
// Investigates whether update_optimal_stops.mjs's confirmed order-blindness bug (its EV formula
// checks mae>stop BEFORE mfe>=target with no chronological ordering, empirically confirmed to
// understate tight-stop EV specifically) explains the 0.70(all-types)/1.16(live-types) median
// stop:target ratio gap. Does a joint stop+target chronological bar-walk (reusing
// makeBarIndex/WALK_WINDOW_BARS from targetCalibrationService.js, not reimplemented) for the 9
// currently-live setup_types, with the SAME guardrail stack computeCorrectedTarget() already
// uses (thin-tail floor, chronological OOS split, baseline comparison walked the same way — not
// read from a stored column, computeRigor clean check).
//
// RESULT (RESEARCH_CLAIM chronological_stop_target_correction_data_limited_20260804): 0 of 9
// live types produce a validated corrected pair under the full guardrail stack — every one fails
// at least one guardrail, matching production reality (computeCorrectedTarget() also currently
// fails for all 9 live types, 100% fallback to the unguarded base sweep). An earlier pass that
// dropped the OOS/rigor guardrails "to observe the raw chronological preference" showed the
// ratio WIDEN (1.06->1.50) — that result was a confound (comparing a guarded baseline against
// an unguarded corrected method) and does not survive a properly guardrail-matched comparison.
// Conclusion: the order-blindness bug is real, but current data volume for these 9 types cannot
// yet PROVE what the corrected stop/target should be. Re-run once real forward N grows
// meaningfully for these types (data accumulates automatically via the standard weekly
// SETUP_STATUS/OPTIMAL_STOP cadence — this script itself is not on that cron, by design, since
// re-running it on unchanged/barely-changed data wastes compute; re-invoke manually when
// revisiting this thread).

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { makeBarIndex, WALK_WINDOW_BARS } from '../server/services/targetCalibrationService.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const TARGET_SWEEP = [10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 100, 120, 150];
const DEFAULT_DPP = LIVE_INSTRUMENT.dollarsPerPoint;

async function main() {
  const targetTypes = [
    'FAILED_AUCTION_LONG', 'GLOBEX_VWAP_MAGNET_LONG', 'GLOBEX_VWAP_MAGNET_SHORT',
    'IB_BEARISH', 'IB_BULLISH', 'IB_MID_SCALP_FADE_LONG', 'STOP_SWEEP_LONG',
    'VWAP_MAGNET_LONG', 'VWAP_MAGNET_SHORT'
  ];

  const typesList = targetTypes.map(t => `'${t}'`).join(',');

  const auditRes = await query(`
    SELECT signal_name as setup_type, optimal_stop, optimal_target
    FROM performance_audit
    WHERE signal_type = 'OPTIMAL_STOP' AND signal_name IN (${typesList})
  `);
  const currentAudit = {};
  for (const r of auditRes.rows) {
    currentAudit[r.setup_type] = {
      stop: parseFloat(r.optimal_stop),
      target: parseFloat(r.optimal_target)
    };
  }

  const statsRes = await query(`
    SELECT
      setup_type, COUNT(*) as n,
      PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY mae_points) as p25_mae,
      PERCENTILE_CONT(0.40) WITHIN GROUP (ORDER BY mae_points) as p40_mae,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mae_points) as p50_mae,
      PERCENTILE_CONT(0.60) WITHIN GROUP (ORDER BY mae_points) as p60_mae,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mae_points) as p75_mae,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mfe_points) as p75_mfe
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND status = 'RESOLVED' AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND setup_type IN (${typesList})
    GROUP BY setup_type
  `);
  const stats = {};
  for (const r of statsRes.rows) {
    stats[r.setup_type] = {
      n: parseInt(r.n),
      p25_mae: parseFloat(r.p25_mae),
      p40_mae: parseFloat(r.p40_mae),
      p50_mae: parseFloat(r.p50_mae),
      p60_mae: parseFloat(r.p60_mae),
      p75_mae: parseFloat(r.p75_mae),
      p75_mfe: parseFloat(r.p75_mfe)
    };
  }

  const rawResExpanded = await query(`
    SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float,
      fired_at, entry_zone_low::float, entry_zone_high::float
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
      AND origin_status IN ('ACTIVE', 'SHADOW')
      AND setup_type IN (${typesList})
    ORDER BY fired_at ASC
  `);
  const rawByTypeExpanded = {};
  for (const t of rawResExpanded.rows) (rawByTypeExpanded[t.setup_type] ||= []).push(t);

  const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close }));
  const firstIndexAfter = makeBarIndex(allBars);

  const resultsUnguarded = [];
  const resultsGuarded = [];
  
  for (const type of targetTypes) {
    const direction = inferDirection(type);
    const trades = rawByTypeExpanded[type] || [];
    const audit = currentAudit[type];
    const stat = stats[type];
    if (!direction || trades.length < 20 || !audit || !stat) continue;
    
    const long = direction === 'LONG';
    const walked = [];
    for (const t of trades) {
      const entry = t.entry_zone_high ?? t.entry_zone_low;
      const startIdx = firstIndexAfter(new Date(t.fired_at).getTime());
      const endIdx = Math.min(allBars.length, startIdx + WALK_WINDOW_BARS);
      if (startIdx >= endIdx) continue;
      walked.push({ trade: t, entry, startIdx, endIdx });
    }
    
    if (walked.length < 20) continue;
    
    // Compute Baseline EV
    let baselineEvents = [];
    for (const w of walked) {
      const targetPrice = long ? w.entry + audit.target : w.entry - audit.target;
      const stopPrice = long ? w.entry - audit.stop : w.entry + audit.stop;
      let outcome = null;
      for (let i = w.startIdx; i < w.endIdx; i++) {
        const bar = allBars[i];
        const targetHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
        const stopHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
        if (targetHit && stopHit) { outcome = 'STOP'; break; }
        if (targetHit) { outcome = 'TARGET'; break; }
        if (stopHit) { outcome = 'STOP'; break; }
      }
      let pnl;
      if (outcome === 'TARGET') pnl = audit.target * DEFAULT_DPP - LIVE_INSTRUMENT.commissionPerRoundTrip;
      else if (outcome === 'STOP') pnl = -(audit.stop * DEFAULT_DPP + LIVE_INSTRUMENT.commissionPerRoundTrip);
      else pnl = w.trade.actual_pnl;
      baselineEvents.push({ date: w.trade.fired_at.toISOString().slice(0,10), pnl });
    }
    const baselineEv = baselineEvents.reduce((a, b) => a + b.pnl, 0) / walked.length;

    const p75mfe = Math.round(stat.p75_mfe || 35);
    const targetCandidates = TARGET_SWEEP.filter(t => t <= p75mfe);
    const stopCandRaw = [
      { value: stat.p25_mae, pct: 0.25 },
      { value: stat.p40_mae, pct: 0.40 },
      { value: stat.p50_mae, pct: 0.50 },
      { value: stat.p60_mae, pct: 0.60 },
      { value: stat.p75_mae, pct: 0.75 }
    ].filter(c => !isNaN(c.value) && c.value > 0);
    
    const stopCandidates = [];
    for (const { value, pct } of stopCandRaw) {
      const requiredN = Math.ceil(20 / (1 - pct));
      if (trades.length >= requiredN) {
        stopCandidates.push(Math.round(value));
      }
    }
    
    let bestCandUnguarded = null;
    let maxEvUnguarded = -Infinity;

    let bestCandGuarded = null;
    let maxEvGuarded = -Infinity;
    
    const splitIdx = Math.floor(walked.length * (2 / 3));

    for (const S of stopCandidates) {
      for (const T of targetCandidates) {
        const events = [];
        let targetHits = 0;
        for (const w of walked) {
          const targetPrice = long ? w.entry + T : w.entry - T;
          const stopPrice = long ? w.entry - S : w.entry + S;
          let outcome = null;
          for (let i = w.startIdx; i < w.endIdx; i++) {
            const bar = allBars[i];
            const targetHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
            const stopHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
            if (targetHit && stopHit) { outcome = 'STOP'; break; }
            if (targetHit) { outcome = 'TARGET'; break; }
            if (stopHit) { outcome = 'STOP'; break; }
          }
          let pnl;
          if (outcome === 'TARGET') { pnl = T * DEFAULT_DPP - LIVE_INSTRUMENT.commissionPerRoundTrip; targetHits++; }
          else if (outcome === 'STOP') pnl = -(S * DEFAULT_DPP + LIVE_INSTRUMENT.commissionPerRoundTrip);
          else pnl = w.trade.actual_pnl;
          events.push({ date: w.trade.fired_at.toISOString().slice(0,10), pnl });
        }
        
        if (targetHits < 15) continue; // thin-tail guardrail

        const fullEv = events.reduce((a, b) => a + b.pnl, 0) / walked.length;
        
        // Unguarded
        if (fullEv > maxEvUnguarded) {
          maxEvUnguarded = fullEv;
          bestCandUnguarded = { S, T, fullEv };
        }

        // Guarded
        const oosSlice = events.slice(splitIdx);
        const oosEv = oosSlice.reduce((a, b) => a + b.pnl, 0) / (walked.length - splitIdx);
        
        if (oosEv > 0 && fullEv > baselineEv) {
           const rigor = computeRigor(events, { pnlFn: e => e.pnl });
           if (rigor.clean) {
             if (fullEv > maxEvGuarded) {
               maxEvGuarded = fullEv;
               bestCandGuarded = { S, T, fullEv };
             }
           }
        }
      }
    }
    
    const corrSUng = bestCandUnguarded ? bestCandUnguarded.S : null;
    const corrTUng = bestCandUnguarded ? bestCandUnguarded.T : null;

    resultsUnguarded.push({
      setup: type,
      curr_stop: audit.stop,
      curr_target: audit.target,
      curr_ratio: audit.stop > 0 ? audit.stop / audit.target : 0,
      corr_stop: corrSUng,
      corr_target: corrTUng,
      corr_ratio: corrSUng && corrTUng ? corrSUng / corrTUng : null
    });

    const corrSGuarded = bestCandGuarded ? bestCandGuarded.S : null;
    const corrTGuarded = bestCandGuarded ? bestCandGuarded.T : null;

    resultsGuarded.push({
      setup: type,
      curr_stop: audit.stop,
      curr_target: audit.target,
      curr_ratio: audit.stop > 0 ? audit.stop / audit.target : 0,
      corr_stop: corrSGuarded,
      corr_target: corrTGuarded,
      corr_ratio: corrSGuarded && corrTGuarded ? corrSGuarded / corrTGuarded : null
    });
  }
  
  function getMedianRatio(res) {
    const ratios = res.map(r => r.corr_ratio).filter(x => x !== null).sort((a,b) => a-b);
    if (!ratios.length) return null;
    const mid = Math.floor(ratios.length / 2);
    return ratios.length % 2 !== 0 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  }

  function printTable(title, results) {
    console.log(`\n=== ${title} ===`);
    console.log("Setup | Curr S | Curr T | Curr Ratio | Corr S | Corr T | Corr Ratio | Delta");
    for (const r of results) {
      if (r.corr_ratio === null) {
        console.log(`${r.setup.padEnd(25)} | ${r.curr_stop} | ${r.curr_target} | ${r.curr_ratio.toFixed(2)} | NULL | NULL | NULL | NULL`);
      } else {
        console.log(`${r.setup.padEnd(25)} | ${r.curr_stop} | ${r.curr_target} | ${r.curr_ratio.toFixed(2)} | ${r.corr_stop} | ${r.corr_target} | ${r.corr_ratio.toFixed(2)} | ${(r.corr_ratio - r.curr_ratio).toFixed(2)}`);
      }
    }
    const median = getMedianRatio(results);
    console.log(`\nMedian Corr Ratio: ${median ? median.toFixed(2) : 'NULL'}`);
  }

  printTable("Table A (Unguarded)", resultsUnguarded);
  printTable("Table B (Guarded)", resultsGuarded);
}

main().catch(console.error);
