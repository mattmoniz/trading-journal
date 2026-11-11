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
  let exitIdx = sessBars.length - 1;                      // index of the bar the position closed in (added 2026-11-09 night for the capitulation replay; extra return fields only)
  if (beyond && !mirror) { exit = entry; exitIdx = entryIdx + 1; }
  else for (let i = entryIdx + 1; i < sessBars.length; i++) {
    const b = sessBars[i], stopHit = long ? b.low <= stop : b.high >= stop, hit = long ? b.high >= tgt : b.low <= tgt;
    if (stopHit) { exit = long ? Math.min(stop, b.open) : Math.max(stop, b.open); exitIdx = i; break; }
    if (hit) { exit = long ? Math.max(tgt, b.open) : Math.min(tgt, b.open); exitIdx = i; break; }
  }
  const pnl = (long ? exit - entry : entry - exit) * PPT - COMM; return { pnl, win: pnl > 0, entry, long, exitIdx };
}


// Bars with the per-minute-of-day 90-bar rolling volume z-score (the backtest's own construction). fromTs bounds the load.
export async function loadBarsWithVolZ(fromTs) {
  const allBars = (await query(`SELECT ts, open::float, high::float, low::float, close::float, COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume, (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 ORDER BY ts ASC`, [fromTs])).rows;
  const modQueues = Array.from({ length: 1440 }, () => []);
  for (const b of allBars) { const q = modQueues[b.mod]; let volZ = null; if (q.length >= 30) { const m = mean(q), sd = Math.sqrt(mean(q.map((x) => (x - m) ** 2))); if (sd > 0) volZ = (Number(b.volume) - m) / sd; } b.volZ = volZ; q.push(Number(b.volume)); if (q.length > 90) q.shift(); }
  return allBars;
}

// ---- Event enumeration (added 2026-11-09 for the outcome-blind flush phase-1 count). These three functions are a verbatim extraction of the RTH trigger loop and
// ---- the Globex value-departure loop inside scripts/backtest_flush_patterns.mjs main() (which cannot be imported). PARITY CHECK: the counts they produce must equal the
// ---- sample sizes of the last backtest run (performance_audit OPTIMAL_STOP rows); scripts/flush_phase1_blind_counts_20261109.mjs asserts it. No outcome is read here.
export function groupBarsByDate(allBars) {
  const byDate = new Map();
  for (let i = 0; i < allBars.length; i++) { const b = allBars[i]; b._idx = i; const d = b.ts.toISOString().slice(0, 10); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(b); }
  return byDate;
}
export function groupRthByDate(allBars) {
  const m = new Map();
  for (const b of allBars) { if (b.mod < 570 || b.mod > 959) continue; const d = b.ts.toISOString().slice(0, 10); if (!m.has(d)) m.set(d, []); m.get(d).push(b); }
  return m;
}
// First trigger bar index of an RTH session: earliest of (close beyond the 60-min IB after it ends) and (close beyond ONH/ONL), or null.
export function rthTriggerIdx(sessBars, levels) {
  const ibBars = sessBars.filter((b) => b.mod < IB_END_MOD);
  let ibIdx = null;
  if (ibBars.length >= 30) {
    const ibHigh = Math.max(...ibBars.map((b) => b.high)), ibLow = Math.min(...ibBars.map((b) => b.low));
    for (let i = 0; i < sessBars.length; i++) { if (sessBars[i].mod < IB_END_MOD) continue; if (sessBars[i].close > ibHigh || sessBars[i].close < ibLow) { ibIdx = i; break; } }
  }
  const onh = levels ? levels['ONH'] : null, onl = levels ? levels['ONL'] : null;
  let onIdx = null;
  if (onh != null && onl != null) for (let i = 0; i < sessBars.length; i++) { if (sessBars[i].close > onh || sessBars[i].close < onl) { onIdx = i; break; } }
  if (ibIdx !== null && onIdx !== null) return Math.min(ibIdx, onIdx);
  return ibIdx !== null ? ibIdx : onIdx;
}
// Globex departures: per RTH date, the first bar in 15:59-16:29 ET (mod 959..989) closing below PD_VAL (DOWN) or above PD_VAH (UP). allBars[i]._idx must be set (groupBarsByDate).
export function findGlobexDepartures(rthByDate, barsByDate, getLevelsForDate) {
  const out = [];
  for (const date of rthByDate.keys()) {
    const levels = getLevelsForDate(date), val = levels?.PD_VAL, vah = levels?.PD_VAH;
    if (val == null || vah == null) continue;
    for (const b of barsByDate.get(date).filter((x) => x.mod >= 959 && x.mod <= 989)) {
      if (b.close < val) { out.push({ date, dir: 'DOWN', departurePrice: b.close, globalIdx: b._idx }); break; }
      if (b.close > vah) { out.push({ date, dir: 'UP', departurePrice: b.close, globalIdx: b._idx }); break; }
    }
  }
  return out;
}
// Continuous bar sequence from the departure bar to the next RTH open (a direct slice of the global array).
export function globexSequenceFor(allBars, dep) {
  const out = [];
  for (let i = dep.globalIdx; i < allBars.length; i++) { const b = allBars[i]; if (i > dep.globalIdx && b.mod >= 570 && b.mod <= 959) break; out.push(b); }
  return out;
}

