import { query } from '../server/db.js';
const rows = (await query(`SELECT high::float h, low::float l, close::float c, open::float o, volume::float v, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int m FROM price_bars_primary WHERE symbol='NQ' AND ts::date BETWEEN '2026-07-28' AND '2026-10-26'`)).rows;
const T = 1, snap = (p) => Math.round(p / T);
function profile(items, forcePoc) { const h = new Map(); for (const [p, v] of items) h.set(snap(p), (h.get(snap(p)) || 0) + v); const keys = [...h.keys()].sort((a, b) => a - b), tot = [...h.values()].reduce((s, x) => s + x, 0); let poc = keys[0]; for (const k of keys) if (h.get(k) > h.get(poc)) poc = k; if (forcePoc) poc = Math.round(forcePoc / T);
  let lo = poc, hi = poc, acc = h.get(poc); const get = (k) => h.get(k) || 0, kmax = keys[keys.length - 1];
  for (let it = 0; it < 20000 && acc < 0.7 * tot; it++) { const up = get(hi + 1) + get(hi + 2), dn = get(lo - 1) + get(lo - 2); let goUp = up > dn || (up === dn && up > 0); if (up === 0 && dn === 0) goUp = hi < kmax; if (goUp) { hi += 1; acc += get(hi); } else { lo -= 1; acc += get(lo); } }
  return { val: lo * T, poc: poc * T, vah: hi * T }; }
const variants = {
  'spread evenly over H-L (ours)': (r) => { const n = Math.max(1, Math.round((r.h - r.l) / T) + 1), out = []; for (let k = 0; k < n; k++) out.push([r.l + k * T, r.v / n]); return out; },
  'all volume at the close': (r) => [[r.c, r.v]],
  'all volume at HLC3': (r) => [[(r.h + r.l + r.c) / 3, r.v]],
  'all volume at OHLC4': (r) => [[(r.o + r.h + r.l + r.c) / 4, r.v]],
  'half at open, half at close': (r) => [[r.o, r.v / 2], [r.c, r.v / 2]],
};
for (const [sess, f] of [['RTH', (r) => r.m >= 570 && r.m < 960]]) for (const nm of ['spread evenly over H-L (ours)', 'all volume at HLC3']) for (const fp of [null, 29780, 29750]) { const p = profile(rows.filter(f).flatMap(variants[nm]), fp); console.log(`${sess} ${nm.padEnd(30)} POC forced ${fp ?? 'no'}: VAL ${p.val} POC ${p.poc} VAH ${p.vah}`); }
const hh = new Map(); for (const r of rows.filter((x) => x.m >= 570 && x.m < 960)) { const n = Math.max(1, Math.round((r.h - r.l)) + 1); for (let k = 0; k < n; k++) { const b = Math.round(r.l + k); hh.set(b, (hh.get(b) || 0) + r.v / n); } } const top = [...hh.entries()].filter(([b]) => b > 29300 && b < 30000).sort((a, b) => b[1] - a[1]).slice(0, 6); console.log('RTH volume peaks 29300-30000 (point, relative volume):', top.map(([b, v]) => b + ':' + Math.round(v / top[0][1] * 100) + '%').join('  '));
process.exit(0);
