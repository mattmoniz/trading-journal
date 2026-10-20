// study_location_regime_pace_20261020.mjs -- runs docs/LOCATION_REGIME_PACE_PREREG_20261020.md (committed e98a945 before any outcome).
// Roster trades: is a NEAR (at the faded price), OWN-side, STUFFED big order (definition A) + FAST tape (volume in the last 30 s ranked vs same clock) followed by worse pnl? Split by regime tercile (R4 frozen cuts 0.30/0.65). Research only; not DeepSeek-reviewed.
import fs from 'fs';
import { loadBars, sessionIndex, sum, f, addDay } from './lib/pocJoinLoader.mjs';
const FROM = '2023-03-06', TO = '2026-10-19', SPLIT = '2025-06-01', NPAST = 60, MINPAST = 30, TICKS = 2, SIZE = 70;
const DNEAR = +(process.env.DNEAR || 0.05), WIN = +(process.env.WIN || 30), FULL = !process.env.SENS, LOOK = 900;
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const D = await loadBars(FROM, TO), S = sessionIndex(D); const { H, L, C, TS } = D; const idxOf = new Map(); for (let i = 0; i < TS.length; i++) idxOf.set(TS[i], i);
const mn = (a) => a.length ? sum(a) / a.length : NaN;
const bootDays = (byDay, stat, n = 1500) => { const ds = [...byDay.values()], o = []; for (let b = 0; b < n; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(ds[Math.floor(rnd() * ds.length)]); const v = stat(pick); if (Number.isFinite(v)) o.push(v); } o.sort((a, b) => a - b); return [o[Math.floor(o.length * 0.0125)], o[Math.floor(o.length * 0.9875)]]; };
// ---- big orders with price paths (stuffed extractor output)
const ORD = new Map(); for (const fn of fs.readdirSync('scratch/stuffed_20261020').sort()) { if (!fn.endsWith('.tsv')) continue; const d = fn.slice(0, 10); if (d < FROM || d > TO || !S.rth.get(d)) continue; const arr = [];
  for (const line of fs.readFileSync(`scratch/stuffed_20261020/${fn}`, 'utf8').split('\n')) { if (!line) continue; const c = line.split('\t'); const n = (x) => (x === '' ? NaN : +x); const o = { side: c[0], t0: +c[1], te: +c[2], size: +c[3], np: +c[4], pf: +c[5], pl: +c[6], vw: +c[7], p60: n(c[8]) }; if (o.size < SIZE) continue;
    o.stuffed = ((o.p60 - o.pl) * (o.side === 'S' ? 1 : -1) / 0.25) >= TICKS; o.ref = o.te + 60; o.speed = o.size / Math.max(o.te - o.t0, 0.001); arr.push(o); } ORD.set(d, arr); }
// ---- per-second total volume prefix sums (seconds 34200..57600 ET)
const PS = new Map(); const SEC0 = 34200, SECN = 57600 - 34200 + 1;
for (const fn of fs.readdirSync('scratch/persec_20261020')) { if (!fn.endsWith('.tsv')) continue; const d = fn.slice(0, 10); if (!ORD.has(d)) continue; const cum = new Float64Array(SECN + 1);
  const v = new Float64Array(SECN); for (const line of fs.readFileSync(`scratch/persec_20261020/${fn}`, 'utf8').split('\n')) { if (!line) continue; const [s, b, a] = line.split('\t'); const k = +s - SEC0; if (k >= 0 && k < SECN) v[k] += +b + +a; }
  for (let k = 0; k < SECN; k++) cum[k + 1] = cum[k] + v[k]; PS.set(d, cum); }
