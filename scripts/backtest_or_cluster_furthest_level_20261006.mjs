// OR-cluster entry test (2026-10-06). When OR5/10/15/30 highs (or lows) sit within 15pt they form one
// zone. Versions, all on the same real RTH bars:
//   A  reached-only: fade at the FURTHEST level (highest high / lowest low), only if price reaches it.
//   B  fallback:     as A, but if price reaches only the NEAREST level and never the furthest, fade there.
//   C  breakout-skip: as A, but skip the day's zone if price first trades through the furthest level by 5pt.
// Exits: stop = 1 x R, target = 1 x R, R = median 15-minute range of the prior 20 sessions (no hand-set
// points). Stop checked before target within a bar. Open at 16:00 marked to market.
// Placebo: side flipped at random per zone. Bounded to the OR window; no lookahead (levels form by 10:00).
import fs from 'fs';
import { query } from '../server/db.js';

const DPP = 2, COMM = 2, CLUSTER_PT = 15, BREAK_PT = 5, N_PL = Number(process.env.PLACEBO_DRAWS || 30);
let seed = 20261006;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const dates = (await query(`SELECT DISTINCT trade_date::text d FROM level_prices WHERE level_name='OR30_HIGH' AND trade_date >= '2025-01-02' ORDER BY d`)).rows.map(r => r.d);
const bars = async (d, a, b) => (await query(`SELECT ts::text ts, open::float o, high::float h, low::float l, close::float c, ask_volume::float ad, bid_volume::float bd FROM price_bars_primary
  WHERE symbol='NQ' AND ts::date = $1::date AND ts::time >= $2::time AND ts::time < $3::time ORDER BY ts`, [d, a, b])).rows;
const levelsOf = async (d) => {
  const r = await query(`SELECT level_name n, price::float p FROM level_prices WHERE trade_date=$1::date AND level_name ~ '^OR(5|10|15|30)_(HIGH|LOW)$'`, [d]);
  const o = {}; for (const x of r.rows) o[x.n] = x.p; return o;
};
const cluster = (vals) => { // vals sorted ascending; returns groups of >=2 within CLUSTER_PT
  const g = []; let cur = [];
  for (const v of vals) { if (cur.length && v - cur[cur.length - 1] > CLUSTER_PT) { if (cur.length >= 2) g.push(cur); cur = []; } cur.push(v); }
  if (cur.length >= 2) g.push(cur); return g;
};
// R: median 15-min range over prior 20 sessions (proxy, data-derived)
const R_CACHE = new Map();
async function rangeR(d) {
  if (R_CACHE.has(d)) return R_CACHE.get(d);
  const r = await query(`WITH s AS (SELECT ts::date d, ts, high, low FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1::date AND ts::date >= $1::date - INTERVAL '40 days' AND ts::time >= '09:30' AND ts::time < '16:00')
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY rr) med FROM (SELECT d, AVG(hi-lo) rr FROM (SELECT d, date_trunc('hour', ts)+ INTERVAL '15 min' * FLOOR(EXTRACT(minute FROM ts)/15) bk, MAX(high)-MIN(low) hi, 0 lo FROM s GROUP BY d, bk) x GROUP BY d) y`, [d]);
  const v = r.rows[0]?.med != null ? +r.rows[0].med : null; R_CACHE.set(d, v); return v;
}