// ---- LIVE-FAITHFUL Globex enumeration (added 2026-11-09). Mirrors server/services/globexFlushDetector.js, NOT the backtest:
// departure day D = every calendar day with bars (Sundays included); departure = FIRST bar in [D 15:59, D+1 09:29] (bars with mod>=959 on D, mod<570 on D+1) whose
// close is below PD_VAL (DOWN) or above PD_VAH (UP), levels from the nearest checkpoint on/AFTER D (live `trade_date >= D ORDER BY trade_date ASC`, per level);
// postBars = later bars of that same window (RTH hours excluded), >= 31 needed, computeBalanceAndResolution on them. One event per departure day.
// Validate against active_setups (trade_date = D, fired_at = entry bar ts) before trusting any count.
export async function loadFollowingLevels() {
  const rows = (await query(`SELECT trade_date::text AS d, level_name, price::float FROM level_prices WHERE level_name IN ('PD_VAL','PD_VAH') AND price IS NOT NULL ORDER BY trade_date ASC`)).rows;
  const by = { PD_VAL: [], PD_VAH: [] };
  for (const r of rows) by[r.level_name].push([r.d, r.price]);
  return (D, name) => { const a = by[name]; let lo = 0, hi = a.length - 1, best = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid][0] >= D) { best = mid; hi = mid - 1; } else lo = mid + 1; } return best === -1 ? null : a[best][1]; };
}
const nextDay = (d) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
export function findGlobexEventsLive(barsByDate, followingLevel) {
  const out = [];
  for (const D of [...barsByDate.keys()].sort()) {
    const cand = [...(barsByDate.get(D) || []).filter((b) => b.mod >= 959), ...(barsByDate.get(nextDay(D)) || []).filter((b) => b.mod < 570)];
    if (!cand.length) continue;
    const val = followingLevel(D, 'PD_VAL'), vah = followingLevel(D, 'PD_VAH');
    if (val == null || vah == null) continue;
    let di = -1, dir = null;
    for (let i = 0; i < cand.length; i++) { if (cand[i].close < val) { di = i; dir = 'DOWN'; break; } if (cand[i].close > vah) { di = i; dir = 'UP'; break; } }
    if (di < 0) continue;
    const post = cand.slice(di + 1);
    if (post.length < 31) continue;
    const res = computeBalanceAndResolution(post);
    if (!res) continue;
    const entryBar = post[res.resolutionIdx];
    out.push({ D, depDir: dir, depBar: cand[di], res, entryBar, post, mode: dir === res.resolutionDir ? 'CONTINUATION' : 'REVERSAL', dir: res.resolutionDir === 'UP' ? 'LONG' : 'SHORT' });
  }
  return out;
}

// ---- Outcome-blind event features (geometry known at the entry bar), shared by the phase-1 scripts. ADR20 = mean RTH range of the 20 sessions (>=200 bars) before the
// ---- date (strictly before for RTH events, up to and including the departure day for Globex, whose RTH of that day is complete). No post-entry bar is read.
export function makeAdrBefore(rthByDate) {
  const range = new Map();
  for (const [d, bs] of rthByDate) if (bs.length >= 200) range.set(d, Math.max(...bs.map((b) => b.high)) - Math.min(...bs.map((b) => b.low)));
  const ds = [...range.keys()].sort();
  return (d, inclusive) => { const prior = ds.filter((x) => (inclusive ? x <= d : x < d)); return prior.length >= 20 ? mean(prior.slice(-20).map((x) => range.get(x))) : null; };
}
export function buildRthBlindEvents(rthByDate, getLevelsForDate, adrBefore) {
  const out = [];
  for (const [date, sessBars] of rthByDate) {
    const t = rthTriggerIdx(sessBars, getLevelsForDate(date)); if (t === null) continue;
    const res = computeBalanceAndResolution(sessBars.slice(t + 1)); if (!res) continue;
    const eb = sessBars[t + 1 + res.resolutionIdx];
    out.push({ session: 'RTH', mode: 'RTH', dir: res.resolutionDir === 'UP' ? 'LONG' : 'SHORT', date, entryTs: eb.ts, fireMin: eb.mod - 570, box: res.balanceHigh - res.balanceLow, stopDist: Math.abs(res.entryPrice - res.stopPrice), adr: adrBefore(date, false), dow: eb.ts.getUTCDay(),
      setup: { sessBars, entryIdx: t + 1 + res.resolutionIdx, resolutionDir: res.resolutionDir, entryPrice: res.entryPrice, stopPrice: res.stopPrice } });
  }
  return out;
}
export function buildGlobexBlindEventsLive(barsByDate, followingLevel, adrBefore) {
  return findGlobexEventsLive(barsByDate, followingLevel).map((e) => {
    const m = e.entryBar.mod;
    return { session: 'GLOBEX', mode: e.mode, dir: e.dir, date: e.D, entryTs: e.entryBar.ts, fireMin: m >= 960 ? m - 960 : m + 480, box: e.res.balanceHigh - e.res.balanceLow,
      stopDist: Math.abs(e.res.entryPrice - e.res.stopPrice), adr: adrBefore(e.D, true), dow: new Date(e.D + 'T12:00:00Z').getUTCDay(),
      setup: { sessBars: e.post, entryIdx: e.res.resolutionIdx, resolutionDir: e.res.resolutionDir, entryPrice: e.res.entryPrice, stopPrice: e.res.stopPrice } };
  });
}