const DATES = [...ORD.keys()].filter(d => PS.has(d)).sort(); const dpos = new Map(DATES.map((d, i) => [d, i]));
console.log(`sessions with big orders and per-second volume: ${DATES.length}; near radius ${DNEAR} x ATR20, pace window ${WIN} s`);
const winVol = (d, T, w) => { const cum = PS.get(d); const a = T - w - SEC0, b = T - SEC0; return a >= 0 && b <= SECN ? cum[b] - cum[a] : NaN; };
const midrank = (x, arr) => { let lt = 0, eq = 0; for (const v of arr) { if (v < x) lt++; else if (v === x) eq++; } return (lt + 0.5 * eq) / arr.length; };
const paceRank = (d, T) => { const k = dpos.get(d), past = DATES.slice(Math.max(0, k - NPAST), k); if (past.length < MINPAST) return null; const cur = winVol(d, T, WIN); if (!Number.isFinite(cur)) return null; return midrank(cur, past.map(p => winVol(p, T, WIN)).filter(Number.isFinite)); };
// ---- regime: developing-range rank (range so far / ATR20 vs previous 60 sessions at the same clock), R4's frozen cuts
const DEVR = new Float64Array(TS.length).fill(NaN); for (const d of DATES) { const rr = S.rth.get(d), atr = S.atr20(d); if (!rr || !atr) continue; let hi = -Infinity, lo = Infinity; for (let i = rr[0]; i < rr[1]; i++) { if (H[i] > hi) hi = H[i]; if (L[i] < lo) lo = L[i]; DEVR[i] = (hi - lo) / atr; } }
const regimeRank = (e) => { const t = TS[e], d = t.slice(0, 10), clock = t.slice(10), k = dpos.get(d); if (k == null || !(DEVR[e] >= 0)) return null; const pv = []; for (let q = Math.max(0, k - NPAST); q < k; q++) { const j = idxOf.get(DATES[q] + clock); if (j != null && DEVR[j] >= 0) pv.push(DEVR[j]); } return pv.length >= MINPAST ? midrank(DEVR[e], pv) : null; };
// ---- trades
const rows0 = JSON.parse(fs.readFileSync('scratch/rotation_gate_replay_rows_ts_20261020.json', 'utf8')); const mod = (i) => +TS[i].slice(11, 13) * 60 + +TS[i].slice(14, 16); const bucket30 = (Tm) => Math.floor((Tm - 600) / 30);
const rows = []; let nNoPace = 0, nNoReg = 0;
for (const r of rows0) { if (r.d < FROM || r.d > TO || !dpos.has(r.d)) continue; const e = idxOf.get(r.ts); if (e == null || e < 2) continue; const Tm = mod(e); if (Tm < 575 || Tm > 959) continue; const T = Tm * 60, atr = S.atr20(r.d); if (!atr) continue; const PT = C[e - 1];
  const pr = paceRank(r.d, T); const rg = regimeRank(e); if (pr == null) { nNoPace++; continue; } if (rg == null) { nNoReg++; continue; }
  const ownSide = r.long ? 'B' : 'S'; let nearOwn = false, nearOpp = false, speedOwn = NaN;
  for (const o of ORD.get(r.d)) { if (!o.stuffed || o.ref > T || o.ref < T - LOOK) continue; if (Math.abs(o.vw - PT) > DNEAR * atr) continue; if (o.side === ownSide) { nearOwn = true; speedOwn = o.speed; } else nearOpp = true; }
  r.T = Tm; r.b = bucket30(Tm); r.m = r.d.slice(0, 7); r.pace = pr; r.fast = pr >= 0.75; r.slow = pr <= 0.25; r.reg = rg; r.regime = rg < 0.30 ? 'LOW' : rg < 0.65 ? 'MID' : 'HIGH'; r.nearOwn = nearOwn; r.nearOpp = nearOpp; r.speedOwn = speedOwn;
  r.fam = /^(OR|IB)/.test(r.lvl) ? 'OR/IB' : /VWAP/.test(r.lvl) ? 'VWAP' : /^PD/.test(r.lvl) ? 'PD' : /^(PW|PM|PY|W|M)/.test(r.lvl) ? 'PW/PM' : 'other'; rows.push(r); }
