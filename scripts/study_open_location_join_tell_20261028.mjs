// study_open_location_join_tell_20261028.mjs -- runs docs/OPEN_LOCATION_JOIN_TELL_PREREG_20261028.md (committed 5f4c2fd before any outcome). Run: node ... [--census]
import fs from 'fs';
import { query } from '../server/db.js';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { loadBars, sessionIndex, buildEvents, lb, ub, addDay, mean, sum, f, epoch } from './lib/pocJoinLoader.mjs';
const FROM = '2023-03-06', TO = '2026-10-27', TELL_TO = '2025-05-16', SPLIT = '2025-06-01', HZ = [60, 120, 240, 'end'], CENSUS = process.argv.includes('--census');
const D = await loadBars(FROM, TO), { T, TS, O, H, L, C } = D, SI = sessionIndex(D);
const events = (await buildEvents(D, FROM, TO)).filter(e => e.d <= TO);
const VA = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND level_name IN ('PD_VAH','PD_VAL')`, [FROM, TO])).rows) (VA.get(r.d) || VA.set(r.d, {}).get(r.d))[r.n] = r.p;
const at = (d, hhmm) => lb(TS, d + ' ' + hhmm);
const dayCache = new Map();
function dayInfo(d) { if (dayCache.has(d)) return dayCache.get(d); const iO = at(d, '09:30:00'); let o = null;
  if (TS[iO] && TS[iO].startsWith(d + ' 09:30')) { const a = at(addDay(d, -1), '18:00:00'), b = iO; if (b - a >= 300) { let hi = -Infinity, lo = Infinity; for (let i = a; i < b; i++) { if (H[i] > hi) hi = H[i]; if (L[i] < lo) lo = L[i]; }
    const va = VA.get(d) || {}; const open = O[iO]; o = { A: SI.atr20(d), open, onhV: hi, onlV: lo, vah: va.PD_VAH, val: va.PD_VAL, vaS: va.PD_VAH == null ? null : open > va.PD_VAH ? 'ABOVE' : open < va.PD_VAL ? 'BELOW' : 'INSIDE' }; } }
  dayCache.set(d, o); return o; }
const modAt = (i) => +TS[i].slice(11, 13) * 60 + +TS[i].slice(14, 16);
function outAt(ei, ep, px, sgn, h, se, A) { const k = h === 'end' ? se : ub(T, ep + h - 1) - 1; if (k > se || k <= ei || T[k] < (h === 'end' ? 0 : ep + h - 1 - 2)) return null; return sgn * (C[k] - px) / A; }
const era = (d) => d < SPLIT ? 'PRE' : 'POST';
const aligned = (st, long) => st === 'INSIDE' ? 'INSIDE' : ((st === 'ABOVE') === long ? 'ALIGNED' : 'AGAINST');
// ---- join rows ----
const rows = [];
for (const e of events) { const m = modAt(e.ei), di = dayInfo(e.d); if (!di || !di.A) continue; const rth = m >= 570 && m < 960, glx = m >= 1080 || m < 570; if (!rth && !glx) continue;
  const se = rth ? at(e.d, '16:00:00') - 1 : at(e.d, '09:30:00') - 1; if (e.ei > se) continue; const sgn = e.long ? 1 : -1; const out = {}; for (const h of HZ) out[h] = outAt(e.ei, e.ep, e.entry, sgn, h, se, di.A);
  const vaEntry = di.vah == null ? null : e.entry > di.vah ? 'ABOVE' : e.entry < di.val ? 'BELOW' : 'INSIDE';
  const onhEntry = e.entry > di.onhV ? 'ABOVE' : e.entry < di.onlV ? 'BELOW' : 'INSIDE';
  if (rth) { rows.push({ fam: 'ONH-at-entry RTH', d: e.d, era: era(e.d), long: e.long, st: onhEntry, al: aligned(onhEntry, e.long), out }); if (di.vaS) rows.push({ fam: 'VA-open RTH', d: e.d, era: era(e.d), long: e.long, st: di.vaS, al: aligned(di.vaS, e.long), out }); if (vaEntry) rows.push({ fam: 'VA-at-entry RTH', d: e.d, era: era(e.d), long: e.long, st: vaEntry, al: aligned(vaEntry, e.long), out }); }
  else if (vaEntry) rows.push({ fam: 'VA-at-entry Globex', d: e.d, era: era(e.d), long: e.long, st: vaEntry, al: aligned(vaEntry, e.long), out }); }
const FAMS = ['VA-open RTH', 'ONH-at-entry RTH', 'VA-at-entry RTH', 'VA-at-entry Globex'], TFAMS = ['VA-open RTH', 'ONH-at-entry RTH', 'VA-at-entry RTH'], STS = ['ABOVE', 'INSIDE', 'BELOW'];
console.log(`join events ${events.length}; rows ${rows.length}`);
console.log('\n=== CENSUS (no outcomes): events (days) by direction x state ===');
for (const fam of FAMS) { const R = rows.filter(r => r.fam === fam); console.log(`${fam}: ` + [true, false].map(lg => `${lg ? 'long ' : 'short'} ` + STS.map(s => { const x = R.filter(r => r.long === lg && r.st === s); return `${s} ${x.length}(${new Set(x.map(r => r.d)).size})`; }).join(' ')).join(' | ') + ` | ALIGNED ${R.filter(r => r.al === 'ALIGNED').length} AGAINST ${R.filter(r => r.al === 'AGAINST').length}`); }
// ---- tell rows ----
const tell = []; { const cache = new Map();
  for (const line of fs.readFileSync('/home/mmoniz/trading-journal/scripts/amt_vbars/trades_V1_explore.csv', 'utf8').trim().split('\n').slice(1)) { const [d, , , dir, entryPx, , , , broke, pts, net] = line.split(','); if (d > TELL_TO) continue; const di = dayInfo(d); if (!di) continue; const long = +dir > 0;
    const ex = +entryPx, onhT = ex > di.onhV ? 'ABOVE' : ex < di.onlV ? 'BELOW' : 'INSIDE', vaT = di.vah == null ? null : ex > di.vah ? 'ABOVE' : ex < di.val ? 'BELOW' : 'INSIDE'; for (const [fam, st] of [['ONH-at-entry RTH', onhT], ['VA-open RTH', di.vaS], ['VA-at-entry RTH', vaT]]) if (st) tell.push({ fam, d, era: era(d), long, st, al: aligned(st, long), broke: broke === 'True' ? 1 : 0, pts: +pts, net: +net }); } }
console.log('tell trades (rows across the 2 families): ' + tell.length);
for (const fam of TFAMS) { const R = tell.filter(r => r.fam === fam); console.log(`tell ${fam}: ALIGNED ${R.filter(r => r.al === 'ALIGNED').length} AGAINST ${R.filter(r => r.al === 'AGAINST').length} INSIDE ${R.filter(r => r.al === 'INSIDE').length}`); }
if (CENSUS) process.exit(0);
// ---- stats ----
const boot = (a, b, key, tag, n = 2000) => { const by = new Map(), add = (arr, k) => { for (const r of arr) { const v = key(r); if (v == null) continue; let o = by.get(r.d); if (!o) by.set(r.d, o = [0, 0, 0, 0]); o[k * 2] += v; o[k * 2 + 1]++; } }; add(a, 0); if (b) add(b, 1);
  const days = [...by.values()], r = mulberry32(hashSeed(tag)), out = []; for (let i = 0; i < n; i++) { let s1 = 0, c1 = 0, s2 = 0, c2 = 0; for (let k = 0; k < days.length; k++) { const o = days[(r() * days.length) | 0]; s1 += o[0]; c1 += o[1]; s2 += o[2]; c2 += o[3]; } if (c1 && (!b || c2)) out.push(s1 / c1 - (b ? s2 / c2 : 0)); }
  out.sort((x, y) => x - y); return out.length ? [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]] : null; };
const pm = (rs, key) => { const v = rs.map(key).filter(x => x != null); return v.length ? mean(v) : NaN; };
const ci = (c) => c ? `[${f(c[0], 3)},${f(c[1], 3)}]` : 'n/a';
console.log('\n=== JOINS: with-join signed move (ATR20) ===');
const verdicts = [];
for (const fam of FAMS) { const R = rows.filter(r => r.fam === fam); console.log(`\n-- ${fam}`);
  for (const h of HZ) { console.log(`  +${String(h).padEnd(3)} ` + [true, false].map(lg => (lg ? 'LONG  ' : 'SHORT ') + STS.map(s => { const x = R.filter(r => r.long === lg && r.st === s); return `${s} ${f(pm(x, r => r.out[h]), 3)}(n${x.filter(r => r.out[h] != null).length})`; }).join(' ')).join(' | ')); }
  const Al = R.filter(r => r.al === 'ALIGNED'), Ag = R.filter(r => r.al === 'AGAINST'), In = R.filter(r => r.al === 'INSIDE'); const res = {};
  for (const h of HZ) { const k = r => r.out[h]; const d1 = pm(Al, k) - pm(Ag, k), c1 = boot(Al, Ag, k, fam + 'AA' + h), d2 = pm(Al, k) - pm(In, k), c2 = boot(Al, In, k, fam + 'AI' + h);
    const pre = pm(Al.filter(r => r.era === 'PRE'), k) - pm(Ag.filter(r => r.era === 'PRE'), k), post = pm(Al.filter(r => r.era === 'POST'), k) - pm(Ag.filter(r => r.era === 'POST'), k); res[h] = { d1, c1, d2, c2, pre, post };
    console.log(`  +${String(h).padEnd(3)} ALIGNED ${f(pm(Al, k), 3)} AGAINST ${f(pm(Ag, k), 3)} INSIDE ${f(pm(In, k), 3)} | ALIGNED-AGAINST ${f(d1, 3)} CI ${ci(c1)} PRE ${f(pre, 3)} POST ${f(post, 3)} | ALIGNED-INSIDE ${f(d2, 3)} CI ${ci(c2)}`); }
  const byDay = new Map(); for (const r of Al) if (r.out[60] != null) byDay.set(r.d, (byDay.get(r.d) || 0) + r.out[60]); const dv = [...byDay.values()].sort((x, y) => y - x), tot = sum(dv), share = tot > 0 ? sum(dv.slice(0, 5)) / tot : NaN;
  const ok = (x) => x.c1 && x.c1[0] > 0, c1ok = Al.length >= 100 && new Set(Al.map(r => r.d)).size >= 40, c2ok = ok(res[60]) && ok(res[120]), c3ok = res[60].d2 > 0 && res[120].d2 > 0, c4ok = [60, 120].every(h => res[h].pre > 0 && res[h].post > 0), c5ok = tot > 0 && share < 0.5;
  console.log(`  screen: N/days ${c1ok} | A-vs-Against CI>0 at +60,+120 ${c2ok} | A>Inside ${c3ok} | PRE&POST>0 ${c4ok} | top5<50% ${c5ok} (share ${f(100 * share, 0)}%)`); verdicts.push({ fam, pass: c1ok && c2ok && c3ok && c4ok && c5ok, d60: res[60].d1, c60: res[60].c1, rev: res[60].c1 && res[60].c1[1] < 0 }); }
console.log('\n=== TELL (V1 research trades, explore): per-trade means by aligned state ===');
for (const fam of TFAMS) { const R = tell.filter(r => r.fam === fam); console.log(`\n-- ${fam}`);
  for (const key of ['broke', 'pts', 'net']) { const dg = key === 'broke' ? 3 : 1; const A = R.filter(r => r.al === 'ALIGNED'), G = R.filter(r => r.al === 'AGAINST'), I = R.filter(r => r.al === 'INSIDE'); const c = boot(A, G, r => r[key], fam + 'T' + key);
    console.log(`  ${key.padEnd(5)} ALIGNED ${f(pm(A, r => r[key]), dg)} (n${A.length}) AGAINST ${f(pm(G, r => r[key]), dg)} (n${G.length}) INSIDE ${f(pm(I, r => r[key]), dg)} (n${I.length}) | ALIGNED-AGAINST ${f(pm(A, r => r[key]) - pm(G, r => r[key]), dg)} CI ${c ? `[${f(c[0], dg)},${f(c[1], dg)}]` : 'n/a'}`); } }
console.log('\n=== VERDICT ===');
for (const v of verdicts) console.log(`${v.fam}: ${v.pass ? 'ALIGNED IMPROVES (lead for one frozen look)' : v.rev ? 'REVERSED: AGAINST beats ALIGNED at +60 (CI below zero)' : 'NOT SHOWN'}; +60 ALIGNED-AGAINST ${f(v.d60, 3)} CI ${ci(v.c60)}`);
process.exit(0);
