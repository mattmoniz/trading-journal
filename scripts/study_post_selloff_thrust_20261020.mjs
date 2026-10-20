// study_post_selloff_thrust_20261020.mjs -- runs docs/POST_SELLOFF_THRUST_PREREG_20261020.md (committed 711c246 before any outcome).
// H1 (primary): after a fast selloff, is the THRUST WINDOW (4h-bar clock c 18-41 since the episode low) followed by an unusually strong up move?
// H2: gate AGREE-DISAGREE inside vs outside the window (3.5y RTH replay rows). H3/H4 descriptive.  Research only; no DB writes, nothing imported by the app.
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex, mean, sum, f, lb, addDay } from './lib/pocJoinLoader.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { detectRotationLegs } from '../server/services/rotationDetector.js';
const FROM = '2023-03-06', TO = '2026-10-16', SPLIT = '2025-06-01';
const argv = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const PCT = +(argv.pct || 90), FH = +(argv.fh || 6), S_SHIFT = +(argv.shift || 0), QUIET = argv.quiet === '1';
const SINCE = argv.since === '1';      // implementation correction after DeepSeek review: episode low = lowest low SINCE the selloff turned on (spec wording); default keeps the original trailing-12 lookback
const WARM = 750;                       // prior 4h bars needed before the rolling percentile exists (~125 sessions; the spec's 250-session window, interpreted with a warm-up)
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const log = (...a) => { if (!QUIET) console.log(...a); };
const D = await loadBars(FROM, TO), S = sessionIndex(D);
// ---- 4h bars anchored 18:00 ET: buckets start 18,22,02,06,10,14 ; hour 17 is the maintenance gap
const startHour = (h) => (h >= 22 || h < 2) ? 22 : h >= 18 ? 18 : h < 6 ? 2 : h < 10 ? 6 : h < 14 ? 10 : 14;
const B = []; { let cur = null;
  for (let i = 0; i < D.TS.length; i++) { const ts = D.TS[i]; if (ts < FROM + ' 00:00:00' || ts > TO + ' 23:59:59') continue; const h = +ts.slice(11, 13); if (h === 17) continue;
    const sh = startHour(h); let sd = ts.slice(0, 10); if (sh === 22 && h < 2) sd = addDay(sd, -1);       // 00:00-01:59 belongs to the bucket that began 22:00 the evening before
    const key = sd + ' ' + sh;
    if (!cur || cur.key !== key) { cur = { key, sd, sh, i0: i, i1: i, H: -Infinity, L: Infinity, n: 0 }; B.push(cur); }
    cur.i1 = i; cur.n++; if (D.H[i] > cur.H) cur.H = D.H[i]; if (D.L[i] < cur.L) cur.L = D.L[i]; cur.C = D.C[i]; cur.endTs = ts; } }