console.log(`replay trades with pace and regime reads: ${rows.length} (dropped for pace ${nNoPace}, regime ${nNoReg}); near own-side stuffed ${rows.filter(r => r.nearOwn).length}; near opposite-side stuffed ${rows.filter(r => r.nearOpp).length}; FAST ${rows.filter(r => r.fast).length}; SLOW ${rows.filter(r => r.slow).length}; regimes ${['LOW', 'MID', 'HIGH'].map(g => g + ' ' + rows.filter(r => r.regime === g).length).join(', ')}`);
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
const CELLS = [['PRIMARY: NEAR own-side STUFFED and FAST tape (step-aside, predicted worse)', (r) => r.nearOwn && r.fast], ['FALLBACK: NEAR own-side STUFFED (any pace)', (r) => r.nearOwn], ['FAST tape alone', (r) => r.fast], ['SLOW tape alone', (r) => r.slow], ['NEAR own-side stuffed and SLOW', (r) => r.nearOwn && r.slow], ['NEAR opposite-side stuffed (step-in, predicted better; negative diff = flagged better)', (r) => r.nearOpp], ['NEAR opposite-side stuffed and FAST', (r) => r.nearOpp && r.fast]];
console.log('\n=== all cells, pooled (matched diff = unflagged minus flagged, positive = flagged trades worse; CI/placebo at 97.5 percent) ===');
const RES = {}; for (const [nm, g] of CELLS) RES[nm] = report(nm, rows, g);
console.log('\n=== same cells by regime tercile (LOW = balance-like, MID, HIGH = expansion-like): flagged n and matched diff; interaction = HIGH minus MID ===');
for (const [nm, g] of CELLS) { const o = {}; for (const rg of ['LOW', 'MID', 'HIGH']) { const R = rows.filter(r => r.regime === rg), s = flaggedStat(R, g); o[rg] = s; } const it = o.HIGH.diff - o.MID.diff; console.log(`${nm.slice(0, 60).padEnd(60)} LOW ${f(o.LOW.diff, 1)} (n ${o.LOW.nF}) | MID ${f(o.MID.diff, 1)} (n ${o.MID.nF}) | HIGH ${f(o.HIGH.diff, 1)} (n ${o.HIGH.nF}) | interaction ${f(it, 1)}`); }
const prim = RES[CELLS[0][0]], fb = RES[CELLS[1][0]]; const useP = prim.s.nF >= 150 && prim.s.days >= 60; const chosen = useP ? [CELLS[0], prim] : [CELLS[1], fb];
console.log(`\nVerdict target: ${useP ? 'PRIMARY conjunction' : 'FALLBACK (primary had too few events: ' + prim.s.nF + ' trades on ' + prim.s.days + ' sessions)'}`);
const gSel = chosen[0][1], pp = chosen[1]; let famPos = 0; const fl = []; for (const fm of ['OR/IB', 'PD', 'PW/PM', 'VWAP', 'other']) { const R = rows.filter(r => r.fam === fm), s = flaggedStat(R, gSel); if (s.diff > 0) famPos++; fl.push(`${fm} ${f(s.diff, 1)} (n ${s.nF})`); }
console.log('   families: ' + fl.join(' | ') + ' ; by direction: ' + [['LONG', rows.filter(r => r.long)], ['SHORT', rows.filter(r => !r.long)]].map(([n, R]) => { const s = flaggedStat(R, gSel); return `${n} ${f(s.diff, 1)} (n ${s.nF})`; }).join(' | '));
report('   AGREE only', rows.filter(r => r.agree === true), gSel); report('   not DISAGREE (incremental over the rotation gate)', rows.filter(r => r.agree !== false), gSel);
const sp = rows.filter(r => r.nearOwn && Number.isFinite(r.speedOwn)).map(r => r.speedOwn); console.log(`   descriptive: speed of the near own-side stuffed big order (contracts per second) median ${f(sp.sort((a, b) => a - b)[Math.floor(sp.length / 2)], 0)}, n ${sp.length}`);
const enough = pp.s.nF >= 150 && pp.s.days >= 60; const useful = enough && FULL && parseFloat(pp.ci.slice(1)) > 0 && pp.s.diff > pp.pl && pp.ex.diff > 0 && Math.sign(pp.ho.diff) === Math.sign(pp.ex.diff) && pp.ho.diff >= 0.5 * pp.ex.diff && famPos >= 3;
console.log(`\nVerdict rules: (i) enough events ${pp.s.nF} on ${pp.s.days} sessions ${enough ? 'PASS' : 'NOT ENOUGH EVENTS'} ; (ii) CI97.5 lower > 0 ${pp.ci} ; (iii) beats placebo97.5 ${f(pp.pl, 2)} ${pp.s.diff > pp.pl ? 'PASS' : 'FAIL'} ; (iv) hold-out same sign and >= half of explore ${(pp.ex.diff > 0 && pp.ho.diff >= 0.5 * pp.ex.diff) ? 'PASS' : 'FAIL'} ; (v) >=3 of 5 families ${famPos} ${famPos >= 3 ? 'PASS' : 'FAIL'} => ${useful ? 'USEFUL' : 'NOT SHOWN'}`);

if (process.env.EXPLORE) { console.log('\n=== EXPLORATORY (not in the pre-registration; labelled): near own-side stuffed (any pace) by regime tercile, with CI97.5/placebo/halves ===');
  for (const rg of ['LOW', 'MID', 'HIGH']) { const R = rows.filter(r => r.regime === rg); report(`   FALLBACK in ${rg}`, R, (r) => r.nearOwn); report(`   PRIMARY in ${rg}`, R, (r) => r.nearOwn && r.fast); }
  report('   SLOW tape alone (all regimes)', rows, (r) => r.slow); }
process.exit(0);
