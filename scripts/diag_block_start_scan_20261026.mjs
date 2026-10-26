import { query } from '../server/db.js';
const rows = (await query(`SELECT ts::date::text d, high::float h, low::float l, close::float c, volume::float v, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int m, ts::text t FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2026-06-28' AND ts < '2026-10-27'`)).rows;
const T = 1, snap = (p) => Math.round(p / T);
function profile(items) { const h = new Map(); for (const [p, v] of items) h.set(snap(p), (h.get(snap(p)) || 0) + v); const keys = [...h.keys()].sort((a, b) => a - b), tot = [...h.values()].reduce((s, x) => s + x, 0); let poc = keys[0]; for (const k of keys) if (h.get(k) > h.get(poc)) poc = k;
  let lo = poc, hi = poc, acc = h.get(poc); const get = (k) => h.get(k) || 0, kmax = keys[keys.length - 1];
  for (let it = 0; it < 20000 && acc < 0.7 * tot; it++) { const up = get(hi + 1) + get(hi + 2), dn = get(lo - 1) + get(lo - 2); let goUp = up > dn || (up === dn && up > 0); if (up === 0 && dn === 0) goUp = hi < kmax; if (goUp) { hi += 1; acc += get(hi); } else { lo -= 1; acc += get(lo); } }
  return { val: lo * T, poc: poc * T, vah: hi * T }; }
const spread = (r) => { const n = Math.max(1, Math.round((r.h - r.l) / T) + 1), out = []; for (let k = 0; k < n; k++) out.push([r.l + k * T, r.v / n]); return out; };
console.log('user chart: current thick-blue block VAL ~28,970 POC ~29,780 VAH ~30,925; previous block POC ~29,513');
const win = (a, b, lab, f) => { const rs = rows.filter((r) => r.t >= a && r.t < b && f(r)); const p = profile(rs.flatMap(spread)); console.log(`${lab.padEnd(60)} bars ${rs.length}  VAL ${p.val} POC ${p.poc} VAH ${p.vah}`); };
const ALL = () => true, RTH = (r) => r.m >= 570 && r.m < 960;
const alloc = { 'spread over H-L': spread, 'volume at close': (r) => [[r.c, r.v]], 'volume at HLC3': (r) => [[(r.h + r.l + r.c) / 3, r.v]] };
for (const st of ['2026-10-04 18:00:00', '2026-10-05 09:30:00']) for (const [an, g] of Object.entries(alloc)) { const rs = rows.filter((r) => r.t >= st); const p = profile(rs.flatMap(g)); console.log(`start ${st} ${an.padEnd(16)} VAL ${p.val} POC ${p.poc} VAH ${p.vah}`); }
process.exit(0);