// Simulate one zone. side='SHORT' fades a high zone; 'LONG' fades a low zone. Returns {A,B,C} $ or null.
function simulate(day, side, refs, R, flip) {
  const short = (side === 'SHORT') !== flip; // flip = placebo
  const far = refs.far, near = refs.near;
  const res = { A: null, B: null, C: null, tm: null };
  const entryFor = (px, stopPx, tgtPx, bars, version) => {
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (short ? b.h >= px : b.l <= px) {
        // entry at px; walk from this bar
        for (let j = i; j < bars.length; j++) {
          const x = bars[j];
          const stopHit = short ? x.h >= stopPx : x.l <= stopPx;
          const tgtHit = short ? x.l <= tgtPx : x.h >= tgtPx;
          if (stopHit) return { pnl: (short ? px - stopPx : stopPx - px) * DPP - COMM, v: version };
          if (tgtHit) return { pnl: (short ? px - tgtPx : tgtPx - px) * DPP - COMM, v: version };
        }
        const last = bars.at(-1).c;
        return { pnl: (short ? px - last : last - px) * DPP - COMM, v: version };
      }
    }
    return null;
  };
  // ----- A / C: at the far level
  const stopDist = R, tgtDist = R;
  const farPx = far;
  // version C: breakout check first
  const breakIdx = bars_.findIndex(b => short ? b.h >= farPx + BREAK_PT : b.l <= farPx - BREAK_PT);
  const reachIdx = bars_.findIndex(b => short ? b.h >= farPx : b.l <= farPx);
  const nearIdx = bars_.findIndex(b => short ? b.h >= near : b.l <= near);
  if (reachIdx >= 0) { const m = bars_[reachIdx].ts.match(/(\d{2}):(\d{2})/); res.tm = (+m[1]) * 60 + (+m[2]); }
  const dir = short ? -1 : 1;
  const sPx = (px) => px + (short ? stopDist : -stopDist), tPx = (px) => px + (short ? -tgtDist : tgtDist);
  if (reachIdx >= 0) {
    const r = entryFor(farPx, sPx(farPx), tPx(farPx), bars_.slice(reachIdx), 'A');
    if (r) res.A = r.pnl;
    if (breakIdx < 0 || breakIdx > reachIdx) { if (r) res.C = r.pnl; }
  }
  DBG.total++; if (reachIdx < 0 && nearIdx >= 0) DBG.nearOnly++; if (reachIdx < 0) DBG.farNever++; if (nearIdx < 0) DBG.nearNever++;
  // version P_K (pause): as A, but the furthest-level entry needs a calm pause first -- K consecutive
  // 1-min bars, each with range below CALM (median 1-min range of the prior 20 sessions), all within
  // 15pt of the furthest level, before the bar that reaches it. K swept = 2, 3, 5.
  for (const K of PAUSE_K) {
    let run = 0, paused = false;
    for (let i = 0; i < (reachIdx >= 0 ? reachIdx : bars_.length); i++) {
      const b = bars_[i], calm = (b.h - b.l) < CALM && Math.abs(b.c - farPx) <= CLUSTER_PT;
      run = calm ? run + 1 : 0; if (run >= K) { paused = true; break; }
    }
    if (paused && reachIdx >= 0) { const rp = entryFor(farPx, sPx(farPx), tPx(farPx), bars_.slice(reachIdx), 'P' + K); if (rp) res['P' + K] = rp.pnl; }
  }
  // version D_K (delta flip): as A, but entry at the furthest level only if the cumulative delta
  // (ask_volume - bid_volume) over the K 1-min bars ending at the touch points AGAINST the fade
  // (sellers for a high zone). X_K is the control: delta with the fade (buyers into a high zone).
  if (reachIdx >= K_DELTA_MAX) {
    for (const K of DELTA_K) {
      let dsum = 0;
      for (let i = reachIdx - K + 1; i <= reachIdx; i++) dsum += (bars_[i].ad ?? 0) - (bars_[i].bd ?? 0);
      const againstFade = short ? dsum < 0 : dsum > 0;
      const rd = entryFor(farPx, sPx(farPx), tPx(farPx), bars_.slice(reachIdx), 'D' + K);
      if (rd) { if (againstFade) res['D' + K] = rd.pnl; else res['X' + K] = rd.pnl; }
    }
  }
  // version N: enter at the NEAREST level on its first touch (no waiting for the furthest)
  if (nearIdx >= 0) { const rn = entryFor(near, sPx(near), tPx(near), bars_.slice(nearIdx), 'N'); if (rn) res.N = rn.pnl; }
  // version B: the nearest level is hit first and the far level is never reached -> fade the near level
  if (reachIdx < 0 && nearIdx >= 0) {
    const r = entryFor(near, sPx(near), tPx(near), bars_.slice(nearIdx), 'B');
    if (r) res.B = r.pnl;
  } else if (reachIdx >= 0 && nearIdx >= 0 && nearIdx < reachIdx) {
    // B also covers the nearer level hit first and far reached later: enter at far (as A), so B == A here
    if (res.A != null) res.B = res.A;
  } else if (reachIdx >= 0) {
    if (res.A != null) res.B = res.A;
  }
  return res;
}
let bars_ = [];
let CALM = 0;
const PAUSE_K = [2, 3, 5];
const DELTA_K = [3, 5, 10]; const K_DELTA_MAX = 10;
const DBG = { total: 0, nearOnly: 0, farNever: 0, nearNever: 0 };

