// Review sample for the sequential-run definition (scripts/lib/sequentialRuns.mjs): 12 runs at band 0.25 x H4 (seeded, outcome-blind): this morning's floor (2026-10-26) first as the anchor,
// then 2 floors + 2 tops from each of three run-length strata (4 bars, 5-6 bars, 7+ bars). Chart data ends at the bar where the run reaches 4 bars (the bar the event fires on).
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars } from './lib/floorEngine.mjs';
import { build4h } from './lib/fourHourLevels.mjs';
import { sequentialRuns } from './lib/sequentialRuns.mjs';
const end = (await query(`SELECT MAX(ts)::date::text d FROM price_bars_primary WHERE symbol='NQ'`)).rows[0].d;
const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', end))), { bars, h4 } = build4h(NQ);
const ev = sequentialRuns(bars, h4, { bandMult: 0.25 }), linesBy = JSON.parse(fs.readFileSync('scratch/defended_lines_by_date_20261026.json'));
// run length when it eventually ends (descriptive stratum only; no price outcome): extend the same run forward while it persists
const fullLen = (e) => { let n = e.len; const sg = e.dir, lo = (b) => (sg > 0 ? b.L : -b.H), cl = (b) => (sg > 0 ? b.C : -b.C); let mn = Math.min(...e.runBars.map(lo)), mx = Math.max(...e.runBars.map(lo)); for (let k = e.t + 1; k < bars.length; k++) { const l = lo(bars[k]); const nmn = Math.min(mn, l), nmx = Math.max(mx, l); if (nmx - nmn > e.band || !(cl(bars[k]) > nmn)) break; mn = nmn; mx = nmx; n++; } return n; };
const rng = mulberry32(hashSeed('sequential-run-review-20261026')), pick = [], used = new Set();
const anchor = ev.find((e) => e.side === 'floor' && e.td === '2026-10-26'); if (anchor) { pick.push({ e: anchor, stratum: 'this morning', anchor: true }); used.add(anchor.t); }
const strata = [['4 bars', (n) => n === 4], ['5-6 bars', (n) => n >= 5 && n <= 6], ['7+ bars', (n) => n >= 7]];
const pool = ev.filter((e) => e.t >= 700 && e.td < '2026-10-24').map((e) => ({ e, n: fullLen(e) }));
console.log('pool', pool.length, strata.map(([nm, f]) => `${nm}: ${pool.filter((x) => f(x.n)).length}`).join(', '));
for (const [nm, f] of strata) for (const side of ['floor', 'top']) { const c = pool.filter((x) => x.e.side === side && f(x.n) && !used.has(x.e.t)).map((x) => ({ x, r: rng() })).sort((a, b) => a.r - b.r); for (const { x } of c.slice(0, 2)) { pick.push({ e: x.e, stratum: nm, n: x.n }); used.add(x.e.t); } }
const out = pick.map(({ e, stratum, n, anchor }, i) => { const from = Math.max(0, e.t - 6 * 120); const w = []; for (let k = from; k <= e.t; k++) { const b = bars[k]; w.push([k, NQ.T[b.i0].slice(5, 16), b.O, b.H, b.L, b.C, b.relBase ? +(b.V / b.relBase).toFixed(2) : null]); }
  const rv = e.runBars.filter((b) => b.relBase).map((b) => b.V / b.relBase); const defBars = []; for (let k = e.s; k <= e.t; k++) defBars.push(k);
  return { id: 'S' + String(i + 1).padStart(2, '0'), key: `${e.side}|${e.t}`, side: e.side, level: +e.level.toFixed(2), band: +e.band.toFixed(2), lines: [], K: e.len, A: null, relVol: rv.length ? +(rv.reduce((a, b) => a + b, 0) / rv.length).toFixed(2) : null, date: e.td, defBars, tIdx: e.t, firstIdx: from, bars: w, stratum: anchor ? 'this morning' : `${stratum}`, ctx: linesBy[e.td] || [], run: true, batch: 'A', fullLen: n || null }; });
fs.writeFileSync('scratch/sequential_review_events_20261026.json', JSON.stringify(out));
console.log('sampled', out.length, out.map((o) => `${o.id}:${o.side}:${o.date}:${o.K}`).join(' '));
process.exit(0);
