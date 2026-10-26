// Analysis of the Four-Hour Picks blind rating (docs/FOUR_HOUR_PICKS_BLIND_RATING_PREREG_20261026.md). Run ONCE on whatever number is rated at that moment (pre-registered: no re-running as ratings arrive).
// usage: node scripts/analyze_four_hour_picks_20261026.mjs <ratings.json>   (array of {id, call, cues, recognised, note, side})
import fs from 'fs';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
const rat = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), keys = JSON.parse(fs.readFileSync('scratch/picks_20261026/sample_keys.json', 'utf8')).keys;
const EV = JSON.parse(fs.readFileSync('scratch/four_hour_events_20261026.json', 'utf8')).events, byKey = new Map(EV.map((e) => [e.key, e]));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN), f = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : 'n/a');
const aD = (e) => (e.excFree == null ? null : e.excFree / e.d20), bP = (e) => e.excM;
const rows = rat.map((r) => ({ ...r, e: byKey.get(keys[r.id]) })).filter((r) => r.e && aD(r.e) != null);
console.log(`rated charts ${rat.length}; with an outcome ${rows.length}; calls ${JSON.stringify(rows.reduce((m, r) => ((m[r.call] = (m[r.call] || 0) + 1), m), {}))}; recognised-day flags ${rows.filter((r) => r.recognised).length}`);
const seen = new Set(Object.values(keys)), unseen = EV.filter((e) => !seen.has(e.key) && aD(e) != null);
function diffCI(A, B, val, seed, iters = 4000) { // date-blocked bootstrap of mean(A) - mean(B): resample dates within each arm
  const grp = (X) => { const g = new Map(); for (const x of X) (g.get(x.e.day) || g.set(x.e.day, []).get(x.e.day)).push(val(x.e)); return g; }, ga = grp(A), gb = grp(B), ka = [...ga.keys()], kb = [...gb.keys()], r = mulberry32(hashSeed(seed)), d = [];
  const m = (g, ks) => { let s = 0, n = 0; for (let k = 0; k < ks.length; k++) for (const v of g.get(ks[Math.floor(r() * ks.length)])) { s += v; n++; } return s / n; };
  for (let i = 0; i < iters; i++) d.push(m(ga, ka) - m(gb, kb)); d.sort((p, q) => p - q); return [d[Math.floor(0.025 * d.length)], d[Math.floor(0.975 * d.length) - 1]];
}
function perm(T, A, val, seed) { // date-blocked: whole dates' label vectors are exchanged among dates with the same number of rated events
  const rows2 = [...T.map((x) => ({ d: x.e.day, v: val(x.e), t: 1 })), ...A.map((x) => ({ d: x.e.day, v: val(x.e), t: 0 }))], g = new Map(); for (const x of rows2) (g.get(x.d) || g.set(x.d, []).get(x.d)).push(x);
  const bySize = new Map(); for (const [d, xs] of g) (bySize.get(xs.length) || bySize.set(xs.length, []).get(xs.length)).push(xs); const stat = () => { let a = 0, na = 0, b = 0, nb = 0; for (const xs of g.values()) for (const x of xs) { if (x.t) { a += x.v; na++; } else { b += x.v; nb++; } } return a / na - b / nb; };
  const obs = stat(), r = mulberry32(hashSeed(seed)); let ge = 0;
  for (let i = 0; i < 20000; i++) { for (const groups of bySize.values()) { const labs = groups.map((xs) => xs.map((x) => x.t)); for (let k = labs.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [labs[k], labs[j]] = [labs[j], labs[k]]; } groups.forEach((xs, k) => xs.forEach((x, q) => { x.t = labs[k][q]; })); } if (stat() >= obs - 1e-12) ge++; }
  return ge / 20000;
}
const part = (c, set = rows) => set.filter((r) => r.call === c);
function contrast(label, set, val, unit) {
  const T = part('TAKE', set), A = part('STEP ASIDE', set), U = part('UNSURE', set);
  if (T.length < 3 || A.length < 3) { console.log(`  ${label}: too few (TAKE ${T.length}, STEP ASIDE ${A.length})`); return null; }
  const dts = new Set([...T, ...A].map((x) => x.e.day)).size, under = T.length < 15 || A.length < 15 || dts < 15; if (label === 'ALL rated') console.log(`  ${under ? 'UNDERPOWERED (min(TAKE, STEP ASIDE) < 15 or < 15 distinct dates): the numbers below are descriptive only' : 'power floor met'}; TAKE ${T.length}, STEP ASIDE ${A.length}, distinct dates ${dts}, rated events sharing a date ${T.length + A.length - dts}`);
  const d = mean(T.map((x) => val(x.e))) - mean(A.map((x) => val(x.e))), [lo, hi] = diffCI(T, A, val, label), p = perm(T, A, val, label + 'p');
  console.log(`  ${label}: TAKE n${T.length} mean ${f(mean(T.map((x) => val(x.e))))} | STEP ASIDE n${A.length} ${f(mean(A.map((x) => val(x.e))))} | UNSURE n${U.length} ${f(mean(U.map((x) => val(x.e))))} ${unit}\n      TAKE minus STEP ASIDE ${f(d)} [95% date-blocked ${f(lo)}, ${f(hi)}], smallest detectable effect (half-width) ${f((hi - lo) / 2)}, permutation p one-sided ${p.toFixed(3)}`);
  return d;
}
console.log('\nPRIMARY (one counted cell): exit-free +1,440-minute move, excess over clock-matched blind entry, D20 units');
const dPrimary = contrast('ALL rated', rows, aD, 'D20');
console.log('\nSECONDARY (descriptive, no verdict)');
contrast('ALL rated, moonshot exit M excess (points)', rows, bP, 'pts');
contrast('FLOORS only (exit-free, D20)', rows.filter((r) => r.e.side === 'floor'), aD, 'D20'); contrast('TOPS only (exit-free, D20)', rows.filter((r) => r.e.side === 'top'), aD, 'D20');
contrast('WITHOUT recognised-day charts (exit-free, D20)', rows.filter((r) => !r.recognised), aD, 'D20');
const T = part('TAKE'); if (T.length >= 3 && unseen.length) { const [lo, hi] = diffCI(T, unseen.map((e) => ({ e })), aD, 'takeVsUnseen'); console.log(`  TAKE-rated vs the ${unseen.length} UNSEEN events: ${f(mean(T.map((x) => aD(x.e))))} vs ${f(mean(unseen.map(aD)))}; difference ${f(mean(T.map((x) => aD(x.e))) - mean(unseen.map(aD)))} [95% ${f(lo)}, ${f(hi)}]`); }
const cue = new Map(); for (const r of rows) for (const c of r.cues || []) { const o = cue.get(c) || { n: 0, take: 0 }; o.n++; if (r.call === 'TAKE') o.take++; cue.set(c, o); }
console.log('  cues ticked (count, how many of those were TAKE):'); for (const [c, o] of [...cue].sort((x, y) => y[1].n - x[1].n)) console.log(`    ${c.padEnd(44)} ${o.n} / ${o.take}`);
const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = Array(a.length); s.forEach(([, i], k) => (r[i] = k)); return r; }, spear = (x, y) => { const a = rank(x), b = rank(y), ma = mean(a), mb = mean(b); return a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0) * b.reduce((s, v) => s + (v - mb) ** 2, 0)); };
const allE = EV.filter((e) => aD(e) != null && e.relVol != null);
console.log(`  across ALL ${allE.length} events (rated and unrated): Spearman(DROP into the level, exit-free excess) ${f(spear(allE.map((e) => e.drop), allE.map(aD)))}; Spearman(relative volume at the defended bars, exit-free excess) ${f(spear(allE.map((e) => e.relVol), allE.map(aD)))}; same with moonshot excess: DROP ${f(spear(allE.filter((e) => e.excM != null).map((e) => e.drop), allE.filter((e) => e.excM != null).map((e) => e.excM)))}`);
console.log(`  among rated: mean DROP TAKE ${f(mean(part('TAKE').map((r) => r.e.drop)), 2)} vs STEP ASIDE ${f(mean(part('STEP ASIDE').map((r) => r.e.drop)), 2)}; mean relative volume TAKE ${f(mean(part('TAKE').map((r) => r.e.relVol).filter((v) => v != null)), 2)} vs STEP ASIDE ${f(mean(part('STEP ASIDE').map((r) => r.e.relVol).filter((v) => v != null)), 2)}`);
if (dPrimary != null && dPrimary > 0 && T.length >= 5) {
  const md = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }, dc = md(T.map((r) => r.e.drop)), vc = md(T.map((r) => r.e.relVol).filter((v) => v != null)), pass = unseen.filter((e) => e.drop >= dc && e.relVol != null && e.relVol >= vc), fail = unseen.filter((e) => !(e.drop >= dc && e.relVol != null && e.relVol >= vc));
  if (pass.length >= 5 && fail.length >= 5) { const [lo, hi] = diffCI(pass.map((e) => ({ e })), fail.map((e) => ({ e })), aD, 'rule'); console.log(`  LEAD RULE (same-history split, NOT out-of-sample) built from the TAKE-rated medians (DROP >= ${f(dc, 2)} D20 and relative volume >= ${f(vc, 2)}x), applied to the UNSEEN events: pass n${pass.length} ${f(mean(pass.map(aD)))} vs fail n${fail.length} ${f(mean(fail.map(aD)))}; difference ${f(mean(pass.map(aD)) - mean(fail.map(aD)))} [95% ${f(lo)}, ${f(hi)}] (a lead only)`); }
}
process.exit(0);
