import { query } from '../server/db.js';
import { classify, CHECKPOINT_STEP, MIN_ELAPSED, BASELINE_NIGHTS } from '../server/services/overnightTripwire.js';
const c = await query(`SELECT column_name FROM information_schema.columns WHERE table_name='daily_rth_stats'`); const cols = c.rows.map((r) => r.column_name); console.log(cols.join(','));
const rows = (await query(`SELECT trade_date::text d, checkpoint_min c, volume::float v, legs FROM overnight_checkpoint_stats ORDER BY 1,2`)).rows;
const by = new Map(); for (const r of rows) (by.get(r.d) || by.set(r.d, new Map()).get(r.d)).set(r.c, r); const nights = [...by.keys()].sort();
const rth = new Map((await query(`SELECT trade_date::text d, (rth_high - rth_low)::float rng FROM daily_rth_stats`)).rows.map((r) => [r.d, r.rng]));
const heavy = [], other = [];
for (let i = BASELINE_NIGHTS; i < nights.length; i++) { const prior = nights.slice(i - BASELINE_NIGHTS, i); let h = false; for (let cp = MIN_ELAPSED; cp <= 930; cp += CHECKPOINT_STEP) { const t = by.get(nights[i]).get(cp); if (!t) continue; const base = prior.map((d) => by.get(d).get(cp)).filter(Boolean); if (classify({ vol: t.v, legs: t.legs, baseVols: base.map((x) => x.v), baseLegs: base.map((x) => x.legs) }).level === 'HEAVY') { h = true; break; } } const r = rth.get(nights[i]); if (r == null) continue; (h ? heavy : other).push(r); }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length, med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`next RTH range (points): HEAVY nights n=${heavy.length} mean ${mean(heavy).toFixed(0)} median ${med(heavy).toFixed(0)} | other nights n=${other.length} mean ${mean(other).toFixed(0)} median ${med(other).toFixed(0)}`);
let seed = 42; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); const d = []; for (let i = 0; i < 5000; i++) { const a = heavy.map(() => heavy[Math.floor(rnd() * heavy.length)]), b = other.map(() => other[Math.floor(rnd() * other.length)]); d.push(mean(a) - mean(b)); } d.sort((x, y) => x - y);
console.log(`mean difference ${(mean(heavy) - mean(other)).toFixed(0)} points, bootstrap 95% CI [${d[125].toFixed(0)}, ${d[4875].toFixed(0)}]; share of HEAVY nights above the other-night median: ${(100 * heavy.filter((x) => x > med(other)).length / heavy.length).toFixed(0)}%`);
process.exit(0);
