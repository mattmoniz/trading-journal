// EXPLORATORY diagnostic (not pre-registered; run after scripts/study_mechanism_20261026.mjs to audit its control A): why are 17/20 cells "SHOWN"? Compare level touches with ALL non-level bars sharing the same fade direction (own 5-bar approach),
// 5-minute time-of-day bin and prior-bar day-extremity decile. Also the absolute (not excess) mean of those generic bars.
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex } from './lib/pocJoinLoader.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
const FROM = '2023-03-06', TO = '2026-10-23', PROX = 15, H = 60, SPARSE_FROM = '2025-09-28', SPARSE_TO = '2025-11-19';
const D = await loadBars(FROM, TO), S = sessionIndex(D);
const LV = new Map(); for (const r of (await query(`SELECT trade_date::text d, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND price IS NOT NULL AND level_name <> 'RTH_VWAP'`, [FROM, TO])).rows) { if (!LV.has(r.d)) LV.set(r.d, []); LV.get(r.d).push(r.p); }
const mod = (gi) => +D.TS[gi].slice(11, 13) * 60 + +D.TS[gi].slice(14, 16);
const base = new Map();            // key f|tbin|ebin -> {s,n} over NON-level bars
const dayGeneric = [];             // per-day sums for generic non-level high-extremity bars (e>=0.9)
const bars = [];                   // all bars' compact records for the second pass
for (let di = 0; di < S.dates.length; di++) {
  const d = S.dates[di]; if (d < FROM || d > TO || (d >= SPARSE_FROM && d <= SPARSE_TO)) continue; const prev = S.dates[di - 1]; if (isInsideNqRollWeek(d) || (prev && isInsideNqRollWeek(prev))) continue;
  const atr = S.atr20(d), L = LV.get(d); if (!atr || !L || !prev) continue; const [a, b] = S.rth.get(d);
  const hi = new Float64Array(b - a), lo = new Float64Array(b - a); let hh = -Infinity, ll = Infinity; for (let i = a; i < b; i++) { hh = Math.max(hh, D.H[i]); ll = Math.min(ll, D.L[i]); hi[i - a] = hh; lo[i - a] = ll; }
  let gs = 0, gn = 0, gsl = 0, gnl = 0;
  for (let j = a + 5; j <= b - H - 1; j++) {
    const f = D.C[j - 5] < D.C[j] ? -1 : 1, rg = hi[j - 1 - a] - lo[j - 1 - a]; if (!(rg > 0)) continue;
    const e = f < 0 ? (D.C[j - 1] - lo[j - 1 - a]) / rg : (hi[j - 1 - a] - D.C[j - 1]) / rg, eb = Math.min(9, Math.floor(e * 10)), tb = Math.floor(mod(j) / 5);
    const ret = f * (D.C[j + H] - D.O[j + 1]) / atr, near = L.some((p) => Math.abs(D.C[j] - p) <= PROX);
    if (!near) { const k = `${f}|${tb}|${eb}`; let o = base.get(k); if (!o) base.set(k, (o = { s: 0, n: 0 })); o.s += ret; o.n++; if (e >= 0.9) { gs += ret; gn++; } }
    bars.push({ d, f, tb, eb, e, ret, near, lt: false });
  }
  if (gn) dayGeneric.push({ d, s: gs, n: gn });
}
const key = (r) => `${r.f}|${r.tb}|${r.eb}`;
// level touches from the study file: need tb/eb of the touch; recompute from stored mod and e
const E = JSON.parse(fs.readFileSync(new URL('../scratch/level_touch_events_20261026.json', import.meta.url))).rows.filter((r) => r.ret60 !== null && r.e !== null);
const bm = (r) => { const o = base.get(`${r.f}|${Math.floor(r.mod / 5)}|${Math.min(9, Math.floor(r.e * 10))}`); return o && o.n >= 30 ? o.s / o.n : null; };
const withB = E.map((r) => ({ ...r, g: bm(r) })).filter((r) => r.g !== null).map((r) => ({ ...r, x: r.ret60 - r.g }));
const fx = (v, d = 3) => (v >= 0 ? '+' : '') + v.toFixed(d);
function dayCI(rows, val, seed) { const by = new Map(); for (const r of rows) { let o = by.get(r.d); if (!o) by.set(r.d, (o = { s: 0, n: 0 })); o.s += val(r); o.n++; } const ds = [...by.values()], rnd = mulberry32(hashSeed(seed)), out = []; for (let k = 0; k < 2000; k++) { let s = 0, n = 0; for (let i = 0; i < ds.length; i++) { const x = ds[Math.floor(rnd() * ds.length)]; s += x.s; n += x.n; } out.push(s / n); } out.sort((x, y) => x - y); const tot = ds.reduce((a, o) => a + o.s, 0) / ds.reduce((a, o) => a + o.n, 0); return [tot, out[50], out[1949]]; }
console.log('GENERIC non-level bars with prior-bar extremity >= 0.9, fade of own 5-bar move, ret60 ABSOLUTE (ATR) day-blocked:'); { const [m, l, h] = (() => { const rnd = mulberry32(hashSeed('gen')), out = []; for (let k = 0; k < 2000; k++) { let s = 0, n = 0; for (let i = 0; i < dayGeneric.length; i++) { const x = dayGeneric[Math.floor(rnd() * dayGeneric.length)]; s += x.s; n += x.n; } out.push(s / n); } out.sort((x, y) => x - y); return [dayGeneric.reduce((a, o) => a + o.s, 0) / dayGeneric.reduce((a, o) => a + o.n, 0), out[50], out[1949]]; })(); console.log(`  mean ${fx(m)} CI [${fx(l)},${fx(h)}] over ${dayGeneric.length} days, ${dayGeneric.reduce((a, o) => a + o.n, 0)} bars`); }
const allNon = bars.filter((r) => !r.near); for (const f of [-1, 1]) for (const [lab, p] of [['e<0.3', (r) => r.e < 0.3], ['0.3<=e<0.7', (r) => r.e >= 0.3 && r.e < 0.7], ['e>=0.9', (r) => r.e >= 0.9]]) { const x = allNon.filter((r) => r.f === f && p(r)); const [m, l, h] = dayCI(x, (r) => r.ret, `abs|${f}|${lab}`); console.log(`  non-level bars f=${f} ${lab.padEnd(11)} N=${String(x.length).padStart(6)} absolute mean ret60 ${fx(m)} CI [${fx(l)},${fx(h)}]`); }
console.log('\nLEVEL TOUCHES vs generic non-level bars matched on f x 5-min time bin x extremity decile (excess_G):');
const grp = (lab, rows) => { const [m, l, h] = dayCI(rows, (r) => r.x, `x|${lab}`), raw = rows.reduce((a, r) => a + r.ret60, 0) / rows.length; console.log(`  ${lab.padEnd(28)} N=${String(rows.length).padStart(5)} raw ret60 ${fx(raw)} | excess_G ${fx(m)} CI [${fx(l)},${fx(h)}]`); };
grp('ALL touches', withB); grp('short', withB.filter((r) => r.f < 0)); grp('long', withB.filter((r) => r.f > 0));
for (const fam of [...new Set(withB.map((r) => r.fam))].sort()) grp(`family ${fam}`, withB.filter((r) => r.fam === fam));
for (const [lvl, f] of [['IB_HIGH', -1], ['WS1', 1], ['IB_LOW', 1], ['WR1', -1]]) grp(`${lvl} f=${f} (pre-07-09)`, withB.filter((r) => r.lvl === lvl && r.f === f && r.d < '2026-07-09'));
process.exit(0);
