// Independent sanity checks of the loaded ES bars (price_bars_es / es_front_calendar). Re-run after any new load.  node scripts/verify_es_bars_20261026.mjs
import { query } from '../server/db.js';
const q = async (sql, p) => (await query(sql, p)).rows;
const FROM = '2023-03-06', TO = '2026-10-23';
console.log('== per contract'); for (const r of await q(`SELECT contract, COUNT(*)::int n, MIN(ts)::text a, MAX(ts)::text b, MIN(low)::float lo, MAX(high)::float hi FROM price_bars_es GROUP BY contract ORDER BY MIN(ts)`)) console.log(`  ${r.contract}: ${r.n} bars ${r.a.slice(0, 16)} -> ${r.b.slice(0, 16)} price ${r.lo}..${r.hi}`);
console.log('== thin front-month days (rth_minutes < 371):', (await q(`SELECT COUNT(*)::int n, MIN(trade_date)::text a, MAX(trade_date)::text b FROM es_front_calendar WHERE rth_minutes IS NOT NULL AND rth_minutes < 371`))[0]);
console.log('== roll calendar'); console.log('  ', (await q(`SELECT trade_date::text d, contract FROM es_front_calendar WHERE is_roll_day ORDER BY 1`)).map((r) => `${r.d}->${r.contract}`).join('  '));
// coverage vs NQ RTH days (explicit lower AND upper bounds on the NQ view)
const nq = new Map((await q(`SELECT ts::date::text d, COUNT(*)::int n FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < ($2::date + 1) AND ts::time >= '09:30' AND ts::time < '16:00' GROUP BY 1`, [FROM, TO])).map((r) => [r.d, r.n]));
const es = new Map((await q(`SELECT ts::date::text d, COUNT(*)::int n FROM price_bars_es_front WHERE ts >= $1::date AND ts < ($2::date + 1) AND ts::time >= '09:30' AND ts::time < '16:00' GROUP BY 1`, [FROM, TO])).map((r) => [r.d, r.n]));
const nqDays = [...nq.keys()].filter((d) => nq.get(d) >= 371), missing = nqDays.filter((d) => (es.get(d) || 0) < 371);
console.log(`== coverage: NQ full RTH days ${nqDays.length}; ES front RTH days ${[...es.keys()].filter((d) => es.get(d) >= 371).length}; NQ-full but ES-short days ${missing.length}: ${missing.slice(0, 25).join(' ')}${missing.length > 25 ? ' ...' : ''}`);
// lead/lag correlation of 1-minute RTH returns NQ vs ES on a seeded sample of days
const days = nqDays.filter((d) => es.get(d) >= 371).filter((_, i) => i % 6 === 0); const sums = {}; for (const L of [-2, -1, 0, 1, 2]) sums[L] = { sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, n: 0 };
for (const d of days) {
  const a = await q(`SELECT n.ts::text t, n.close::float nc, e.close::float ec FROM price_bars_primary n JOIN price_bars_es_front e ON e.ts = n.ts WHERE n.symbol='NQ' AND n.ts >= $1::date + time '09:30' AND n.ts < $1::date + time '16:00' ORDER BY n.ts`, [d]);
  const rn = [], re = []; for (let i = 1; i < a.length; i++) { rn.push(Math.log(a[i].nc / a[i - 1].nc)); re.push(Math.log(a[i].ec / a[i - 1].ec)); }
  for (const L of [-2, -1, 0, 1, 2]) for (let i = 0; i < rn.length; i++) { const j = i + L; if (j < 0 || j >= re.length) continue; const s = sums[L]; s.sx += rn[i]; s.sy += re[j]; s.sxx += rn[i] ** 2; s.syy += re[j] ** 2; s.sxy += rn[i] * re[j]; s.n++; }
}
console.log(`== 1-minute return correlation NQ[t] vs ES[t+lag] over ${days.length} sampled days (lag 0 must dominate, otherwise the timestamps are shifted):`);
for (const L of [-2, -1, 0, 1, 2]) { const s = sums[L], c = (s.sxy - (s.sx * s.sy) / s.n) / Math.sqrt((s.sxx - s.sx ** 2 / s.n) * (s.syy - s.sy ** 2 / s.n)); console.log(`  lag ${L >= 0 ? '+' : ''}${L}: ${c.toFixed(3)}  (n=${s.n})`); }
// roll continuity: spread between consecutive contracts on overlap days
console.log('== spread (next - prior contract) on overlap days: mean / sd of daily RTH-close difference (a slowly varying carry, not jumps)');
const ek = (c) => ((+c[3] < 3 ? +c[3] + 10 : +c[3]) * 10) + 'HMUZ'.indexOf(c[2]), cs = (await q(`SELECT contract FROM price_bars_es GROUP BY contract`)).map((r) => r.contract).sort((x, y) => ek(x) - ek(y));   // expiry order, not first-data order
for (let i = 0; i + 1 < cs.length; i++) { const r = (await q(`SELECT a.ts::date::text d, (b.close - a.close)::float sp FROM price_bars_es a JOIN price_bars_es b ON b.ts = a.ts AND b.contract = $2 WHERE a.contract = $1 AND a.ts::time = '15:59' AND a.ts >= '2023-01-01' ORDER BY 1`, [cs[i], cs[i + 1]])); if (r.length < 3) { console.log(`  ${cs[i]}->${cs[i + 1]}: ${r.length} overlap days`); continue; } const m = r.reduce((s, x) => s + x.sp, 0) / r.length, sd = Math.sqrt(r.reduce((s, x) => s + (x.sp - m) ** 2, 0) / (r.length - 1)); console.log(`  ${cs[i]}->${cs[i + 1]}: ${r.length} overlap days, spread mean ${m.toFixed(2)} sd ${sd.toFixed(2)} pts, range ${Math.min(...r.map((x) => x.sp)).toFixed(2)}..${Math.max(...r.map((x) => x.sp)).toFixed(2)}`); }
process.exit(0);
