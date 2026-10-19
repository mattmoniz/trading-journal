// Directional bias state, L1 (market, bar level). Implements docs/DIRECTIONAL_BIAS_STATE_SPEC.md section 10 + 10.1 (LOCKED before any run).
// RESEARCH ONLY. Fit window ends 2026-10-10 (2026-10-11+ is the untouched holdout; the Oct 12-16 week is only printed as a descriptive case note
// from sessions AFTER the fit window and is NOT used in any statistic).
// Primary horizon = H2: the second RTH close after the checkpoint (RTH plan: next day's RTH close; Globex plan: the RTH close after the one
// that follows the 18:00 checkpoint). H1 (first RTH close after the checkpoint) is secondary. Outcome = direction-signed points from the checkpoint price.
import { loadSessions, buildZones, median, mean } from './lib/biasStateData.mjs';
import { makeModel, FIT_END } from './lib/biasStateEvents.mjs';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';

const PCT_ON = 80;
const S = await loadSessions(); const Z = buildZones(S);
console.log(`sessions ${S.length}, zones ${Z.length}`);
const f = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const { plans, events, control, moveFrom } = makeModel(S, Z);
const LOOK = 2; void moveFrom;
function boot(vals, tag, N = 4000) { if (vals.length < 5) return null; const r = mulberry32(hashSeed('BIAS|' + tag)), o = []; for (let k = 0; k < N; k++) { let s = 0; for (let q = 0; q < vals.length; q++) s += vals[Math.floor(r() * vals.length)]; o.push(s / vals.length); } o.sort((a, b) => a - b); return { lo: o[Math.floor(N * .025)], hi: o[Math.floor(N * .975)], p: 2 * Math.min(o.filter((x) => x <= 0).length, o.filter((x) => x >= 0).length) / N }; }
function summarize(label, list, which, tag) {
  const diffs = list.filter((e) => e[which === 'h2' ? 'm2' : 'm1'] != null).map((e) => { const m = e.dir * e[which === 'h2' ? 'm2' : 'm1']; return { m, c: control(tag.split('|')[0], e.i, e.dir, which), e }; });
  const dv = diffs.map((x) => x.m - x.c); const ci = boot(dv, tag + label + which);
  console.log(`  ${label.padEnd(26)} n=${String(diffs.length).padStart(3)} aligned move ${f(mean(diffs.map((x) => x.m)))} pts (median ${f(median(diffs.map((x) => x.m)))}; ${f(100 * diffs.filter((x) => x.m > 0).length / (diffs.length || 1))}% aligned) | drift control ${f(mean(diffs.map((x) => x.c)))} | event-control ${f(mean(dv))}  CI ${ci ? `[${f(ci.lo)}, ${f(ci.hi)}] p=${f(ci.p, 3)}` : 'n/a (n<5)'}`);
  return { n: diffs.length, d: mean(dv), ci };
}
const primary = {};
for (const plan of ['RTH', 'GLX']) {
  const ev = events(plan); const A = ev, B = ev.filter((e) => e.hasP), N = ev.filter((e) => !e.hasP);
  console.log(`\n===== ${plan} plan: crack ON (Cpct>=${PCT_ON}) episodes ${A.length} (down ${A.filter((e) => e.dir < 0).length}, up ${A.filter((e) => e.dir > 0).length}); with open tail print ${B.length}; without ${N.length} =====`);
  for (const which of ['h2', 'h1']) { console.log(` horizon ${which.toUpperCase()}${which === 'h2' ? ' (PRIMARY)' : ' (secondary)'}`);
    const a = summarize('C-only (all ON)', A, which, plan + '|A'), b = summarize('C & P', B, which, plan + '|B'); summarize('C, no P', N, which, plan + '|N');
    if (which === 'h2') primary[plan] = { a, b }; }
  // descriptive splits (pooled hides opposite signs)
  console.log(' descriptive (H2): by direction');
  summarize('crack DOWN', A.filter((e) => e.dir < 0), 'h2', plan + '|D'); summarize('crack UP', A.filter((e) => e.dir > 0), 'h2', plan + '|U');
  console.log(' descriptive (H2): C & P & S rung'); summarize('C&P&S', B.filter((e) => e.stretch), 'h2', plan + '|S');
  for (const look of [1, 3]) { const e2 = events(plan, look); console.log(` descriptive sensitivity lookback=${look}: episodes ${e2.length}`); summarize(`C-only look${look}`, e2, 'h2', plan + '|L' + look); }
  // print-as-magnet check on P-on events: reached the far edge by H2 close vs mirror level same distance opposite side
  let reached = 0, mirror = 0, n = 0;
  for (const e of B) { const P = plans[plan]; const lastIdx = plan === 'RTH' ? e.i + 1 : e.i + 2; if (lastIdx >= S.length) continue; const zone = e.zone, px = P.px(e.i), dist = e.dir < 0 ? px - zone.hi : zone.lo - px; let lo = Infinity, hi = -Infinity;
    for (let k = (plan === 'RTH' ? e.i : e.i + 1); k <= lastIdx; k++) { const s = S[k]; for (const arr of (k === e.i && plan === 'RTH' ? [s.r] : [s.g, s.r])) for (const b of arr) { if (plan === 'RTH' && k === e.i && false) continue; if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; } }
    n++; const toFar = e.dir < 0 ? lo <= zone.lo : hi >= zone.hi; const toMirror = e.dir < 0 ? hi >= px + (px - zone.lo) : lo <= px - (zone.hi - px); reached += toFar ? 1 : 0; mirror += toMirror ? 1 : 0; }
  console.log(` print-as-magnet (descriptive): P-on episodes ${n}; far edge of the zone reached by the H2 close ${f(100 * reached / (n || 1))}% vs mirror level (same far-edge distance, opposite side) ${f(100 * mirror / (n || 1))}%`);
}
console.log('\n===== Holm over the 4 primary cells (H2): =====');
const cells = [['RTH C-only', primary.RTH.a], ['RTH C&P', primary.RTH.b], ['GLX C-only', primary.GLX.a], ['GLX C&P', primary.GLX.b]].filter(([, c]) => c.ci).sort((x, y) => x[1].ci.p - y[1].ci.p);
cells.forEach(([nm, c], k) => console.log(`  ${nm.padEnd(12)} n=${c.n} event-minus-control ${f(c.d)} pts CI [${f(c.ci.lo)}, ${f(c.ci.hi)}] raw p=${f(c.ci.p, 3)} Holm-adjusted p=${f(Math.min(1, c.ci.p * (cells.length - k)), 3)}`));
const c1 = primary.RTH.a.ci, c2 = primary.GLX.a.ci;
console.log(`KILL RULE: both C-only CIs include zero? RTH ${c1 ? c1.lo <= 0 && c1.hi >= 0 : 'n/a'}, GLX ${c2 ? c2.lo <= 0 && c2.hi >= 0 : 'n/a'} -> ${c1 && c2 && c1.lo <= 0 && c1.hi >= 0 && c2.lo <= 0 && c2.hi >= 0 ? 'L1 FAILS (L2 exploratory only)' : 'L1 not killed'}`);

