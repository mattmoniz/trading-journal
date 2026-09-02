import fs from 'fs';
import { query } from '../server/db.js';
import { computeBalanceAndResolution, computeEntryPace } from '../server/services/flushMechanics.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { getVolumeBaseline } from '../server/services/touchQuality.js';

const PT = 2; // LIVE_INSTRUMENT.MNQ.dollarsPerPoint
// FIXED 2026-09-02: was 1, applied ONCE per trade in getTradePnl() below (representing the
// full round-trip cost, not a per-side charge) -- CLAUDE.md/instruments.js's
// commissionPerRoundTrip is $2 for MNQ, not $1. Every $/trade figure this file (and its
// sibling pilot_exits.mjs, same bug, same fix) has reported was $1/trade too generous.
// Doesn't change which config wins each sweep (a uniform -$1/trade shift preserves relative
// ranking across configs on the same trade population) -- only the absolute headline numbers,
// which were corrected in performance_audit and docs/OPEN_THREADS.md in the same session this
// was caught.
const COMM = 2;

function computeIntradayATR(bars, currentIdx, window = 60) {
  const start = Math.max(1, currentIdx - window + 1);
  let sum = 0, count = 0;
  for (let i = start; i <= currentIdx; i++) {
    const b = bars[i], prev = bars[i - 1];
    if (!b || !prev) continue;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
    sum += tr; count++;
  }
  return count > 0 ? sum / count : null;
}

function aggregate5Min(bars) {
  const out = [];
  let current = null;
  for (const b of bars) {
    const m = Math.floor(new Date(b.ts).getTime() / 60000);
    const bucket = m - (m % 5);
    if (!current || current.bucket !== bucket) {
      if (current) out.push(current);
      current = { bucket, ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: Number(b.volume) };
    } else {
      current.high = Math.max(current.high, b.high);
      current.low = Math.min(current.low, b.low);
      current.close = b.close;
      current.volume += Number(b.volume);
    }
  }
  if (current) out.push(current);
  return out;
}

