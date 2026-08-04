import { query } from '../server/db.js';
import { recordClaim } from './record_claim.mjs';
import { 
  WALK_WINDOW_BARS, TRAIL_PERCENTILES_A, TRAIL_PERCENTILES_B, MIN_N, 
  percentile, firstIndexAfter, exactPnl 
} from './lib/breakevenTrailCore.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

async function main() {
  // ORDER BY fired_at ASC is load-bearing, not cosmetic -- the IS/OOS split below (`walked`
  // sliced at 2/3) assumes `walked` is in chronological order. A bare SELECT with no ORDER BY
  // has no guaranteed row order in Postgres; verified directly (2026-08-04 audit) that this
  // query's natural scan order does NOT match chronological fired_at order for this table, so
  // the original version of this script silently ran the "IS/OOS" split on an arbitrary subset,
  // not a real walk-forward split -- exactly the "no lookahead in backtests" hard rule this
  // codebase has flagged as a recurring bug class elsewhere.
  const { rows: trades } = await query(`
    SELECT id, trade_date::text as trade_date, fired_at, entry_zone_low, entry_zone_high, resolution, replay_resolution, actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND is_rth = true
      AND setup_type = 'IB_BEARISH'
    ORDER BY fired_at ASC
  `);
  
  const { rows: barRows } = await query(`
    SELECT ts, high::float as high, low::float as low, close::float as close
    FROM price_bars_primary
    WHERE symbol = 'NQ'
    ORDER BY ts ASC
  `);
  
  const allBars = barRows.map(b => ({ ...b, dateObj: new Date(b.ts) }));
  
  const ranges = allBars.map(b => b.high - b.low).sort((a,b) => a-b);
  const minTrailWidth = ranges[Math.floor(ranges.length / 2)];
  const minTightTrail = minTrailWidth * 2;
  
  const long = false; // IB_BEARISH
  const stop = 53;
  const originalTarget = 50;
  
  const walked = [];
  for (const t of trades) {
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    const startIdx = firstIndexAfter(allBars, new Date(t.fired_at).getTime());
    const endIdx = Math.min(allBars.length, startIdx + WALK_WINDOW_BARS);
    if (startIdx >= endIdx) continue;
    walked.push({ trade: t, entry, startIdx, endIdx });
  }
  
  if (walked.length < MIN_N) {
    console.log('Failed: MIN_N gate');
    process.exit(0);
  }
  
  const pullbacks = [];
  for (const w of walked) {
    if (!(w.trade.replay_resolution === 'TARGET_HIT' || w.trade.resolution === 'TARGET_HIT')) continue;
    let maxFav = -Infinity;
    let maxPullbackSinceNewFav = 0;
    for (let i = w.startIdx; i < w.endIdx; i++) {
      const bar = allBars[i];
      const fav = long ? bar.high - w.entry : w.entry - bar.low;
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
  
  // Create candidates (using both A and B for search just to sweep, or just B as standard wide trail? 
  // Let's use both sets and combine them to "sweep").
  const percentiles = [...TRAIL_PERCENTILES_A, ...TRAIL_PERCENTILES_B];
  const trailCandidates = [...new Set(percentiles.map(p => +percentile(pullbacks, p).toFixed(1)))].filter(c => c >= minTrailWidth).sort((a,b)=>a-b);
  
  let t1ReachedTotal = 0;
  const baselineEvents = [];
  
  // Baseline resimulation
  for (const w of walked) {
    const entry = w.entry;
    const targetPrice = long ? entry + originalTarget : entry - originalTarget;
    const stopPrice = long ? entry - stop : entry + stop;
    let outcomeA = null;
    let t1Reached = false;
    let pnlA = null;

    for (let i = w.startIdx; i < w.endIdx; i++) {
      const bar = allBars[i];
      if (outcomeA === null) {
        const tHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
        const sHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
        if (tHit && sHit) outcomeA = 'STOP';
        else if (tHit) outcomeA = 'TARGET';
        else if (sHit) outcomeA = 'STOP';

        if (outcomeA === 'TARGET') { pnlA = exactPnl(entry, targetPrice, long); t1Reached = true; }
        else if (outcomeA === 'STOP') { pnlA = exactPnl(entry, stopPrice, long); }
      }
    }
    if (outcomeA === null) {
      pnlA = exactPnl(entry, allBars[w.endIdx - 1].close, long);
    }
    if (t1Reached) t1ReachedTotal++;
    baselineEvents.push({ date: w.trade.fired_at.toISOString().slice(0, 10), pnl: pnlA });
  }
  
  if (t1ReachedTotal < 15) {
    console.log(`Failed: t1ReachedTotal < 15 (got ${t1ReachedTotal})`);
    await recordClaim({
      slug: 'ib_bearish_2of3_1of3_runner_pilot',
      claimText: `Failed thin tail gate: only ${t1ReachedTotal} reached original target.`,
      sourceFile: 'scripts/pilot_ib_bearish_2of3_target_1of3_trail.mjs'
    });
    process.exit(0);
  }
  
  const baselineSplitIdx = Math.floor(baselineEvents.length * (2 / 3));
  const baselineEv = baselineEvents.reduce((s, e) => s + e.pnl, 0) / baselineEvents.length;
  const baselineIsEv = baselineEvents.slice(0, baselineSplitIdx).reduce((s, e) => s + e.pnl, 0) / baselineSplitIdx;
  const baselineOosEv = baselineEvents.slice(baselineSplitIdx).reduce((s, e) => s + e.pnl, 0) / (baselineEvents.length - baselineSplitIdx);
  
  console.log(`Baseline IS: $${baselineIsEv.toFixed(2)} | OOS: $${baselineOosEv.toFixed(2)} | Full: $${baselineEv.toFixed(2)}`);
  
  const simResults = [];
  
  for (const trail of trailCandidates) {
    let totalEv = 0;
    const events = [];
    
    for (const w of walked) {
      const entry = w.entry;
      const targetPrice = long ? entry + originalTarget : entry - originalTarget;
      let currentStopPrice = long ? entry - stop : entry + stop;
      let outcome = null;
      let pnl = null;
      let runningExtreme = -Infinity;
      let targetHit = false;
      let pnlAtOriginalTarget = 0;
      let pnlOfTrailedRemainder = 0;

      for (let i = w.startIdx; i < w.endIdx; i++) {
        const bar = allBars[i];

        const hours = bar.dateObj.getUTCHours();
        const mins = bar.dateObj.getUTCMinutes();
        let sessionEnd = false;
        if (i === w.endIdx - 1) sessionEnd = true;
        else if ((hours > 16) || (hours === 16 && mins >= 0)) sessionEnd = true;

        if (!targetHit) {
          const tHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
          const sHit = long ? bar.low <= currentStopPrice : bar.high >= currentStopPrice;

          // Same-bar tie-break: original stop AND target both reachable within one bar (rare --
          // verified 0/118 real IB_BEARISH trades hit this for the live 53pt/50pt distances, so
          // this branch is latent/untriggered for the current run, but the original version of
          // this script left `pnl` unassigned here, which JS's `totalEv += null` silently
          // coerces to +0 -- understating a real stop-loss on any future trade/parameter set
          // where this DOES trigger. Fixed to assign the stop-out PnL explicitly, matching the
          // baseline simulation's own (correct) handling of this exact tie a few lines above.
          if (tHit && sHit) { outcome = 'STOP'; pnl = exactPnl(entry, currentStopPrice, long); }
          else if (tHit) {
            targetHit = true;
            pnlAtOriginalTarget = exactPnl(entry, targetPrice, long);
            currentStopPrice = entry; // move remainder stop to BE
            runningExtreme = long ? bar.high : bar.low;

            const sHitBE = long ? bar.low <= currentStopPrice : bar.high >= currentStopPrice;
            if (sHitBE) {
              outcome = 'TRAIL_STOP';
              pnlOfTrailedRemainder = exactPnl(entry, currentStopPrice, long);
            }
          }
          else if (sHit) {
             outcome = 'STOP';
             pnl = exactPnl(entry, currentStopPrice, long);
          }
        } else if (outcome === null) {
          const high = bar.high, low = bar.low;
          if (long && high > runningExtreme) runningExtreme = high;
          if (!long && low < runningExtreme) runningExtreme = low;

          const rawTrailStop = long ? runningExtreme - trail : runningExtreme + trail;
          const candidateStop = long ? Math.max(entry, rawTrailStop) : Math.min(entry, rawTrailStop);

          if (long && candidateStop > currentStopPrice) currentStopPrice = candidateStop;
          if (!long && candidateStop < currentStopPrice) currentStopPrice = candidateStop;

          const trHit = long ? low <= currentStopPrice : high >= currentStopPrice;
          if (trHit) {
            outcome = 'TRAIL_STOP';
            pnlOfTrailedRemainder = exactPnl(entry, currentStopPrice, long);
          }
        }

        if (outcome === null && sessionEnd) {
          outcome = 'TIME_EXPIRED';
          if (!targetHit) {
             pnl = exactPnl(entry, bar.close, long);
          } else {
             pnlOfTrailedRemainder = exactPnl(entry, bar.close, long);
          }
        }

        if (outcome !== null) break;
      }
      
      if (outcome === null) {
          if (!targetHit) {
             pnl = exactPnl(entry, allBars[w.endIdx - 1].close, long);
          } else {
             pnlOfTrailedRemainder = exactPnl(entry, allBars[w.endIdx - 1].close, long);
          }
      }

      if (targetHit) {
         pnl = (2/3) * pnlAtOriginalTarget + (1/3) * pnlOfTrailedRemainder;
      }
      
      totalEv += pnl;
      events.push({ date: w.trade.fired_at.toISOString().slice(0, 10), pnl });
    }
    
    const ev = totalEv / walked.length;
    simResults.push({ trail, ev, events });
  }
  
  const numWalked = walked.length;
  const splitIdx = Math.floor(numWalked * (2 / 3));

  let bestInSample = null;
  for (const res of simResults) {
    const isEv = res.events.slice(0, splitIdx).reduce((acc, e) => acc + e.pnl, 0) / splitIdx;
    if (!bestInSample || isEv > bestInSample.isEv) {
      bestInSample = { ...res, isEv };
    }
  }
  
  let plateauPassed = false;
  let trailNeighborsNotes = '';
  if (bestInSample) {
    const b_t = bestInSample.trail;
    let tIdx = trailCandidates.indexOf(b_t);

    const neighbors = [];
    const trNeighbors = [];

    if (tIdx > 0) {
      const n = simResults.find(r => r.trail === trailCandidates[tIdx - 1]);
      neighbors.push(n); if (n) trNeighbors.push(n);
    }
    if (tIdx < trailCandidates.length - 1) {
      const n = simResults.find(r => r.trail === trailCandidates[tIdx + 1]);
      neighbors.push(n); if (n) trNeighbors.push(n);
    }
    
    // In this specific 2/3 1/3 scenario, "beat baseline in-sample" means IS EV > Baseline IS EV
    plateauPassed = neighbors.every(n => n && (n.events.slice(0, splitIdx).reduce((acc, e) => acc + e.pnl, 0) / splitIdx) > baselineIsEv);
    
    trailNeighborsNotes = trNeighbors.map(n => `trail=${n.trail} IS $${(n.events.slice(0, splitIdx).reduce((acc, e) => acc + e.pnl, 0) / splitIdx).toFixed(2)}`).join(', ');
  }
  
  let claimText = '';
  let status = 'PROVISIONAL';
  let passedGates = true;
  
  if (!bestInSample) {
      claimText = 'Failed to find a best in sample trail width.';
      passedGates = false;
  } else if (!plateauPassed) {
      claimText = `Failed plateau check at trail=${bestInSample.trail}. Neighbors: ${trailNeighborsNotes}`;
      passedGates = false;
  } else {
      const oosEv = bestInSample.events.slice(splitIdx).reduce((acc, e) => acc + e.pnl, 0) / (numWalked - splitIdx);
      const fullEv = bestInSample.ev;
      
      const rigor = computeRigor(bestInSample.events, { dateField: 'date', pnlFn: e => e.pnl });
      
      if (!(oosEv > 0 && fullEv > baselineEv && oosEv > baselineOosEv)) {
          claimText = `Failed OOS/Baseline checks. Best IS trail=${bestInSample.trail}. Baseline full=$${baselineEv.toFixed(2)}, OOS=$${baselineOosEv.toFixed(2)}. Trail full=$${fullEv.toFixed(2)}, OOS=$${oosEv.toFixed(2)}.`;
          passedGates = false;
      } else {
          claimText = `Success! Trail=${bestInSample.trail} passed all gates. Rigor clean: ${rigor.clean}. Baseline full=$${baselineEv.toFixed(2)}, OOS=$${baselineOosEv.toFixed(2)}. Trail full=$${fullEv.toFixed(2)}, OOS=$${oosEv.toFixed(2)}.`;
          if (rigor.clean) status = 'CONFIRMED';
      }
      
      console.log(claimText);
      console.log('Rigor:', rigor);
  }
  
  if (!passedGates) {
      console.log(claimText);
  }
  
  await recordClaim({
    slug: 'ib_bearish_2of3_1of3_runner_pilot',
    claimText,
    sourceFile: 'scripts/pilot_ib_bearish_2of3_target_1of3_trail.mjs',
    status
  });

  process.exit(0);
}

main().catch(console.error);
