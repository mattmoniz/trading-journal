// study_poc_join_tell_overlap_20261028.mjs -- Amendment 2 of docs/POC_JOIN_BLOWN_THROUGH_AT_EDGE_PREREG_20261028.md (committed before this was computed). DESCRIPTIVE.
// Is a POC join that gets blown through (a 1-minute close beyond its own leg anchor, against it) the same event as the AMT node-ladder tell (research V1 trades, explore sessions)?
import fs from 'fs';
import { loadBars, buildEvents, fwd, epoch, addDay, mean, sum, f } from './lib/pocJoinLoader.mjs';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
const ROOT = '/home/mmoniz/trading-journal/scratch/volbars500_full_20261028', CSV = '/home/mmoniz/trading-journal/scripts/amt_vbars/trades_V1_explore.csv';
const FROM = '2023-03-06', TO = '2025-05-16', M0 = 600, M1 = 870;                 // tell decisions 10:00..14:30 ET (minutes of day)
const D = await loadBars(FROM, TO), { T, TS, C } = D;
const events = (await buildEvents(D, FROM, TO)).filter(e => e.d <= TO);
const dates = fs.readdirSync(ROOT).filter(x => x.endsWith('.bars.tsv')).map(x => x.slice(0, 10)).filter(d => d <= TO).sort();
// joins: lifetime end epoch and the first blow-through epoch (close beyond the leg anchor against the join, inside the lifetime)
const joins = events.map((e, i) => { const w = fwd(D, events, i); const last = w ? w[1] : e.ei; let blow = Infinity;
  for (let k = e.ei; k <= last; k++) if (e.long ? C[k] < e.anchor : C[k] > e.anchor) { blow = T[k]; break; }
  return { d: e.d, long: e.long, ep: e.ep, end: T[last], blow }; });
const byDate = new Map(); for (const j of joins) (byDate.get(j.d) || byDate.set(j.d, []).get(j.d)).push(j);
// tells
const tells = []; const startCache = new Map();
for (const line of fs.readFileSync(CSV, 'utf8').trim().split('\n').slice(1)) { const [d, ei, , dir, , , , , broke, pts, net] = line.split(','); if (d > TO) continue;
  if (!startCache.has(d)) { startCache.set(d, fs.readFileSync(`${ROOT}/${d}.bars.tsv`, 'utf8').trim().split('\n').map(r => +r.split('\t')[1])); }
  const st = startCache.get(d)[+ei]; if (st == null) continue; const t = epoch(addDay(d, -1) + ' 18:00:00') + Math.floor(st / 60);
  tells.push({ d, dir: +dir, t, m: (t - epoch(d + ' 00:00:00')), broke: broke === 'True' ? 1 : 0, pts: +pts, net: +net }); }
const tellByDate = new Map(); for (const x of tells) (tellByDate.get(x.d) || tellByDate.set(x.d, []).get(x.d)).push(x);
// flags at (date, direction, epoch t): opposed join fired within W min and alive; opposed join blown through before t
const flag = (d, dir, t) => { const o = { o60: false, o120: false, blown: false }; for (const j of byDate.get(d) || []) { if (j.long === (dir > 0)) continue; if (j.ep > t || t >= j.end) continue; const age = t - j.ep; if (age <= 60) o.o60 = true; if (age <= 120) o.o120 = true; if (j.blow <= t) o.blown = true; } return o; };
console.log(`sessions with bars ${dates.length}; joins in range ${joins.length} (blown through: ${joins.filter(j => Number.isFinite(j.blow)).length}); research tell trades ${tells.length} on ${tellByDate.size} days`);
// base rate at the SAME clock minute on all OTHER sessions (each direction): flags and "a tell of that direction fires in the next 120 min"
const base = new Map(); const nowM = (d, m) => epoch(d + ' 00:00:00') + m;
for (const d of dates) for (const dir of [1, -1]) for (let m = M0; m <= M1; m += 5) { const t = nowM(d, m), fl = flag(d, dir, t); const nt = (tellByDate.get(d) || []).some(x => x.dir === dir && x.t > t && x.t <= t + 120);
  const k = dir + '|' + m; let o = base.get(k); if (!o) base.set(k, o = { n: 0, o60: 0, o120: 0, blown: 0, nt: 0, byD: new Map() }); o.n++; o.o60 += fl.o60; o.o120 += fl.o120; o.blown += fl.blown; o.nt += nt; o.byD.set(d, { o60: fl.o60 ? 1 : 0, o120: fl.o120 ? 1 : 0, blown: fl.blown ? 1 : 0 }); }
