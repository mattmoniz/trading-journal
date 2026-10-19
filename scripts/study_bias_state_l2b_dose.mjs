// L2b (exploratory): is it the CRACK SIZE that matters, or is "trade with the last-2-sessions direction" simply better every day?
// For EVERY valid session (not just crack-ON episodes) take d = sign(C) at the same checkpoint, and measure the same-window roster result:
// per-session (mean pnl of trades with direction d) - (mean pnl of trades against d), roster only (POC excluded), declustered, SIM (BACKFILL) vs REAL arms.
// Then bucket sessions by Cpct (the crack-size percentile). A real crack effect should rise with Cpct; a flat profile means the crack adds nothing.
import { loadSessions, buildZones, mean } from './lib/biasStateData.mjs';
import { makeModel, FIT_END } from './lib/biasStateEvents.mjs';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { query } from '../server/db.js';
const S = await loadSessions(); const Z = buildZones(S); const M = makeModel(S, Z);
const rows = (await query(`SELECT setup_type st, fired_at::text fa, actual_pnl::float pnl, origin_status os FROM active_setups WHERE fired_at >= '2025-11-20' AND fired_at < '2026-10-17 18:00' AND actual_pnl IS NOT NULL AND COALESCE(resolution,'')<>'NOT_FILLED' AND origin_status IN ('ACTIVE','SHADOW','BACKFILL') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%' ORDER BY fired_at`)).rows;
for (const r of rows) { r.dir = /(^|_)SHORT(_|$)/.test(r.st) ? -1 : /(^|_)LONG(_|$)/.test(r.st) ? 1 : 0; r.cls = r.os === 'BACKFILL' ? 'SIM' : 'REAL'; }
const f = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const buckets = [[0, 40], [40, 60], [60, 80], [80, 101]];
function boot(vals, tag, N = 3000) { if (vals.length < 5) return null; const blk = 5, nb = Math.ceil(vals.length / blk), r = mulberry32(hashSeed('L2b|' + tag)), o = []; for (let k = 0; k < N; k++) { const pick = []; for (let q = 0; q < nb; q++) { const s = Math.floor(r() * nb) * blk; for (let j = s; j < Math.min(vals.length, s + blk); j++) pick.push(vals[j]); } o.push(mean(pick)); } o.sort((a, b) => a - b); return [o[Math.floor(N * .025)], o[Math.floor(N * .975)]]; }
for (const plan of ['RTH', 'GLX']) {
  const C = M.cSeries(plan), P = M.plans[plan];
  for (const cls of ['SIM', 'REAL']) {
    const per = [];
    for (let i = M.LOOK; i < S.length; i++) {
      if (S[i].d > FIT_END || S[i].roll || !P.valid(i)) continue; const pct = M.cPct(C, i); const d = Math.sign(C[i]); if (!Number.isFinite(pct) || d === 0) continue;
      const day = S[i].r[0].ts.slice(0, 10), start = plan === 'RTH' ? S[i].r[0].ts : `${day} 18:00:00`, hIdx = plan === 'RTH' ? i : i + 1, end = S[hIdx].r[S[hIdx].r.length - 1].ts;
      const rs = rows.filter((r) => r.cls === cls && r.dir !== 0 && r.fa >= start && r.fa < end); const al = rs.filter((r) => r.dir === d).map((r) => r.pnl), co = rs.filter((r) => r.dir !== d).map((r) => r.pnl);
      if (al.length < 3 || co.length < 3) continue; per.push({ i, pct, diff: mean(al) - mean(co), nal: al.length, nco: co.length });
    }
    console.log(`\n${plan} plan, ${cls} arm, W1: ${per.length} sessions with >=3 trades each side. per-session (with-direction minus against-direction) $/trade by crack-size bucket:`);
    for (const [lo, hi] of buckets) { const b = per.filter((x) => x.pct >= lo && x.pct < hi).map((x) => x.diff); const ci = boot(b, `${plan}${cls}${lo}`); console.log(`  Cpct ${String(lo).padStart(2)}-${String(Math.min(hi, 100)).padStart(3)}: sessions ${String(b.length).padStart(3)}  mean ${f(mean(b), 1).padStart(6)}  CI ${ci ? `[${f(ci[0])}, ${f(ci[1])}]` : 'n/a'}`); }
    const all = per.map((x) => x.diff); const ci = boot(all, `${plan}${cls}all`); console.log(`  ALL sessions: mean ${f(mean(all), 1)} CI ${ci ? `[${f(ci[0])}, ${f(ci[1])}]` : 'n/a'}`);
    const xs = per.map((x) => x.pct), ys = per.map((x) => x.diff), mx = mean(xs), my = mean(ys); const rho = per.length > 5 ? xs.reduce((s, x, k) => s + (x - mx) * (ys[k] - my), 0) / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0)) : NaN;
    console.log(`  Pearson(Cpct, with-minus-against) = ${f(rho, 3)}`);
  }
}
process.exit(0);