function computeRangeSlope(trueRanges) {
  const n = trueRanges.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = trueRanges.reduce((s, r) => s + r, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (trueRanges[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den > 0 ? num / den : 0;
}

async function getLiveTargets() {
  const { rows } = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, optimal_target::float as target, notes
    FROM performance_audit
    WHERE signal_type='OPTIMAL_STOP'
      AND signal_name IN ('RTH_FLUSH_LONG','RTH_FLUSH_SHORT','GLOBEX_FLUSH_LONG','GLOBEX_FLUSH_SHORT','GLOBEX_FLUSH_REVERSAL_LONG','GLOBEX_FLUSH_REVERSAL_SHORT')
    ORDER BY signal_name, run_date DESC
  `);
  const dict = {};
  for (const r of rows) {
    try {
      const n = JSON.parse(r.notes || '{}');
      dict[r.signal_name] = { target: r.target, ...n };
    } catch(e) {}
  }
  return dict;
}

function getTradePnl(trade, exitIdx1Min) {
  const isLong = trade.dir === 'UP';
  let stopHit = false;
  let pnl = 0;
  for (let i = trade.entryIdx; i <= exitIdx1Min && i < trade.bars.length; i++) {
    const bb = trade.bars[i];
    if ((isLong && bb.low <= trade.stopPrice) || (!isLong && bb.high >= trade.stopPrice)) {
      stopHit = true;
      pnl = -Math.abs(trade.entryPrice - trade.stopPrice) * PT - COMM;
      break;
    }
  }
  if (!stopHit) {
    const exitBar = trade.bars[Math.min(exitIdx1Min, trade.bars.length - 1)];
    const exitPrice = exitBar.close;
    pnl = (isLong ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice) * PT - COMM;
  }
  return pnl;
}

async function evaluateTrade(t, baselinePts) {
  const bars = t.bars;
  const entryIdx = t.entryIdx;
  const entry = t.entryPrice;
  const stop = t.stopPrice;
  const dir = t.dir;
  const isLong = dir === 'UP';
  const baselineTgt = isLong ? entry + baselinePts : entry - baselinePts;
  
  let baselinePnl = null;
  let maxFav = 0;
  for (let i = entryIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    const fav = isLong ? b.high - entry : entry - b.low;
    if (fav > maxFav) maxFav = fav;
    
    const stopHit = isLong ? b.low <= stop : b.high >= stop;
    const tgtHit = isLong ? b.high >= baselineTgt : b.low <= baselineTgt;
    
    if (stopHit && tgtHit) { baselinePnl = -(entry - stop) * PT - COMM; break; }
    if (stopHit) { baselinePnl = -Math.abs(entry - stop) * PT - COMM; break; }
    if (tgtHit) { baselinePnl = Math.abs(baselineTgt - entry) * PT - COMM; break; }
  }
  if (baselinePnl === null) baselinePnl = 0;
  
  t.mfe = maxFav;
  t.baselinePnl = baselinePnl;
  t.meaningful = maxFav >= 20;

  const postBars = bars.slice(entryIdx);
  const fiveMinBars = aggregate5Min(postBars);
  t.fiveMinBars = fiveMinBars;
  t.postBars = postBars;

  const trueRanges = fiveMinBars.map((b, i) => {
    const prevClose = i > 0 ? fiveMinBars[i-1].close : b.open;
    return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  });
  t.trueRanges = trueRanges;
  
  const dirs = [];
  for (let i = 1; i < fiveMinBars.length; i++) {
    const d = fiveMinBars[i].close > fiveMinBars[i - 1].close ? 1 : (fiveMinBars[i].close < fiveMinBars[i - 1].close ? -1 : 0);
    dirs.push(d);
  }
  t.dirs = dirs;

  // volZs for post-entry
  t.volZs = [];
  for (const b of postBars) {
    const bl = t.volBaseline.get(b.mod);
    if (bl && bl.std_vol > 0) {
      t.volZs.push((Number(b.volume) - bl.avg_vol) / bl.std_vol);
    } else {
      t.volZs.push(0);
    }
  }

  // VWAP logic from original
  if (fiveMinBars.length > 2) {
    const vwapSeries = computeRunningVwapSeries(fiveMinBars);
    const slopes = [];
    for (let i = 1; i < fiveMinBars.length; i++) {
      const rawSlope = vwapSeries[i] - vwapSeries[i-1];
      const signedSlope = isLong ? rawSlope : -rawSlope;
      const b1minIdx = bars.findIndex(b => b.ts === fiveMinBars[i].ts);
      const atr = b1minIdx !== -1 ? computeIntradayATR(bars, b1minIdx, 60) : null;
      slopes.push({ 
        fiveMinIdx: i, 
        val: signedSlope, 
        atrNorm: (atr && atr > 0) ? signedSlope / atr : null 
      });
    }
    t.vwapSlopes = slopes;
  }
}

// Shared detection loop (2026-09-02, extracted for wire_flush_post_entry_exit_signals_globex):
// simulateRangeSlope() below needs a final PnL for the backtest; the live poller
// (acd.js, via detectPostEntryExitSignals() at the bottom of this file) needs to know
// WHERE/WHEN it fired so it can persist a real fired_at/fired_price on an open position.
// Both now call this one loop -- do not let the two diverge into separate copies of the
// flat-run condition.
function findRangeSlopeFireIdx(trade, windowK, thresh, confirmDur) {
  let flatRun = 0;
  for (let i = windowK; i < trade.fiveMinBars.length; i++) {
    const slice = trade.trueRanges.slice(i - windowK + 1, i + 1);
    const slope = computeRangeSlope(slice);
    if (slope <= thresh) {
      flatRun++;
    } else {
      flatRun = 0;
    }
    if (flatRun >= confirmDur) return i;
  }
  return null;
}

function simulateRangeSlope(trade, windowK, thresh, confirmDur) {
  const i = findRangeSlopeFireIdx(trade, windowK, thresh, confirmDur);
  if (i == null) return getTradePnl(trade, trade.bars.length - 1);
  const exit1Min = trade.bars.findIndex(b => b.ts === trade.fiveMinBars[i].ts) + 4;
  return getTradePnl(trade, exit1Min);
}

function simulateDirectionalPersistence(trade, minRun, maxNotMetDur) {
  const tradeSign = trade.dir === 'UP' ? 1 : -1;
  let notMetCount = 0;
  let currentRun = 0;
  for (let i = 0; i < trade.dirs.length; i++) {
    if (trade.dirs[i] === tradeSign) {
      currentRun++;
    } else {
      currentRun = 0;
    }
    if (currentRun >= minRun) {
      notMetCount = 0;
    } else {
      notMetCount++;
    }
    if (notMetCount >= maxNotMetDur) {
      const exit1Min = trade.bars.findIndex(b => b.ts === trade.fiveMinBars[i+1].ts) + 4; 
      return getTradePnl(trade, exit1Min);
    }
  }
  return getTradePnl(trade, trade.bars.length - 1);
}

// Same extraction rationale as findRangeSlopeFireIdx above.
function findVolRolloverFireIdx(trade, M, N) {
  const volZs = trade.volZs;
  if (!volZs || volZs.length < M + N) return null;
  for (let i = M; i < volZs.length - N; i++) {
    let rising = true;
    for (let j = i - M; j < i; j++) {
      if (volZs[j] >= volZs[j+1]) { rising = false; break; }
    }
    if (!rising) continue;

    let declining = true;
    for (let j = i; j < i + N; j++) {
      if (volZs[j] <= volZs[j+1]) { declining = false; break; }
    }

    if (declining) return i;
  }
  return null;
}

function simulateVolRollover(trade, M, N) {
  const i = findVolRolloverFireIdx(trade, M, N);
  if (i == null) return getTradePnl(trade, trade.bars.length - 1);
  return getTradePnl(trade, trade.entryIdx + i + N);
}


const volBaselineCache = new Map();
async function getCachedVolumeBaseline(query, d) {
  if (volBaselineCache.has(d)) return volBaselineCache.get(d);
  const bl = await getVolumeBaseline(query, d);
  volBaselineCache.set(d, bl);
  return bl;
}

async function main() {
  const calib = await getLiveTargets();
  const levelsQ = await query(`SELECT trade_date::text as d, level_name, price::float FROM level_prices WHERE trade_date >= '2023-01-01'`);
  const levels = new Map();
  for (const r of levelsQ.rows) {
    if (!levels.has(r.d)) levels.set(r.d, {});
    levels.get(r.d)[r.level_name] = r.price;
  }

  const ibQ = await query(`
    SELECT ts::date::text as d, MAX(high)::float as ib_high, MIN(low)::float as ib_low
    FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    GROUP BY ts::date
  `);
  for (const r of ibQ.rows) {
    if (!levels.has(r.d)) levels.set(r.d, {});
    levels.get(r.d)['IB_HIGH'] = r.ib_high;
    levels.get(r.d)['IB_LOW'] = r.ib_low;
  }

  const barsQ = await query(`
    SELECT ts, ts::date::text as d,
           EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as mod,
           open::float, high::float, low::float, close::float,
           (COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::int as volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= '2023-01-01'
    ORDER BY ts
  `);
  const allBars = barsQ.rows;

  const rthDays = new Map();
  for (const b of allBars) {
    if (b.mod >= 570 && b.mod <= 959) {
      if (!rthDays.has(b.d)) rthDays.set(b.d, []);
      rthDays.get(b.d).push(b);
    }
  }

  const population = [];

  // RTH
  for (const [d, bars] of rthDays.entries()) {
    if (bars.length < 40) continue;
    const l = levels.get(d) || {};
    const ibHigh = l['IB_HIGH'], ibLow = l['IB_LOW'];
    const onh = l['ONH'], onl = l['ONL'];
    
    let triggerIdx = null;
    let trigSrc = null;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.mod >= 630 && ibHigh != null && (b.close > ibHigh || b.close < ibLow)) { triggerIdx = i; break; }
      if (b.mod >= 570 && onh != null && onl != null && (b.close > onh || b.close < onl)) { 
        if (triggerIdx === null || i < triggerIdx) { triggerIdx = i; trigSrc = 'ON'; }
      }
    }
    
    if (triggerIdx !== null) {
      const postBars = bars.slice(triggerIdx + 1);
      const res = computeBalanceAndResolution(postBars);
      if (res) {
        const setup = `RTH_FLUSH_${res.resolutionDir === 'UP' ? 'LONG' : 'SHORT'}`;
        const c = calib[setup];
        if (c) {
          let targetPts = c.target;
          if (c.buildingTarget != null && c.avgVolZMedian != null && c.volZTrendMedian != null) {
            const volBaseline = await getCachedVolumeBaseline(query, d);
            const preEntryBars = bars.slice(triggerIdx + 1, res.resolutionIdx + triggerIdx + 2);
            const volZs = [];
            for (const b of preEntryBars) {
              const bl = volBaseline.get(b.mod);
              if (bl && bl.std_vol > 0) volZs.push((Number(b.volume) - bl.avg_vol) / bl.std_vol);
            }
            if (volZs.length >= 5) {
              const avgVolZ = volZs.reduce((a, b) => a + b, 0) / volZs.length;
              const n = volZs.length, xs = Array.from({ length: n }, (_, i) => i);
              const mx = xs.reduce((a, b) => a + b, 0) / n;
              let cov = 0, vx = 0, vy = 0;
              for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (volZs[i] - avgVolZ); vx += (xs[i] - mx) ** 2; vy += (volZs[i] - avgVolZ) ** 2; }
              const volZTrend = (vx > 0 && vy > 0) ? cov / Math.sqrt(vx * vy) : 0;
              if (avgVolZ > c.avgVolZMedian && volZTrend > c.volZTrendMedian) targetPts = c.buildingTarget;
            }
            population.push({
              date: d, window: 'RTH', dir: res.resolutionDir, mode: 'CONTINUATION', 
              entryIdx: triggerIdx + 1 + res.resolutionIdx, entryPrice: res.entryPrice, stopPrice: res.stopPrice,
              bars, levels: l, baselinePts: targetPts, volBaseline
            });
          } else {
             // Fallback
             const volBaseline = await getCachedVolumeBaseline(query, d);
             population.push({
                date: d, window: 'RTH', dir: res.resolutionDir, mode: 'CONTINUATION', 
                entryIdx: triggerIdx + 1 + res.resolutionIdx, entryPrice: res.entryPrice, stopPrice: res.stopPrice,
                bars, levels: l, baselinePts: targetPts, volBaseline
             });
          }
        }
      }
    }
  }

  // GLOBEX
  let currentGlobexDay = null;
  let currentGlobexBars = [];
  for (const b of allBars) {
    const isGlobex = b.mod >= 959 || b.mod < 570;
    if (!isGlobex) continue;
    let gDay = b.d;
    if (b.mod < 570) {
      const d = new Date(b.ts); d.setUTCDate(d.getUTCDate() - 1); gDay = d.toISOString().slice(0, 10);
    }
    if (currentGlobexDay !== gDay) {
      if (currentGlobexBars.length > 0 && currentGlobexDay) await processGlobexDay(currentGlobexDay, currentGlobexBars, levels, calib, population);
      currentGlobexDay = gDay; currentGlobexBars = [];
    }
    currentGlobexBars.push(b);
  }
  if (currentGlobexBars.length > 0 && currentGlobexDay) await processGlobexDay(currentGlobexDay, currentGlobexBars, levels, calib, population);

  console.log(`Evaluating ${population.length} entries...`);
  for (const t of population) await evaluateTrade(t, t.baselinePts);

  const meaningful = population.filter(t => t.meaningful);
  console.log(`Meaningful moves (MFE >= 20): ${meaningful.length} (out of ${population.length})`);

  const res = { rth_cont: [], rth_rev: [], glbx_cont: [], glbx_rev: [] };
  
  function getBucket(w, m) {
    if (w === 'RTH') return m === 'CONTINUATION' ? res.rth_cont : res.rth_rev;
    return m === 'CONTINUATION' ? res.glbx_cont : res.glbx_rev;
  }

  for (const t of meaningful) {
    getBucket(t.window, t.mode).push(t);
  }

  const out = {};
  
  // Sweeps configurations
  const rangeSlopeConfigs = [
    { k: 3, th: 0, dur: 2 },
    { k: 4, th: 0, dur: 3 },
    { k: 6, th: -0.5, dur: 3 },
    { k: 4, th: -1, dur: 4 }
  ];
  const dpConfigs = [
    { run: 2, dur: 3 },
    { run: 3, dur: 4 },
    { run: 3, dur: 6 }
  ];
  const volConfigs = [
    { m: 2, n: 2 },
    { m: 3, n: 2 },
    { m: 3, n: 3 }
  ];

  for (const [key, list] of Object.entries(res)) {
    if (list.length < 5) continue;
    const basePnl = list.reduce((s,x)=>s+x.baselinePnl,0)/list.length;

    let bestRangeSlope = { ev: -999, conf: '', cfg: null };
    for (const c of rangeSlopeConfigs) {
      const ev = list.reduce((s,x)=>s+simulateRangeSlope(x, c.k, c.th, c.dur),0)/list.length;
      if (ev > bestRangeSlope.ev) bestRangeSlope = { ev, conf: `K=${c.k}, TH=${c.th}, DUR=${c.dur}`, cfg: c };
    }

    let bestDP = { ev: -999, conf: '', cfg: null };
    for (const c of dpConfigs) {
      const ev = list.reduce((s,x)=>s+simulateDirectionalPersistence(x, c.run, c.dur),0)/list.length;
      if (ev > bestDP.ev) bestDP = { ev, conf: `RUN=${c.run}, DUR=${c.dur}`, cfg: c };
    }

    let bestVol = { ev: -999, conf: '', cfg: null };
    for (const c of volConfigs) {
      const ev = list.reduce((s,x)=>s+simulateVolRollover(x, c.m, c.n),0)/list.length;
      if (ev > bestVol.ev) bestVol = { ev, conf: `M=${c.m}, N=${c.n}`, cfg: c };
    }

    out[key] = {
      n: list.length,
      baselineEv: basePnl,
      bestRangeSlopeEv: bestRangeSlope.ev,
      bestRangeSlopeConf: bestRangeSlope.conf,
      bestDirectionalPersistenceEv: bestDP.ev,
      bestDirectionalPersistenceConf: bestDP.conf,
      bestVolumeRolloverEv: bestVol.ev,
      bestVolumeRolloverConf: bestVol.conf
    };

    if (list.length >= 10) {
        // rigor for the ACTUAL winning config of each sweep, not an arbitrary fixed config --
        // a rigor check on a different config than the one being reported as "best" proves nothing
        // about the reported number.
        const rsRigor = computeRigor(list, { dateField: 'date', pnlFn: (x) => simulateRangeSlope(x, bestRangeSlope.cfg.k, bestRangeSlope.cfg.th, bestRangeSlope.cfg.dur) });
        const dpRigor = computeRigor(list, { dateField: 'date', pnlFn: (x) => simulateDirectionalPersistence(x, bestDP.cfg.run, bestDP.cfg.dur) });
        const volRigor = computeRigor(list, { dateField: 'date', pnlFn: (x) => simulateVolRollover(x, bestVol.cfg.m, bestVol.cfg.n) });
        out[key].rigor = {
            rangeSlope: rsRigor ? { clean: rsRigor.clean, distinctDates: rsRigor.distinctDates, top5DayPct: rsRigor.top5DayPct, stable: rsRigor.stable, clustered: rsRigor.clustered } : null,
            dp: dpRigor ? { clean: dpRigor.clean, distinctDates: dpRigor.distinctDates, top5DayPct: dpRigor.top5DayPct, stable: dpRigor.stable, clustered: dpRigor.clustered } : null,
            volRollover: volRigor ? { clean: volRigor.clean, distinctDates: volRigor.distinctDates, top5DayPct: volRigor.top5DayPct, stable: volRigor.stable, clustered: volRigor.clustered } : null,
        }
    }
  }

  fs.writeFileSync('scratch/pilot_exits_extended_out.json', JSON.stringify(out, null, 2));
  console.log("Done.");
}

async function processGlobexDay(d, bars, levels, calib, population) {
  if (bars.length < 40) return;
  const l = levels.get(d) || {};
  const vah = l['PD_VAH'], val = l['PD_VAL'];
  if (vah == null || val == null) return;
  
  let triggerIdx = null; let triggerDir = null; let triggerTs = null; let triggerPrice = null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].close > vah) { triggerIdx = i; triggerDir = 'UP'; triggerTs = bars[i].ts; triggerPrice = bars[i].close; break; }
    if (bars[i].close < val) { triggerIdx = i; triggerDir = 'DOWN'; triggerTs = bars[i].ts; triggerPrice = bars[i].close; break; }
  }
  
  if (triggerIdx !== null) {
    const postBars = bars.slice(triggerIdx + 1);
    const res = computeBalanceAndResolution(postBars);
    if (res) {
      const mode = triggerDir === res.resolutionDir ? 'CONTINUATION' : 'REVERSAL';
      const setup = mode === 'CONTINUATION' ? `GLOBEX_FLUSH_${res.resolutionDir === 'UP'?'LONG':'SHORT'}` : `GLOBEX_FLUSH_REVERSAL_${res.resolutionDir === 'UP'?'LONG':'SHORT'}`;
      const c = calib[setup];
      if (c && c.tierTargets) {
        const pace = computeEntryPace(triggerPrice, triggerTs, res.entryPrice, postBars[res.resolutionIdx].ts);
        const volBaseline = await getCachedVolumeBaseline(query, d);
        const preEntryBars = postBars.slice(0, res.resolutionIdx + 1);
        const volZs = [];
        for (const b of preEntryBars) {
          const bl = volBaseline.get(b.mod);
          if (bl && bl.std_vol > 0) volZs.push((Number(b.volume) - bl.avg_vol) / bl.std_vol);
        }
        let avgVolZ = null, volZTrend = null;
        if (volZs.length >= 5) {
          avgVolZ = volZs.reduce((a, b) => a + b, 0) / volZs.length;
          const n = volZs.length, xs = Array.from({ length: n }, (_, i) => i);
          const mx = xs.reduce((a, b) => a + b, 0) / n;
          let cov = 0, vx = 0, vy = 0;
          for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (volZs[i] - avgVolZ); vx += (xs[i] - mx) ** 2; vy += (volZs[i] - avgVolZ) ** 2; }
          volZTrend = (vx > 0 && vy > 0) ? cov / Math.sqrt(vx * vy) : 0;
        }

        let score = 0;
        if (pace !== null && pace <= c.paceCutoffPtsPerMin) score++;
        if (avgVolZ !== null && volZTrend !== null && avgVolZ > c.avgVolZMedian && volZTrend > c.volZTrendMedian) score++;
        const targetPts = c.tierTargets[score];

        population.push({
          date: d, window: 'GLOBEX', dir: res.resolutionDir, mode, 
          entryIdx: triggerIdx + 1 + res.resolutionIdx, entryPrice: res.entryPrice, stopPrice: res.stopPrice,
          bars, levels: l, baselinePts: targetPts, volBaseline
        });
      }
    }
  }
}

main().catch(console.error);
