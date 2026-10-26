// Review sample for the defended-level finder (docs/DEFENDED_LEVEL_FINDER_SPEC_20261026.md). Seeded, outcome-blind: events with at least one NON-prior-day period line (PW/PM/3M/P3M),
// stratified by number of separate approaches A (1, 2, 3+), 20 each, half floors half tops where available, one per level-cluster per week at most. Chart data ends at the confirming bar.
import fs from 'fs';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
const E = JSON.parse(fs.readFileSync('scratch/defended_events_band0.25_20261026.json')).events, BARS = JSON.parse(fs.readFileSync('scratch/defended_bars_20261026.json'));
const pool = E.filter((e) => e.lines.some((l) => !l.startsWith('PD_')) && e.t >= 700);
const rng = mulberry32(hashSeed('defended-review-20261026')), pick = [], used = new Set();
const strata = [['A=1', (e) => e.A === 1], ['A=2', (e) => e.A === 2], ['A>=3', (e) => e.A >= 3]];
console.log('pool', pool.length, strata.map(([n, f]) => `${n}: ${pool.filter(f).length}`).join(', '));
for (const [nm, f] of strata) {
  const c = pool.filter(f).map((e) => ({ e, r: rng() })).sort((a, b) => a.r - b.r).map((x) => x.e); let got = { floor: 0, top: 0 };
  for (const e of c) { if (got.floor + got.top >= 20) break; const wk = e.td.slice(0, 8) + Math.floor(+e.td.slice(8, 10) / 7) + '|' + Math.round(e.level / 100); if (used.has(wk)) continue; if (got[e.side] >= 10) continue; used.add(wk); got[e.side]++; pick.push({ ...e, stratum: nm }); }
  console.log(nm, JSON.stringify(got));
}
// shuffle presentation order (seeded) so strata are not visible in the order
pick.sort((a, b) => hashSeed(a.key) - hashSeed(b.key));
const lineSets = {}; // price lines as of each event: recompute names/prices from the event itself (level only) plus the other period lines the finder used that day
const out = pick.map((e, i) => {
  const from = Math.max(0, e.t - 6 * 120); const w = BARS.slice(from, e.t + 1).map((b, k) => [k + from, b[1].slice(5, 16), b[2], b[3], b[4], b[5], b[7]]);
  return { id: 'E' + String(i + 1).padStart(2, '0'), key: e.key, side: e.side, level: +e.level.toFixed(2), band: +e.band.toFixed(2), lines: e.lines, K: e.K, A: e.A, relVol: e.relVol ? +e.relVol.toFixed(2) : null, date: e.td, defBars: e.defBars, tIdx: e.t, firstIdx: from, bars: w, stratum: e.stratum, ctx: e.ctx };
});
fs.writeFileSync('scratch/defended_review_events_20261026.json', JSON.stringify(out));
fs.writeFileSync('reports/defended_review_sample_index_20261026.json', JSON.stringify(out.map((o) => ({ id: o.id, key: o.key, side: o.side, date: o.date, level: o.level, lines: o.lines, K: o.K, A: o.A, relVol: o.relVol, stratum: o.stratum })), null, 1));
console.log('sampled', out.length, 'floors', out.filter((o) => o.side === 'floor').length, 'tops', out.filter((o) => o.side === 'top').length, 'json bytes', JSON.stringify(out).length);
