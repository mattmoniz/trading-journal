// Directional bias state, L2 (roster gating). EXPLORATORY: the pre-registered L1 kill rule fired (both C-only CIs include zero), so per
// docs/DIRECTIONAL_BIAS_STATE_SPEC.md section 10 this layer is NOT confirmatory. Question: on episodes where the locked crack state is ON,
// would "only fire the crack direction" have beaten the unrestricted roster? Roster rows = active_setups, declustered (siblings kept; primaries-only
// alongside), origin split REAL (ACTIVE+SHADOW, since 2026-07-09) vs SIM (BACKFILL = strategy simulation, never mixed silently); UNKNOWN excluded;
// NOT_FILLED / null-pnl excluded; POC_ROTATION_JOIN reported separately (10/11-12 exit-mechanism confound; its history is pre-change anyway).
// Window W1 = rows fired from the checkpoint to the first RTH close after it; W2 = through the second RTH close. Fit window ends 2026-10-10.
// Controls: label permutation (flip the episode direction at random, 4000x) for aligned-minus-counter; always-long / always-short benchmark on the same windows.
import { loadSessions, buildZones, mean } from './lib/biasStateData.mjs';
import { makeModel, FIT_END } from './lib/biasStateEvents.mjs';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { query } from '../server/db.js';
const S = await loadSessions(); const Z = buildZones(S); const M = makeModel(S, Z);
const rows = (await query(`SELECT setup_type st, fired_at::text fa, actual_pnl::float pnl, origin_status os, COALESCE(is_cluster_primary,true) prim
  FROM active_setups WHERE fired_at >= '2025-11-20' AND fired_at < '2026-10-17 18:00' AND actual_pnl IS NOT NULL AND COALESCE(resolution,'')<>'NOT_FILLED' AND origin_status IN ('ACTIVE','SHADOW','BACKFILL') ORDER BY fired_at`)).rows;