const barsOK = B.filter(b => b.n >= 30); const idxOf = new Map(); barsOK.forEach((b, k) => idxOf.set(b.key, k));
const calDate = (b) => b.endTs.slice(0, 10);          // calendar date of the bucket's last minute (used for ATR20 and roll-week test)
for (const b of barsOK) { b.atr = S.atr20(calDate(b)); b.roll = isInsideNqRollWeek(b.sd) || isInsideNqRollWeek(calDate(b)); b.date = b.sd; b.endMin = +b.endTs.slice(11, 13) * 60 + +b.endTs.slice(14, 16); }
log(`4h bars ${barsOK.length} (raw buckets ${B.length}); roll-week bars ${barsOK.filter(b => b.roll).length}; bars without ATR20 ${barsOK.filter(b => !b.atr).length}`);
// ---- DROP, rolling percentile, episode state machine
const N = barsOK.length, DROP = new Array(N).fill(null), PH = new Array(N).fill('CONTROL'), EP = new Array(N).fill(-1), CC = new Array(N).fill(null);
const hist = []; let active = false, L = 0, tL = 0, ep = -1, epCount = 0;
const eps = [];                                           // {id, startIdx}
const T0 = 18 + S_SHIFT, T1 = 41 + S_SHIFT, EXPIRE = Math.max(41, T1);
for (let i = 0; i < N; i++) { const b = barsOK[i];
  if (b.roll || !b.atr) { active = false; continue; }
  if (i >= 11) { let hh = -Infinity, ok = true; for (let k = i - 11; k <= i; k++) { if (barsOK[k].roll) { ok = false; break; } if (barsOK[k].H > hh) hh = barsOK[k].H; } if (ok) DROP[i] = (hh - b.C) / b.atr; }
  let pctv = null; if (DROP[i] != null && hist.length >= WARM) { const w = hist.slice(-1500).sort((a, c) => a - c); pctv = w[Math.floor(w.length * PCT / 100)]; }
  if (DROP[i] != null) hist.push(DROP[i]);
  if (!active) { if (pctv != null && DROP[i] >= pctv) { active = true; ep = epCount++; eps.push({ id: ep, startIdx: i }); let lo = Infinity, li = i; for (let k = (SINCE ? i : i - 11); k <= i; k++) if (barsOK[k].L < lo) { lo = barsOK[k].L; li = k; } L = lo; tL = li; } }
  else { if (b.L < L) { L = b.L; tL = i; } }
  if (active) { const c = i - tL; if (c > EXPIRE) { active = false; } else { CC[i] = c; EP[i] = ep; PH[i] = c <= 5 ? 'FRESH' : c < T0 ? 'BALANCE' : c <= T1 ? 'THRUST' : 'CONTROL'; } } }
// ---- outcomes (ATR units, FH 4h bars forward). valid only if the FH+1 bars are all non-roll, ATR known
const OUT = new Array(N).fill(null);
for (let i = 0; i + FH < N; i++) { const b = barsOK[i]; if (b.roll || !b.atr) continue; let ok = true, hi = -Infinity, lo = Infinity; for (let k = i + 1; k <= i + FH; k++) { if (barsOK[k].roll) { ok = false; break; } hi = Math.max(hi, barsOK[k].H); lo = Math.min(lo, barsOK[k].L); } if (!ok) continue;
  const R = (barsOK[i + FH].C - b.C) / b.atr, U = (hi - b.C) / b.atr, Dn = (b.C - lo) / b.atr; OUT[i] = { R, U, D: Dn, NET: U - Dn, date: b.date }; }
const cnt = (p) => { let n = 0; for (let i = 0; i < N; i++) if (PH[i] === p && OUT[i]) n++; return n; };
log(`episodes ${epCount}; bars with outcome by phase: FRESH ${cnt('FRESH')}, BALANCE ${cnt('BALANCE')}, THRUST ${cnt('THRUST')}, CONTROL ${cnt('CONTROL')}`);
const epsWith = (p) => new Set(barsOK.map((_, i) => i).filter(i => PH[i] === p && OUT[i]).map(i => EP[i])).size;
log(`episodes with >=1 THRUST bar having an outcome: ${epsWith('THRUST')}; FRESH ${epsWith('FRESH')}; BALANCE ${epsWith('BALANCE')}`);
// ---- H1 statistic with episode-clustered CI
const bars = (p, filt = () => true) => barsOK.map((_, i) => i).filter(i => PH[i] === p && OUT[i] && filt(i));
const ctrl = bars('CONTROL');
const stat = (idx, key) => mean(idx.map(i => OUT[i][key]));
function ci(tIdx, cIdx, key, n = 2000, dropEp = null) { const byEp = new Map(); for (const i of tIdx) { if (EP[i] === dropEp) continue; (byEp.get(EP[i]) || byEp.set(EP[i], []).get(EP[i])).push(i); } const E = [...byEp.values()];
  const byD = new Map(); for (const i of cIdx) (byD.get(OUT[i].date) || byD.set(OUT[i].date, []).get(OUT[i].date)).push(i); const Dd = [...byD.values()]; const o = [];
  for (let b = 0; b < n; b++) { const tt = [], cc = []; for (let k = 0; k < E.length; k++) tt.push(...E[Math.floor(rnd() * E.length)]); for (let k = 0; k < Dd.length; k++) cc.push(...Dd[Math.floor(rnd() * Dd.length)]); o.push(stat(tt, key) - stat(cc, key)); }
  o.sort((a, c) => a - c); return [o[Math.floor(n * 0.025)], o[Math.floor(n * 0.975)], E.length]; }
