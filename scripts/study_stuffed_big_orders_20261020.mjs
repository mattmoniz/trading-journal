// study_stuffed_big_orders_20261020.mjs -- runs docs/STUFFED_BIG_ORDER_PREREG_20261020.md (+ Addendum B), committed 27137b6 / 3aa5810 before any outcome.
// A big individual order (merged same-side prints <=1 ms apart, size >= SIZE) is judged by what price does right after it: A = 60 s later at least TICKS ticks back against its last print, B = price trades back through its VWAP (by 2 ticks) within 5 minutes.
// Test A: does price keep going the other way afterwards (vs matched not-stuffed orders)? Test B: roster dollars when a stuffed order sits on our side / the other side in the last 10-15 minutes. Research only; not DeepSeek-reviewed.
import fs from 'fs';
import { loadBars, sessionIndex, sum, f } from './lib/pocJoinLoader.mjs';
const FROM = '2023-03-06', TO = '2026-10-19', SPLIT = '2025-06-01', SIZE = +(process.env.SIZE || 70), TICKS = +(process.env.TICKS || 2), FULL = !process.env.SENS;
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const D = await loadBars(FROM, TO), S = sessionIndex(D); const { C, TS } = D; const idxOf = new Map(); for (let i = 0; i < TS.length; i++) idxOf.set(TS[i], i);
const OD = 'scratch/stuffed_20261020'; const ORD = new Map(); let nOrders = 0;
for (const fn of fs.readdirSync(OD).sort()) { if (!fn.endsWith('.tsv')) continue; const d = fn.slice(0, 10); if (d < FROM || d > TO || !S.rth.get(d)) continue; const arr = [];
  for (const line of fs.readFileSync(`${OD}/${fn}`, 'utf8').split('\n')) { if (!line) continue; const c = line.split('\t'); const n = (x) => (x === '' || x == null ? NaN : +x); const o = { side: c[0], t0: +c[1], te: +c[2], size: +c[3], np: +c[4], pf: +c[5], pl: +c[6], vw: +c[7], p60: n(c[8]), p300: n(c[9]), p360: n(c[10]), p600: n(c[11]), p960: n(c[12]), p1200: n(c[13]), p1860: n(c[14]), p2100: n(c[15]), ag5: n(c[16]), wi5: n(c[17]) }; if (o.size >= SIZE) arr.push(o); }
  ORD.set(d, arr); nOrders += arr.length; }
console.log(`SIZE>=${SIZE}, stuffed = ${TICKS}+ ticks; sessions ${ORD.size}, big orders ${nOrders}`);
const T = 0.25; const sgnOpp = (o) => (o.side === 'S' ? 1 : -1);                  // outcome sign: positive = price moves OPPOSITE to the order's direction (up after a sell)
for (const [d, arr] of ORD) { const atr = S.atr20(d); for (const o of arr) { o.d = d; o.atr = atr; o.m = d.slice(0, 7); o.sb = o.size >= 150 ? 2 : o.size >= 100 ? 1 : 0;
  o.aTicks = (o.p60 - o.pl) * sgnOpp(o) / T;                                      // + = price 60 s later is AGAINST the order relative to its last print
  o.A = o.aTicks >= TICKS ? 'STUFFED' : o.aTicks <= -TICKS ? 'FOLLOWED' : 'NEUTRAL'; o.refA = o.te + 60;
  o.B = Number.isFinite(o.ag5) ? ((o.side === 'S' ? o.ag5 >= o.vw + 2 * T : o.ag5 <= o.vw - 2 * T) ? 'RECLAIM' : 'NOT') : null; o.refB = o.te + 300; } }
const all = [...ORD.values()].flat();
const bucketOf = (sec) => Math.floor((sec - 36000) / 1800); const mon = (o) => o.m;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mn = (a) => a.length ? sum(a) / a.length : NaN;
const bootDays = (byDay, stat, n = 1500) => { const ds = [...byDay.values()], o = []; for (let b = 0; b < n; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(ds[Math.floor(rnd() * ds.length)]); const v = stat(pick); if (Number.isFinite(v)) o.push(v); } o.sort((a, b) => a - b); return [o[Math.floor(o.length * 0.0125)], o[Math.floor(o.length * 0.9875)]]; };   // 97.5 percent interval (two definitions are tested)
// ======================= TEST A =======================
const HZ = [['5m', 300], ['15m', 900], ['30m', 1800]];
// outcome for definition A from p60 ; for B from p300. pf: forward price key per horizon.
const KEYA = { 300: 'p360', 900: 'p960', 1800: 'p1860' }, KEYB = { 300: 'p600', 900: 'p1200', 1800: 'p2100' };
const outcome = (o, def, h) => { const p0 = def === 'A' ? o.p60 : o.p300, p1 = o[(def === 'A' ? KEYA : KEYB)[h]]; return Number.isFinite(p0) && Number.isFinite(p1) && o.atr ? sgnOpp(o) * (p1 - p0) / o.atr : NaN; };
// unconditional matched control: every minute's signed forward change over the same horizon, by side sign x 30-min bucket (all sessions)
const UC = new Map(); for (const d of ORD.keys()) { const atr = S.atr20(d); if (!atr) continue; const rr = S.rth.get(d); for (let m = 600; m <= 930; m++) { const i = idxOf.get(`${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`); if (i == null) continue;
  for (const [, h] of HZ) { const j = idxOf.get(`${d} ${String(Math.floor((m + h / 60) / 60)).padStart(2, '0')}:${String((m + h / 60) % 60).padStart(2, '0')}:00`); if (j == null) continue; const b = bucketOf(m * 60); for (const s of [1, -1]) { const key = `${h}|${s}|${b}`; const c = UC.get(key) || UC.set(key, [0, 0]).get(key); c[0] += s * (C[j] - C[i]) / atr; c[1]++; } } } }