// ---- event lists (descriptive) and the Oct 12-16 case note (holdout dates: PRINTED ONLY, never in any statistic above) ----
for (const plan of ['RTH', 'GLX']) {
  console.log(`\n--- ${plan} plan event list (fit window): date dir Cpct print(zone) | aligned move H1 / H2 ---`);
  for (const e of events(plan)) console.log(`  ${e.d} ${e.dir < 0 ? 'DN' : 'UP'} Cpct ${f(e.pct)} ${e.hasP ? `P[${f(e.zone.lo)}-${f(e.zone.hi)} dist ${f(e.zone.dist)}]` : 'noP'} | ${e.m1 == null ? 'n/a' : f(e.dir * e.m1)} / ${e.m2 == null ? 'n/a' : f(e.dir * e.m2)}`);
  console.log(`--- ${plan} plan, HOLDOUT case note (Oct 12-16, descriptive only) ---`);
  const late = events(plan, LOOK, '2026-10-17').filter((e) => e.d > FIT_END);
  if (!late.length) console.log('  no crack-ON checkpoint episode starts in that week'); for (const e of late) console.log(`  ${e.d} ${e.dir < 0 ? 'DN' : 'UP'} Cpct ${f(e.pct)} ${e.hasP ? `P[${f(e.zone.lo)}-${f(e.zone.hi)}]` : 'noP'} | aligned move H1 ${e.m1 == null ? 'n/a' : f(e.dir * e.m1)} H2 ${e.m2 == null ? 'n/a' : f(e.dir * e.m2)}`);
}
process.exit(0);
