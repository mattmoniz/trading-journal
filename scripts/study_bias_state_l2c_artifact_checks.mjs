// POST-HOC (2026-10-19, after the DeepSeek review of the bias-state study; NOT part of the locked v1 results). Question: is the simulated-roster
// advantage "with the prior-2-session direction beats against" (L2b: SIM RTH +26.9/trade, REAL +4.3) a BACKFILL artifact?
// Checks: (1) exclude VWAP_MAGNET / GLOBEX_VWAP_MAGNET (CLAUDE.md: BACKFILL fired_at for these is stored 4-5h early -> mis-assigned windows);
// (2) time stability: SIM first vs second half; (3) by setup family; (4) same-day overlap 2026-07-09..07-28 where BACKFILL and ACTIVE/SHADOW coexist;
// (5) calendar-week CLUSTER bootstrap for the L1 primary cells (DeepSeek item 2: the locked run used an i.i.d. episode bootstrap).
import { loadSessions, buildZones, mean } from './lib/biasStateData.mjs';
import { makeModel, FIT_END } from './lib/biasStateEvents.mjs';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { query } from '../server/db.js';
const S = await loadSessions(); const Z = buildZones(S); const M = makeModel(S, Z);
const rows = (await query(`SELECT setup_type st, fired_at::text fa, actual_pnl::float pnl, origin_status os FROM active_setups WHERE fired_at >= '2025-11-20' AND fired_at < '2026-10-17 18:00' AND actual_pnl IS NOT NULL AND COALESCE(resolution,'')<>'NOT_FILLED' AND origin_status IN ('ACTIVE','SHADOW','BACKFILL') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%' ORDER BY fired_at`)).rows;
for (const r of rows) { r.dir = /(^|_)SHORT(_|$)/.test(r.st) ? -1 : /(^|_)LONG(_|$)/.test(r.st) ? 1 : 0; r.cls = r.os === 'BACKFILL' ? 'SIM' : 'REAL'; r.vwapm = /VWAP_MAGNET/.test(r.st); r.fam = r.st.replace(/_(LONG|SHORT)(_OVERNIGHT)?(_TRAIL)?$/, ''); }
const f = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
function blockCI(vals, tag, blk = 5, N = 3000) { if (vals.length < 6) return null; const nb = Math.ceil(vals.length / blk), r = mulberry32(hashSeed('L2c|' + tag)), o = []; for (let k = 0; k < N; k++) { const pick = []; for (let q = 0; q < nb; q++) { const s = Math.floor(r() * nb) * blk; for (let j = s; j < Math.min(vals.length, s + blk); j++) pick.push(vals[j]); } o.push(mean(pick)); } o.sort((a, b) => a - b); return [o[Math.floor(N * .025)], o[Math.floor(N * .975)]]; }
const C = M.cSeries('RTH'), P = M.plans.RTH;
function perSession(pred, dateFilter = () => true) { const out = []; for (let i = M.LOOK; i < S.length; i++) {
  if (S[i].d > FIT_END || S[i].roll || !P.valid(i) || !dateFilter(S[i].d)) continue; const pct = M.cPct(C, i), d = Math.sign(C[i]); if (!Number.isFinite(pct) || d === 0) continue;
  const day = S[i].r[0].ts.slice(0, 10), start = S[i].r[0].ts, end = S[i].r[S[i].r.length - 1].ts;
  const rs = rows.filter((r) => pred(r) && r.dir !== 0 && r.fa >= start && r.fa < end); const al = rs.filter((r) => r.dir === d).map((r) => r.pnl), co = rs.filter((r) => r.dir !== d).map((r) => r.pnl);
  if (al.length < 3 || co.length < 3) continue; out.push({ d: day, diff: mean(al) - mean(co), dir: d, pct }); } return out; }
