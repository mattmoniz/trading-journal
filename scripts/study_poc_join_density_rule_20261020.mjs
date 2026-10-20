// study_poc_join_density_rule_20261020.mjs -- runs the PRE-REGISTERED low-density-entry rule (docs/POC_JOIN_DENSITY_RULE_PREREG_20261020.md, committed d169e52) on the HOLD-OUT (trade dates >= 2025-01-01).
// Reads scratch/poc_join_profile_rows_20261020.json written by study_poc_join_profile_confluence_20261020.mjs (features computed point-in-time; hold-out rows were not examined before this script). Independent Gemini build: scratch/gemini_poc_join_density_rule.mjs.
import fs from 'fs';
import { mean, sum, f } from './lib/pocJoinLoader.mjs';
const CUT = 0.3392, rows = JSON.parse(fs.readFileSync('scratch/poc_join_profile_rows_20261020.json')).filter(r => r.real.dens3 != null);
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
function boot(arr, stat, n = 2000) { const by = new Map(); for (const r of arr) (by.get(r.d) || by.set(r.d, []).get(r.d)).push(r); const ds = [...by.values()], o = []; for (let b = 0; b < n; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(...ds[(rnd() * ds.length) | 0]); const v = stat(pick); if (Number.isFinite(v)) o.push(v); } o.sort((a, b) => a - b); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
const pass = (r) => r.real.dens3 <= CUT, shiftedPassCount = (r) => r.plc.filter(p => p.dens3 != null && p.dens3 <= CUT).length;
const passMinusAll = (pick) => mean(pick.filter(pass).map(r => r.pnl)) - mean(pick.map(r => r.pnl));
const realMinusShift = (pick) => mean(pick.filter(pass).map(r => r.pnl)) - sum(pick.map(r => shiftedPassCount(r) * r.pnl)) / sum(pick.map(shiftedPassCount));
function section(label, sub) { const P = sub.filter(pass), pm = mean(P.map(r => r.pnl)), am = mean(sub.map(r => r.pnl)), [lo, hi] = boot(sub, passMinusAll), big = (a) => a.filter(r => r.pnl >= 100).length / a.length;
  const srt = [...P].sort((x, y) => y.pnl - x.pnl), top5 = sum(srt.slice(0, 5).map(r => r.pnl)) / sum(P.map(r => r.pnl)), flipM = mean(P.map(r => r.pnlFlip)), shM = sum(sub.map(r => shiftedPassCount(r) * r.pnl)) / sum(sub.map(shiftedPassCount));
  console.log(`\n${label}: N all ${sub.length}, N pass ${P.length}, days(pass) ${new Set(P.map(r => r.d)).size}`);
  console.log(`  mean E1: pass ${f(pm, 2)}  all ${f(am, 2)}  pass-minus-all ${f(pm - am, 2)} CI [${f(lo, 1)},${f(hi, 1)}]`);
  console.log(`  P(pnl>=+100): pass ${(100 * big(P)).toFixed(1)}%  all ${(100 * big(sub)).toFixed(1)}% | top-5 share of pass total ${(100 * top5).toFixed(0)}% | flipped-direction placebo (pass set) ${f(flipM, 2)} | shifted-profile placebo ${f(shM, 2)}`);
  return { n: P.length, pm, am, diff: pm - am, lo, hi, top5, bigP: big(P), bigA: big(sub), flipM, shM }; }
const hold = rows.filter(r => r.half === 'HOLDOUT'), h25 = hold.filter(r => r.d < '2026-01-01'), h26 = hold.filter(r => r.d >= '2026-01-01');
console.log(`HOLD-OUT joins with a 3-session profile: ${hold.length} (2025: ${h25.length}, 2026: ${h26.length}); cut dens3 <= ${CUT}`);
const H = section('HOLD-OUT overall', hold), A = section('HOLD-OUT 2025', h25), B = section('HOLD-OUT 2026', h26); const [dlo, dhi] = boot(hold, realMinusShift);
console.log(`\nreal-profile pass mean minus shifted-profile pass mean (hold-out): ${f(H.pm - H.shM, 2)} CI [${f(dlo, 1)},${f(dhi, 1)}]`);
const X = section('REFERENCE ONLY: exploration half (where the cut came from)', rows.filter(r => r.half === 'EXPLORE'));
const P = (ok, t) => console.log((ok ? 'PASS ' : 'FAIL ') + t);
console.log('\n=== PRE-REGISTERED CRITERIA (hold-out) ===');
P(H.n >= 100 && A.n >= 40 && B.n >= 40, `1. N pass >= 100 overall and >= 40 per half (overall ${H.n}, 2025 ${A.n}, 2026 ${B.n})`);
P(H.diff > 0 && H.lo > 0 && A.diff > 0 && B.diff > 0, `2. pass-minus-all > 0, overall CI excludes zero, both halves positive (overall ${f(H.diff, 2)} [${f(H.lo, 1)},${f(H.hi, 1)}], 2025 ${f(A.diff, 2)}, 2026 ${f(B.diff, 2)})`);
P(dlo > 0, `3. real minus shifted-profile placebo CI excludes zero ([${f(dlo, 1)},${f(dhi, 1)}])`);
P(H.pm > H.flipM && A.pm > A.flipM && B.pm > B.flipM, `4. pass mean beats flipped-direction placebo overall/2025/2026 (${f(H.pm, 1)} vs ${f(H.flipM, 1)}; ${f(A.pm, 1)} vs ${f(A.flipM, 1)}; ${f(B.pm, 1)} vs ${f(B.flipM, 1)})`);
P(H.top5 < 0.5, `5. top-5 share of passing total < 50% (${(100 * H.top5).toFixed(0)}%)`);
P(H.bigP > H.bigA, `6. P(pnl>=+100) pass > all (${(100 * H.bigP).toFixed(1)}% vs ${(100 * H.bigA).toFixed(1)}%)`);
process.exit(0);
