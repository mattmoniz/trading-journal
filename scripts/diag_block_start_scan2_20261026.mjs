import { query } from '../server/db.js';
const rows = (await query(`SELECT high::float h, low::float l, volume::float v, ts::text t FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2026-09-28' AND ts < '2026-10-27'`)).rows;
const snap = (p) => Math.round(p);
function profile(items) { const h = new Map(); for (const [p, v] of items) h.set(snap(p), (h.get(snap(p)) || 0) + v); const keys = [...h.keys()].sort((a, b) => a - b), tot = [...h.values()].reduce((s, x) => s + x, 0); let poc = keys[0]; for (const k of keys) if (h.get(k) > h.get(poc)) poc = k; let lo = poc, hi = poc, acc = h.get(poc); const get = (k) => h.get(k) || 0, kmax = keys[keys.length - 1];
  for (let it = 0; it < 20000 && acc < 0.7 * tot; it++) { const up = get(hi + 1) + get(hi + 2), dn = get(lo - 1) + get(lo - 2); let goUp = up > dn || (up === dn && up > 0); if (up === 0 && dn === 0) goUp = hi < kmax; if (goUp) { hi += 1; acc += get(hi); } else { lo -= 1; acc += get(lo); } } return { val: lo, poc, vah: hi }; }
const spread = (r) => { const n = Math.max(1, Math.round(r.h - r.l) + 1), o = []; for (let k = 0; k < n; k++) o.push([r.l + k, r.v / n]); return o; };
console.log('target: VAL ~28970-29000, POC ~29780, VAH ~30925');
for (const d of ['2026-09-30 18:00', '2026-10-01 18:00', '2026-10-02 18:00', '2026-10-04 18:00', '2026-10-05 18:00', '2026-10-06 18:00']) { const rs = rows.filter((r) => r.t >= d + ':00'); const p = profile(rs.flatMap(spread)); console.log(d, 'bars', rs.length, 'VAL', p.val, 'POC', p.poc, 'VAH', p.vah); }
// daily volume and range Sep 28 - Oct 9
const by = {}; for (const r of rows) { const k = r.t.slice(0, 10); (by[k] ||= { v: 0, h: -1e9, l: 1e9 }); by[k].v += r.v; by[k].h = Math.max(by[k].h, r.h); by[k].l = Math.min(by[k].l, r.l); }
for (const [k, o] of Object.entries(by).slice(0, 14)) console.log(k, 'vol', Math.round(o.v), 'H', o.h, 'L', o.l);
process.exit(0);
