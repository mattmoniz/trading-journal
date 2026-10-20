// study_big_order_plus_delta_20261020.mjs -- runs docs/BIG_ORDER_PLUS_DELTA_PREREG_20261020.md (committed 80d34cb before any outcome).
// Big individual orders (BIG) in conjunction with cumulative delta (TOTAL) and the rest of the crowd (REST = TOTAL - BIG). Test A (bars first) and Test B (roster dollars). Research only; not DeepSeek-reviewed.
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex, sum, f } from './lib/pocJoinLoader.mjs';
const FROM = '2023-03-06', TO = '2026-10-19', SPLIT = '2025-06-01', NPAST = 60, MINPAST = 30, T0 = 600, T1 = 959, TEV1 = 900;
const SIZE = +(process.env.SIZE || 70), W = +(process.env.W || 30), HI = +(process.env.HI || 0.75), FULL = !process.env.SENS; const LO = 1 - HI; const T0X = Math.max(T0, 570 + W);   // SENS=1 -> sensitivity run: no CI/placebo
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const D = await loadBars(FROM, TO), S = sessionIndex(D); const { C, TS } = D; const idxOf = new Map(); for (let i = 0; i < TS.length; i++) idxOf.set(TS[i], i);
// ---- big orders per session: per-minute signed net (minute of the order's first print) + prefix sums
const ODIR = 'scratch/orders_20261020'; const ODATES = []; const CUM = new Map();
for (const fn of fs.readdirSync(ODIR).sort()) { if (!fn.endsWith('.tsv')) continue; const d = fn.slice(0, 10); if (d < FROM || d > TO || !S.rth.get(d)) continue;
  const nm = new Float64Array(1000); for (const line of fs.readFileSync(`${ODIR}/${fn}`, 'utf8').split('\n')) { if (!line) continue; const [sd, sec, sz] = line.split('\t'); if (+sz < SIZE) continue; nm[Math.floor(+sec / 60)] += (sd === 'B' ? 1 : -1) * +sz; }
  const cum = new Float64Array(1001); for (let m = 0; m < 1000; m++) cum[m + 1] = cum[m] + nm[m]; CUM.set(d, cum); ODATES.push(d); }
// total delta per minute (ask-aggressor minus bid-aggressor volume) from the complete 1-minute bars
const TOTM = new Map(); { const r = await query(`SELECT ts::text ts, bid_volume::float b, ask_volume::float a FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date + 3`, [FROM, TO]); for (const x of r.rows) { const d = x.ts.slice(0, 10); if (!CUM.has(d)) continue; const m = +x.ts.slice(11, 13) * 60 + +x.ts.slice(14, 16); if (m < 570 || m > 959) continue; const arr = TOTM.get(d) || TOTM.set(d, new Float64Array(1000)).get(d); arr[m] += (x.a || 0) - (x.b || 0); } }
const TCUM = new Map(); for (const [d, arr] of TOTM) { const c = new Float64Array(1001); for (let m = 0; m < 1000; m++) c[m + 1] = c[m] + arr[m]; TCUM.set(d, c); }
for (let k = ODATES.length - 1; k >= 0; k--) if (!TCUM.has(ODATES[k])) ODATES.splice(k, 1);
console.log(`SIZE>=${SIZE}, window ${W} min, strong = rank >=${HI} / <=${LO.toFixed(2)}; sessions with big-order files and delta ${ODATES.length}`);
const net = (d, a, b) => CUM.get(d)[b] - CUM.get(d)[a]; const tnet = (d, a, b) => TCUM.get(d)[b] - TCUM.get(d)[a];
const midrank = (x, arr) => { let lt = 0, eq = 0; for (const v of arr) { if (v < x) lt++; else if (v === x) eq++; } return (lt + 0.5 * eq) / arr.length; };
// RK[d] = { rB, rR, rC } indexed by T - T0X ; rB rank of BIG(T-W,T), rR rank of REST(T-W,T)=TOTAL-BIG, rC rank of CVD from the open (secondary)
const RK = new Map();
for (let k = 0; k < ODATES.length; k++) { const d = ODATES[k], past = ODATES.slice(Math.max(0, k - NPAST), k); const L = T1 - T0X + 1; const rB = new Float32Array(L).fill(NaN), rR = new Float32Array(L).fill(NaN), rC = new Float32Array(L).fill(NaN);
  if (past.length >= MINPAST) for (let T = T0X; T <= T1; T++) { const bg = net(d, T - W, T), rs = tnet(d, T - W, T) - bg, cv = tnet(d, 570, T);
    rB[T - T0X] = midrank(bg, past.map(j => net(j, T - W, T))); rR[T - T0X] = midrank(rs, past.map(j => tnet(j, T - W, T) - net(j, T - W, T))); rC[T - T0X] = midrank(cv, past.map(j => tnet(j, 570, T))); }
  RK.set(d, { rB, rR, rC }); }
