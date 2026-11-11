// Row 42 step B (outcome-blind): for every climax of events_raw.csv, is the climax extreme inside the band of a LIVE confirmed swing pivot of the matching type, and did that pivot have a completed prior test? Uses the system's own pivot module
// (scripts/lib/pivotContext.mjs: load5m, pivotTimeline, indexByDate, pivotAt). Reads NO price after the climax bar's end (pivotAt only uses pivots known and confirmed >= 30 minutes before T). Every call awaited (hr-060).
import { readFileSync, writeFileSync } from 'node:fs';
import { load5m, pivotTimeline, indexByDate, pivotAt } from '../lib/pivotContext.mjs';
import { emOf } from '../lib/floorEngine.mjs';
const OUT = 'scratch/capitulation_reengage_20261110';
const rows = readFileSync(`${OUT}/events_raw.csv`, 'utf8').trim().split(/\r?\n/); const hdr = rows.shift().split(','); const ev = rows.map((l) => Object.fromEntries(l.split(',').map((v, i) => [hdr[i], v])));
const dates = [...new Set(ev.map((e) => e.date))].sort();
const b = await load5m('2023-02-20', '2025-05-18'); const tl = await pivotTimeline(b.bars5m, b.atr); if (!tl.same) console.warn('WARNING: pivot timeline differs from the shared walk');
const cands = indexByDate(tl.piv, dates);
const out = ['date,track,k,dir,defended,pivot_live,tests,dist_band,def5,pivot5'];
let nDef = 0;
for (const e of ev) {
  const type = Number(e.dir) < 0 ? 'LOW' : 'HIGH', T = emOf(e.ts_et), pc = cands.get(e.date) || [];
  const r = pivotAt(pc, type, Number(e.px), T), r5 = pivotAt(pc, type, Number(e.px5), T);
  const def = r != null && r.tests >= 1 ? 1 : 0, def5 = r5 != null && r5.tests >= 1 ? 1 : 0; nDef += def;
  out.push([e.date, e.track, e.k, e.dir, def, r ? 1 : 0, r ? r.tests : 0, r ? (r.dist / r.p.band).toFixed(3) : '', def5, r5 ? 1 : 0].join(','));
}
writeFileSync(`${OUT}/events_flags.csv`, out.join('\n') + '\n');
const cnt = {}; ev.forEach((e, i) => { const f = out[i + 1].split(','); const key = `${e.track} ${f[4] === '1' ? 'DEFENDED' : 'not'}`; cnt[key] = (cnt[key] || 0) + 1; });
console.log('events', ev.length, 'defended', nDef, JSON.stringify(cnt), 'pivots in the timeline', tl.piv.length, 'zigzag identical to the shared function:', tl.same);
process.exit(0);
