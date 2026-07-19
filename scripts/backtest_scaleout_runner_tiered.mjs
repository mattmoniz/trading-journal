import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
function exactPnl(entry, exitPrice, long) {
  const signedPoints = long ? (exitPrice - entry) : (entry - exitPrice);
  return signedPoints * PNL_PER_POINT - COMMISSION;
}

const WALK_WINDOW_BARS = 390;
const TRAIL_PERCENTILES_A = [0.25, 0.35, 0.50];
const TRAIL_PERCENTILES_B = [0.65, 0.75, 0.85, 0.90, 0.95];
const FRACTIONS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const MIN_N = 20;

function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

async function main() {
  console.log('Loading current live OPTIMAL_STOP...');
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, optimal_stop, optimal_target
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const optMap = {};
  for (const r of optRes.rows) optMap[r.setup_type] = { stop: parseFloat(r.optimal_stop), target: parseFloat(r.optimal_target) };

  console.log('Loading corroborating evidence...');
  const postResSeqRes = await query(`SELECT signal_name, notes FROM performance_audit WHERE signal_type='POST_RES_SEQ'`);
  const postResSeqMap = {};
  for (const r of postResSeqRes.rows) {
    postResSeqMap[r.signal_name] = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes;
  }

  const levelContRes = await query(`SELECT signal_name, notes FROM performance_audit WHERE signal_type='LEVEL_CONTINUATION'`);
  const levelContMap = {};
  for (const r of levelContRes.rows) {
    levelContMap[r.signal_name] = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes;
  }

  function getLevelCont(setupType) {
    if (levelContMap[setupType]) return levelContMap[setupType];
    // try prefix
    for (const k of Object.keys(levelContMap)) {
      if (setupType.startsWith(k)) return levelContMap[k];
    }
    return null;
  }

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

  const barRangeRes = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high-low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
  const MIN_TRAIL_WIDTH = parseFloat(barRangeRes.rows[0].median_range);
  const MIN_TIGHT_TRAIL = 2 * MIN_TRAIL_WIDTH;
  console.log(`Median 1-min NQ bar range: ${MIN_TRAIL_WIDTH.toFixed(2)}pt`);
  console.log(`Tier A (snug) floor (2x median): ${MIN_TIGHT_TRAIL.toFixed(2)}pt`);
  console.log(`Tier B (runner) floor: ${MIN_TRAIL_WIDTH.toFixed(2)}pt`);

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const results = { A: {}, B: {} };
  const setupTypes = Object.keys(byType).filter(st => {
    const ts = byType[st].filter(t => t.replay_resolution === 'TARGET_HIT' || t.resolution === 'TARGET_HIT');
    return optMap[st] && ts.length >= MIN_N;
  });
  console.log(`Sweeping ${setupTypes.length} setup_types...`);
  
  const funnel = { A: { total: setupTypes.length, noPullbackData: 0, thinTail: 0, noPlateauPass: 0, failedOosOrBaseline: 0, notRigorClean: 0, survived: 0 }, 
                   B: { total: setupTypes.length, noPullbackData: 0, thinTail: 0, noPlateauPass: 0, failedOosOrBaseline: 0, notRigorClean: 0, survived: 0 } };

  let responseMd = '# Scaleout Runner Test Results (Tiered)\n\n';

  for (const tier of ['A', 'B']) {
    responseMd += `## Tier ${tier} (${tier === 'A' ? 'Snug Trail / Take-a-little-extra' : 'Real Runner / Continuation Capture'})\n\n`;
    if (tier === 'A') responseMd += `*Note: Marginal/execution-risk-sensitive. Floor set to 2x median bar range (${MIN_TIGHT_TRAIL.toFixed(2)}pt).* \n\n`;
    
    for (const setupType of setupTypes) {
      const trades = byType[setupType];
      const { stop, target: originalTarget } = optMap[setupType];
      const direction = inferDirection(setupType);
      if (!direction) continue;
      const long = direction === 'LONG';

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
      if (pullbacks.length === 0) { funnel[tier].noPullbackData++; continue; }

      const percentiles = tier === 'A' ? TRAIL_PERCENTILES_A : TRAIL_PERCENTILES_B;
      const minTrail = tier === 'A' ? MIN_TIGHT_TRAIL : MIN_TRAIL_WIDTH;
      const trailCandidates = [...new Set(percentiles.map(p => +percentile(pullbacks, p).toFixed(1)))].filter(c => c >= minTrail);
      
      if (trailCandidates.length === 0) { funnel[tier].noPullbackData++; continue; }

      const simResults = [];
      let t1ReachedTotal = 0;
      const baselineEvents = [];

      for (const w of walked) {
        const entry = w.entry;
        const targetPrice = long ? entry + originalTarget : entry - originalTarget;
        const stopPrice = long ? entry - stop : entry + stop;
        let outcomeA = null, outcomeB = null;
        let t1Reached = false;
        let pnlA = null, pnlB = null;
        let runningFav = -Infinity;

        for (let i = w.startIdx; i < w.endIdx; i++) {
          const bar = allBars[i];
          if (outcomeA === null) {
            const tHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
            const sHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
            if (tHit && sHit) outcomeA = 'STOP';
            else if (tHit) outcomeA = 'TARGET';
            else if (sHit) outcomeA = 'STOP';

            if (outcomeA === 'TARGET') { pnlA = exactPnl(entry, targetPrice, long); t1Reached = true; runningFav = originalTarget; }
            else if (outcomeA === 'STOP') { pnlA = exactPnl(entry, stopPrice, long); outcomeB = 'STOP'; pnlB = pnlA; }
          }
          if (t1Reached && outcomeB === null) {
            const fav = long ? bar.high - entry : entry - bar.low;
            if (fav > runningFav) runningFav = fav;
          }
        }

        if (t1Reached) t1ReachedTotal++;
        baselineEvents.push({ date: w.trade.fired_at.toISOString().slice(0, 10), pnl: pnlA === null ? w.trade.actual_pnl : pnlA });
      }

      const baselineSplitIdx = Math.floor(baselineEvents.length * (2 / 3));
      const baselineEv = baselineEvents.reduce((s, e) => s + e.pnl, 0) / baselineEvents.length;
      const baselineOosEv = baselineEvents.slice(baselineSplitIdx).reduce((s, e) => s + e.pnl, 0) / (baselineEvents.length - baselineSplitIdx);

      if (t1ReachedTotal < 15) { funnel[tier].thinTail++; continue; }

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
                
                if (outcomeA === 'TARGET') { pnlA = exactPnl(entry, targetPrice, long); }
                else if (outcomeA === 'STOP') { pnlA = exactPnl(entry, stopPrice, long); outcomeB = 'STOP'; pnlB = pnlA; }
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
                    pnlB = exactPnl(entry, trailingStopPx, long);
                 }
              }
            }
            
            if (pnlA === null) pnlA = w.trade.actual_pnl;
            if (outcomeA === 'TARGET' && outcomeB === null) pnlB = w.trade.actual_pnl;
            else if (pnlB === null) pnlB = w.trade.actual_pnl;

            const tradeEv = f * pnlA + (1 - f) * pnlB;
            totalEv += tradeEv;
            events.push({ date: w.trade.fired_at.toISOString().split('T')[0], pnl: tradeEv, tradeEv, originalEv: w.trade.actual_pnl });
          }
          
          const ev = totalEv / walked.length;
          simResults.push({ f, trail, ev, events });
        }
      }

      const numWalked = walked.length;
      const splitIdx = Math.floor(numWalked * (2/3));
      
      let bestInSample = null;
      for (const res of simResults) {
        const isEv = res.events.slice(0, splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / splitIdx;
        if (!bestInSample || isEv > bestInSample.isEv) {
          bestInSample = { ...res, isEv };
        }
      }
      
      let plateauPassed = false;
      let fractionNeighborsNotes = "";
      if (bestInSample) {
         const b_f = bestInSample.f;
         const b_t = bestInSample.trail;
         let fIdx = FRACTIONS.indexOf(b_f);
         let tIdx = trailCandidates.indexOf(b_t);
         
         const neighbors = [];
         const fracNeighbors = [];
         
         if (fIdx > 0) {
           const n = simResults.find(r => r.f === FRACTIONS[fIdx-1] && r.trail === b_t);
           neighbors.push(n);
           if (n) fracNeighbors.push(n);
         }
         if (fIdx < FRACTIONS.length - 1) {
           const n = simResults.find(r => r.f === FRACTIONS[fIdx+1] && r.trail === b_t);
           neighbors.push(n);
           if (n) fracNeighbors.push(n);
         }
         if (tIdx > 0) neighbors.push(simResults.find(r => r.f === b_f && r.trail === trailCandidates[tIdx-1]));
         if (tIdx < trailCandidates.length - 1) neighbors.push(simResults.find(r => r.f === b_f && r.trail === trailCandidates[tIdx+1]));
         
         plateauPassed = neighbors.every(n => n && n.events.slice(0, splitIdx).reduce((acc, e) => acc + e.tradeEv, 0)/splitIdx > 0);
         
         const getOosEv = (events) => events.slice(splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / (events.length - splitIdx);
         fractionNeighborsNotes = fracNeighbors.map(n => `f=${n.f}: IS $${(n.events.slice(0, splitIdx).reduce((acc, e) => acc + e.tradeEv, 0)/splitIdx).toFixed(2)} OOS $${getOosEv(n.events).toFixed(2)}`).join(", ");
      }
      
      if (bestInSample && plateauPassed) {
         const oosEv = bestInSample.events.slice(splitIdx).reduce((acc, e) => acc + e.tradeEv, 0) / (numWalked - splitIdx);
         const fullEv = bestInSample.ev;

         if (oosEv > 0 && fullEv > baselineEv && oosEv > baselineOosEv) {
             const rigor = computeRigor(bestInSample.events, { dateField: 'date', pnlFn: e => e.pnl });
             if (rigor.clean) {
               results[tier][setupType] = { f: bestInSample.f, trail: bestInSample.trail, baselineEv, baselineOosEv, fullEv, isEv: bestInSample.isEv, oosEv, t1Reached: t1ReachedTotal, rigor };
               
               let corroboration = "";
               if (tier === 'B') {
                 const postSeq = postResSeqMap[`TARGET_${setupType}`.slice(0, 60)];
                 const lvlCont = getLevelCont(setupType);
                 corroboration += `\n- **Corroborating Evidence**:`;
                 if (postSeq) corroboration += `\n  - POST_RES_SEQ (TARGET_HIT): favFirstPct=${postSeq.favFirstPct}%, avgEfficiency=${postSeq.avgEfficiency}%`;
                 else corroboration += `\n  - POST_RES_SEQ (TARGET_HIT): None found`;
                 
                 if (lvlCont) corroboration += `\n  - LEVEL_CONTINUATION: bigContinuationPct=${lvlCont.bigContinuationPct}%, avgExtension=${lvlCont.avgExtension}pt`;
                 else corroboration += `\n  - LEVEL_CONTINUATION: None found`;
               }
               
               responseMd += `### ${setupType}\n- **T1 Reach Count**: ${t1ReachedTotal}\n- **Best Config**: Fraction=${bestInSample.f}, Trail=${bestInSample.trail}pt\n- **Baseline EV (100% T1, full)**: $${baselineEv.toFixed(2)}\n- **Baseline EV (100% T1, OOS)**: $${baselineOosEv.toFixed(2)}\n- **In-Sample EV (first 2/3)**: $${bestInSample.isEv.toFixed(2)}\n- **OOS EV (last 1/3)**: $${oosEv.toFixed(2)}\n- **Full Blended EV**: $${fullEv.toFixed(2)}\n- **2D Grid Fraction Neighbors**: ${fractionNeighborsNotes}${corroboration}\n\n`;
               funnel[tier].survived++;
             } else funnel[tier].notRigorClean++;
         } else funnel[tier].failedOosOrBaseline++;
      } else if (bestInSample) funnel[tier].noPlateauPass++;
    }
    if (Object.keys(results[tier]).length === 0) {
      responseMd += `No setup types survived Tier ${tier}.\n\n`;
    }
  }

  console.log('Guardrail funnel Tier A:', JSON.stringify(funnel.A));
  console.log('Guardrail funnel Tier B:', JSON.stringify(funnel.B));
  
  fs.writeFileSync('scratch/antigravity_response.md', responseMd);
  console.log('Done, wrote results to scratch/antigravity_response.md');
  
  const todayRow = await query(`SELECT CURRENT_DATE::text as d`);
  const today = todayRow.rows[0].d;
  
  const allSurvivorNames = [];
  for (const tier of ['A', 'B']) {
    for (const [st, r] of Object.entries(results[tier])) {
       const signalName = `${tier}_${st}`;
       allSurvivorNames.push(signalName);
       await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
        VALUES ($1, 0, 'SCALEOUT_TIERED_TEST', $2, $3, $4, $5)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
          SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
      `, [today, signalName, r.t1Reached, r.fullEv, JSON.stringify(r)]);
    }
  }
  
  const staleRes = await query(`
    DELETE FROM performance_audit WHERE signal_type='SCALEOUT_TIERED_TEST' AND NOT (signal_name = ANY($1))
    RETURNING signal_name
  `, [allSurvivorNames]);
  if (staleRes.rows.length) console.log(`Cleaned up ${staleRes.rows.length} stale row(s) no longer surviving: ${staleRes.rows.map(r => r.signal_name).join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
