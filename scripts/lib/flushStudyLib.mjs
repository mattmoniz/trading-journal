// Shared helpers for the flush-family studies (docs/FLUSH_RECONCILE_PREREG_20261026.md and the Globex prereg). loadLevels/evalFromTrigger/simulateExit/percentile/pearson are VERBATIM copies of
// scripts/backtest_flush_patterns.mjs (that file runs main() on import, so it cannot be imported); realistic() is the realistic-fill arm. Research use only; nothing live imports this.
import { query } from '../../server/db.js';
import { LIVE_INSTRUMENT } from '../../server/config/instruments.js';
import { computeBalanceAndResolution, computeEntryPace } from '../../server/services/flushMechanics.js';
export const PPT = LIVE_INSTRUMENT.dollarsPerPoint, COMM = LIVE_INSTRUMENT.commissionPerRoundTrip, IB_END_MOD = 630;
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export const money = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);
export function percentile(arr, p) { const s = [...arr].sort((a, b) => a - b); const pos = (s.length - 1) * p, base = Math.floor(pos), rest = pos - base; return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base]; }
export function pearson(xs, ys) { const n = xs.length, mx = mean(xs), my = mean(ys); let cov = 0, vx = 0, vy = 0; for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; } return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0; }
export async function loadLevels() {
  const res = await query(`SELECT trade_date::text as trade_date, level_name, price::float FROM level_prices ORDER BY trade_date ASC`);
  const levelsByDate = {}; let cur = null, latest = {};
  for (const row of res.rows) { if (row.trade_date !== cur) { if (cur !== null) levelsByDate[cur] = { ...latest }; cur = row.trade_date; } latest[row.level_name] = row.price; }
  if (cur !== null) levelsByDate[cur] = { ...latest };
  const dense = {}; let running = {}; const checkpoints = [];
  for (const row of (await query(`SELECT DISTINCT trade_date::text as d FROM level_prices ORDER BY d ASC`)).rows) { const d = row.d; if (levelsByDate[d]) running = { ...running, ...levelsByDate[d] }; dense[d] = { ...running }; checkpoints.push(d); }
  return { getLevelsForDate: (td) => { let lo = 0, hi = checkpoints.length - 1, best = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (checkpoints[mid] <= td) { best = mid; lo = mid + 1; } else hi = mid - 1; } return best === -1 ? null : dense[checkpoints[best]]; } };
}
export function evalFromTrigger(sessBars, triggerIdx) {
  const postBars = sessBars.slice(triggerIdx + 1), res = computeBalanceAndResolution(postBars); if (!res) return null;
  const entryIdx = triggerIdx + 1 + res.resolutionIdx, entryBar = sessBars[entryIdx];
  const pace = computeEntryPace(sessBars[0].open, sessBars[0].ts, res.entryPrice, entryBar.ts);
  let mfe = 0; for (let i = entryIdx + 1; i < sessBars.length; i++) { const b = sessBars[i]; const fav = res.resolutionDir === 'UP' ? b.high - res.entryPrice : res.entryPrice - b.low; if (fav > mfe) mfe = fav; }
  const volZs = sessBars.slice(triggerIdx + 1, entryIdx + 1).map((b) => b.volZ).filter((v) => v !== null);
  const avgVolZ = volZs.length >= 5 ? mean(volZs) : null, volZTrend = volZs.length >= 5 ? pearson(Array.from({ length: volZs.length }, (_, i) => i), volZs) : null;
  return { resolutionDir: res.resolutionDir, entryPrice: res.entryPrice, stopPrice: res.stopPrice, entryIdx, pace, mfe, avgVolZ, volZTrend, sessBars };
}
export function simulateExit(setup, targetPts) {   // ARM A/B: the backtest's own exit (ideal fills, entry = resolution bar close)
  const { resolutionDir, entryPrice, entryIdx, stopPrice, sessBars } = setup, up = resolutionDir === 'UP';
  const targetPrice = up ? entryPrice + targetPts : entryPrice - targetPts; let exitPrice = sessBars[sessBars.length - 1].close;
  for (let i = entryIdx + 1; i < sessBars.length; i++) { const b = sessBars[i]; const stopHit = up ? b.low <= stopPrice : b.high >= stopPrice, hit = up ? b.high >= targetPrice : b.low <= targetPrice; if (stopHit) { exitPrice = stopPrice; break; } if (hit) { exitPrice = targetPrice; break; } }
  return { pnl: (up ? exitPrice - entryPrice : entryPrice - exitPrice) * PPT - COMM, win: up ? exitPrice > entryPrice : exitPrice < entryPrice };
}
export function realistic(setup, targetPts, mirror) {   // ARM C/D: entry at the NEXT bar's open; gap-aware fills; stop first; session close exit.
  // ARM C keeps the STRUCTURAL stop PRICE (the opposite balance edge), as the live detector does (stop = res.stopPrice), with a gap-aware fill (if the open is already beyond it, fill at the open).
  // ARM D (mirror = placebo) flips direction: same stop DISTANCE from the real entry and same target distance, opposite side, so the geometry is identical and only direction differs.
  const { entryIdx, sessBars } = setup; if (entryIdx + 1 >= sessBars.length) return null;
  const entry = sessBars[entryIdx + 1].open, up = setup.resolutionDir === 'UP', long = up !== !!mirror;
  const stopDist = Math.abs(entry - setup.stopPrice);
  const stop = mirror ? (long ? entry - stopDist : entry + stopDist) : setup.stopPrice, tgt = long ? entry + targetPts : entry - targetPts; let exit = sessBars[sessBars.length - 1].close;
  const beyond = long ? entry <= stop : entry >= stop;   // already through the structural stop at the open: filled at the open
  if (beyond && !mirror) exit = entry;
  else for (let i = entryIdx + 1; i < sessBars.length; i++) {
    const b = sessBars[i], stopHit = long ? b.low <= stop : b.high >= stop, hit = long ? b.high >= tgt : b.low <= tgt;
    if (stopHit) { exit = long ? Math.min(stop, b.open) : Math.max(stop, b.open); break; }
    if (hit) { exit = long ? Math.max(tgt, b.open) : Math.min(tgt, b.open); break; }
  }
  const pnl = (long ? exit - entry : entry - exit) * PPT - COMM; return { pnl, win: pnl > 0 };
}


// Bars with the per-minute-of-day 90-bar rolling volume z-score (the backtest's own construction). fromTs bounds the load.
export async function loadBarsWithVolZ(fromTs) {
  const allBars = (await query(`SELECT ts, open::float, high::float, low::float, close::float, COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume, (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 ORDER BY ts ASC`, [fromTs])).rows;
  const modQueues = Array.from({ length: 1440 }, () => []);
  for (const b of allBars) { const q = modQueues[b.mod]; let volZ = null; if (q.length >= 30) { const m = mean(q), sd = Math.sqrt(mean(q.map((x) => (x - m) ** 2))); if (sd > 0) volZ = (Number(b.volume) - m) / sd; } b.volZ = volZ; q.push(Number(b.volume)); if (q.length > 90) q.shift(); }
  return allBars;
}
