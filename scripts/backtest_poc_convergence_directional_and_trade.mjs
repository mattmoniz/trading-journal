import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const TICK = 0.25;
const round = p => Math.round(p / TICK) * TICK;
const RTH_START = 570, RTH_END = 959;
const VBAR = 500;
const H_MINUTES = 15;
const LOOKBACK_K = 10;
const MIN_N = 20;
const TARGET_SWEEP = [10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 100, 120, 150];

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function stddev(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function statStr(a) { return `mean=${mean(a)?.toFixed(2) ?? 'n/a'} sd=${stddev(a)?.toFixed(2) ?? 'n/a'} N=${a.length}`; }
function percentile(sorted, p) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
function etMinuteOfDay(ts) { const d = new Date(ts); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

class IncrementalProfile {
    constructor() {
        this.volMap = new Map();
        this.totalVol = 0;
    }
    addBar(b) {
        const h = b.high, l = b.low, v = b.volume;
        if (!(h >= l)) return;
        const levels = Math.max(1, Math.round((h - l) / TICK) + 1);
        const vpl = v / levels;
        for (let p = l; p <= h + TICK / 2; p += TICK) {
            const lvl = round(p);
            this.volMap.set(lvl, (this.volMap.get(lvl) || 0) + vpl);
        }
        this.totalVol += v;
    }
    getMed50() {
        if (this.totalVol === 0) return 0;
        const prices = Array.from(this.volMap.keys()).sort((a,b)=>a-b);
        const half = this.totalVol / 2;
        let cum = 0;
        for (const p of prices) {
            cum += this.volMap.get(p);
            if (cum >= half) return p;
        }
        return prices[prices.length - 1];
    }
}

function subPoints(bar) {
  const path = bar.close >= bar.open ? [bar.open, bar.low, bar.high, bar.close] : [bar.open, bar.high, bar.low, bar.close];
  const segVol = bar.volume / 3, steps = 5, out = [];
  for (let s = 0; s < 3; s++) {
    const p0 = path[s], p1 = path[s + 1];
    for (let i = 1; i <= steps; i++) {
        const price = p0 + (p1 - p0) * (i / steps);
        const vol = segVol / steps;
        out.push({ price, vol, ts: bar.ts, closePx: bar.close, high: price, low: price, volume: vol });
    }
  }
  return out;
}

function stepPocStructuralStop(state, bar) {
  const isSessionEnd = etMinuteOfDay(bar.ts) >= 960;
  let resolution = null;

  let hitTarget = false;
  if (state.T != null) {
      if (state.long && bar.high >= state.entry + state.T) hitTarget = true;
      if (!state.long && bar.low <= state.entry - state.T) hitTarget = true;
  }

  let closedWrong = state.long ? bar.close < state.L : bar.close > state.L;
  if (closedWrong) state.wrongCloses++;
  else state.wrongCloses = 0;
  
  let hitStop = state.wrongCloses >= 2;

  if (hitStop) {
      resolution = { resolution: 'STOP_HIT', exitPx: bar.close };
  } else if (hitTarget) {
      resolution = { resolution: 'TARGET_HIT', exitPx: state.long ? state.entry + state.T : state.entry - state.T };
  } else if (isSessionEnd) {
      resolution = { resolution: 'TIME_EXPIRED', exitPx: bar.close };
  }
  
  return { state: { ...state, wrongCloses: state.wrongCloses }, resolution };
}

async function main() {
  const dvl = (await query(`SELECT trade_date::text as t FROM developing_value_log ORDER BY trade_date DESC`)).rows.reverse();
  console.log(`Population widened: ${dvl.length} sessions available in developing_value_log`);

  const sessions = [];
  for (const row of dvl) {
    const t = row.t;
    const bars = (await query(`
      SELECT ts, ts::date::text as d, high::float, low::float, close::float, open::float, volume::float as volume
      FROM price_bars_primary WHERE symbol='NQ' AND (
        (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
        (ts::date = $1 AND EXTRACT(hour FROM ts) < 17)
      ) ORDER BY ts`, [t])).rows;
    const globexBars = bars.filter(b => b.d !== t || etMinuteOfDay(b.ts) < RTH_START);
    const rthBars = bars.filter(b => b.d === t && etMinuteOfDay(b.ts) >= RTH_START && etMinuteOfDay(b.ts) <= RTH_END);
    if (rthBars.length < 300) continue;
    const globexPoints = globexBars.flatMap(subPoints);
    const rthPoints = rthBars.flatMap(subPoints);
    sessions.push({ t, globexPoints, rthPoints, rthBars });
  }
  console.log(`Sessions with full RTH bars: ${sessions.length}`);

  const splitIdx = Math.floor(sessions.length * 0.7);
  const trainS = sessions.slice(0, splitIdx), testS = sessions.slice(splitIdx);
  
  for (const s of sessions) {
    s.checkpoints = [];
    let cumVol = 0, nextTarget = VBAR;
    
    const pRTH = new IncrementalProfile();
    const p24 = new IncrementalProfile();
    
    for (const pt of s.globexPoints) {
        p24.addBar(pt);
    }
    
    for (const pt of s.rthPoints) {
      pRTH.addBar(pt);
      p24.addBar(pt);
      cumVol += pt.vol;
      
      if (cumVol >= nextTarget) {
        const mR = pRTH.getMed50();
        const m24 = p24.getMed50();
        s.checkpoints.push({
          ts: pt.ts,
          d50: Math.abs(mR - m24),
          mR,
          m24,
          closePx: pt.closePx,
        });
        nextTarget += VBAR;
      }
    }
    delete s.globexPoints;
  }
  
  console.log('Profiles evaluated successfully.');

  const NBUCKETS = 7;
  const bucketDs = Array.from({ length: NBUCKETS }, () => []);
  for (const s of trainS) s.checkpoints.forEach((c, i) => { const frac = i / s.checkpoints.length; bucketDs[Math.min(NBUCKETS - 1, Math.floor(frac * NBUCKETS))].push(c.d50); });
  const thresholds = bucketDs.map(arr => Math.max(TICK, percentile([...arr].sort((a, b) => a - b), 0.25)));

  for (const s of sessions) {
    s.tauIdx = null;
    for (let i = 0; i < s.checkpoints.length; i++) {
      const frac = i / s.checkpoints.length;
      if (s.checkpoints[i].d50 <= thresholds[Math.min(NBUCKETS - 1, Math.floor(frac * NBUCKETS))]) {
        s.tauIdx = i; break;
      }
    }
  }

  const trainPxDist = trainS.filter(s => s.tauIdx != null).map(s => Math.abs(s.checkpoints[s.tauIdx].closePx - s.checkpoints[s.tauIdx].m24));
  const theta_px = Math.max(TICK, percentile([...trainPxDist].sort((a,b)=>a-b), 0.5) || TICK);

  const minuteCloses = new Map();
  for (const s of trainS) {
    const uniq = [...new Map(s.rthPoints.map(p => [p.ts, p.closePx])).entries()];
    for (let i = 0; i + H_MINUTES < uniq.length; i++) {
      const key = new Date(uniq[i][0]).toISOString().slice(11, 16);
      if (!minuteCloses.has(key)) minuteCloses.set(key, []);
      minuteCloses.get(key).push(uniq[i + H_MINUTES][1] - uniq[i][1]);
    }
  }

  function evaluateEvent(s) {
      if (s.tauIdx == null || s.tauIdx < LOOKBACK_K) return null;
      const ck = s.checkpoints[s.tauIdx];
      const ck10 = s.checkpoints[s.tauIdx - LOOKBACK_K];
      const dirR = ck.mR - ck10.mR;
      const dir24 = ck.m24 - ck10.m24;
      const pxDist = Math.abs(ck.closePx - ck.m24);
      
      let dir = null;
      if (dirR <= -TICK && dir24 <= -TICK) dir = 'LONG';
      else if (dirR >= TICK && dir24 >= TICK) dir = 'SHORT';
      
      if (!dir || pxDist > theta_px) return null;
      
      const uniq = [...new Map(s.rthPoints.map(p => [p.ts, p.closePx])).entries()];
      const tauMinIdx = uniq.findIndex(([ts]) => ts === ck.ts);
      if (tauMinIdx === -1 || tauMinIdx + H_MINUTES >= uniq.length) return null;
      const ret = uniq[tauMinIdx + H_MINUTES][1] - uniq[tauMinIdx][1];
      const key = new Date(ck.ts).toISOString().slice(11, 16);
      const baseline = mean(minuteCloses.get(key) || []) || 0;
      
      const dirSign = dir === 'LONG' ? +1 : -1;
      const delta_dir = dirSign * (ret - baseline);
      
      const ret_abs = Math.abs(ret);
      const baseline_abs = mean(minuteCloses.get(key)?.map(Math.abs) || []) || 0;
      const delta_mag = ret_abs - baseline_abs;
      
      return { t: s.t, dir, ret, baseline, delta_dir, pxDist, delta_mag, tauMinIdx, ck };
  }

  const testEvents = testS.map(evaluateEvent).filter(e => e != null);
  const trainEvents = trainS.map(evaluateEvent).filter(e => e != null);
  
  const longEvents = testEvents.filter(e => e.dir === 'LONG');
  const shortEvents = testEvents.filter(e => e.dir === 'SHORT');
  
  const meanLong = mean(longEvents.map(e => e.delta_dir)) ?? 0;
  const meanShort = mean(shortEvents.map(e => e.delta_dir)) ?? 0;
  const sdLong = stddev(longEvents.map(e => e.delta_dir)) ?? 0;
  const sdShort = stddev(shortEvents.map(e => e.delta_dir)) ?? 0;
  const pooledSd = stddev(testEvents.map(e => e.delta_dir)) ?? 0;
  const meanMag = mean(testEvents.map(e => e.delta_mag)) ?? 0;
  const sdMag = stddev(testEvents.map(e => e.delta_mag)) ?? 0;
  
  const rigorLong = longEvents.length >= 15 ? computeRigor(longEvents.map(e => ({ t: e.t, delta: e.delta_dir })), { dateField: 't', pnlFn: r => r.delta }) : { stable: null };
  const rigorShort = shortEvents.length >= 15 ? computeRigor(shortEvents.map(e => ({ t: e.t, delta: e.delta_dir })), { dateField: 't', pnlFn: r => r.delta }) : { stable: null };
  
  const k1 = (Math.abs(meanLong - meanShort) <= pooledSd) && (meanLong <= 0) && (meanShort <= 0);
  const k2 = rigorLong.stable === false || rigorShort.stable === false;
  const k3 = longEvents.length < MIN_N || shortEvents.length < MIN_N;
  
  const k1_trip_msg = k1 ? (meanMag > sdMag ? 'K-DIR-1 tripped, but magnitude residual exists (case b)' : 'K-DIR-1 tripped, direction AND convergence both dead (case a)') : 'K-DIR-1 cleared';
  
  const pretest_claim = `Widened population: ${sessions.length} sessions. pxDist diagnostic: median=${percentile([...trainPxDist].sort((a,b)=>a-b), 0.5)?.toFixed(2)} (theta_px floored to ${theta_px.toFixed(2)}). Test Events: LONG N=${longEvents.length} (mean delta_dir=${meanLong.toFixed(2)} sd=${sdLong.toFixed(2)}), SHORT N=${shortEvents.length} (mean delta_dir=${meanShort.toFixed(2)} sd=${sdShort.toFixed(2)}). K-DIR-1 (no sep)=${k1} (${k1_trip_msg}), K-DIR-2 (rigor)=${k2}, K-DIR-3 (thin)=${k3}. If K-DIR-1 tripped or N<20/direction, SHADOW is not warranted.`;
  
  const ptStatus = (k1 || k2) ? 'REJECTED' : (k3 ? 'PROVISIONAL' : 'CONFIRMED');

  await recordClaim({
    slug: 'poc_convergence_directional_pretest',
    claimText: pretest_claim,
    sourceFile: 'scripts/backtest_poc_convergence_directional_and_trade.mjs',
    sampleSize: testEvents.length,
    rigorStatus: `L:${rigorLong.stable}, S:${rigorShort.stable}`,
    status: ptStatus
  });

  function runWalkForEvent(e, s, T = null) {
      const entryBarIdx = s.rthBars.findIndex(b => new Date(b.ts).getTime() > new Date(e.ck.ts).getTime());
      if (entryBarIdx === -1 || entryBarIdx >= s.rthBars.length) return null;
      
      const entry = s.rthBars[entryBarIdx].open;
      const L = e.ck.m24;
      const long = e.dir === 'LONG';
      
      let state = { wrongCloses: 0, long, entry, L, T };
      let resolution = null;
      let mae = 0, mfe = 0;
      
      for (let i = entryBarIdx; i < s.rthBars.length; i++) {
          const bar = s.rthBars[i];
          const adv = long ? entry - bar.low : bar.high - entry;
          const fav = long ? bar.high - entry : entry - bar.low;
          if (adv > mae) mae = adv;
          if (fav > mfe) mfe = fav;
          
          const step = stepPocStructuralStop(state, bar);
          state = step.state;
          if (step.resolution) {
              resolution = step.resolution;
              break;
          }
      }
      
      if (!resolution) {
          const lastClose = s.rthBars[s.rthBars.length - 1].close;
          resolution = { resolution: 'TIME_EXPIRED', exitPx: lastClose };
      }
      
      const pnl = long ? resolution.exitPx - entry : entry - resolution.exitPx;
      return { pnl, mae, mfe, res: resolution.resolution };
  }
  
  let bestT = null, bestEV = -Infinity;
  if (trainEvents.length > 0) {
      for (const T of TARGET_SWEEP) {
          let evSum = 0;
          for (const e of trainEvents) {
              const s = trainS.find(sess => sess.t === e.t);
              const walk = runWalkForEvent(e, s, T);
              if (walk) evSum += walk.pnl;
          }
          const ev = evSum / trainEvents.length;
          if (ev > bestEV) { bestEV = ev; bestT = T; }
      }
  }

  const testWalks = testEvents.map(e => runWalkForEvent(e, testS.find(sess => sess.t === e.t), bestT)).filter(w => w != null);
  const ev = mean(testWalks.map(w => w.pnl)) ?? 0;
  const wins = testWalks.filter(w => w.pnl > 0).length;
  const wr = testWalks.length ? (wins / testWalks.length * 100) : 0;
  
  let targetDesc = bestT ? bestT.toString() : 'None';
  if (trainEvents.length < MIN_N) targetDesc += ' (PROVISIONAL)';
  
  const trade_claim = `Trade Sim (Test) WR=${wr.toFixed(1)}% EV=${ev.toFixed(2)} N=${testWalks.length}. Derived Target: ${targetDesc}. (Exploratory if K-DIR-1 tripped).`;
  
  const tradeStatus = (ptStatus === 'REJECTED') ? 'REJECTED' : (testWalks.length < MIN_N ? 'PROVISIONAL' : 'CONFIRMED');

  await recordClaim({
    slug: 'poc_convergence_structural_stop_trade_sim',
    claimText: trade_claim,
    sourceFile: 'scripts/backtest_poc_convergence_directional_and_trade.mjs',
    sampleSize: testWalks.length,
    winRate: wr / 100,
    evPerTrade: ev,
    rigorStatus: 'n/a',
    status: tradeStatus
  });

  const responseText = `Actual session count after widening: ${sessions.length}\n\npxDist distribution on Train: ${trainPxDist.length > 0 ? statStr(trainPxDist) : 'N/A'}\n\nPart B K-DIR verdicts:\n- K-DIR-1 (no separation) = ${k1} (${k1_trip_msg})\n- K-DIR-2 (rigor) = ${k2}\n- K-DIR-3 (thin) = ${k3}\n\nPart C Sim:\n- Derived Target = ${targetDesc}\n- EV = ${ev.toFixed(2)}\n- WR = ${wr.toFixed(1)}%\n- N = ${testWalks.length}\n\nClaims used:\n- Directional pretest:\n  ${pretest_claim}\n- Trade sim:\n  ${trade_claim}`;
  
  fs.writeFileSync('scratch/antigravity_response.md', responseText);
  
  console.log("DONE");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