const mod = (i) => +TS[i].slice(11, 13) * 60 + +TS[i].slice(14, 16); const bucket = (T) => Math.floor((T - 600) / 30);
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mn = (a) => a.length ? sum(a) / a.length : NaN;
const bootDays = (byDay, stat, n = 1500) => { const ds = [...byDay.values()], o = []; for (let b = 0; b < n; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(ds[Math.floor(rnd() * ds.length)]); const v = stat(pick); if (Number.isFinite(v)) o.push(v); } o.sort((a, b) => a - b); return [o[Math.floor(o.length * 0.025)], o[Math.floor(o.length * 0.975)]]; };
const minuteIdx = (d, m) => idxOf.get(`${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`);

// =============== TEST A: market behavior (bars first) ===============
const HS = [30, 60]; const ctrl = new Map(), allMin = []; const CLS = ['DIVUP', 'DIVDN', 'AGUP', 'AGDN', 'BIGUP', 'BIGDN']; const evs = Object.fromEntries(CLS.map(c => [c, []]));
for (const d of ODATES) { const atr = S.atr20(d); if (!atr) continue; const rk = RK.get(d); const last = {}; for (const c of CLS) last[c] = -1e9;
  for (let T = T0X; T <= TEV1; T++) { const pos = minuteIdx(d, T - 1); if (pos == null) continue; const fw = {}; let ok = true; for (const h of HS) { const j = minuteIdx(d, T - 1 + h); if (j == null) { ok = false; break; } fw[h] = (C[j] - C[pos]) / atr; } if (!ok) continue;
    const m = d.slice(0, 7), b = bucket(T); allMin.push({ d, m, b, fw }); for (const h of HS) for (const s of [1, -1]) { const key = `${h}|${s}|${m}|${b}`; const c = ctrl.get(key) || ctrl.set(key, [0, 0]).get(key); c[0] += s * fw[h]; c[1]++; }
    const rB = rk.rB[T - T0X], rR = rk.rR[T - T0X]; if (!(rB >= 0)) continue; const bu = rB >= HI, bd = rB <= LO, ru = rR >= HI, rd = rR <= LO, rn = rR > LO && rR < HI;
    const hit = { DIVUP: bu && rd, DIVDN: bd && ru, AGUP: bu && ru, AGDN: bd && rd, BIGUP: bu && rn, BIGDN: bd && rn };
    for (const c of CLS) if (hit[c] && T - last[c] >= 30) { last[c] = T; evs[c].push({ d, m, b, s: c.endsWith('UP') ? 1 : -1, fw, T }); } } }
const ctrlMean = (h, s, m, b) => { const c = ctrl.get(`${h}|${s}|${m}|${b}`); return c && c[1] ? c[0] / c[1] : NaN; };
const resid = (e, h) => e.s * e.fw[h] - ctrlMean(h, e.s, e.m, e.b);     // positive = price moved WITH the big orders more than the matched control
console.log(`\n=== TEST A: events per class: ${CLS.map(c => c + ' ' + evs[c].length).join(', ')}; eligible minutes ${allMin.length} ===`);
const evByDay = (E) => { const m = new Map(); for (const e of E) (m.get(e.d) || m.set(e.d, []).get(e.d)).push(e); return m; };
const t1 = (E, h) => { const r = E.map(e => resid(e, h)).filter(Number.isFinite); return { n: r.length, resid: mn(r), raw: mn(E.map(e => e.s * e.fw[h])) }; };
const poolsAll = new Map(); for (const a of allMin) { const key = a.m + '|' + a.b; (poolsAll.get(key) || poolsAll.set(key, []).get(key)).push(a); }
const t1null = (E, h, n = 1000) => { const o = []; for (let k = 0; k < n; k++) { let t = 0, c = 0; for (const e of E) { const pl = poolsAll.get(e.m + '|' + e.b); if (!pl) continue; const a = pl[Math.floor(rnd() * pl.length)]; const v = e.s * a.fw[h] - ctrlMean(h, e.s, e.m, e.b); if (Number.isFinite(v)) { t += v; c++; } } o.push(t / c); } o.sort((a, b) => a - b); return o[Math.floor(o.length * 0.95)]; };
const GROUPS = { 'DIVERGENCE (big up/crowd down + big down/crowd up) [primary]': [...evs.DIVUP, ...evs.DIVDN], 'AGREE (both up + both down)': [...evs.AGUP, ...evs.AGDN], 'BIG strong, crowd neutral': [...evs.BIGUP, ...evs.BIGDN] }; const TA = {};
for (const [nm, E] of Object.entries(GROUPS)) for (const h of HS) { const s = t1(E, h), ex = t1(E.filter(e => e.d < SPLIT), h), ho = t1(E.filter(e => e.d >= SPLIT), h), am = t1(E.filter(e => e.T < 660), h), pm = t1(E.filter(e => e.T >= 660), h);
  let ci = [NaN, NaN], pl = NaN; if (FULL) { ci = bootDays(evByDay(E), (days) => mn(days.flat().map(e => resid(e, h)).filter(Number.isFinite))); pl = t1null(E, h); } TA[nm + h] = { s, ci, pl, ex, ho };
  console.log(`${nm.slice(0, 62).padEnd(62)} H=${h}: n ${s.n} follows-big mean ${f(s.raw, 3)} | matched residual ${f(s.resid, 3)} CI [${f(ci[0], 3)},${f(ci[1], 3)}] null95 ${f(pl, 3)} | explore ${f(ex.resid, 3)} (n ${ex.n}) hold-out ${f(ho.resid, 3)} (n ${ho.n}) | before 11:00 ${f(am.resid, 3)} (n ${am.n}) 11:00+ ${f(pm.resid, 3)}`); }
