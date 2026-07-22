import fs from 'fs';
import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { getBarShapeBaseline, classifyReversalPattern } from '../server/services/candlePatternQuality.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const _baselineCache = new Map();
async function getBaseline(date) {
  if (_baselineCache.has(date)) return _baselineCache.get(date);
  const b = await getBarShapeBaseline(query, date, 'NQ', 90);
  _baselineCache.set(date, b);
  return b;
}

function calcEV(rows, pnlField) {
  const evs = rows.map(r => Number(r[pnlField])).filter(v => Number.isFinite(v));
  if (evs.length === 0) return 0;
  return evs.reduce((a, b) => a + b, 0) / evs.length;
}

function calcWR(rows, resField) {
  if (rows.length === 0) return 0;
  const wins = rows.filter(r => r[resField] === 'TARGET_HIT').length;
  return (wins / rows.length) * 100;
}

async function main() {
  const typesRes = await query(`
    SELECT setup_type
    FROM active_setups
    WHERE resolution_method = 'BACKFILL' 
      AND resolution IN ('STOP_HIT', 'TARGET_HIT')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND actual_pnl IS NOT NULL
    GROUP BY setup_type
    HAVING COUNT(*) >= 50
  `);
  const setupTypes = typesRes.rows.map(r => r.setup_type);

  const results = [];
  const pooled = {
    neverOvershot: 0,
    stopTooTight: 0,
    overshotBaseline: [],
    overshootNoPattern: [],
    overshootPatternPairedOrig: [],
    overshootPatternPairedNew: []
  };

  for (const setupType of setupTypes) {
    const setupsRes = await query(`
      SELECT id, trade_date, fired_at, resolution, actual_pnl,
             entry_zone_low::float AS entry_low,
             COALESCE(entry_zone_high, entry_zone_low)::float AS entry_high,
             stop_level::float AS stop, t1_level::float AS t1
      FROM active_setups
      WHERE setup_type = $1
        AND resolution_method = 'BACKFILL'
        AND resolution IN ('STOP_HIT', 'TARGET_HIT')
        AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
        AND actual_pnl IS NOT NULL
      ORDER BY trade_date, fired_at
    `, [setupType]);

    const setups = setupsRes.rows;
    if (setups.length < 50) continue; // Safety check

    const direction = directionFromType(setupType);
    const byDate = new Map();
    for (const s of setups) {
      const d = typeof s.trade_date === 'string' ? s.trade_date.slice(0, 10) : s.trade_date.toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(s);
    }

    const tradesData = [];
    for (const [date, dateSetups] of byDate) {
      const barsRes = await query(`
        SELECT ts, open::float, high::float, low::float, close::float
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date = $1
        ORDER BY ts
      `, [date]);
      const allBars = barsRes.rows;
      const baseline = await getBaseline(date);

      for (const s of dateSetups) {
        const bars = allBars.filter(b => b.ts > s.fired_at);
        if (bars.length === 0) continue;
        const entry = (s.entry_low + s.entry_high) / 2;
        
        let mae = 0;
        let resolvedAtIdx = -1;

        for (let i = 0; i < bars.length; i++) {
          const bar = bars[i];
          const advExc = direction === 'LONG' ? entry - bar.low : bar.high - entry;
          if (advExc > mae) mae = advExc;

          const stopHit   = direction === 'LONG' ? bar.low  <= s.stop : bar.high >= s.stop;
          const targetHit = direction === 'LONG' ? bar.high >= s.t1   : bar.low  <= s.t1;
          
          if (stopHit || targetHit) {
             resolvedAtIdx = i;
             break; 
          }
        }
        
        tradesData.push({ ...s, dateStr: date, bars, baseline, entry, originalBarsToRes: resolvedAtIdx + 1, finalMae: mae });
      }
    }

    if (tradesData.length === 0) continue;

    // Step 2
    const allMaes = tradesData.map(t => t.finalMae).sort((a,b) => a-b);
    const overshootThreshold = percentile(allMaes, 0.5);

    // Window sizing (Step 4 prereq)
    const barsToResList = tradesData.map(r => r.originalBarsToRes).filter(x => x > 0).sort((a, b) => a - b);
    const windowBars = Math.max(1, Math.ceil(percentile(barsToResList, 0.25)));

    // Step 3
    const overshot = [];
    const neverOvershot = [];
    const stopTooTight = [];

    for (const t of tradesData) {
      const stopDist = Math.abs(t.entry - t.stop);
      if (overshootThreshold >= stopDist) {
        stopTooTight.push(t);
        continue;
      }
      
      let crossedIdx = -1;
      let hitTargetBeforeCross = false;
      let runningExcursion = 0;

      for (let i = 0; i < t.bars.length; i++) {
        const bar = t.bars[i];
        const advExc = direction === 'LONG' ? t.entry - bar.low : bar.high - t.entry;
        if (advExc > runningExcursion) runningExcursion = advExc;
        
        const targetHit = direction === 'LONG' ? bar.high >= t.t1 : bar.low <= t.t1;
        if (targetHit && runningExcursion <= overshootThreshold) {
          hitTargetBeforeCross = true;
          break;
        }
        
        if (runningExcursion > overshootThreshold) {
          crossedIdx = i;
          break;
        }
      }
      
      if (hitTargetBeforeCross || crossedIdx === -1) {
        neverOvershot.push(t);
      } else {
        t.overshootIdx = crossedIdx;
        overshot.push(t);
      }
    }

    // Step 4 & 5
    const overshootPatternPairedOrig = [];
    const overshootPatternPairedNew = [];
    const overshootNoPattern = [];

    const { dollarsPerPoint, commissionPerRoundTrip } = LIVE_INSTRUMENT;

    for (const t of overshot) {
      const win = t.bars.slice(t.overshootIdx, t.overshootIdx + windowBars);
      const match = t.baseline ? classifyReversalPattern({ windowBars: win, direction, baseline: t.baseline }) : null;
      
      if (match) {
        t.patternCompleteIdx = t.overshootIdx + match.barIndex;
        
        // Sim new entry
        const entryBar = t.bars[t.patternCompleteIdx];
        const newEntry = entryBar.close;
        const remainingBars = t.bars.slice(t.patternCompleteIdx + 1);
        
        let newRes = 'EXPIRED';
        for (const bar of remainingBars) {
          const stopHit   = direction === 'LONG' ? bar.low  <= t.stop : bar.high >= t.stop;
          const targetHit = direction === 'LONG' ? bar.high >= t.t1   : bar.low  <= t.t1;
          if (stopHit) { newRes = 'STOP_HIT'; break; }
          if (targetHit) { newRes = 'TARGET_HIT'; break; }
        }
        
        let exitPrice = newEntry;
        if (newRes === 'TARGET_HIT') exitPrice = t.t1;
        else if (newRes === 'STOP_HIT') exitPrice = t.stop;
        else if (remainingBars.length > 0) exitPrice = remainingBars[remainingBars.length - 1].close;
        
        let pnlPts = direction === 'LONG' ? exitPrice - newEntry : newEntry - exitPrice;
        const newPnl = (pnlPts * dollarsPerPoint) - commissionPerRoundTrip;

        overshootPatternPairedOrig.push({ actual_pnl: t.actual_pnl, resolution: t.resolution, dateStr: t.dateStr });
        overshootPatternPairedNew.push({ newResolution: newRes, newPnl, dateStr: t.dateStr });
      } else {
        overshootNoPattern.push({ actual_pnl: t.actual_pnl, resolution: t.resolution, dateStr: t.dateStr });
      }
    }

    pooled.neverOvershot += neverOvershot.length;
    pooled.stopTooTight += stopTooTight.length;
    pooled.overshotBaseline.push(...overshot.map(x => ({ actual_pnl: x.actual_pnl, resolution: x.resolution, dateStr: x.dateStr })));
    pooled.overshootNoPattern.push(...overshootNoPattern);
    pooled.overshootPatternPairedOrig.push(...overshootPatternPairedOrig);
    pooled.overshootPatternPairedNew.push(...overshootPatternPairedNew);

    results.push({
      setupType,
      counts: {
        neverOvershot: neverOvershot.length,
        stopTooTight: stopTooTight.length,
        overshotTotal: overshot.length,
        noPattern: overshootNoPattern.length,
        pairedPattern: overshootPatternPairedOrig.length
      },
      overshotBaseline: {
        n: overshot.length,
        wr: calcWR(overshot, 'resolution'),
        ev: calcEV(overshot, 'actual_pnl')
      },
      noPattern: {
        n: overshootNoPattern.length,
        wr: calcWR(overshootNoPattern, 'resolution'),
        ev: calcEV(overshootNoPattern, 'actual_pnl')
      },
      pairedOrig: {
        n: overshootPatternPairedOrig.length,
        wr: calcWR(overshootPatternPairedOrig, 'resolution'),
        ev: calcEV(overshootPatternPairedOrig, 'actual_pnl'),
        rigor: computeRigor(overshootPatternPairedOrig, { dateField: 'dateStr', pnlFn: r => Number(r.actual_pnl) })
      },
      pairedNew: {
        n: overshootPatternPairedNew.length,
        wr: calcWR(overshootPatternPairedNew, 'newResolution'),
        ev: calcEV(overshootPatternPairedNew, 'newPnl'),
        rigor: computeRigor(overshootPatternPairedNew, { dateField: 'dateStr', pnlFn: r => r.newPnl })
      }
    });
  }

  const pooledResults = {
    counts: {
      neverOvershot: pooled.neverOvershot,
      stopTooTight: pooled.stopTooTight,
      overshotTotal: pooled.overshotBaseline.length,
      noPattern: pooled.overshootNoPattern.length,
      pairedPattern: pooled.overshootPatternPairedOrig.length
    },
    overshotBaseline: {
      n: pooled.overshotBaseline.length,
      wr: calcWR(pooled.overshotBaseline, 'resolution'),
      ev: calcEV(pooled.overshotBaseline, 'actual_pnl')
    },
    noPattern: {
      n: pooled.overshootNoPattern.length,
      wr: calcWR(pooled.overshootNoPattern, 'resolution'),
      ev: calcEV(pooled.overshootNoPattern, 'actual_pnl')
    },
    pairedOrig: {
      n: pooled.overshootPatternPairedOrig.length,
      wr: calcWR(pooled.overshootPatternPairedOrig, 'resolution'),
      ev: calcEV(pooled.overshootPatternPairedOrig, 'actual_pnl'),
      rigor: computeRigor(pooled.overshootPatternPairedOrig, { dateField: 'dateStr', pnlFn: r => Number(r.actual_pnl) })
    },
    pairedNew: {
      n: pooled.overshootPatternPairedNew.length,
      wr: calcWR(pooled.overshootPatternPairedNew, 'newResolution'),
      ev: calcEV(pooled.overshootPatternPairedNew, 'newPnl'),
      rigor: computeRigor(pooled.overshootPatternPairedNew, { dateField: 'dateStr', pnlFn: r => r.newPnl })
    }
  };

  fs.writeFileSync('/home/mmoniz/trading-journal/scratch/overshoot_results.json', JSON.stringify({ results, pooled: pooledResults }, null, 2));
  console.log("Results written to /home/mmoniz/trading-journal/scratch/overshoot_results.json");
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