const exp = (tl, key) => { const m5 = Math.min(M1, Math.max(M0, Math.round(tl.m / 5) * 5)), o = base.get(tl.dir + '|' + m5); const own = o.byD.get(tl.d); return (o[key] - (own ? own[key] : 0)) / Math.max(1, o.n - (own ? 1 : 0)); };
console.log('\n=== (1) share of tell fires with an OPPOSED join, vs the same clock minute on other sessions ===');
const inWin = tells.filter(x => x.m >= M0 && x.m <= M1 + 4);
for (const key of ['o60', 'o120', 'blown']) { const obs = mean(inWin.map(x => flag(x.d, x.dir, x.t)[key] ? 1 : 0)), ex = mean(inWin.map(x => exp(x, key))); console.log(`  ${key.padEnd(6)} observed ${(100 * obs).toFixed(1)}%  expected ${(100 * ex).toFixed(1)}%  lift ${(obs / ex).toFixed(2)}x  (n=${inWin.length})`); }
console.log('\n=== (2) reverse: blown-through joins followed by a same-direction tell within 120 min ===');
const bl = joins.filter(j => Number.isFinite(j.blow) && j.d <= TO && dates.includes(j.d)); let n2 = 0, hit = 0, ex2 = 0;
for (const j of bl) { const dir = j.long ? -1 : 1, m = j.blow - epoch(j.d + ' 00:00:00'); if (m < M0 || m > M1) continue; n2++; if ((tellByDate.get(j.d) || []).some(x => x.dir === dir && x.t > j.blow && x.t <= j.blow + 120)) hit++;
  const o = base.get(dir + '|' + Math.min(M1, Math.max(M0, Math.round(m / 5) * 5))); ex2 += o.nt / o.n; }
console.log(`  blown-through joins with the blow-through at 10:00-14:30: ${n2}; followed by a tell of the break direction within 120 min: ${hit} (${(100 * hit / (n2 || 1)).toFixed(1)}%); same-clock-minute expected ${(100 * ex2 / (n2 || 1)).toFixed(1)}%`);
console.log('\n=== (3) V1 tell outcomes with vs without an opposed join (per-trade means; day-blocked CI of the difference) ===');
const boot = (a, b, key, tag, n = 2000) => { const by = new Map(), add = (arr, k) => { for (const r of arr) { let o = by.get(r.d); if (!o) by.set(r.d, o = [0, 0, 0, 0]); o[k * 2] += r[key]; o[k * 2 + 1]++; } }; add(a, 0); add(b, 1); const days = [...by.values()], r = mulberry32(hashSeed(tag)), out = [];
  for (let i = 0; i < n; i++) { let s1 = 0, c1 = 0, s2 = 0, c2 = 0; for (let k = 0; k < days.length; k++) { const o = days[(r() * days.length) | 0]; s1 += o[0]; c1 += o[1]; s2 += o[2]; c2 += o[3]; } if (c1 && c2) out.push(s1 / c1 - s2 / c2); } out.sort((x, y) => x - y); return out.length ? [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]] : null; };
for (const fk of ['o120', 'blown']) { const A = inWin.filter(x => flag(x.d, x.dir, x.t)[fk]), B = inWin.filter(x => !flag(x.d, x.dir, x.t)[fk]); console.log(`  flag ${fk}: WITH n=${A.length} (${new Set(A.map(x => x.d)).size} days), WITHOUT n=${B.length}`);
  for (const key of ['broke', 'pts', 'net']) { const ci = boot(A, B, key, fk + key); console.log(`    ${key.padEnd(5)} WITH ${f(mean(A.map(x => x[key])), key === 'broke' ? 3 : 1)} WITHOUT ${f(mean(B.map(x => x[key])), key === 'broke' ? 3 : 1)} diff ${f(mean(A.map(x => x[key])) - mean(B.map(x => x[key])), key === 'broke' ? 3 : 1)} CI ${ci ? `[${f(ci[0], key === 'broke' ? 3 : 1)},${f(ci[1], key === 'broke' ? 3 : 1)}]` : 'n/a'}`); } }
process.exit(0);