const VERS = ['A', 'B', 'C', 'N', 'P2', 'P3', 'P5', 'D3', 'X3', 'D5', 'X5', 'D10', 'X10'];
const outcomes = Object.fromEntries(VERS.map(v => [v, []])), placeboOut = Object.fromEntries(VERS.map(v => [v, []]));
let zones = 0, days = 0;
for (const d of dates) {
  const R = await rangeR(d);
  if (R == null || R <= 0) continue;
  const cm = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high-low) m FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1::date AND ts::date >= $1::date - INTERVAL '40 days' AND ts::time >= '09:30' AND ts::time < '16:00'`, [d]);
  CALM = cm.rows[0]?.m != null ? +cm.rows[0].m : 0;
  const L = await levelsOf(d);
  const bs = await bars(d, '10:00', '16:00');
  if (bs.length < 30) continue;
  days++;
  bars_ = bs;
  for (const side of ['SHORT', 'LONG']) {
    const keys = Object.keys(L).filter(k => k.endsWith(side === 'SHORT' ? '_HIGH' : '_LOW'));
    const vals = keys.map(k => L[k]).sort((a, b) => a - b);
    for (const g of cluster(vals)) {
      zones++;
      const far = side === 'SHORT' ? g[g.length - 1] : g[0];
      const near = side === 'SHORT' ? g[0] : g[g.length - 1];
      const r = simulate(d, side, { far, near }, R, false);
      for (const v of VERS) if (r[v] != null) outcomes[v].push({ d, pnl: r[v], tm: r.tm });
      const p = simulate(d, side, { far, near }, R, true);
      for (const v of VERS) if (p[v] != null) placeboOut[v].push({ d, pnl: p[v], tm: p.tm });
    }
  }
}
function summarize(list) {
  const byDay = new Map(); for (const x of list) byDay.set(x.d, (byDay.get(x.d) || 0) + x.pnl);
  const days_ = [...byDay.values()];
  const mean = list.reduce((s, x) => s + x.pnl, 0) / Math.max(list.length, 1);
  const boots = []; for (let i = 0; i < 2000; i++) { let s = 0; for (let j = 0; j < days_.length; j++) s += days_[Math.floor(rand() * days_.length)]; boots.push(s / Math.max(days_.length, 1)); }
  boots.sort((a, b) => a - b);
  return { n: list.length, days: days_.length, meanPerTrade: +mean.toFixed(2), dayBlockedMeanCI: [+boots[50].toFixed(2), +boots[1949].toFixed(2)] };
}
console.log(`sessions ${days}, zones ${zones}`, DBG);
const out = {};
for (const v of VERS) {
  const real = summarize(outcomes[v]);
  const placeboMeans = []; // placebo: same versions with flipped sides (already computed once per zone) -> use mean
  const pm = summarize(placeboOut[v]).meanPerTrade;
  out[v] = { real, placeboMean: pm };
  console.log(`version ${v}:`, real, `| placebo mean ${pm}`);
}
fs.writeFileSync(new URL('../scratch/or_cluster_furthest_level_20261006.json', import.meta.url), JSON.stringify(out, null, 2));

// time-window split (touch time): 10:00-11:30, 11:30-13:30, 13:30-close
const WINDOWS = [['10:00-11:30', 600, 690], ['11:30-13:30', 690, 810], ['13:30-16:00', 810, 960]];
console.log('\nTime-window split (versions with at least 1 trade):');
for (const [wl, a, b] of WINDOWS) {
  for (const v of ['A', 'C', 'D3', 'X3', 'D5', 'X5']) {
    const list = outcomes[v].filter(x => x.tm != null && x.tm >= a && x.tm < b);
    if (!list.length) continue;
    const sm = summarize(list);
    console.log(`${wl} ${v}: trades ${sm.n}, days ${sm.days}, mean ${sm.meanPerTrade}, CI ${JSON.stringify(sm.dayBlockedMeanCI)}`);
  }
}
process.exit(0);
