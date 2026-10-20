// study_big_order_burst_flip_20261020.mjs -- runs docs/BIG_ORDER_BURST_FLIP_PREREG_20261020.md (committed d1aa571 before any outcome).
// Big-order burst-then-flip: Test 1 (does price turn, bars first) and Test 2 (do level-fade trades on the burst side after the flip do worse, dollars). Research only.
import fs from 'fs';
import { loadBars, sessionIndex, sum, f } from './lib/pocJoinLoader.mjs';
const FROM = '2023-03-06', TO = '2026-10-19', SPLIT = '2025-06-01', NPAST = 60, MINPAST = 30, T0 = 600, T1 = 959, TEV1 = 900;
const SIZE = +(process.env.SIZE || 70), HI = +(process.env.HI || 0.90), LO_R = +(process.env.LOR || 0.25), FULL = !process.env.SENS;   // SENS=1 -> sensitivity run: no CI/placebo
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const D = await loadBars(FROM, TO), S = sessionIndex(D); const { C, TS } = D; const idxOf = new Map(); for (let i = 0; i < TS.length; i++) idxOf.set(TS[i], i);
// ---- big orders per session: per-minute signed net (minute of the order's first print) + prefix sums
const ODIR = 'scratch/orders_20261020'; const ODATES = []; const CUM = new Map();
for (const fn of fs.readdirSync(ODIR).sort()) { if (!fn.endsWith('.tsv')) continue; const d = fn.slice(0, 10); if (d < FROM || d > TO || !S.rth.get(d)) continue;
  const nm = new Float64Array(1000); for (const line of fs.readFileSync(`${ODIR}/${fn}`, 'utf8').split('\n')) { if (!line) continue; const [sd, sec, sz] = line.split('\t'); if (+sz < SIZE) continue; nm[Math.floor(+sec / 60)] += (sd === 'B' ? 1 : -1) * +sz; }
  const cum = new Float64Array(1001); for (let m = 0; m < 1000; m++) cum[m + 1] = cum[m] + nm[m]; CUM.set(d, cum); ODATES.push(d); }
console.log(`SIZE>=${SIZE}; rank cuts burst>=${HI}/<=${(1 - HI).toFixed(2)}, flip <=${LO_R}/>=${(1 - LO_R).toFixed(2)}; sessions with big-order files ${ODATES.length}`);
const net = (d, a, b) => { const c = CUM.get(d); return c[b] - c[a]; };            // minutes [a,b): orders whose first print is at or after minute a and before minute b
const midrank = (x, arr) => { let lt = 0, eq = 0; for (const v of arr) { if (v < x) lt++; else if (v === x) eq++; } return (lt + 0.5 * eq) / arr.length; };
// ranks[d] = { rP: Float32Array(T1-T0+1), rR } indexed by T - T0 ; T = decision minute (start of that minute)
const RK = new Map();
for (let k = 0; k < ODATES.length; k++) { const d = ODATES[k], past = ODATES.slice(Math.max(0, k - NPAST), k); const rP = new Float32Array(T1 - T0 + 1).fill(NaN), rR = new Float32Array(T1 - T0 + 1).fill(NaN);
  if (past.length >= MINPAST) for (let T = T0; T <= T1; T++) { const p = net(d, T - 30, T - 15), r = net(d, T - 15, T); const pp = past.map(j => net(j, T - 30, T - 15)), pr = past.map(j => net(j, T - 15, T)); rP[T - T0] = midrank(p, pp); rR[T - T0] = midrank(r, pr); }
  RK.set(d, { rP, rR }); }
const mod = (i) => +TS[i].slice(11, 13) * 60 + +TS[i].slice(14, 16); const bucket = (T) => Math.floor((T - T0) / 30);
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mn = (a) => a.length ? sum(a) / a.length : NaN;
const bootDays = (byDay, stat, n = 1500) => { const ds = [...byDay.values()], o = []; for (let b = 0; b < n; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(ds[Math.floor(rnd() * ds.length)]); const v = stat(pick); if (Number.isFinite(v)) o.push(v); } o.sort((a, b) => a - b); return [o[Math.floor(o.length * 0.025)], o[Math.floor(o.length * 0.975)]]; };
const minuteIdx = (d, m) => idxOf.get(`${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`);

