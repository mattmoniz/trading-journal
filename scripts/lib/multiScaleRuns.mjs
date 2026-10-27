// Sequential defended runs at several bar sizes, merged to ONE event per floor/top episode (user, 2026-10-26: "they all stopped at the same floor" at any bar size; the bar size does not matter).
// Per scale: scripts/lib/sequentialRuns.mjs with that scale's own band (0.25 x mean bar range of the 20 prior days), 4+ bars, prior reference required (130 trade days' worth of bars). Merge: same side, fired within
// `mergeMinutes` of each other and run extremes within `mergeBand` x H4 -> keep the EARLIEST firing; record every scale that fired. Entry = open of the first 1-minute bar after the firing bar.
import { sequentialRuns } from './sequentialRuns.mjs';
import { buildBars } from './barBuilder.mjs';
export function multiScaleEvents(NQ, h4ByTd, { scales = [60, 120, 240], bandMult = 0.25, mergeMinutes = 720, mergeBand = 0.25, limit = NQ.n } = {}) {
  const all = [];
  for (const m of scales) {
    const { bars, h } = buildBars(NQ, m), refLookback = Math.round((130 * 1380) / m), maxLookback = Math.max(40, Math.round(40 * 240 / m));
    for (const e of sequentialRuns(bars, h, { bandMult, minLen: 4, maxLookback, refLookback })) {
      const b = bars[e.t], i0 = b.i1 + 1; if (i0 >= limit - 3000) continue; const H4 = h4ByTd[b.td]; if (!H4) continue;
      const rv = e.runBars.filter((x) => x.relBase).map((x) => x.V / x.relBase);
      all.push({ scale: m, side: e.side, dir: e.dir, i0, em: NQ.EM[i0], tdBar: b.td, day: NQ.TD[i0], H4, extreme: e.level, len: e.len, runStartI: e.runBars[0].i0, relVol: rv.length ? rv.reduce((a, c) => a + c, 0) / rv.length : null, bar: m });
    }
  }
  all.sort((a, b) => a.em - b.em);
  const out = [];
  for (const e of all) { const dup = out.find((o) => o.side === e.side && e.em - o.em <= mergeMinutes && Math.abs(o.extreme - e.extreme) <= mergeBand * o.H4); if (dup) { dup.scales.push(e.scale); continue; } out.push({ ...e, scales: [e.scale] }); }
  return out;
}
