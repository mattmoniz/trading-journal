// pocJoinLoader.mjs -- shared loader for the 2026-10-20 POC_ROTATION_JOIN research scripts (bars in flat arrays, session/ATR helpers, the REAL detectSignalEvents event builder, the realistic-fill live-exit simulator E1).
// Extracted so the next scripts stop copy-pasting the loader (3 copies existed). Research use only; nothing live imports this.
import { query } from '../../server/db.js';
import { detectSignalEvents } from '../../server/services/pocRotationService.js';
import { isInsideNqRollWeek } from '../../server/services/acdShared.js';
export const sum = (a) => { let s = 0; for (const x of a) s += x; return s; };
export const mean = (a) => a.length ? sum(a) / a.length : NaN;
export const f = (x, d = 1) => (x == null || Number.isNaN(x) ? ' n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
export const epoch = (ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16)) / 60000;   // naive-as-UTC: only differences are used
export const addDay = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const lb = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };
export const ub = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; };
export async function loadBars(from, to) {
  const D = { T: [], TS: [], O: [], H: [], L: [], C: [], V: [] };
  let cur = new Date(from + 'T00:00:00Z'); cur.setUTCDate(cur.getUTCDate() - 200); const end = new Date(to + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 3);
  while (cur < end) { const nxt = new Date(cur); nxt.setUTCDate(nxt.getUTCDate() + 31);
    for (const x of (await query(`SELECT ts::text ts, open::float o, high::float h, low::float l, close::float c, COALESCE(volume,0)::float v FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)])).rows) { D.TS.push(x.ts); D.T.push(epoch(x.ts)); D.O.push(x.o); D.H.push(x.h); D.L.push(x.l); D.C.push(x.c); D.V.push(x.v); }
    cur = nxt; }
  return D;
}
export function sessionIndex(D) {               // RTH session [a,b) per date, sorted dates, ATR20 (mean RTH range of the 20 prior sessions)
  const rth = new Map(); const seen = new Set(); for (let i = 0; i < D.TS.length; i++) { const d = D.TS[i].slice(0, 10); if (seen.has(d)) continue; seen.add(d); const a = lb(D.TS, d + ' 09:30:00'), b = lb(D.TS, d + ' 16:00:00'); if (b - a > 300) rth.set(d, [a, b]); }
  const dates = [...rth.keys()].sort(), rng = new Map(); for (const d of dates) { const [a, b] = rth.get(d); let hi = -Infinity, lo = Infinity; for (let i = a; i < b; i++) { hi = Math.max(hi, D.H[i]); lo = Math.min(lo, D.L[i]); } rng.set(d, hi - lo); }
  const atr20 = (d) => { const j = lb(dates, d); return j >= 20 ? mean(dates.slice(j - 20, j).map(x => rng.get(x))) : null; };
  return { rth, dates, atr20 };
}
// THETA = max(0.25, median 1-minute bar range over the 180 days before date d), computed in memory (same value as the SQL PERCENTILE_CONT(0.5) the original scripts ran per date, ~100x faster); memoized per date.
const _theta = new Map();
function thetaFor(D, d) { if (_theta.has(d)) return _theta.get(d); const a = lb(D.TS, addDay(d, -180) + ' 00:00:00'), b = lb(D.TS, d + ' 00:00:00'); let out = 6.75; if (b > a) { const v = new Float64Array(b - a); for (let i = a; i < b; i++) v[i - a] = D.H[i] - D.L[i]; v.sort(); const n = v.length, pos = (n - 1) * 0.5, lo = Math.floor(pos), hi = Math.ceil(pos), m = v[lo] + (v[hi] - v[lo]) * (pos - lo); out = Math.max(0.25, m); } _theta.set(d, out); return out; }
// events from the REAL detector. opts: { R: 65, rMode: 'fixed'|'pct' }. Returns events with entry/anchor/leg info; `ei` = global index of the entry bar.
export async function buildEvents(D, from, to, opts = {}) {
  const { R = 65, rMode = 'fixed' } = opts, { T, TS, O, H, L, C } = D, events = [];
  const dates = (await query(`SELECT DISTINCT trade_date::text d FROM developing_value_log WHERE trade_date >= $1::date AND trade_date <= $2::date ORDER BY d`, [from, to])).rows.map(r => r.d).filter(d => !isInsideNqRollWeek(d));
  for (const d of dates) {
    const a = lb(TS, addDay(d, -1) + ' 18:00:00'), b = lb(TS, d + ' 17:00:00'); const bars = []; for (let i = a; i < b; i++) bars.push({ ts: TS[i], open: O[i], high: H[i], low: L[i], close: C[i] });
    if (bars.length < 100 || bars.length < 0.9 * (T[b - 1] - T[a] + 1)) continue;
    const theta = thetaFor(D, d);
    const { all_signal } = detectSignalEvents(R, 'standard', theta, [{ t: d, bars }], rMode);
    for (const ev of all_signal) { if (ev.entry_idx == null) continue; const ei = a + ev.entry_idx, long = ev.direction === 'UP', ls = a + ev.leg_start;
      events.push({ d, ep: T[ei], ei, trig: ei - 1, a, legStart: ls, entry: O[ei], long, anchor: long ? L[ls] : H[ls], L24: ev.L, len: ev.len, d50: ev.d50, pocDist: ev.poc_dist }); } }
  events.sort((x, y) => x.ep - y.ep); return events;
}
// forward window: strictly after the entry bar up to min(next event, entry+24h). Returns [fi,last] global indices or null.
export function fwd(D, events, i) { const e = events[i], bound = Math.min(e.ep + 1440, i + 1 < events.length ? events[i + 1].ep : Infinity), fi = ub(D.T, e.ep), last = ub(D.T, bound) - 1; return last - fi + 1 >= 2 ? [fi, last] : null; }
// realistic-fill live exit E1 for direction `long` with stop distance `stopPts` (breakeven from forward bar `armBars`; stop beyond the market fills at the bar open). Returns { pnl, k }
export function simE1(D, e, fi, last, { long = e.long, stopPts = 100, armBars = 60 } = {}) {
  const { O, H, L, C } = D; let stop = long ? e.entry - stopPts : e.entry + stopPts, armed = false;
  for (let k = fi; k <= last; k++) { if (!armed && k - fi >= armBars) { armed = true; stop = e.entry; }
    if (long ? L[k] <= stop : H[k] >= stop) { const fill = long ? Math.min(stop, O[k]) : Math.max(stop, O[k]); return { pnl: (long ? fill - e.entry : e.entry - fill) * 2 - 2, k }; } }
  return { pnl: (long ? C[last] - e.entry : e.entry - C[last]) * 2 - 2, k: last }; }
let _seed = 20261020; export const rnd = () => (_seed = (_seed * 1664525 + 1013904223) >>> 0) / 4294967296;
export function dayCI(arr, fn, n = 1500) { const by = new Map(); for (const r of arr) (by.get(r.d) || by.set(r.d, []).get(r.d)).push(fn(r)); const ds = [...by.values()], S = ds.map(sum), Cn = ds.map(x => x.length), o = []; for (let b = 0; b < n; b++) { let s = 0, c = 0; for (let k = 0; k < ds.length; k++) { const j = (rnd() * ds.length) | 0; s += S[j]; c += Cn[j]; } if (c) o.push(s / c); } o.sort((a, b) => a - b); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