// =============== TEST 1: market behavior (bars first) ===============
const HS = [30, 60]; const ctrl = new Map(), evs = [];     // ctrl: key h|s|month|bucket -> [sum, n]; s=+1 (UP-THEN-DOWN class sign) / -1
const allMin = [];                                          // every eligible minute: {d,m,b,fw30,fw60} (ATR-normalised forward change)
for (const d of ODATES) { const atr = S.atr20(d); if (!atr) continue; const rk = RK.get(d); let last = -1e9;
  for (let T = T0; T <= TEV1; T++) { const pos = minuteIdx(d, T - 1); if (pos == null) continue; const fw = {}; let ok = true; for (const h of HS) { const j = minuteIdx(d, T - 1 + h); if (j == null) { ok = false; break; } fw[h] = (C[j] - C[pos]) / atr; } if (!ok) continue;
    const m = d.slice(0, 7), b = bucket(T); allMin.push({ d, m, b, fw }); for (const h of HS) for (const s of [1, -1]) { const key = `${h}|${s}|${m}|${b}`; const c = ctrl.get(key) || ctrl.set(key, [0, 0]).get(key); c[0] += -s * fw[h]; c[1]++; }
    const rP = rk.rP[T - T0], rR = rk.rR[T - T0]; if (!(rP >= 0)) continue;
    const up = rP >= HI && rR <= LO_R, dn = rP <= 1 - HI && rR >= 1 - LO_R; if ((up || dn) && T - last >= 30) { last = T; evs.push({ d, m, b, s: up ? 1 : -1, fw, T }); } } }
// outcome for class sign s: price turning AGAINST the burst = -s * fw  (s=+1: burst was up, turn = down)
const ctrlMean = (h, s, m, b) => { const c = ctrl.get(`${h}|${s}|${m}|${b}`); return c && c[1] ? c[0] / c[1] : NaN; };
const resid = (e, h) => -e.s * e.fw[h] - ctrlMean(h, e.s, e.m, e.b);
console.log(`\n=== TEST 1: events (UP-THEN-DOWN ${evs.filter(e => e.s === 1).length}, DOWN-THEN-UP ${evs.filter(e => e.s === -1).length}) on ${new Set(evs.map(e => e.d)).size} sessions; eligible minutes ${allMin.length} ===`);
const evByDay = (E) => { const m = new Map(); for (const e of E) (m.get(e.d) || m.set(e.d, []).get(e.d)).push(e); return m; };
const t1 = (E, h) => { const r = E.map(e => resid(e, h)).filter(Number.isFinite); return { n: r.length, resid: mn(r), raw: mn(E.map(e => -e.s * e.fw[h])) }; };
const t1null = (E, h, n = 1000) => { const pools = new Map(); for (const a of allMin) { const key = a.m + '|' + a.b; (pools.get(key) || pools.set(key, []).get(key)).push(a); } const o = []; for (let k = 0; k < n; k++) { let t = 0, c = 0; for (const e of E) { const pl = pools.get(e.m + '|' + e.b); if (!pl) continue; const a = pl[Math.floor(rnd() * pl.length)]; const v = -e.s * a.fw[h] - ctrlMean(h, e.s, e.m, e.b); if (Number.isFinite(v)) { t += v; c++; } } o.push(t / c); } o.sort((a, b) => a - b); return o[Math.floor(o.length * 0.95)]; };
for (const h of HS) { const E = evs, s = t1(E, h), ex = t1(E.filter(e => e.d < SPLIT), h), ho = t1(E.filter(e => e.d >= SPLIT), h), am = t1(E.filter(e => e.T < 660), h), pm = t1(E.filter(e => e.T >= 660), h);
  let ci = '[n/a,n/a]', pl = NaN; if (FULL) { const [lo, hi] = bootDays(evByDay(E), (days) => mn(days.flat().map(e => resid(e, h)).filter(Number.isFinite))); ci = `[${f(lo, 3)},${f(hi, 3)}]`; pl = t1null(E, h); }
  console.log(`H=${h}min: n ${s.n} | turn-against-burst outcome (ATR20) mean ${f(s.raw, 3)} | minus matched control = ${f(s.resid, 3)} CI ${ci} placebo95 ${f(pl, 3)} | explore ${f(ex.resid, 3)} (n ${ex.n}) hold-out ${f(ho.resid, 3)} (n ${ho.n}) | before 11:00 ${f(am.resid, 3)} (n ${am.n}) 11:00+ ${f(pm.resid, 3)} (n ${pm.n})`); }

