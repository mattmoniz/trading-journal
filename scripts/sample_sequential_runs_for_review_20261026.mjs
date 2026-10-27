// Review sample for the sequential-run definition (scripts/lib/sequentialRuns.mjs): runs (seeded, outcome-blind): this morning's floor (2026-10-26) first as the anchor, then 3 floors + 3 tops found at band 0.25 x H4 and 4 floors + 4 tops found ONLY at band 0.35 x H4, shuffled. Chart data ends at the bar where the run reaches 4 bars (the bar the event fires on).
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars } from './lib/floorEngine.mjs';
import { build4h } from './lib/fourHourLevels.mjs';
import { sequentialRuns } from './lib/sequentialRuns.mjs';
const end = (await query(`SELECT MAX(ts)::date::text d FROM price_bars_primary WHERE symbol='NQ'`)).rows[0].d;
const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', end))), { bars, h4 } = build4h(NQ);
const ev25 = sequentialRuns(bars, h4, { bandMult: 0.25 }), ev35 = sequentialRuns(bars, h4, { bandMult: 0.35 }), linesBy = JSON.parse(fs.readFileSync('scratch/defended_lines_by_date_20261026.json'));
const in25 = new Set(ev25.map((e) => e.side + '|' + e.t)), only35 = ev35.filter((e) => !in25.has(e.side + '|' + e.t));
const rng = mulberry32(hashSeed('sequential-run-review-v2-20261026')), pick = [], used = new Set();
const anchor = ev25.find((e) => e.side === 'floor' && e.td === '2026-10-26'); if (anchor) { pick.push({ e: anchor, stratum: 'this morning', anchor: true }); used.add('floor|' + anchor.t); }
const ok = (e) => e.t >= 700 && e.td < '2026-10-24';
console.log('band 0.25 events', ev25.length, 'floors', ev25.filter((e) => e.side === 'floor').length, '| only at 0.35:', only35.length, 'floors', only35.filter((e) => e.side === 'floor').length);
for (const [nm, src, per] of [['band 0.25', ev25, 3], ['band 0.35 only', only35, 4]]) for (const side of ['floor', 'top']) { const c = src.filter((e) => e.side === side && ok(e) && !used.has(side + '|' + e.t)).map((e) => ({ e, r: rng() })).sort((a, b) => a.r - b.r); for (const { e } of c.slice(0, per)) { pick.push({ e, stratum: nm }); used.add(side + '|' + e.t); } }
pick.sort((a, b) => (a.anchor ? -1 : b.anchor ? 1 : hashSeed(a.e.side + a.e.t) - hashSeed(b.e.side + b.e.t))); // anchor first, rest shuffled (seeded)
const out = pick.map(({ e, stratum, anchor }, i) => { const from = Math.max(0, e.t - 6 * 120); const w = []; for (let k = from; k <= e.t; k++) { const b = bars[k]; w.push([k, NQ.T[b.i0].slice(5, 16), b.O, b.H, b.L, b.C, b.relBase ? +(b.V / b.relBase).toFixed(2) : null]); }
  const rv = e.runBars.filter((b) => b.relBase).map((b) => b.V / b.relBase); const defBars = []; for (let k = e.s; k <= e.t; k++) defBars.push(k);
  return { id: 'S' + String(i + 1).padStart(2, '0'), key: `${e.side}|${e.t}`, side: e.side, level: +e.level.toFixed(2), band: +e.band.toFixed(2), lines: [], K: e.len, A: null, relVol: rv.length ? +(rv.reduce((a, b) => a + b, 0) / rv.length).toFixed(2) : null, date: e.td, defBars, tIdx: e.t, firstIdx: from, bars: w, stratum: anchor ? 'this morning' : stratum, ctx: linesBy[e.td] || [], run: true, batch: 'A' }; });
fs.writeFileSync('scratch/sequential_review_events_20261026.json', JSON.stringify(out));
console.log('sampled', out.length, out.map((o) => `${o.id}:${o.side}:${o.date}:${o.K}`).join(' '));
process.exit(0);