for (const c of ['DIVUP', 'DIVDN']) console.log(`   ${c}: n ${evs[c].length} H=30 residual ${f(t1(evs[c], 30).resid, 3)} H=60 ${f(t1(evs[c], 60).resid, 3)}`);
const pa = TA['DIVERGENCE (big up/crowd down + big down/crowd up) [primary]30'], pa60 = TA['DIVERGENCE (big up/crowd down + big down/crowd up) [primary]60'];
const sigA = (p) => FULL && p.ci[0] > 0 && p.s.resid > p.pl && Math.sign(p.ho.resid) === Math.sign(p.ex.resid) && p.ex.resid > 0; console.log(`Test A signal (CI above 0, above null95, hold-out same sign): H=30 ${sigA(pa) ? 'YES' : 'NO'}, H=60 ${sigA(pa60) ? 'YES' : 'NO'}`);

// =============== TEST B: the roster (dollars) ===============
const rows0 = JSON.parse(fs.readFileSync('scratch/rotation_gate_replay_rows_ts_20261020.json', 'utf8')); const rows = [];
for (const r of rows0) { if (r.d < FROM || r.d > TO || !RK.has(r.d)) continue; const e = idxOf.get(r.ts); if (e == null) continue; const T = mod(e); if (T < T0X || T > T1) continue; const rk = RK.get(r.d); let aB = rk.rB[T - T0X], aR = rk.rR[T - T0X], aC = rk.rC[T - T0X]; if (!(aB >= 0)) continue; if (!r.long) { aB = 1 - aB; aR = 1 - aR; aC = 1 - aC; }
  r.b = bucket(T); r.m = r.d.slice(0, 7); r.T = T; r.stand = aB <= LO && aR >= HI; r.standin = aB >= HI && aR <= LO; r.cvdAgainst = aC <= LO; r.fam = /^(OR|IB)/.test(r.lvl) ? 'OR/IB' : /VWAP/.test(r.lvl) ? 'VWAP' : /^PD/.test(r.lvl) ? 'PD' : /^(PW|PM|PY|W|M)/.test(r.lvl) ? 'PW/PM' : 'other'; rows.push(r); }
console.log(`\n=== TEST B: replay trades with a read (decision minute ${T0X}..${T1}, >=${MINPAST} past sessions): ${rows.length} of ${rows0.length}; stand-down flagged ${rows.filter(r => r.stand).length} on ${new Set(rows.filter(r => r.stand).map(r => r.d)).size} sessions; stand-in ${rows.filter(r => r.standin).length}; CVD-from-open against us ${rows.filter(r => r.cvdAgainst).length} ===`);
function tally(R, g) { const t = new Map(); for (const r of R) { const k = r.b; const c = t.get(k) || t.set(k, [0, 0, 0, 0]).get(k); if (g(r)) { c[0]++; c[1] += r.pnl; } else { c[2]++; c[3] += r.pnl; } } return t; }
function matched(t) { let w = 0, d = 0; for (const [, c] of t) { if (c[0] && c[2]) { w += c[0]; d += c[0] * (c[3] / c[2] - c[1] / c[0]); } } return w ? d / w : NaN; }       // matched unflagged mean minus flagged mean
const flaggedStat = (R, g) => { const fl = R.filter(g); return { nF: fl.length, days: new Set(fl.map(r => r.d)).size, mF: mn(fl.map(r => r.pnl)), diff: matched(tally(R, g)), saving: -sum(fl.map(r => r.pnl)) / (R.length || 1) }; };
const byDay = (R) => { const m = new Map(); for (const r of R) (m.get(r.d) || m.set(r.d, []).get(r.d)).push(r); return m; };
function placebo(R, g, n = 1000) { const strata = new Map(); for (const r of R) { const k = r.m + '|' + r.b; (strata.get(k) || strata.set(k, { R: [], nF: 0 }).get(k)).R.push(r); if (g(r)) strata.get(k).nF++; } const o = [];
  for (let k = 0; k < n; k++) { const t = new Map(); for (const st of strata.values()) { const idx = st.R.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } const fl = new Set(idx.slice(0, st.nF)); st.R.forEach((r, i) => { const c = t.get(r.b) || t.set(r.b, [0, 0, 0, 0]).get(r.b); if (fl.has(i)) { c[0]++; c[1] += r.pnl; } else { c[2]++; c[3] += r.pnl; } }); } o.push(matched(t)); } o.sort((a, b) => a - b); return o[Math.floor(o.length * 0.95)]; }