const rowH1 = (label, tIdx, cIdx) => { const out = {}; for (const key of ['R', 'NET', 'U', 'D']) { const d = stat(tIdx, key) - stat(cIdx, key); const [lo, hi, ne] = key === 'R' || key === 'NET' ? ci(tIdx, cIdx, key) : [NaN, NaN, 0]; out[key] = { d, lo, hi, ne }; }
  log(`${label.padEnd(26)} N bars ${String(tIdx.length).padStart(4)} eps ${String(out.R.ne).padStart(3)} | dR ${f(out.R.d, 3)} [${f(out.R.lo, 3)},${f(out.R.hi, 3)}] | dNET ${f(out.NET.d, 3)} [${f(out.NET.lo, 3)},${f(out.NET.hi, 3)}] | dU ${f(out.U.d, 3)} dD ${f(out.D.d, 3)} | THRUST mean R ${f(stat(tIdx, 'R'), 3)} vs control ${f(stat(cIdx, 'R'), 3)}`); return out; };
const isEx = (i) => barsOK[i].date < SPLIT;
const thr = bars('THRUST');
log('\n=== H1: phase minus CONTROL (ATR20 units, forward ' + FH + ' x 4h bars) ===');
const full = rowH1('THRUST pooled', thr, ctrl);
const ex = rowH1('THRUST explore <2025-06', thr.filter(isEx), ctrl.filter(isEx)), ho = rowH1('THRUST hold-out >=2025-06', thr.filter(i => !isEx(i)), ctrl.filter(i => !isEx(i)));
rowH1('FRESH pooled', bars('FRESH'), ctrl); rowH1('BALANCE pooled', bars('BALANCE'), ctrl);
// ---- placebo: shift every episode's THRUST bars by a random +-(20..120 sessions) = *6 bars; stat = mean R(shifted) - mean R(control)
function placebo(key, draws = 200) { const byEp = new Map(); for (const i of thr) (byEp.get(EP[i]) || byEp.set(EP[i], []).get(EP[i])).push(i); const E = [...byEp.values()]; const base = stat(ctrl, key), o = [];
  for (let d = 0; d < draws; d++) { const vals = []; for (const e of E) { const off = (20 + Math.floor(rnd() * 101)) * 6 * (rnd() < 0.5 ? -1 : 1); for (const i of e) { const j = i + off; if (j >= 0 && j < N && OUT[j]) vals.push(OUT[j][key]); } } o.push(mean(vals) - base); } o.sort((a, c) => a - c); return o; }