// =============== TEST 2: the roster (dollars) ===============
const rows0 = JSON.parse(fs.readFileSync('scratch/rotation_gate_replay_rows_ts_20261020.json', 'utf8')); const rows = [];
for (const r of rows0) { if (r.d < FROM || r.d > TO || !RK.has(r.d)) continue; const e = idxOf.get(r.ts); if (e == null) continue; const T = mod(e); if (T < T0 || T > T1) continue; const rk = RK.get(r.d); let aP = rk.rP[T - T0], aR = rk.rR[T - T0]; if (!(aP >= 0)) continue; if (!r.long) { aP = 1 - aP; aR = 1 - aR; }
  r.b = bucket(T); r.m = r.d.slice(0, 7); r.T = T; r.burst = aP >= HI && aR <= LO_R; r.flipside = aP <= 1 - HI && aR >= 1 - LO_R; r.fam = /^(OR|IB)/.test(r.lvl) ? 'OR/IB' : /VWAP/.test(r.lvl) ? 'VWAP' : /^PD/.test(r.lvl) ? 'PD' : /^(PW|PM|PY|W|M)/.test(r.lvl) ? 'PW/PM' : 'other'; rows.push(r); }
console.log(`\n=== TEST 2: replay trades with a pattern read (decision minute 10:00-15:59, >=${MINPAST} past sessions): ${rows.length} of ${rows0.length}; burst-side flagged ${rows.filter(r => r.burst).length} on ${new Set(rows.filter(r => r.burst).map(r => r.d)).size} sessions; flip-side ${rows.filter(r => r.flipside).length} ===`);
function tally(R, g) { const t = new Map(); for (const r of R) { const k = r.b; const c = t.get(k) || t.set(k, [0, 0, 0, 0]).get(k); if (g(r)) { c[0]++; c[1] += r.pnl; } else { c[2]++; c[3] += r.pnl; } } return t; }
function matched(t) { let w = 0, d = 0; for (const [, c] of t) { if (c[0] && c[2]) { w += c[0]; d += c[0] * (c[3] / c[2] - c[1] / c[0]); } } return w ? d / w : NaN; }       // matched unflagged mean minus flagged mean
const flaggedStat = (R, g) => { const fl = R.filter(g); return { nF: fl.length, days: new Set(fl.map(r => r.d)).size, mF: mn(fl.map(r => r.pnl)), diff: matched(tally(R, g)), saving: -sum(fl.map(r => r.pnl)) / (R.length || 1) }; };
const byDay = (R) => { const m = new Map(); for (const r of R) (m.get(r.d) || m.set(r.d, []).get(r.d)).push(r); return m; };
function placebo(R, g, n = 1000) { const strata = new Map(); for (const r of R) { const k = r.m + '|' + r.b; (strata.get(k) || strata.set(k, { R: [], nF: 0 }).get(k)).R.push(r); if (g(r)) strata.get(k).nF++; } const o = [];
  for (let k = 0; k < n; k++) { const t = new Map(); for (const st of strata.values()) { const idx = st.R.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } const fl = new Set(idx.slice(0, st.nF)); st.R.forEach((r, i) => { const c = t.get(r.b) || t.set(r.b, [0, 0, 0, 0]).get(r.b); if (fl.has(i)) { c[0]++; c[1] += r.pnl; } else { c[2]++; c[3] += r.pnl; } }); } o.push(matched(t)); } o.sort((a, b) => a - b); return o[Math.floor(o.length * 0.95)]; }
