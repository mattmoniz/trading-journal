// Four-hour defended-level builders (extracted 2026-10-26 from study_four_hour_defended_level_20261026.mjs so the live check reuses the SAME code).
import { isInsideNqRollWeek } from '../../server/services/acdShared.js';
import { clock, mean, SPARSE } from './floorEngine.mjs';
export const WIN = 6, LIFE = 12;
const elapsed = (c) => (c >= 1080 ? c - 1080 : c + 360);
export function build4h(NQ) {
  const by = new Map(); for (let i = 0; i < NQ.n; i++) { const c = clock(NQ.T[i]); if (c >= 1020 && c < 1080) continue; const key = NQ.TD[i] + '|' + Math.min(5, Math.floor(elapsed(c) / 240)); let o = by.get(key); if (!o) by.set(key, (o = { td: NQ.TD[i], slot: +key.split('|')[1], i0: i, i1: i, H: -Infinity, L: Infinity, V: 0, n: 0 })); o.i1 = i; o.H = Math.max(o.H, NQ.H[i]); o.L = Math.min(o.L, NQ.L[i]); o.V += NQ.V[i] || 0; o.n++; o.O ??= NQ.O[i]; o.C = NQ.C[i]; }
  const bars = [...by.values()].filter((b) => b.n >= 60).sort((a, b) => NQ.EM[a.i0] - NQ.EM[b.i0]);
  const perTd = new Map(); for (const b of bars) (perTd.get(b.td) || perTd.set(b.td, []).get(b.td)).push(b.H - b.L); const tds = [...perTd.keys()].sort(), h4 = {}, volSlot = new Map();
  tds.forEach((d, k) => { if (k >= 20) h4[d] = mean(tds.slice(k - 20, k).flatMap((x) => perTd.get(x))); });
  const slotV = new Map(); for (const b of bars) { const k = b.slot; (slotV.get(k) || slotV.set(k, []).get(k)).push({ td: b.td, v: b.V }); }
  for (const b of bars) { const prior = slotV.get(b.slot).filter((x) => x.td < b.td).slice(-20); b.relBase = prior.length >= 10 ? mean(prior.map((x) => x.v)) : null; }
  return { bars, h4 };
}
export const negBars = (bars) => bars.map((b) => ({ ...b, H: -b.L, L: -b.H, O: -b.O, C: -b.C }));
export function runLevels(bars, h4, bandMult) {
  const ev = [], funnel = { born: 0, k2: 0, k3: 0, k4: 0, k5: 0, brokeBeforeK3: 0, expired: 0 }; let active = [], id = 0;
  for (let t = 0; t < bars.length; t++) {
    const b = bars[t], H4 = h4[b.td]; if (!H4 || isInsideNqRollWeek(b.td) || SPARSE(b.td)) { active = []; continue; } const band = bandMult * H4;
    const keep = [];
    for (const lv of active) {
      if (t - lv.t0 > LIFE) { funnel.expired++; continue; }
      if (b.C <= lv.L - band) { if (lv.K >= 3) ev.push({ kind: 'BRK', K: lv.K, id: lv.id, t, td: b.td, level: lv.L, brk: (lv.L - b.C) / H4 }); else { funnel.brokeBeforeK3++; ev.push({ kind: 'BRK1', K: lv.K, id: lv.id, t, td: b.td, level: lv.L, brk: (lv.L - b.C) / H4 }); } continue; }
      if (b.L >= lv.L - band && b.L <= lv.L + band && b.C > lv.L - band) { lv.K++; lv.vols.push(b); if (lv.K === 2) funnel.k2++; if (lv.K >= 3) { const kk = Math.min(lv.K, 5); if (lv.K === 3) funnel.k3++; if (lv.K === 4) funnel.k4++; if (lv.K === 5) funnel.k5++; if (lv.K <= 5) ev.push({ kind: 'K' + kk, K: lv.K, id: lv.id, t, td: b.td, level: lv.L, bars: lv.vols.slice() }); } }
      keep.push(lv);
    }
    active = keep;
    if (t >= WIN - 1) { let lo = Infinity; for (let k = t - WIN + 1; k <= t; k++) lo = Math.min(lo, bars[k].L); if (b.L <= lo && !active.some((lv) => Math.abs(lv.L - b.L) <= band)) { const lv = { id: ++id, L: b.L, t0: t, K: 1, vols: [b] }; active.push(lv); funnel.born++; ev.push({ kind: 'K1', K: 1, id: lv.id, t, td: b.td, level: lv.L }); } }
  }
  return { ev, funnel };
}
