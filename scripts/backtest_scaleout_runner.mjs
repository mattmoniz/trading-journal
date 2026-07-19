import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { DEFAULT_DPP } from './update_optimal_stops.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import fs from 'fs';

const WALK_WINDOW_BARS = 390;
const TRAIL_PERCENTILES = [0.50, 0.65, 0.75, 0.85, 0.90];
const FRACTIONS = [0.5, 0.6, 0.7];
const MIN_N = 20;

function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

async function main() {
  console.log('Loading current live OPTIMAL_STOP...');
  // NOTE: deliberately NOT selecting ev_per_trade here -- that stored value is computed by
  // the old order-blind sweepOptimalTarget() against historically-mismatched mae/mfe data
  // (see the baselineEvents comment below). Only stop/target values are trustworthy from
  // this table; the baseline EV itself is always re-derived by chronological resimulation.
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, optimal_stop, optimal_target
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const optMap = {};
  for (const r of optRes.rows) optMap[r.setup_type] = { stop: parseFloat(r.optimal_stop), target: parseFloat(r.optimal_target) };

  console.log('Loading eligible trades...');
  const tradesRes = await query(`
    SELECT setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, stop_level::float as stop_level,
      t1_level::float as t1_level, actual_pnl::float as actual_pnl, resolution,
      replay_resolution
    FROM active_setups
    WHERE status = 'RESOLVED' AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300 AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const allTrades = tradesRes.rows;

  const byType = {};
  for (const t of allTrades) (byType[t.setup_type] ||= []).push(t);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
  
  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const results = {};
  const setupTypes = Object.keys(byType).filter(st => {
    const ts = byType[st].filter(t => t.replay_resolution === 'TARGET_HIT' || t.resolution === 'TARGET_HIT');
    return optMap[st] && ts.length >= MIN_N;
  });
  console.log(`Sweeping ${setupTypes.length} setup_types...`);
  // Claude audit addition: transparency into the guardrail funnel -- how many setups get
  // rejected at each stage, not just how many survive. Doesn't change simulation results.
  const funnel = { total: setupTypes.length, noPullbackData: 0, thinTail: 0, noPlateauPass: 0, failedOosOrBaseline: 0, notRigorClean: 0, survived: 0 };

  let responseMd = '# Scaleout Runner Test Results\\n\\n';

  for (const setupType of setupTypes) {
    const trades = byType[setupType];
    const { stop, target: originalTarget } = optMap[setupType]; // baselineEv no longer sourced here -- see the properly-resimulated baselineEv computed below
    const direction = inferDirection(setupType);
    if (!direction) continue;
    const long = direction === 'LONG';
    const dpp = DEFAULT_DPP; // Using default $2/pt for simplicity as verified

    const walked = [];
    for (const t of trades) {
      const entry = t.entry_zone_high ?? t.entry_zone_low;
      const startIdx = firstIndexAfter(new Date(t.fired_at).getTime());
      const endIdx = Math.min(allBars.length, startIdx + WALK_WINDOW_BARS);
      if (startIdx >= endIdx) continue;
      walked.push({ trade: t, entry, startIdx, endIdx });
    }
    if (walked.length < MIN_N) continue;

    const pullbacks = [];
    for (const w of walked) {
      // Only target hit trades for pullback distribution
      if (!(w.trade.replay_resolution === 'TARGET_HIT' || w.trade.resolution === 'TARGET_HIT')) continue;
      let maxFav = -Infinity;
      let currentPullback = 0;
      let maxPullbackSinceNewFav = 0;
      for (let i = w.startIdx; i < w.endIdx; i++) {
        const bar = allBars[i];
        const fav = long ? bar.high - w.entry : w.entry - bar.low;
        const adv = long ? w.entry - bar.low : bar.high - w.entry;
        
        if (fav > maxFav) {
          if (maxPullbackSinceNewFav > 0) pullbacks.push(maxPullbackSinceNewFav);
          maxFav = fav;
          maxPullbackSinceNewFav = 0;
        } else {
          const currentAdvFromMax = maxFav - fav;
          if (currentAdvFromMax > maxPullbackSinceNewFav) maxPullbackSinceNewFav = currentAdvFromMax;
        }
      }
    }
    pullbacks.sort((a, b) => a - b);
    if (pullbacks.length === 0) { funnel.noPullbackData++; continue; }

    const trailCandidates = [...new Set(TRAIL_PERCENTILES.map(p => +percentile(pullbacks, p).toFixed(1)))].filter(c => c > 0);
    if (trailCandidates.length === 0) { funnel.noPullbackData++; continue; }

    // Simulate for each (f, trail) on all walked trades
    const simResults = [];
    let t1ReachedTotal = 0;
    // FIXED (Claude audit, 2026-07-19): the baseline used to come from the STORED live
    // OPTIMAL_STOP.ev_per_trade -- computed by the OLD order-blind sweepOptimalTarget()
    // using mae_points/mfe_points captured under whatever stop/target was live when each
    // trade fired historically, which can differ wildly from the CURRENT live stop/target
    // (confirmed for VALUE_AREA_RESPONSIVE_SHORT: historical stop distances ranged
    // 15-28pt+ vs the current live stop of 10pt -- comparing today's stop/target against
    // MAE/MFE truncated at a DIFFERENT historical boundary silently invalidates the
    // number). That made the promotion gate (fullEv > baselineEv) an apples-to-oranges
    // comparison -- caught because VALUE_AREA_RESPONSIVE_SHORT's properly-resimulated true
    // baseline turned out to be +$15.22, not the stored -$1.99, which reverses whether the
    // scale-out config actually clears the bar. Fixed by resimulating the SAME
    // 100%-at-T1 baseline chronologically, from entry, in this same loop (pnlA IS that
    // computation -- it was already being computed and discarded every iteration).
    const baselineEvents = [];

    for (const w of walked) {
      const entry = w.entry;
      const targetPrice = long ? entry + originalTarget : entry - originalTarget;
      const stopPrice = long ? entry - stop : entry + stop;
      let outcomeA = null, outcomeB = null;
      let t1Reached = false;
      let pnlA = null, pnlB = null;

      let runningFav = -Infinity;
      let trailingStop = null;

      for (let i = w.startIdx; i < w.endIdx; i++) {
        const bar = allBars[i];

        // Portion A logic (standard)
        if (outcomeA === null) {
          const tHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
          const sHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
          if (tHit && sHit) outcomeA = 'STOP';
          else if (tHit) outcomeA = 'TARGET';
          else if (sHit) outcomeA = 'STOP';

          if (outcomeA === 'TARGET') { pnlA = originalTarget * dpp; t1Reached = true; runningFav = originalTarget; }
          else if (outcomeA === 'STOP') { pnlA = -stop * dpp; outcomeB = 'STOP'; pnlB = pnlA; }
        }

        // Portion B logic
        if (t1Reached && outcomeB === null) {
          const fav = long ? bar.high - entry : entry - bar.low;
          if (fav > runningFav) {
             runningFav = fav;
          }
          // Trail logic gets applied after we know trail candidates, so we just collect raw path data.
        }
      }

      if (t1Reached) t1ReachedTotal++;
      baselineEvents.push({ date: w.trade.fired_at.toISOString().slice(0, 10), pnl: pnlA === null ? w.trade.actual_pnl : pnlA });
    }

    const baselineSplitIdx = Math.floor(baselineEvents.length * (2 / 3));
    const baselineEv = baselineEvents.reduce((s, e) => s + e.pnl, 0) / baselineEvents.length;
    const baselineOosEv = baselineEvents.slice(baselineSplitIdx).reduce((s, e) => s + e.pnl, 0) / (baselineEvents.length - baselineSplitIdx);

    if (t1ReachedTotal < 15) { funnel.thinTail++; continue; } // Thin-tail gate

    for (const f of FRACTIONS) {
      for (const trail of trailCandidates) {
        let totalEv = 0;
        const events = [];

        for (const w of walked) {
          const entry = w.entry;
          const targetPrice = long ? entry + originalTarget : entry - originalTarget;
          const stopPrice = long ? entry - stop : entry + stop;
          let outcomeA = null, outcomeB = null;
          let pnlA = null, pnlB = null;
          let runningExtreme = -Infinity;
          
          for (let i = w.startIdx; i < w.endIdx; i++) {
            const bar = allBars[i];
            const tHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
            const sHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
            
            if (outcomeA === null) {
              if (tHit && sHit) outcomeA = 'STOP';
              else if (tHit) outcomeA = 'TARGET';
              else if (sHit) outcomeA = 'STOP';
              
              if (outcomeA === 'TARGET') { pnlA = originalTarget * dpp; }
              else if (outcomeA === 'STOP') { pnlA = -stop * dpp; outcomeB = 'STOP'; pnlB = pnlA; }
            }

            if (outcomeA === 'TARGET' && outcomeB === null) {
               const high = bar.high, low = bar.low;
               if (runningExtreme === -Infinity) {
                  runningExtreme = long ? high : low;
               } else {
                  if (long && high > runningExtreme) runningExtreme = high;
                  if (!long && low < runningExtreme) runningExtreme = low;
               }
               const trailingStopPx = long ? runningExtreme - trail : runningExtreme + trail;
               const trHit = long ? low <= trailingStopPx : high >= trailingStopPx;
               if (trHit) {
                  outcomeB = 'TRAIL_STOP';
                  pnlB = (long ? trailingStopPx - entry : entry - trailingStopPx) * dpp;
               }
            }
          }
          
          if (pnlA === null) pnlA = w.trade.actual_pnl;
          if (outcomeA === 'TARGET' && outcomeB === null) pnlB = w.trade.actual_pnl; // fell through
          else if (pnlB === null) pnlB = w.trade.actual_pnl;

          const tradeEv = f * pnlA + (1 - f) * pnlB;
          totalEv += tradeEv;
          events.push({ date: w.trade.fired_at.toISOString().split('T')[0], pnl: tradeEv, tradeEv, originalEv: w.trade.actual_pnl });
        }
        
        const ev = totalEv / walked.length;
        simResults.push({ f, trail, ev, events });
      }
    }

    // Split for OOS
    const numWalked = walked.length;
    const splitIdx = Math.floor(numWalked * (2/3));
    
    // Find best in-sample
    let bestInSample = null;
    for (const res of simResults) {
      const isEv = res.events.slice(0, splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / splitIdx;
      if (!bestInSample || isEv > bestInSample.isEv) {
        bestInSample = { ...res, isEv };
      }
    }
    
    // Plateau check
    let plateauPassed = false;
    if (bestInSample) {
       const b_f = bestInSample.f;
       const b_t = bestInSample.trail;
       let fIdx = FRACTIONS.indexOf(b_f);
       let tIdx = trailCandidates.indexOf(b_t);
       
       const neighbors = [];
       if (fIdx > 0) neighbors.push(simResults.find(r => r.f === FRACTIONS[fIdx-1] && r.trail === b_t));
       if (fIdx < FRACTIONS.length - 1) neighbors.push(simResults.find(r => r.f === FRACTIONS[fIdx+1] && r.trail === b_t));
       if (tIdx > 0) neighbors.push(simResults.find(r => r.f === b_f && r.trail === trailCandidates[tIdx-1]));
       if (tIdx < trailCandidates.length - 1) neighbors.push(simResults.find(r => r.f === b_f && r.trail === trailCandidates[tIdx+1]));
       
       plateauPassed = neighbors.every(n => n && n.events.slice(0, splitIdx).reduce((acc, e) => acc + e.tradeEv, 0)/splitIdx > 0);
    }
    
    if (bestInSample && plateauPassed) {
       const oosEv = bestInSample.events.slice(splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / (numWalked - splitIdx);
       const fullEv = bestInSample.ev;

       // Promotion bar now requires beating the baseline BOTH full-sample AND
       // out-of-sample (apples-to-apples -- both numbers come from the same
       // chronological resimulation and the same first-2/3/last-1/3 split).
       if (oosEv > 0 && fullEv > baselineEv && oosEv > baselineOosEv) {
           const rigor = computeRigor(bestInSample.events, { dateField: 'date', pnlFn: e => e.pnl });
           if (rigor.clean) {
             results[setupType] = { f: bestInSample.f, trail: bestInSample.trail, baselineEv, baselineOosEv, fullEv, isEv: bestInSample.isEv, oosEv, t1Reached: t1ReachedTotal, rigor };
             responseMd += `### ${setupType}\n- **T1 Reach Count**: ${t1ReachedTotal}\n- **Best Config**: Fraction=${bestInSample.f}, Trail=${bestInSample.trail}pt\n- **Baseline EV (100% T1, full)**: $${baselineEv.toFixed(2)}\n- **Baseline EV (100% T1, OOS)**: $${baselineOosEv.toFixed(2)}\n- **In-Sample EV (first 2/3)**: $${bestInSample.isEv.toFixed(2)}\n- **OOS EV (last 1/3)**: $${oosEv.toFixed(2)}\n- **Full Blended EV**: $${fullEv.toFixed(2)}\n\n`;
             funnel.survived++;
           } else funnel.notRigorClean++;
       } else funnel.failedOosOrBaseline++;
    } else if (bestInSample) funnel.noPlateauPass++;
  }
  console.log('Guardrail funnel:', JSON.stringify(funnel));
  
  if (Object.keys(results).length === 0) {
      responseMd += "No setup types survived the overfitting guardrails (thin-tail gate, plateau check, OOS check, rigor clean). Nothing survives.\\n";
  }

  fs.writeFileSync('scratch/antigravity_response.md', responseMd);
  console.log('Done, wrote results to scratch/antigravity_response.md');
  
  // Optionally insert to DB
  // FIXED (Claude audit, 2026-07-19): was new Date().toISOString().split('T')[0] -- the
  // exact forbidden pattern this codebase's own hard rule warns about (JS UTC date vs the
  // DB's ET-based trading day; the two disagree once past 8PM ET). Use CURRENT_DATE instead.
  const todayRow = await query(`SELECT CURRENT_DATE::text as d`);
  const today = todayRow.rows[0].d;
  for (const [st, r] of Object.entries(results)) {
     await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'SCALEOUT_RUNNER_TEST', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, st, r.t1Reached, r.fullEv, JSON.stringify(r)]);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