const ucMean = (o, h, ref) => { const c = UC.get(`${h}|${sgnOpp(o)}|${bucketOf(ref)}`); return c && c[1] ? c[0] / c[1] : NaN; };
const inWin = (ref) => ref >= 36000 && ref < 55800;                     // reference time 10:00-15:30 ET
function items(def, lab, h, controlFilter) { const out = []; for (const o of all) { const ref = def === 'A' ? o.refA : o.refB; if (!inWin(ref)) continue; const y = outcome(o, def, h); if (!Number.isFinite(y)) continue; const L = def === 'A' ? o.A : o.B; const isLab = L === lab; if (!isLab && !controlFilter(o)) continue;
    out.push({ d: o.d, m: o.m, side: o.side, y, lab: isLab ? 1 : 0, cell: `${o.side}|${bucketOf(ref)}|${o.sb}`, ref, uc: ucMean(o, h, ref) }); } return out; }
function matchedDiff(IT, mode = 'ctrl') { const t = new Map(); for (const x of IT) { const c = t.get(x.cell) || t.set(x.cell, [0, 0, 0, 0]).get(x.cell); if (x.lab) { c[0]++; c[1] += x.y; } else { c[2]++; c[3] += x.y; } }
  let w = 0, s = 0; for (const [, c] of t) { if (c[0] && c[2] >= 5) { w += c[0]; s += c[0] * (c[1] / c[0] - c[3] / c[2]); } } return w ? s / w : NaN; }
function ucDiff(IT) { const L = IT.filter(x => x.lab && Number.isFinite(x.uc)); return L.length ? mn(L.map(x => x.y - x.uc)) : NaN; }
function permNull(IT, n = 1000) { const strata = new Map(); for (const x of IT) { const k = x.m + '|' + x.cell; (strata.get(k) || strata.set(k, []).get(k)).push(x); } const o = [];
  for (let k = 0; k < n; k++) { const ag = []; for (const arr of strata.values()) { const nl = arr.filter(x => x.lab).length; const idx = arr.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } const set = new Set(idx.slice(0, nl)); arr.forEach((x, i) => ag.push({ ...x, lab: set.has(i) ? 1 : 0 })); } o.push(matchedDiff(ag)); } o.sort((a, b) => a - b); return o[Math.floor(o.length * 0.975)]; }
const byDayItems = (IT) => { const m = new Map(); for (const x of IT) (m.get(x.d) || m.set(x.d, []).get(x.d)).push(x); return m; };
const TA = {};
for (const [def, lab, ctlName, ctl] of [['A', 'STUFFED', 'FOLLOWED', (o) => o.A === 'FOLLOWED'], ['A', 'STUFFED', 'all other', (o) => o.A !== 'STUFFED'], ['B', 'RECLAIM', 'NOT reclaimed', (o) => o.B === 'NOT']]) {
  console.log(`\n=== TEST A, definition ${def}: ${lab} vs ${ctlName} (outcome: ATR20-normalised price change opposite to the order, from the label time; positive = reversal continues) ===`);
  for (const [hn, h] of HZ) { const IT = items(def, lab, h, ctl); const nl = IT.filter(x => x.lab).length, nc = IT.length - nl; if (nl < 30) { console.log(`   ${hn}: too few (${nl})`); continue; }
    const diff = matchedDiff(IT), ex = matchedDiff(IT.filter(x => x.d < SPLIT)), ho = matchedDiff(IT.filter(x => x.d >= SPLIT)), am = matchedDiff(IT.filter(x => x.ref < 39600)), pm = matchedDiff(IT.filter(x => x.ref >= 39600)), sl = matchedDiff(IT.filter(x => x.side === 'S')), bu = matchedDiff(IT.filter(x => x.side === 'B'));
    let ci = [NaN, NaN], pl = NaN; if (FULL && ctlName !== 'all other') { ci = bootDays(byDayItems(IT), (days) => matchedDiff(days.flat())); pl = permNull(IT); }
    TA[`${def}|${ctlName}|${hn}`] = { diff, ci, pl, ex, ho, nl };
    console.log(`   ${hn}: ${lab} n ${nl} vs ${nc} | mean outcome ${f(mn(IT.filter(x => x.lab).map(x => x.y)), 3)} vs ${f(mn(IT.filter(x => !x.lab).map(x => x.y)), 3)} | matched diff ${f(diff, 3)} CI97.5 [${f(ci[0], 3)},${f(ci[1], 3)}] null97.5 ${f(pl, 3)} | vs unconditional minute ${f(ucDiff(IT), 3)} | explore ${f(ex, 3)} hold-out ${f(ho, 3)} | before 11:00 ${f(am, 3)} later ${f(pm, 3)} | sells ${f(sl, 3)} buys ${f(bu, 3)}`); } }
