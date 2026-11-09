// Exporter for docs/OVERNIGHT_TO_RTH_SHAPE_PREREG_20261103.md (A1 item 4): per explore session, the 1-MINUTE bars of the Globex session (18:00 the previous calendar day to 09:29 ET) plus the 09:30 open,
// the median 15-minute ranges (overnight and RTH), and the rotation legs of the REAL detector (server/services/rotationDetector.js detectRotationLegs, hr-022) on the overnight bars for a grid of reversal sizes R (Python picks the nearest to the scaled R_ON).
// Features/prices only: no RTH outcome (the RTH final profile and range are read from the 500-contract bar files by the study script). Minute-of-session m = minutes since 18:00 ET of the previous calendar day (09:30 = 930, 16:00 = 1320).
// Usage: node export_overnight_1m_20261103.mjs   -> scratch/overnight_to_rth_20261103/overnight_1m.json   {date: {...}}
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
import { detectRotationLegs } from '../../../server/services/rotationDetector.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');
const barDir = path.join(repo, 'scratch', 'volbars500_full_20261028');
const dates = fs.readdirSync(barDir).filter(f => f.endsWith('.bars.tsv')).map(f => f.slice(0, 10)).filter(d => d <= '2025-05-16').sort();
const GRID = []; for (let r = 15; r <= 100; r += 5) GRID.push(r);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
function q15(bars) {                                       // median over 15-minute buckets of (bucket high - bucket low)
  const b = new Map(); for (const x of bars) { const k = Math.floor(x.m / 15); const v = b.get(k); if (!v) b.set(k, { h: x.high, l: x.low }); else { v.h = Math.max(v.h, x.high); v.l = Math.min(v.l, x.low); } }
  return median([...b.values()].map(v => v.h - v.l));
}
const out = {}; const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const CH = 60; const todo = [...dates];
for (let i = 0; i < todo.length; i += CH) {
  const chunk = todo.slice(i, i + CH); const lo = addDays(chunk[0], -1) + ' 17:59:00', hi = chunk[chunk.length - 1] + ' 16:00:00';
  const r = await query(`SELECT (ts + interval '6 hours')::date::text AS d, (EXTRACT(hour FROM ts)::int) AS h, (EXTRACT(minute FROM ts)::int) AS mi, open::float AS open, high::float AS high, low::float AS low, close::float AS close, volume::float AS vol
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp AND (EXTRACT(hour FROM ts) >= 18 OR EXTRACT(hour FROM ts) < 16) ORDER BY ts`, [lo, hi]);
  const by = new Map(chunk.map(d => [d, []]));
  for (const x of r.rows) { const b = by.get(x.d); if (!b) continue; x.m = x.h >= 18 ? (x.h - 18) * 60 + x.mi : (x.h + 6) * 60 + x.mi; if (x.m < 1320) b.push(x); }
  for (const d of chunk) {
    const bars = by.get(d); const on = bars.filter(x => x.m < 930), rth = bars.filter(x => x.m >= 930 && x.m < 1320);
    const o = { n_on: on.length, n_rth: rth.length, open930: rth.length && rth[0].m === 930 ? rth[0].open : null, q15_on: q15(on), q15_rth: q15(rth) };
    if (on.length) { o.m = on.map(x => x.m); o.o = on.map(x => x.open); o.h = on.map(x => x.high); o.l = on.map(x => x.low); o.c = on.map(x => x.close); o.v = on.map(x => x.vol); o.rot = {};
      for (const R of GRID) { const legs = detectRotationLegs(on, R); o.rot[R] = [legs.length, legs.length ? legs.reduce((s, g) => s + g.size, 0) / legs.length : 0]; } }
    out[d] = o;
  }
  console.log(`exported through ${chunk[chunk.length - 1]}`);
}
fs.writeFileSync(path.join(repo, 'scratch', 'overnight_to_rth_20261103', 'overnight_1m.json'), JSON.stringify(out)); console.log(Object.keys(out).length, 'sessions'); process.exit(0);
