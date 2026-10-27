// Session-aligned bars of any size (60, 120, 240, ...) from 1-minute bars: the generalization of build4h() in fourHourLevels.mjs (same alignment: 18:00 ET Globex open, the 17:00-18:00 maintenance hour skipped,
// the last bar of a session absorbs the short tail, bars with under 60 one-minute rows dropped). `h[td]` = mean bar range over the 20 prior trade days (the scale for bands and stops); `relBase` = mean volume
// of the SAME slot over the 20 prior trade days (volume vs normal). buildBars(NQ, 240) is checked against build4h(NQ) by scripts/test_bar_builder_20261026.mjs.
import { clock, mean } from './floorEngine.mjs';
const elapsed = (c) => (c >= 1080 ? c - 1080 : c + 360);
export function buildBars(NQ, barMinutes, minRows = null) {
  const nSlots = Math.ceil(1380 / barMinutes), need = minRows ?? Math.min(60, Math.floor(barMinutes / 2) || 1), by = new Map();
  for (let i = 0; i < NQ.n; i++) { const c = clock(NQ.T[i]); if (c >= 1020 && c < 1080) continue; const slot = Math.min(nSlots - 1, Math.floor(elapsed(c) / barMinutes)), key = NQ.TD[i] + '|' + slot; let o = by.get(key); if (!o) by.set(key, (o = { td: NQ.TD[i], slot, i0: i, i1: i, H: -Infinity, L: Infinity, V: 0, n: 0 })); o.i1 = i; o.H = Math.max(o.H, NQ.H[i]); o.L = Math.min(o.L, NQ.L[i]); o.V += NQ.V[i] || 0; o.n++; o.O ??= NQ.O[i]; o.C = NQ.C[i]; }
  const bars = [...by.values()].filter((b) => b.n >= need).sort((a, b) => NQ.EM[a.i0] - NQ.EM[b.i0]);
  const perTd = new Map(); for (const b of bars) (perTd.get(b.td) || perTd.set(b.td, []).get(b.td)).push(b.H - b.L); const tds = [...perTd.keys()].sort(), h = {};
  tds.forEach((d, k) => { if (k >= 20) h[d] = mean(tds.slice(k - 20, k).flatMap((x) => perTd.get(x))); });
  const slotV = new Map(); for (const b of bars) (slotV.get(b.slot) || slotV.set(b.slot, []).get(b.slot)).push({ td: b.td, v: b.V });
  for (const b of bars) { const prior = slotV.get(b.slot).filter((x) => x.td < b.td).slice(-20); b.relBase = prior.length >= 10 ? mean(prior.map((x) => x.v)) : null; }
  return { bars, h };
}