const plR = placebo('R'), plN = placebo('NET'); const q = (a, p) => a[Math.floor(a.length * p)];
log(`placebo (200 shifts): dR 50th ${f(q(plR, .5), 3)} 95th ${f(q(plR, .95), 3)} | real ${f(full.R.d, 3)} ${full.R.d > q(plR, .95) ? 'EXCEEDS' : 'does not exceed'} 95th ; dNET 95th ${f(q(plN, .95), 3)} real ${f(full.NET.d, 3)} ${full.NET.d > q(plN, .95) ? 'EXCEEDS' : 'does not exceed'}`);
// ---- criterion (iv): drop the episode that contributes most
const byEpAll = new Map(); for (const i of thr) (byEpAll.get(EP[i]) || byEpAll.set(EP[i], []).get(EP[i])).push(i);
let worst = null, worstD = Infinity; for (const e of byEpAll.keys()) { const t2 = thr.filter(i => EP[i] !== e); const d = stat(t2, 'R') - stat(ctrl, 'R'); if (d < worstD) { worstD = d; worst = e; } }
log(`drop-best-episode (ep ${worst}) dR ${f(worstD, 3)}`);
const c1 = full.R.lo > 0 && full.NET.lo > 0, c2 = full.R.d > q(plR, .95), c3 = Math.sign(ex.R.d) === Math.sign(ho.R.d) && Math.sign(ex.R.d) > 0 && ho.R.d >= 0.5 * ex.R.d, c4 = worstD > 0;
log(`criteria: (i) CI excludes 0 for R and NET ${c1 ? 'PASS' : 'FAIL'} ; (ii) beats placebo 95th ${c2 ? 'PASS' : 'FAIL'} ; (iii) same sign both halves, hold-out >= half of explore ${c3 ? 'PASS' : 'FAIL'} ; (iv) survives dropping best episode ${c4 ? 'PASS' : 'FAIL'}  => ${c1 && c2 && c3 && c4 ? 'SUPPORTED' : 'NOT SUPPORTED'}`);
if (QUIET) { console.log(`SENS pct=${PCT} fh=${FH} shift=${S_SHIFT}: eps ${epCount} thrustBars ${thr.length} dR ${f(full.R.d, 3)} [${f(full.R.lo, 3)},${f(full.R.hi, 3)}] dNET ${f(full.NET.d, 3)} [${f(full.NET.lo, 3)},${f(full.NET.hi, 3)}] hold-out dR ${f(ho.R.d, 3)} explore dR ${f(ex.R.d, 3)}`); process.exit(0); }
// ---- phase lookup at an arbitrary ET time (last 4h bar whose last minute is <= that time)
const ends = barsOK.map(b => b.endTs); function phaseAt(ts) { let j = lb(ends, ts); if (j >= ends.length || ends[j] !== ts) j--; return j >= 0 ? { ph: PH[j], c: CC[j], roll: barsOK[j].roll } : null; }
// ---- H2
const rows = JSON.parse(fs.readFileSync('scratch/rotation_gate_replay_rows_20261020.json', 'utf8'));
function h2(tagTime, label) { const T = rows.map(r => { const p = phaseAt(r.d + ' ' + tagTime); return { ...r, ph: p ? p.ph : null }; }).filter(r => r.ph); const inW = (r) => r.ph === 'THRUST';
  const gap = (a) => mean(a.filter(t => t.agree).map(t => t.pnl)) - mean(a.filter(t => !t.agree).map(t => t.pnl)); const I = T.filter(inW), O = T.filter(r => !inW(r));
  const days = [...new Set(T.map(t => t.d))]; const byD = new Map(); for (const t of T) (byD.get(t.d) || byD.set(t.d, []).get(t.d)).push(t); const o = [], oL = [];
  for (let b = 0; b < 1500; b++) { const ti = [], to = []; for (let k = 0; k < days.length; k++) { const arr = byD.get(days[Math.floor(rnd() * days.length)]); for (const t of arr) (inW(t) ? ti : to).push(t); } if (ti.length > 20) { o.push(gap(ti) - gap(to)); oL.push(mean(ti.filter(t => t.long).map(t => t.pnl)) - mean(ti.filter(t => !t.long).map(t => t.pnl))); } } o.sort((a, c) => a - c); oL.sort((a, c) => a - c);
  const ex2 = (a) => a.filter(t => t.d < SPLIT), ho2 = (a) => a.filter(t => t.d >= SPLIT);
  log(`\n=== H2 (${label}) tagged ${T.length} of ${rows.length}; in THRUST ${I.length} (AGREE ${I.filter(t => t.agree).length}/DISAGREE ${I.filter(t => !t.agree).length}); outside ${O.length} ===`);
  log(`gap AGREE-DISAGREE inside ${f(gap(I))}  outside ${f(gap(O))}  diff-of-diff ${f(gap(I) - gap(O))} [${f(o[Math.floor(o.length * .025)])},${f(o[Math.floor(o.length * .975)])}]  explore in/out ${f(gap(ex2(I)))}/${f(gap(ex2(O)))}  hold-out in/out ${f(gap(ho2(I)))}/${f(gap(ho2(O)))}`);
  log(`inside THRUST: mean per-trade AGREE ${f(mean(I.filter(t => t.agree).map(t => t.pnl)))} DISAGREE ${f(mean(I.filter(t => !t.agree).map(t => t.pnl)))} ; LONG ${f(mean(I.filter(t => t.long).map(t => t.pnl)))} (n ${I.filter(t => t.long).length}) SHORT ${f(mean(I.filter(t => !t.long).map(t => t.pnl)))} (n ${I.filter(t => !t.long).length}) LONG-SHORT CI [${f(oL[Math.floor(oL.length * .025)])},${f(oL[Math.floor(oL.length * .975)])}]`);
  for (const ph of ['FRESH', 'BALANCE', 'THRUST', 'CONTROL']) { const a = T.filter(t => t.ph === ph); log(`  ${ph.padEnd(8)} n ${String(a.length).padStart(5)} mean ${f(mean(a.map(t => t.pnl)))} gap ${f(gap(a))}`); } }
