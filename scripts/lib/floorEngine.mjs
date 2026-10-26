// Shared floor/episode/sequence engine (extracted 2026-10-26 from study_floor_hold_to_poc_20261026.mjs so the entry-quality study reuses the SAME code, not a copy).
import fs from 'fs';
import { query } from '../../server/db.js';
import { hashSeed, mulberry32 } from '../../server/services/rigorDiagnostics.js';
import { isInsideNqRollWeek } from '../../server/services/acdShared.js';

export const FAMS = ['PW', '3M', 'PM', 'PD', 'PY']; export const START = process.env.FH_START || '2023-03-06';
export const SPARSE = (d) => d >= '2025-09-28' && d <= '2025-11-19';
export const addDay = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const tradeDateOf = (ts) => (+ts.slice(11, 13) >= 18 ? addDay(ts.slice(0, 10), 1) : ts.slice(0, 10));
export const clock = (ts) => +ts.slice(11, 13) * 60 + +ts.slice(14, 16);
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
export const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };

export async function loadBars(table, where, startDate, endDate, cols) {
  const T = [], O = [], H = [], L = [], C = [];
  let m = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (m <= end) {
    const a = m.toISOString().slice(0, 10), nx = new Date(m); nx.setUTCMonth(nx.getUTCMonth() + 1); const b = nx.toISOString().slice(0, 10);
    const r = await query(`SELECT ts::text t, open::float o, high::float h, low::float l, close::float c FROM ${table} WHERE ${where} AND ts >= $1 AND ts < $2 ORDER BY ts`, [a, b]);
    for (const x of r.rows) { T.push(x.t.slice(0, 19)); O.push(x.o); H.push(x.h); L.push(x.l); C.push(x.c); }
    m = nx;
  }
  return { T, O, H, L, C, n: T.length };
}
export function prep(B) {
  B.TD = B.T.map(tradeDateOf);
  const q = new Map(); // 15-minute ranges per trade date
  for (let i = 0; i < B.n; i++) { const key = B.T[i].slice(0, 14) + String(Math.floor(+B.T[i].slice(14, 16) / 15) * 15).padStart(2, '0'); let o = q.get(key); if (!o) q.set(key, (o = { td: B.TD[i], h: -Infinity, l: Infinity })); o.h = Math.max(o.h, B.H[i]); o.l = Math.min(o.l, B.L[i]); }
  const byDay = new Map(); for (const o of q.values()) { const d = byDay.get(o.td) || { s: 0, n: 0 }; d.s += o.h - o.l; d.n++; byDay.set(o.td, d); }
  const days = [...byDay.keys()].sort(); B.days = days; B.A15 = {};
  days.forEach((d, i) => { if (i >= 20) { let s = 0; for (let j = i - 20; j < i; j++) s += byDay.get(days[j]).s / byDay.get(days[j]).n; B.A15[d] = s / 20; } });
  const rthEnd = new Map(), lastOf = new Map(); // last bar of each trade date: RTH close (<16:00 on the calendar date itself) else the last bar of the date
  for (let i = 0; i < B.n; i++) { lastOf.set(B.TD[i], i); if (B.T[i].slice(0, 10) === B.TD[i] && clock(B.T[i]) < 960) rthEnd.set(B.TD[i], i); }
  B.capIdx = (d) => (rthEnd.get(d) ?? lastOf.get(d));
  return B;
}
export function neg(B) { return { ...B, O: B.O.map((x) => -x), H: B.L.map((x) => -x), L: B.H.map((x) => -x), C: B.C.map((x) => -x) }; }

export function walk(B, i0, dir, entry, stopDist, tgtDist, cap) {
  const stop = entry - dir * stopDist, tgt = entry + dir * tgtDist; let mfe = 0;
  for (let i = i0; i <= cap; i++) {
    if (dir > 0) {
      if (B.L[i] <= stop) return { res: 'S', pts: Math.min(stop, B.O[i]) - entry, mfe, t: i - i0 };   // gap-through fills at the open; stop checked before target in the same bar (conservative)
      if (B.H[i] >= tgt) return { res: 'T', pts: tgtDist, mfe: tgtDist, t: i - i0 };
      mfe = Math.max(mfe, B.H[i] - entry);
    } else {
      if (B.H[i] >= stop) return { res: 'S', pts: entry - Math.max(stop, B.O[i]), mfe, t: i - i0 };
      if (B.L[i] <= tgt) return { res: 'T', pts: tgtDist, mfe: tgtDist, t: i - i0 };
      mfe = Math.max(mfe, entry - B.L[i]);
    }
  }
  return { res: 'C', pts: dir * (B.C[cap] - entry), mfe, t: cap - i0 };
}