function report(name, R, g, sign = 1) { const s = flaggedStat(R, g); const ex = flaggedStat(R.filter(r => r.d < SPLIT), g), ho = flaggedStat(R.filter(r => r.d >= SPLIT), g); let ci = '[n/a,n/a]', pl = NaN;
  if (FULL && s.nF >= 20) { const [lo, hi] = bootDays(byDay(R), (days) => matched(tally(days.flat(), g))); ci = `[${f(lo, 2)},${f(hi, 2)}]`; pl = placebo(R, g); }
  console.log(`${name}: flagged ${s.nF} (${s.days} sessions) mean pnl ${f(s.mF, 2)} | matched diff (unflagged - flagged) ${f(s.diff, 2)} CI ${ci} placebo95 ${f(pl, 2)} | saving/trade ${f(s.saving, 2)} | explore ${f(ex.diff, 2)} (n ${ex.nF}) hold-out ${f(ho.diff, 2)} (n ${ho.nF})`); return { s, ex, ho, ci, pl }; }
const gS = (r) => r.stand, gI = (r) => r.standin, gC = (r) => r.cvdAgainst;
const main = report('STAND-DOWN (big orders against us, crowd with us) [primary]', rows, gS);
report('STAND-IN (big orders with us, crowd against us) [secondary; a NEGATIVE matched diff means flagged trades are better]', rows, gI);
report('secondary: CVD from the open against us (aligned rank <= low cut), not used for the verdict', rows, gC);
console.log('per family (stand-down):'); let famPos = 0; for (const fm of ['OR/IB', 'PD', 'PW/PM', 'VWAP', 'other']) { const R = rows.filter(r => r.fam === fm), s = flaggedStat(R, gS); if (s.diff > 0) famPos++; console.log(`   ${fm.padEnd(6)} flagged ${s.nF} diff ${f(s.diff, 2)}`); }
console.log('time of day (stand-down):'); for (const [nm, R] of [['decision before 11:00', rows.filter(r => r.T < 660)], ['decision 11:00 or later', rows.filter(r => r.T >= 660)]]) { const s = flaggedStat(R, gS); console.log(`   ${nm}: flagged ${s.nF} diff ${f(s.diff, 2)}`); }
console.log('by trade direction (stand-down):'); for (const [nm, R] of [['LONG', rows.filter(r => r.long)], ['SHORT', rows.filter(r => !r.long)]]) { const s = flaggedStat(R, gS); console.log(`   ${nm}: flagged ${s.nF} diff ${f(s.diff, 2)}`); }
console.log('inside the AGREE (rotation-gated) roster:'); report('   AGREE only', rows.filter(r => r.agree === true), gS);
console.log('incremental over the rotation gate (trades NOT DISAGREE):'); report('   not DISAGREE', rows.filter(r => r.agree !== false), gS);
const p = main; const enough = p.s.nF >= 150 && p.s.days >= 60;
const useful = enough && FULL && p.ci !== '[n/a,n/a]' && parseFloat(p.ci.slice(1)) > 0 && p.s.diff > p.pl && Math.sign(p.ho.diff) === Math.sign(p.ex.diff) && p.ex.diff > 0 && p.ho.diff >= 0.5 * p.ex.diff && famPos >= 3;
console.log(`\nVerdict rules (Test B, stand-down): (i) enough events (>=150 trades on >=60 sessions: ${p.s.nF} on ${p.s.days}) ${enough ? 'PASS' : 'NOT ENOUGH EVENTS'} ; (ii) CI lower > 0 ${p.ci} ; (iii) beats placebo95 ${f(p.pl, 2)} ${p.s.diff > p.pl ? 'PASS' : 'FAIL'} ; (iv) hold-out same sign and >= half of explore ${(p.ex.diff > 0 && p.ho.diff >= 0.5 * p.ex.diff) ? 'PASS' : 'FAIL'} ; (v) >=3 of 5 families positive ${famPos} ${famPos >= 3 ? 'PASS' : 'FAIL'} => ${useful ? 'USEFUL' : 'NOT SHOWN'}`);
process.exit(0);
