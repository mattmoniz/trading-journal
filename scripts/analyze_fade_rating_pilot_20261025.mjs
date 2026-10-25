// Analysis of the Fade Rating Pilot (blind TAKE / STEP ASIDE / UNSURE ratings by the user on 40 roster level-fade moments, outcomes hidden at rating time).
// Plan (from docs/ROSTER_FAMILIES_AND_INDICATOR_SPRINT_SCOPE_20261021.md Part C): take-vs-step-aside replay P&L per moment with an interval, plus which cues went with which call.
// Input: ratings exported from the artifact (dir of M##.json) + scratch/label_set_20261020/outcomes.json. Each moment is its own trade; BLIND moments are one per day by construction.
import fs from 'fs';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
const dir = process.argv[2]; const out = JSON.parse(fs.readFileSync('scratch/label_set_20261020/outcomes.json', 'utf8'));
const ratings = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN), f = (x) => (x >= 0 ? '+' : '') + x.toFixed(1);
const rows = ratings.map((r) => ({ id: r.id, call: r.call, cues: r.cues || [], set: r.set, ...out[r.id] })).filter((r) => r.pnl != null);
console.log(`rated moments with an outcome: ${rows.length} of ${ratings.length}; set mix ${JSON.stringify(rows.reduce((m, r) => ((m[r.set] = (m[r.set] || 0) + 1), m), {}))}`);
function ci(a, b, seed) { const rnd = mulberry32(hashSeed(seed)), d = []; for (let i = 0; i < 5000; i++) { const x = Array.from({ length: a.length }, () => a[Math.floor(rnd() * a.length)]), y = Array.from({ length: b.length }, () => b[Math.floor(rnd() * b.length)]); d.push(mean(x) - mean(y)); } d.sort((p, q) => p - q); return [d[Math.floor(0.025 * d.length)], d[Math.floor(0.975 * d.length)]]; }
const by = (c, set = null) => rows.filter((r) => r.call === c && (!set || r.set === set)).map((r) => r.pnl);
const all = rows.map((r) => r.pnl);
console.log(`\nbase rate (all ${all.length}): mean ${f(mean(all))}, win rate ${(100 * all.filter((p) => p > 0).length / all.length).toFixed(0)}%`);
for (const c of ['TAKE', 'STEP ASIDE', 'UNSURE']) { const a = by(c); console.log(`${c.padEnd(11)} n${a.length}  mean ${f(mean(a))}  win ${(100 * a.filter((p) => p > 0).length / a.length).toFixed(0)}%  total ${f(a.reduce((s, x) => s + x, 0))}`); }
const T = by('TAKE'), A = by('STEP ASIDE'); const [lo, hi] = ci(T, A, 'take_vs_aside');
console.log(`\nTAKE minus STEP ASIDE: ${f(mean(T) - mean(A))} per moment, bootstrap 95% [${f(lo)}, ${f(hi)}]  (moments resampled; ${T.length} vs ${A.length})`);
// permutation test on the call labels
const rnd = mulberry32(hashSeed('perm')); const labs = rows.filter((r) => r.call !== 'UNSURE'); let ge = 0; const obs = mean(T) - mean(A);
for (let i = 0; i < 20000; i++) { const p = labs.map((r) => r.pnl); for (let k = p.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [p[k], p[j]] = [p[j], p[k]]; } const t = p.slice(0, T.length), a2 = p.slice(T.length); if (mean(t) - mean(a2) >= obs) ge++; }
console.log(`permutation p (one-sided, TAKE better than STEP ASIDE by at least this much): ${(ge / 20000).toFixed(3)}`);
for (const s of ['BLIND', 'VERIFY']) { const t = by('TAKE', s), a = by('STEP ASIDE', s); console.log(`  ${s}: TAKE n${t.length} ${f(mean(t))} | STEP ASIDE n${a.length} ${f(mean(a))}`); }
console.log('\nby setup direction and gate flag (agree = trade direction matched the 65pt rotation leg at entry):');
for (const k of ['long', 'agree']) for (const v of [true, false]) { const g = rows.filter((r) => r[k] === v); const t = g.filter((r) => r.call === 'TAKE').map((r) => r.pnl), a = g.filter((r) => r.call === 'STEP ASIDE').map((r) => r.pnl); console.log(`  ${k}=${v}: all n${g.length} ${f(mean(g.map((r) => r.pnl)))} | TAKE n${t.length} ${f(mean(t))} | ASIDE n${a.length} ${f(mean(a))}`); }
const cue = new Map(); for (const r of rows) for (const c of r.cues) { const e = cue.get(c) || { n: 0, p: [], take: 0, aside: 0 }; e.n++; e.p.push(r.pnl); if (r.call === 'TAKE') e.take++; if (r.call === 'STEP ASIDE') e.aside++; cue.set(c, e); }
console.log('\ncues ticked (count, mean replay P&L of moments where ticked, #TAKE/#ASIDE):');
for (const [c, e] of [...cue].sort((x, y) => y[1].n - x[1].n)) console.log(`  ${c.padEnd(46)} n${String(e.n).padStart(2)}  ${f(mean(e.p)).padStart(7)}  ${e.take}/${e.aside}`);
process.exit(0);
