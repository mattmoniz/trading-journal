// Validation gate for docs/STOP_RUN_DEPTH_PREREG_20261021.md (as amended): rebuilt book vs traded range, per session; chooses the candidate contract file per date.
import fs from 'fs';
const dd = 'scratch/depth_persec_20261021', pp = 'scratch/persec_px_20261021';
const byDate = new Map(); for (const f of fs.readdirSync(dd).filter((x) => x.endsWith('.tsv'))) { const d = f.slice(0, 10); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(f); }
const chosen = {}, relaxed = {}, rows = [];
for (const [d, files] of [...byDate].sort()) { if (!fs.existsSync(`${pp}/${d}.tsv`)) { rows.push({ d, note: 'no price archive' }); continue; }
  const tr = new Map(); for (const l of fs.readFileSync(`${pp}/${d}.tsv`, 'utf8').split('\n')) { if (!l) continue; const p = l.split('\t'); tr.set(+p[0], { lo: +p[3], hi: +p[4], last: +p[5] }); }
  let best = null; for (const f of files) { let n = 0, crossed = 0, ov = 0, inside = 0; for (const l of fs.readFileSync(`${dd}/${f}`, 'utf8').split('\n')) { if (!l) continue; const p = l.split('\t'), s = +p[0], bb = +p[1], ba = +p[2], t = tr.get(s); if (!t) continue; n++; if (bb >= ba) crossed++; if (t.hi >= bb - 0.25 && t.lo <= ba + 0.25) ov++; if (t.last >= bb - 0.25 && t.last <= ba + 0.25) inside++; }
    const r = { d, file: f, n, crossedPct: n ? crossed / n * 100 : 100, overlapPct: n ? ov / n * 100 : 0, lastInsidePct: n ? inside / n * 100 : 0 }; if (!best || r.overlapPct > best.overlapPct) best = r; }
  rows.push(best); if (best.n > 15000 && best.crossedPct <= 1 && best.overlapPct >= 95) relaxed[d] = best.file; if (best.n > 15000 && best.crossedPct <= 1 && best.overlapPct >= 98) chosen[d] = best.file; }
const v = rows.filter((r) => r.n); const pass = Object.keys(chosen).length; const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
console.log(`sessions with a price archive ${v.length}; PASS (crossed<=1%, traded range overlaps book >=98%): ${pass}; overlap% quartiles ${[0, 0.25, 0.5, 0.75, 1].map((p) => q(v.map((r) => r.overlapPct), p).toFixed(1)).join(' / ')}; original last-trade-inside% median ${q(v.map((r) => r.lastInsidePct), 0.5).toFixed(1)}; crossed% median ${q(v.map((r) => r.crossedPct), 0.5).toFixed(2)}`);
console.log('failing sessions:', v.filter((r) => !chosen[r.d]).map((r) => `${r.d} ${r.file.split('.')[1]} overlap ${r.overlapPct.toFixed(0)}% crossed ${r.crossedPct.toFixed(1)}%`).join('; '));
fs.writeFileSync('scratch/depth_chosen_20261021.json', JSON.stringify(chosen)); fs.writeFileSync('scratch/depth_relaxed_20261021.json', JSON.stringify(relaxed)); console.log(`sessions at >=95% overlap and crossed<=1% (post-hoc relaxation, exploratory only): ${Object.keys(relaxed).length}`); console.log(pass >= 60 ? 'GATE PASSED (>=60 sessions)' : 'GATE FAILED (<60 sessions): no depth result will be reported');
process.exit(0);