const sigA = (def, hn) => { const p = TA[`${def}|${def === 'A' ? 'FOLLOWED' : 'NOT reclaimed'}|${hn}`]; return p && FULL && p.ci[0] > 0 && p.diff > p.pl && Math.sign(p.ho) === Math.sign(p.ex) && p.ex > 0; };
const sA = sigA('A', '15m') && (sigA('A', '5m') || sigA('A', '30m')), sB = sigA('B', '15m') && (sigA('B', '5m') || sigA('B', '30m'));
console.log(`\nTest A signal rule (15m primary + one other horizon, CI97.5 above 0, above null97.5, hold-out same sign): definition A ${sA ? 'YES' : 'NO'}, definition B ${sB ? 'YES' : 'NO'}`);
// ======================= TEST B (roster dollars) =======================
const rows0 = JSON.parse(fs.readFileSync('scratch/rotation_gate_replay_rows_ts_20261020.json', 'utf8')); const bucket30 = (T0) => Math.floor((T0 - 600) / 30); const mod = (i) => +TS[i].slice(11, 13) * 60 + +TS[i].slice(14, 16);
function buildRows(def, winSec) { const rows = [];
  for (const r of rows0) { if (r.d < FROM || r.d > TO || !ORD.has(r.d)) continue; const e = idxOf.get(r.ts); if (e == null) continue; const Tm = mod(e); if (Tm < 575 || Tm > 959) continue; const tsec = Tm * 60; const arr = ORD.get(r.d);
    let own = false, opp = false; for (const o of arr) { const lab = def === 'A' ? o.A === 'STUFFED' : o.B === 'RECLAIM'; if (!lab) continue; const ref = def === 'A' ? o.refA : o.refB; if (ref > tsec || ref < tsec - winSec) continue; const ownSide = r.long ? 'B' : 'S'; if (o.side === ownSide) own = true; else opp = true; }
    r.aside = own; r.stepin = opp; r.b = bucket30(Tm); r.m = r.d.slice(0, 7); r.T = Tm; r.fam = /^(OR|IB)/.test(r.lvl) ? 'OR/IB' : /VWAP/.test(r.lvl) ? 'VWAP' : /^PD/.test(r.lvl) ? 'PD' : /^(PW|PM|PY|W|M)/.test(r.lvl) ? 'PW/PM' : 'other'; rows.push(r); } return rows; }
function tally(R, g) { const t = new Map(); for (const r of R) { const k = r.b; const c = t.get(k) || t.set(k, [0, 0, 0, 0]).get(k); if (g(r)) { c[0]++; c[1] += r.pnl; } else { c[2]++; c[3] += r.pnl; } } return t; }
function matched(t) { let w = 0, d = 0; for (const [, c] of t) { if (c[0] && c[2]) { w += c[0]; d += c[0] * (c[3] / c[2] - c[1] / c[0]); } } return w ? d / w : NaN; }       // matched unflagged mean minus flagged mean
const flaggedStat = (R, g) => { const fl = R.filter(g); return { nF: fl.length, days: new Set(fl.map(r => r.d)).size, mF: mn(fl.map(r => r.pnl)), diff: matched(tally(R, g)), saving: -sum(fl.map(r => r.pnl)) / (R.length || 1) }; };
const byDay = (R) => { const m = new Map(); for (const r of R) (m.get(r.d) || m.set(r.d, []).get(r.d)).push(r); return m; };
function placebo(R, g, n = 1000) { const strata = new Map(); for (const r of R) { const k = r.m + '|' + r.b; (strata.get(k) || strata.set(k, { R: [], nF: 0 }).get(k)).R.push(r); if (g(r)) strata.get(k).nF++; } const o = [];
  for (let k = 0; k < n; k++) { const t = new Map(); for (const st of strata.values()) { const idx = st.R.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } const fl = new Set(idx.slice(0, st.nF)); st.R.forEach((r, i) => { const c = t.get(r.b) || t.set(r.b, [0, 0, 0, 0]).get(r.b); if (fl.has(i)) { c[0]++; c[1] += r.pnl; } else { c[2]++; c[3] += r.pnl; } }); } o.push(matched(t)); } o.sort((a, b) => a - b); return o[Math.floor(o.length * 0.975)]; }