function report(name, R, g, sign = 1) { const s = flaggedStat(R, g); const ex = flaggedStat(R.filter(r => r.d < SPLIT), g), ho = flaggedStat(R.filter(r => r.d >= SPLIT), g); let ci = '[n/a,n/a]', pl = NaN;
  if (FULL && s.nF >= 20) { const [lo, hi] = bootDays(byDay(R), (days) => matched(tally(days.flat(), g))); ci = `[${f(lo, 2)},${f(hi, 2)}]`; pl = placebo(R, g); }
  console.log(`${name}: flagged ${s.nF} (${s.days} sessions) mean pnl ${f(s.mF, 2)} | matched diff (unflagged - flagged) ${f(s.diff, 2)} CI ${ci} placebo95 ${f(pl, 2)} | saving/trade ${f(s.saving, 2)} | explore ${f(ex.diff, 2)} (n ${ex.nF}) hold-out ${f(ho.diff, 2)} (n ${ho.nF})`); return { s, ex, ho, ci, pl }; }
const gB = (r) => r.burst, gF = (r) => r.flipside;
const main = report('BURST-SIDE after the flip [primary]', rows, gB);
const mir = report('FLIP-SIDE (mirror; positive diff would mean flagged trades are BETTER if negated)', rows, gF);
console.log('per family (burst-side):'); let famPos = 0; for (const fm of ['OR/IB', 'PD', 'PW/PM', 'VWAP', 'other']) { const R = rows.filter(r => r.fam === fm), s = flaggedStat(R, gB); if (s.diff > 0) famPos++; console.log(`   ${fm.padEnd(6)} flagged ${s.nF} diff ${f(s.diff, 2)}`); }
console.log('time of day (burst-side):'); for (const [nm, R] of [['decision before 11:00', rows.filter(r => r.T < 660)], ['decision 11:00 or later', rows.filter(r => r.T >= 660)]]) { const s = flaggedStat(R, gB); console.log(`   ${nm}: flagged ${s.nF} diff ${f(s.diff, 2)}`); }
console.log('inside the AGREE (rotation-gated) roster:'); report('   AGREE only', rows.filter(r => r.agree === true), gB);
console.log('incremental over the rotation gate (trades NOT DISAGREE):'); report('   not DISAGREE', rows.filter(r => r.agree !== false), gB);
const p = main; const enough = p.s.nF >= 150 && p.s.days >= 60;
const useful = enough && p.ci !== '[n/a,n/a]' && parseFloat(p.ci.slice(1)) > 0 && p.s.diff > p.pl && Math.sign(p.ho.diff) === Math.sign(p.ex.diff) && p.ex.diff > 0 && p.ho.diff >= 0.5 * p.ex.diff && famPos >= 3;
console.log(`\nVerdict rules (Test 2, burst-side): (i) enough events (>=150 trades on >=60 sessions: ${p.s.nF} on ${p.s.days}) ${enough ? 'PASS' : 'NOT ENOUGH EVENTS'} ; (ii) CI lower > 0 ${p.ci} ; (iii) beats placebo95 ${f(p.pl, 2)} ${p.s.diff > p.pl ? 'PASS' : 'FAIL'} ; (iv) hold-out same sign and >= half of explore ${(p.ex.diff > 0 && p.ho.diff >= 0.5 * p.ex.diff) ? 'PASS' : 'FAIL'} ; (v) >=3 of 5 families positive ${famPos} ${famPos >= 3 ? 'PASS' : 'FAIL'} => ${useful ? 'USEFUL' : 'NOT SHOWN'}`);
process.exit(0);