function line(label, per) { const v = per.map((x) => x.diff); const ci = blockCI(v, label); console.log(`  ${label.padEnd(46)} sessions ${String(per.length).padStart(3)}  with-minus-against ${f(mean(v), 1).padStart(6)}  CI ${ci ? `[${f(ci[0])}, ${f(ci[1])}]` : 'n/a'}`); }
console.log('RTH plan, W1 (same RTH session), roster excl. POC, declustered. per-session with-direction minus against-direction $/trade');
line('SIM  baseline (replicates L2b)', perSession((r) => r.cls === 'SIM'));
line('SIM  excluding VWAP_MAGNET types', perSession((r) => r.cls === 'SIM' && !r.vwapm));
const simAll = perSession((r) => r.cls === 'SIM'); const mid = simAll[Math.floor(simAll.length / 2)].d;
line(`SIM  first half (to ${mid})`, perSession((r) => r.cls === 'SIM', (d) => d < mid)); line(`SIM  second half (from ${mid})`, perSession((r) => r.cls === 'SIM', (d) => d >= mid));
line('SIM  crack DOWN days only', simAll.filter((x) => x.dir < 0)); line('SIM  crack UP days only', simAll.filter((x) => x.dir > 0));
line('REAL baseline', perSession((r) => r.cls === 'REAL')); line('REAL excluding VWAP_MAGNET types', perSession((r) => r.cls === 'REAL' && !r.vwapm));
// (3) which families carry the SIM effect: pooled aligned-minus-counter by family over all SIM sessions
console.log('\nSIM family contributions (pooled over sessions; aligned $/trade minus counter $/trade; n aligned/counter):');
const famAcc = new Map();
for (let i = M.LOOK; i < S.length; i++) { if (S[i].d > FIT_END || S[i].roll || !P.valid(i)) continue; const pct = M.cPct(C, i), d = Math.sign(C[i]); if (!Number.isFinite(pct) || d === 0) continue; const start = S[i].r[0].ts, end = S[i].r[S[i].r.length - 1].ts;
  for (const r of rows) { if (r.cls !== 'SIM' || r.dir === 0 || r.fa < start || r.fa >= end) continue; const a = famAcc.get(r.fam) || { al: [], co: [] }; (r.dir === d ? a.al : a.co).push(r.pnl); famAcc.set(r.fam, a); } }
[...famAcc].filter(([, a]) => a.al.length + a.co.length >= 80).map(([k, a]) => [k, mean(a.al) - mean(a.co), a.al.length, a.co.length]).sort((x, y) => y[1] - x[1]).forEach(([k, d, na, nc]) => console.log(`  ${k.padEnd(34)} ${f(d, 1).padStart(7)}  (${na}/${nc})`));
// (4) same-day overlap: BACKFILL vs ACTIVE/SHADOW rows for the same (setup_type, trade day)
console.log('\nOverlap 2026-07-09..2026-07-28: per (setup_type, day) mean pnl SIM vs REAL, where both exist');
const key = (r) => r.st + '|' + r.fa.slice(0, 10); const sim = new Map(), real = new Map();
for (const r of rows) { if (r.fa < '2026-07-09' || r.fa >= '2026-07-29' || r.vwapm) continue; const m = r.cls === 'SIM' ? sim : real; if (!m.has(key(r))) m.set(key(r), []); m.get(key(r)).push(r.pnl); }
const both = [...sim.keys()].filter((k) => real.has(k)).map((k) => [mean(sim.get(k)), mean(real.get(k))]);
const mx = mean(both.map((b) => b[0])), my = mean(both.map((b) => b[1])); const rho = both.length > 4 ? both.reduce((s, b) => s + (b[0] - mx) * (b[1] - my), 0) / Math.sqrt(both.reduce((s, b) => s + (b[0] - mx) ** 2, 0) * both.reduce((s, b) => s + (b[1] - my) ** 2, 0)) : NaN;
console.log(`  (type,day) cells with both: ${both.length}; mean SIM ${f(mx, 1)} vs REAL ${f(my, 1)}; correlation ${f(rho, 2)}; total rows SIM ${[...sim.values()].flat().length} REAL ${[...real.values()].flat().length}`);
// (5) calendar-week cluster bootstrap for the L1 primary cells (event-minus-control), vs the locked i.i.d. CIs
console.log('\nL1 primary cells, WEEK-CLUSTER bootstrap (post-hoc sensitivity; locked i.i.d. CIs in spec section 11):');
const wk = (d) => { const t = new Date(d + 'T00:00:00Z'); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day); return t.toISOString().slice(0, 10); };
for (const plan of ['RTH', 'GLX']) { const ev = M.events(plan); for (const [nm, sel] of [['C-only', () => true], ['C&P', (e) => e.hasP]]) {
  const items = ev.filter(sel).filter((e) => e.m2 != null).map((e) => ({ w: wk(e.d), v: e.dir * e.m2 - M.control(plan, e.i, e.dir, 'h2') })); const weeks = [...new Set(items.map((x) => x.w))];
  const r = mulberry32(hashSeed('wk|' + plan + nm)), o = []; for (let k = 0; k < 4000; k++) { const pick = []; for (let q = 0; q < weeks.length; q++) pick.push(...items.filter((x) => x.w === weeks[Math.floor(r() * weeks.length)]).map((x) => x.v)); if (pick.length) o.push(mean(pick)); } o.sort((a, b) => a - b);
  console.log(`  ${plan} ${nm.padEnd(7)} n=${items.length} (weeks ${weeks.length}) event-minus-control ${f(mean(items.map((x) => x.v)))} week-cluster CI [${f(o[Math.floor(o.length * .025)])}, ${f(o[Math.floor(o.length * .975)])}]`); } }
process.exit(0);