// episodes/sequences per the pre-registration; lv(td) -> {val, poc} (already mirrored when B is negated)
export function findEvents(B, fam, lv, pm, sm) {
  const out = []; let seq = null, seqId = 0;
  for (let i = 0; i < B.n - 1; i++) {
    const td = B.TD[i], a = B.A15[td], row = lv(td);
    if (!row || !a || isInsideNqRollWeek(td) || SPARSE(td) || !(row.val < row.poc)) { seq = null; continue; }
    if (seq && Math.abs(row.val - seq.val) > pm * a) seq = null;
    if (!seq) seq = { id: ++seqId, val: row.val, k: 0, inEp: false, armed: false, epLow: Infinity, epStart: 0, prevLow: null, prevStart: 0, prevEnd: 0, approachLow: Infinity, lastEnd: 0, k3: false };
    seq.val = row.val;
    if (B.C[i] <= seq.val - sm * a || B.H[i] >= row.poc) { seq = null; continue; }   // decisive break, or POC reached: sequence resolved
    const zoneHi = seq.val + pm * a, esc = seq.val + 2 * pm * a;
    if (!seq.inEp) {
      seq.approachLow = Math.min(seq.approachLow, B.L[i]);
      if (B.L[i] > esc) seq.armed = true;
      if (seq.armed && B.L[i] <= zoneHi) {
        seq.k++; if (seq.k >= 3 && seq.k3) out.dropK3 = (out.dropK3 || 0) + 1; seq.inEp = true; seq.epLow = B.L[i]; seq.epStart = i;
        const arm = seq.k === 1 ? 'K1' : seq.k === 2 ? 'K2' : (!seq.k3 ? 'K3P' : null); if (seq.k >= 3) seq.k3 = true;
        if (arm && clock(B.T[i + 1]) !== undefined) out.push({ fam, arm, k: seq.k, seq: seq.id, i, val: seq.val, poc: row.poc, a, prevLow: seq.prevLow, prevStart: seq.prevStart, prevEnd: seq.prevEnd, approachLow: seq.approachLow, lastEnd: seq.lastEnd });
      }
    } else {
      seq.epLow = Math.min(seq.epLow, B.L[i]);
      if (B.L[i] > esc) { seq.inEp = false; seq.prevLow = seq.epLow; seq.prevStart = seq.epStart; seq.prevEnd = i; seq.approachLow = Infinity; seq.lastEnd = i; }
    }
  }
  return out;
}
function simulate(B, evs, sm, rng, trials = 0) {
  const res = []; res.censored = 0;
  for (const e of evs) {
    const i0 = e.i + 1, entry = B.O[i0], td0 = B.TD[i0], di = B.days.indexOf(td0);
    if (di < 0 || di + 2 >= B.days.length) { res.censored++; continue; }                          // censored near the end of data
    if (B.T.length && (Date.parse(B.T[i0].replace(' ', 'T') + 'Z') - Date.parse(B.T[e.i].replace(' ', 'T') + 'Z')) > 300000) { res.censored++; continue; }   // next bar more than 5 min later: no clean fill
    const cap = B.capIdx(B.days[di + 2]), a = e.a, stopDist = entry - (e.val - sm * a), tgtDist = e.poc - entry;
    if (!(stopDist > 0) || !(tgtDist > 0) || cap == null || cap < i0) continue;
    const real = walk(B, i0, 1, entry, stopDist, tgtDist, cap), mir = walk(B, i0, -1, entry, stopDist, tgtDist, cap);
    const rnd = []; for (let k = 0; k < trials; k++) rnd.push(walk(B, i0, rng() < 0.5 ? 1 : -1, entry, stopDist, tgtDist, cap));
    res.push({ ...e, day: td0, sess: B.T[i0].slice(0, 10) === td0 && clock(B.T[i0]) >= 570 && clock(B.T[i0]) < 960 ? 'RTH' : 'GLOBEX', entry, stopDist, tgtDist, atrDist: tgtDist / a, real, mir, rnd, base: stopDist / (stopDist + tgtDist) });
  }
  return res;
}


// Level table + lookup (first level_prices row with trade_date >= the bar's trade date; mirror=true gives the VAH-ceiling version for negated bars).
export async function loadLevels() {
  const lvRows = (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE level_name ~ '^(PW|3M|PM|PD|PY)_(VAL|POC|VAH)$' AND trade_date >= '2023-02-01' ORDER BY trade_date`)).rows;
  const tab = {}; for (const r of lvRows) { const [f, k] = r.n.split('_'); ((tab[f] ||= new Map()).get(r.d) || tab[f].set(r.d, {}).get(r.d))[k] = r.p; }
  return (f, mirror) => { const ds = [...tab[f].keys()].sort(), cache = new Map(); return (td) => { if (cache.has(td)) return cache.get(td); let lo = 0, hi = ds.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ds[m] >= td) hi = m; else lo = m + 1; } const r = lo < ds.length ? tab[f].get(ds[lo]) : null; const v = r && r.VAL != null && r.POC != null && r.VAH != null ? (mirror ? { val: -r.VAH, poc: -r.POC } : { val: r.VAL, poc: r.POC }) : null; cache.set(td, v); return v; }; };
}
