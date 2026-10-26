// Tests the block start read off the user's Sierra screenshot (step at Wed 2026-09-30 17:00 chart time) against their stated lines.
import { query } from '../server/db.js';
const rows = (await query(`SELECT high::float h, low::float l, volume::float v, ts::text t FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2026-06-20' AND ts < '2026-10-27 00:00'`)).rows;
const T = 1, snap = (p) => Math.round(p / T);
function profile(items) { const h = new Map(); for (const [p, v] of items) h.set(snap(p), (h.get(snap(p)) || 0) + v); const keys = [...h.keys()].sort((a, b) => a - b), tot = [...h.values()].reduce((s, x) => s + x, 0); let poc = keys[0]; for (const k of keys) if (h.get(k) > h.get(poc)) poc = k;
  let lo = poc, hi = poc, acc = h.get(poc); const get = (k) => h.get(k) || 0, kmax = keys[keys.length - 1];
  for (let it = 0; it < 20000 && acc < 0.7 * tot; it++) { const up = get(hi + 1) + get(hi + 2), dn = get(lo - 1) + get(lo - 2); let goUp = up > dn || (up === dn && up > 0); if (up === 0 && dn === 0) goUp = hi < kmax; if (goUp) { hi += 1; acc += get(hi); } else { lo -= 1; acc += get(lo); } }
  return { val: lo * T, poc: poc * T, vah: hi * T }; }
const spread = (r) => { const n = Math.max(1, Math.round((r.h - r.l) / T) + 1), out = []; for (let k = 0; k < n; k++) out.push([r.l + k * T, r.v / n]); return out; };
console.log('user readings: current block POC ~29,780, VAH label 30,925.5, VAL ~29,000 (label near 29,000; earlier read 28,970); previous block POC ~29,513');
const run = (a, b, lab) => { const rs = rows.filter((r) => r.t >= a && r.t < b); const p = profile(rs.flatMap(spread)); console.log(`${lab.padEnd(46)} bars ${String(rs.length).padStart(6)}  VAL ${p.val}  POC ${p.poc}  VAH ${p.vah}`); };
for (const st of ['2026-09-30 17:00:00', '2026-09-30 18:00:00', '2026-10-01 00:00:00', '2026-10-01 09:30:00']) run(st, '2026-10-27', `CURRENT block from ${st} (ET) to now`);
for (const [a, b] of [['2026-06-30 18:00:00', '2026-09-30 17:00:00'], ['2026-06-30 18:00:00', '2026-09-30 18:00:00'], ['2026-07-01 00:00:00', '2026-09-30 17:00:00'], ['2026-06-23 18:00:00', '2026-09-30 17:00:00']]) run(a, b, `PREVIOUS block ${a} .. ${b}`);
process.exit(0);