const dirOf = (t) => (/(^|_)SHORT(_|$)/.test(t) ? -1 : /(^|_)LONG(_|$)/.test(t) ? 1 : 0);
for (const r of rows) { r.dir = dirOf(r.st); r.poc = r.st.startsWith('POC_ROTATION_JOIN'); r.cls = r.os === 'BACKFILL' ? 'SIM' : 'REAL'; }
const f = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
function window(plan, e, w) { // [start, end) as naive-ET strings
  const P = M.plans[plan], i = e.i; const day = S[i].r[0].ts.slice(0, 10);
  const start = plan === 'RTH' ? S[i].r[0].ts : `${day} 18:00:00`;
  const hIdx = plan === 'RTH' ? (w === 1 ? i : i + 1) : (w === 1 ? i + 1 : i + 2); void P;
  const end = S[hIdx].r[S[hIdx].r.length - 1].ts; return [start, end];
}
function boot(arr, tag, fn, N = 4000) { const r = mulberry32(hashSeed('L2|' + tag)), o = []; for (let k = 0; k < N; k++) { const pick = []; for (let q = 0; q < arr.length; q++) pick.push(arr[Math.floor(r() * arr.length)]); const v = fn(pick); if (Number.isFinite(v)) o.push(v); } o.sort((a, b) => a - b); return o.length ? [o[Math.floor(o.length * .025)], o[Math.floor(o.length * .975)]] : null; }
function analyse(plan, cls, w, primOnly, pocOnly) {
  const ev = M.events(plan).filter((e) => e.i != null); const items = [];
  for (const e of ev) { const [a, b] = window(plan, e, w); const rs = rows.filter((r) => r.cls === cls && r.poc === pocOnly && r.dir !== 0 && r.fa >= a && r.fa < b && (!primOnly || r.prim)); if (rs.length) items.push({ e, rs }); }
  if (items.length < 4) return { n: items.length };
  const stat = (its, flip) => { let al = [], co = []; for (const it of its) for (const r of it.rs) { (r.dir === it.e.dir * (flip && flip.get(it) ? -1 : 1) ? al : co).push(r.pnl); } return { al, co, d: mean(al) - mean(co) }; };
  const base = stat(items), ci = boot(items, `${plan}${cls}${w}${primOnly}${pocOnly}`, (p) => stat(p).d);
  const rand = mulberry32(hashSeed(`L2perm|${plan}${cls}${w}${primOnly}${pocOnly}`)); let ge = 0; const NP = 4000;
  for (let k = 0; k < NP; k++) { const flip = new Map(items.map((it) => [it, rand() < 0.5])); if (Math.abs(stat(items, flip).d) >= Math.abs(base.d)) ge++; }
  const allL = items.flatMap((it) => it.rs.filter((r) => r.dir > 0).map((r) => r.pnl)), allS = items.flatMap((it) => it.rs.filter((r) => r.dir < 0).map((r) => r.pnl));
  const down = items.filter((it) => it.e.dir < 0), up = items.filter((it) => it.e.dir > 0);
  const d1 = down.length >= 3 ? stat(down).d : NaN, d2 = up.length >= 3 ? stat(up).d : NaN;
  return { n: items.length, trades: base.al.length + base.co.length, al: mean(base.al), nal: base.al.length, co: mean(base.co), nco: base.co.length, d: base.d, ci, p: ge / NP, long: mean(allL), short: mean(allS), d1, d2, nd: down.length, nu: up.length };
}
for (const plan of ['RTH', 'GLX']) {
  console.log(`\n================ ${plan} plan (crack-ON episodes, locked definition) ================`);
  for (const [lab, pocOnly] of [['ROSTER (POC_ROTATION_JOIN excluded)', false], ['POC_ROTATION_JOIN only', true]]) for (const cls of ['SIM', 'REAL']) for (const w of [1, 2]) for (const prim of [false, true]) {
    if (prim && w === 2) continue; const r = analyse(plan, cls, w, prim, pocOnly);
    console.log(`${lab.padEnd(36)} ${cls.padEnd(4)} W${w} ${prim ? 'primaries' : 'declustered'}: ${r.n < 4 ? `episodes with rows=${r.n} (too few)` : `episodes ${r.n}, trades ${r.trades} | aligned $${f(r.al, 1)}/trade (n=${r.nal}) counter $${f(r.co, 1)} (n=${r.nco}) | aligned-counter ${f(r.d, 1)} CI [${f(r.ci?.[0])}, ${f(r.ci?.[1])}] perm p=${f(r.p, 3)} | always-long $${f(r.long, 1)} always-short $${f(r.short, 1)} | by crack dir: DOWN ${f(r.d1, 1)} (n=${r.nd}), UP ${f(r.d2, 1)} (n=${r.nu})`}`);
  }
  console.log(`--- ${plan} holdout week case note (Oct 12-16 rows, DESCRIPTIVE ONLY, not in any statistic above) ---`);
  for (const e of M.events(plan, 2, '2026-10-17').filter((x) => x.d > FIT_END)) { for (const w of [1, 2]) { const [a, b0] = window(plan, e, w); const b = b0 > '2026-10-16 15:59:00' ? '2026-10-16 15:59:00' : b0;
    const rs = rows.filter((r) => !r.poc && r.dir !== 0 && r.fa >= a && r.fa < b && r.os !== 'BACKFILL'); const al = rs.filter((r) => r.dir === e.dir), co = rs.filter((r) => r.dir !== e.dir);
    console.log(`  ${e.d} crack ${e.dir < 0 ? 'DOWN' : 'UP'} W${w} (${a.slice(5, 16)} -> ${b.slice(5, 16)}): aligned n=${al.length} sum $${f(al.reduce((s, r) => s + r.pnl, 0))} ($${f(mean(al.map((r) => r.pnl)), 1)}/trade) | counter n=${co.length} sum $${f(co.reduce((s, r) => s + r.pnl, 0))} ($${f(mean(co.map((r) => r.pnl)), 1)}/trade)`); } }
}
process.exit(0);