h2('06:00', 'state as of the 06:00 close, strictly pre-RTH'); h2('10:00', 'state as of the 10:00 close (bucket 06-10 just closed)');
// ---- H3 descriptive: real FAILED_SWEEP_REVERSAL rows
const fsr = (await query(`SELECT to_char(fired_at,'YYYY-MM-DD HH24:MI:SS') ts, setup_type, actual_pnl::float pnl FROM active_setups WHERE setup_type LIKE 'FAILED_SWEEP_REVERSAL%' AND actual_pnl IS NOT NULL AND origin_status IN ('ACTIVE','SHADOW') AND (is_cluster_primary IS NULL OR is_cluster_primary=true) AND fired_at >= $1::date`, [FROM])).rows;
log('\n=== H3 (descriptive, no verdict): real FAILED_SWEEP_REVERSAL rows by phase at fire time ===');
for (const ph of ['FRESH', 'BALANCE', 'THRUST', 'CONTROL', null]) { const a = fsr.filter(r => { const p = phaseAt(r.ts); return (p ? p.ph : null) === ph; }); log(`  ${String(ph).padEnd(8)} n ${String(a.length).padStart(3)} mean ${f(mean(a.map(r => r.pnl)))}  LONG n ${a.filter(r => r.setup_type.endsWith('LONG')).length} mean ${f(mean(a.filter(r => r.setup_type.endsWith('LONG')).map(r => r.pnl)))}`); }
const inThr = (() => { const p = phaseAt('2026-10-20 12:00:00'); return p; })(); log(`state now (last closed 4h bar at 2026-10-20 12:00 ET): ${JSON.stringify(inThr)}`);
// ---- H4 descriptive: 65pt legs per session, THRUST sessions (state at 06:00) vs control sessions
const legsBy = new Map(); for (const d of S.dates) { if (d < FROM || d > TO) continue; const a = lb(D.TS, addDay(d, -1) + ' 18:00:00'), b = lb(D.TS, d + ' 17:00:00'); const bb = []; for (let i = a; i < b; i++) bb.push({ high: D.H[i], low: D.L[i] }); const legs = bb.length ? detectRotationLegs(bb, 65) : []; const up = legs.filter(l => l.dir === 'UP').map(l => l.size); legsBy.set(d, { n: legs.length, maxUp: up.length ? Math.max(...up) : 0, atr: S.atr20(d) }); }
const sess = (ph) => [...legsBy.entries()].filter(([d, v]) => { const p = phaseAt(d + ' 06:00:00'); return p && !p.roll && v.atr && p.ph === ph; }).map(([, v]) => v);
log('\n=== H4 (descriptive): 65pt rotation legs per session by the phase at 06:00 ===');
for (const ph of ['FRESH', 'BALANCE', 'THRUST', 'CONTROL']) { const a = sess(ph); log(`  ${ph.padEnd(8)} sessions ${String(a.length).padStart(4)} legs/session ${mean(a.map(v => v.n)).toFixed(2)}  largest up-leg ${mean(a.map(v => v.maxUp)).toFixed(0)}pt (${mean(a.map(v => v.maxUp / v.atr)).toFixed(2)} ATR20)`); }
process.exit(0);
