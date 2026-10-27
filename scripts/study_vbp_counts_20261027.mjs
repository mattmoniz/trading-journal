// Event COUNTS ONLY for the VbP prereg (docs/VBP_ACCEPTANCE_REENTRY_PREREG_20261027.md). No forward move, reach or P&L is computed here.
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, prep, indexBars } from './lib/floorEngine.mjs';
import { build4h, pinnedLimit } from './lib/fourHourLevels.mjs';
import { getDailyProfiles } from '../server/services/tickVolumeProfile.js';
import { loadCells, buildSessions, sessionEvents, valueAreaEvent } from './lib/vbpProfiles.mjs';
const END = process.env.STUDY_END || '2026-10-23';
const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', END))), { h4 } = build4h(NQ), LIM = pinnedLimit(NQ, END);
const linesBy = JSON.parse(fs.readFileSync('scratch/defended_lines_by_date_20261026.json'));
const cells = await loadCells('2023-03-06', END), tdSet = new Set(NQ.TD.filter((d) => d <= END));
const { sessions, excl } = buildSessions(cells, tdSet);
console.log('cells', cells.size, 'sessions used', sessions.length, 'RTH', sessions.filter((s) => s.sess === 'RTH').length, 'GLOBEX', sessions.filter((s) => s.sess === 'GLOBEX').length, 'excluded', JSON.stringify(excl));
const all = []; let noH4 = 0;
for (const s of sessions) { if (s.td > END) continue; const r = sessionEvents(NQ, cells, s, h4, linesBy, LIM); if (r.reason === 'noH4') { noH4++; continue; } all.push(...r.events); }
console.log('sessions with no H4 (first 20 trade days):', noH4);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
for (const sess of ['RTH', 'GLOBEX']) {
  const E = all.filter((e) => e.sess === sess); const dens = E.map((e) => e.dens), dist = E.map((e) => e.dist);
  const d33 = q(dens, 1 / 3), d67 = q(dens, 2 / 3), s33 = q(dist, 1 / 3), s67 = q(dist, 2 / 3);
  const hi = E.filter((e) => e.dens >= d67), lo = E.filter((e) => e.dens <= d33), days = (x) => new Set(x.map((e) => e.td)).size;
  console.log(`\n== Test A ${sess}: events ${E.length} on ${days(E)} dates (up ${E.filter((e) => e.dir > 0).length}, down ${E.filter((e) => e.dir < 0).length}); density cuts ${d33.toFixed(3)} / ${d67.toFixed(3)}; distance cuts ${s33.toFixed(3)} / ${s67.toFixed(3)}; HIGH ${hi.length} (${days(hi)} dates) LOW ${lo.length} (${days(lo)} dates)`);
  for (const [nm, f] of [['dist T1', (e) => e.dist <= s33], ['dist T2', (e) => e.dist > s33 && e.dist <= s67], ['dist T3', (e) => e.dist > s67]]) console.log(`   ${nm}: HIGH ${hi.filter(f).length} LOW ${lo.filter(f).length}`);
  const dates = [...new Set(E.map((e) => e.td))].sort(), cut = dates[Math.floor(0.6 * dates.length) - 1]; console.log(`   explore dates <= ${cut} (${dates.filter((d) => d <= cut).length} dates, ${E.filter((e) => e.td <= cut).length} events), hold-out ${dates.filter((d) => d > cut).length} dates ${E.filter((e) => e.td > cut).length} events`);
  console.log(`   node peak within 0.5 H4 of a named POC: ${E.filter((e) => e.pocNear).length} (${(100 * E.filter((e) => e.pocNear).length / E.length).toFixed(0)}%)`);
  // Test C population: non-POC nodes; back-inside arm vs not (decision cell j+1 must exist)
  const C = E.filter((e) => !e.pocNear && e.j + 1 < e.n && e.closeP[e.j + 1] != null && e.openIdx[e.j + 1] != null), back = C.filter((e) => (e.dir > 0 ? e.closeP[e.j + 1] <= e.edgeP : e.closeP[e.j + 1] >= e.edgeP));
  console.log(`== Test C ${sess}: non-POC events with a following cell ${C.length}; back-inside ${back.length} (${days(back)} dates), no-back-inside ${C.length - back.length}`);
  // Test D': S1 re-entry offsets, matched still-outside controls at the same offset, S2 high-density cell
  const DP = E.filter((e) => e.openIdx[e.j] != null); const s1 = {}, ctl = {}; let s1n = 0, s2n = 0, s2hi = 0, noS1 = 0;
  for (const e of DP) {
    let first = null; for (const l of e.later) { const back2 = e.dir > 0 ? l.close <= e.edgeP : l.close >= e.edgeP; if (back2) { first = l.m; break; } }
    if (first != null) { s1[first] = (s1[first] || 0) + 1; s1n++; } else noS1++;
    for (const l of e.later) { const outAll = e.later.filter((z) => z.m <= l.m).every((z) => (e.dir > 0 ? z.close > e.edgeP : z.close < e.edgeP)); if (outAll) ctl[l.m] = (ctl[l.m] || 0) + 1; }
    const f = e.later.find((l) => (e.dir > 0 ? l.close > e.edgeP : l.close < e.edgeP) && l.dens != null); if (f) { s2n++; if (f.dens >= d67) s2hi++; }
  }
  console.log(`== Test D' ${sess}: positions ${DP.length}; S1 (first re-entry within ${8} cells) ${s1n} on ${days(DP.filter((e) => e.later.some((l) => (e.dir > 0 ? l.close <= e.edgeP : l.close >= e.edgeP))))} dates, by offset m: ${JSON.stringify(s1)}; still-outside-at-offset controls: ${JSON.stringify(ctl)}; never re-entered ${noS1}; S2 decisions ${s2n}, HIGH-density ${s2hi}`);
}
// Test B
const prof = await getDailyProfiles(query, { startDate: '2023-01-01', endDate: END, session: 'rth' }), pdays = Object.keys(prof).sort(), prior = new Map(pdays.map((d, i) => [d, pdays[i - 1]]));
for (const sess of ['RTH', 'GLOBEX']) {
  const why = {}, evs = [];
  for (const s of sessions.filter((x) => x.sess === sess && x.td <= END)) { const p = prior.get(s.td); if (!p) { why.noPrior = (why.noPrior || 0) + 1; continue; } const r = valueAreaEvent(NQ, s, prof, p, LIM); if (r.ev) evs.push(r.ev); else why[r.why] = (why[r.why] || 0) + 1; }
  console.log(`\n== Test B ${sess}: events ${evs.length} on ${new Set(evs.map((e) => e.td)).size} dates (up ${evs.filter((e) => e.dir > 0).length}, down ${evs.filter((e) => e.dir < 0).length}); no-event reasons ${JSON.stringify(why)}`);
}
process.exit(0);