function report(name, R, g, sign = 1) { const s = flaggedStat(R, g); const ex = flaggedStat(R.filter(r => r.d < SPLIT), g), ho = flaggedStat(R.filter(r => r.d >= SPLIT), g); let ci = '[n/a,n/a]', pl = NaN;
  if (FULL && s.nF >= 20) { const [lo, hi] = bootDays(byDay(R), (days) => matched(tally(days.flat(), g))); ci = `[${f(lo, 2)},${f(hi, 2)}]`; pl = placebo(R, g); }
  console.log(`${name}: flagged ${s.nF} (${s.days} sessions) mean pnl ${f(s.mF, 2)} | matched diff (unflagged - flagged) ${f(s.diff, 2)} CI97.5 ${ci} placebo97.5 ${f(pl, 2)} | saving/trade ${f(s.saving, 2)} | explore ${f(ex.diff, 2)} (n ${ex.nF}) hold-out ${f(ho.diff, 2)} (n ${ho.nF})`); return { s, ex, ho, ci, pl }; }

const mnr = (a) => a.length ? sum(a) / a.length : NaN;
for (const [def, win, nm] of [['A', 600, 'definition A (60 s response), orders in the previous 10 minutes'], ['B', 900, 'definition B (reclaim), orders in the previous 15 minutes']]) {
  const rows = buildRows(def, win); console.log(`\n=== TEST B (roster dollars), ${nm}: ${rows.length} replay trades; step-aside flagged ${rows.filter(r => r.aside).length} (${new Set(rows.filter(r => r.aside).map(r => r.d)).size} sessions), step-in flagged ${rows.filter(r => r.stepin).length} ===`);
  const gA = (r) => r.aside, gI = (r) => r.stepin;
  const main = report('STEP-ASIDE (a stuffed order on OUR side) [primary]', rows, gA); report('STEP-IN (a stuffed order on the OTHER side; a NEGATIVE matched diff means flagged trades are better) [secondary]', rows, gI);
  let famPos = 0; const fl = []; for (const fm of ['OR/IB', 'PD', 'PW/PM', 'VWAP', 'other']) { const R = rows.filter(r => r.fam === fm), s = flaggedStat(R, gA); if (s.diff > 0) famPos++; fl.push(`${fm} ${f(s.diff, 1)} (n ${s.nF})`); } console.log('   families (step-aside): ' + fl.join(' | '));
  console.log('   by direction: ' + [['LONG', rows.filter(r => r.long)], ['SHORT', rows.filter(r => !r.long)]].map(([n, R]) => { const s = flaggedStat(R, gA); return `${n} ${f(s.diff, 1)} (n ${s.nF})`; }).join(' | ') + ' ; time of day: ' + [['<11:00', rows.filter(r => r.T < 660)], ['11:00+', rows.filter(r => r.T >= 660)]].map(([n, R]) => { const s = flaggedStat(R, gA); return `${n} ${f(s.diff, 1)} (n ${s.nF})`; }).join(' | '));
  report('   AGREE only (step-aside)', rows.filter(r => r.agree === true), gA); report('   not DISAGREE (incremental over the rotation gate, step-aside)', rows.filter(r => r.agree !== false), gA);
  const p = main, enough = p.s.nF >= 150 && p.s.days >= 60; const useful = enough && FULL && parseFloat(p.ci.slice(1)) > 0 && p.s.diff > p.pl && p.ex.diff > 0 && Math.sign(p.ho.diff) === Math.sign(p.ex.diff) && p.ho.diff >= 0.5 * p.ex.diff && famPos >= 3;
  console.log(`   Verdict (step-aside, ${def}): (i) enough events ${p.s.nF} on ${p.s.days} sessions ${enough ? 'PASS' : 'NOT ENOUGH EVENTS'} ; (ii) CI97.5 lower > 0 ${p.ci} ; (iii) beats placebo97.5 ${f(p.pl, 2)} ${p.s.diff > p.pl ? 'PASS' : 'FAIL'} ; (iv) hold-out same sign and >= half of explore ${(p.ex.diff > 0 && p.ho.diff >= 0.5 * p.ex.diff) ? 'PASS' : 'FAIL'} ; (v) >=3 of 5 families ${famPos} ${famPos >= 3 ? 'PASS' : 'FAIL'} => ${useful ? 'USEFUL' : 'NOT SHOWN'}`); }
process.exit(0);
