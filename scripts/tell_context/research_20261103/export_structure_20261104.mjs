// Exporter for docs/TELL_STRUCTURE_EXIT_ARMS_PREREG_20261104.md: per explore trade date the RAW bars the structure arms need (read-only, price_bars_primary NQ, both time bounds on every query, cv-009):
//   rth   : RTH 1-minute bars of the date {m (minute of RTH, 0 = 09:30), h, l, c, v}
//   on    : the OVERNIGHT session (18:00 previous calendar day to 09:29 ET) as a 1-point volume profile {lo (lowest point), vols[], hi, lowPx} (each minute's volume spread evenly over its high-low range, hr-021)
//   prev  : the PRIOR trading day's RTH 1-point volume profile {date, lo, vols[], hi, lowPx} (the last earlier date with a full RTH session in the database)
// Output scratch/structure_20261104/raw.json. Usage: node scripts/tell_context/research_20261103/export_structure_20261104.mjs
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');
const F = JSON.parse(fs.readFileSync(path.join(repo, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json'), 'utf8')); const dates = Object.keys(F).sort();
const r2 = (v) => Math.round(v * 100) / 100;
function profile(bars) { // bars [{h, l, v}] -> {lo, vols[], hi, lowPx}
  if (!bars.length) return null; const m = new Map(); let lo = Infinity, hi = -Infinity;
  for (const b of bars) { const a = Math.floor(b.l), z = Math.floor(b.h), n = z - a + 1; if (a < lo) lo = a; if (z > hi) hi = z; for (let p = a; p <= z; p++) m.set(p, (m.get(p) || 0) + b.v / n); }
  const vols = []; for (let p = lo; p <= hi; p++) vols.push(Math.round((m.get(p) || 0) * 10) / 10);
  return { lo, hi, vols, lowPx: Math.min(...bars.map((b) => b.l)), highPx: Math.max(...bars.map((b) => b.h)) };
}
// 1) every RTH session in the span (explore dates and the days before them) as minute rows, in chunks
const first = dates[0], last = dates[dates.length - 1]; const rthByDate = {};
const span = (await query(`SELECT to_char(g.d, 'YYYY-MM-DD') AS d FROM generate_series(($1::date - 12), $2::date, interval '30 days') AS g(d)`, [first, last])).rows.map((x) => x.d);
const edges = [...span, last];
for (let i = 0; i + 1 < edges.length; i++) {
  const lo = edges[i] + ' 00:00:00', hi = (i + 2 === edges.length) ? last + ' 16:00:00' : edges[i + 1] + ' 00:00:00';          // consecutive chunks never overlap (a date is read once)
  const r = await query(`SELECT ts::date::text AS d, (EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int - 570) AS m, high::float AS h, low::float AS l, close::float AS c, COALESCE(volume, 0)::float AS v FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp AND ts::time >= '09:30' AND ts::time < '16:00' ORDER BY ts`, [lo, hi]);
  for (const x of r.rows) (rthByDate[x.d] || (rthByDate[x.d] = [])).push(x);
}
const full = Object.keys(rthByDate).filter((d) => rthByDate[d].length >= 300).sort();
const out = {}; let kept = 0, skipped = 0;
for (const d of dates) {
  const rth = rthByDate[d]; if (!rth || rth.length < 300 || rth[0].m !== 0) { skipped++; continue; }
  const prevD = [...full].reverse().find((x) => x < d); if (!prevD) { skipped++; continue; }
  const on = (await query(`SELECT high::float AS h, low::float AS l, COALESCE(volume, 0)::float AS v FROM price_bars_primary WHERE symbol='NQ' AND ts >= ($1::date - 1)::timestamp + interval '18 hours' AND ts < $1::date::timestamp + interval '9 hours 30 minutes' ORDER BY ts`, [d])).rows;
  if (on.length < 200) { skipped++; continue; }
  out[d] = { rth: { m: rth.map((x) => x.m), h: rth.map((x) => r2(x.h)), l: rth.map((x) => r2(x.l)), c: rth.map((x) => r2(x.c)), v: rth.map((x) => Math.round(x.v)) }, on: profile(on), prev: { date: prevD, ...profile(rthByDate[prevD]) } }; kept++;
}
fs.mkdirSync(path.join(repo, 'scratch', 'structure_20261104'), { recursive: true });
fs.writeFileSync(path.join(repo, 'scratch', 'structure_20261104', 'raw.json'), JSON.stringify(out));
console.log(`explore dates ${dates.length}, exported ${kept}, skipped (thin RTH, no prior day or thin overnight) ${skipped}`); process.exit(0);
