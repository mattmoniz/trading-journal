// Exporter for docs/IB_TIGHTEN_LEVELS_PREREG_20261104.md part C: RTH (09:30-15:59 ET) 1-minute open / high / low per explore trade date (TPO levels and the reach outcomes). Output scratch/carried_levels_20261104/rth_1m.json {date: {m: [minute of RTH], o, h, l}}.
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');
const F = JSON.parse(fs.readFileSync(path.join(repo, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json'), 'utf8')); const dates = Object.keys(F).sort(); const out = {}; const CH = 80;
for (let i = 0; i < dates.length; i += CH) {
  const ch = dates.slice(i, i + CH); const lo = ch[0] + ' 09:30:00', hi = ch[ch.length - 1] + ' 16:00:00';
  const r = await query(`SELECT ts::date::text AS d, (EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int - 570) AS m, open::float AS o, high::float AS h, low::float AS l FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp AND ts::time >= '09:30' AND ts::time < '16:00' ORDER BY ts`, [lo, hi]);
  for (const x of r.rows) { const o = out[x.d] || (out[x.d] = { m: [], o: [], h: [], l: [] }); o.m.push(x.m); o.o.push(x.o); o.h.push(x.h); o.l.push(x.l); }
}
for (const d of Object.keys(out)) if (!F[d]) delete out[d];
fs.writeFileSync(path.join(repo, 'scratch', 'carried_levels_20261104', 'rth_1m.json'), JSON.stringify(out)); const n = Object.values(out).map(x => x.m.length); console.log(Object.keys(out).length, 'dates; bars per day median', n.sort((a, b) => a - b)[n.length >> 1], '; days with < 380 bars:', n.filter(x => x < 380).length); process.exit(0);
