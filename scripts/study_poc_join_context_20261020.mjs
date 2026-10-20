// study_poc_join_context_20261020.mjs -- POC_ROTATION_JOIN review part 2: what does the system SEE at the moment of the join, and does it tell good joins from bad ones?
// Every feature is computed ONLY from bars up to the signal's trigger bar (entry is the next bar's open) -- no lookahead. Outcome = REALISTIC-fill live-exit P&L (E1: 100pt stop, breakeven at 60 min, hold to the next event/24h; a stop already
// beyond the market fills at the bar open). Writes scratch/poc_join_context_features_20261020.csv for the walk-forward model (scripts/ml_meta_labeling/ style, python), and prints single-feature tercile cells with day-blocked CIs and era splits.
// Events: the REAL detectSignalEvents (same construction as study_poc_join_exit_review_20261020.mjs). Run: node scripts/study_poc_join_context_20261020.mjs
import fs from 'fs';
import { query } from '../server/db.js';
import { detectSignalEvents } from '../server/services/pocRotationService.js';
import { detectRotationLegs } from '../server/services/rotationDetector.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
const FROM = '2023-03-06', TO = '2026-10-16', SPLIT = '2025-06-01';
const sum = (a) => { let s = 0; for (const x of a) s += x; return s; }, mean = (a) => a.length ? sum(a) / a.length : NaN, f = (x, d = 1) => (x == null || Number.isNaN(x) ? ' n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
const epoch = (ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16)) / 60000;
const addDay = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const T = [], TS = [], O = [], H = [], Lw = [], C = [], V = [], BV = [], AV = [];
{ let cur = new Date(FROM + 'T00:00:00Z'); cur.setUTCDate(cur.getUTCDate() - 200); const end = new Date(TO + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 3);
  while (cur < end) { const nxt = new Date(cur); nxt.setUTCDate(nxt.getUTCDate() + 31);
    for (const x of (await query(`SELECT ts::text ts, open::float o, high::float h, low::float l, close::float c, COALESCE(volume,0)::float v, COALESCE(bid_volume,0)::float bv, COALESCE(ask_volume,0)::float av FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)])).rows) { TS.push(x.ts); T.push(epoch(x.ts)); O.push(x.o); H.push(x.h); Lw.push(x.l); C.push(x.c); V.push(x.v); BV.push(x.bv); AV.push(x.av); }
    cur = nxt; } }
const lb = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };
const ub = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; };
const rthRangeCache = new Map(); const rthRange = (d) => { if (rthRangeCache.has(d)) return rthRangeCache.get(d); const a = lb(TS, d + ' 09:30:00'), b = lb(TS, d + ' 16:00:00'); let r = null; if (b - a > 200) { let hi = -Infinity, lo = Infinity; for (let i = a; i < b; i++) { hi = Math.max(hi, H[i]); lo = Math.min(lo, Lw[i]); } r = hi - lo; } rthRangeCache.set(d, r); return r; };
const atr20 = (d) => { const xs = []; let k = 1; while (xs.length < 20 && k < 60) { const r = rthRange(addDay(d, -k)); if (r != null) xs.push(r); k++; } return xs.length === 20 ? mean(xs) : null; };
const dates = (await query(`SELECT DISTINCT trade_date::text d FROM developing_value_log WHERE trade_date >= $1::date AND trade_date <= $2::date ORDER BY d`, [FROM, TO])).rows.map(r => r.d).filter(d => !isInsideNqRollWeek(d));
const LV = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND price IS NOT NULL AND (level_name ~ '^(PD_|PW_|PM_|PY_|3M_|10D_|5D_|CAM_|FLOOR_|WPP|WR[0-9]|WS[0-9]|MPP|MR[0-9]|MS[0-9]|WEEKLY_OPEN|MONTHLY_OPEN)' OR level_name IN ('ONH','ONL'))`, [FROM, TO])).rows) (LV.get(r.d) || LV.set(r.d, []).get(r.d)).push(r);
// ---- events (same as the exit review) + features at the trigger bar
const events = []; let skipped = 0;
for (const d of dates) {
  const a = lb(TS, addDay(d, -1) + ' 18:00:00'), b = lb(TS, d + ' 17:00:00'); const bars = []; for (let i = a; i < b; i++) bars.push({ ts: TS[i], open: O[i], high: H[i], low: Lw[i], close: C[i] });
  if (bars.length < 100 || bars.length < 0.9 * (T[b - 1] - T[a] + 1)) { skipped++; continue; }
  const th = (await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) m FROM price_bars_primary WHERE symbol='NQ' AND ts < $1::date AND ts >= $1::date - interval '180 days'`, [d])).rows[0]?.m; const theta = th ? Math.max(0.25, +th) : 6.75;
  const A = atr20(d); const lvls = LV.get(d) || []; const pdv = lvls.find(x => x.n === 'PD_VAH'), pdl = lvls.find(x => x.n === 'PD_VAL');
  const { all_signal } = detectSignalEvents(65, 'standard', theta, [{ t: d, bars }], 'fixed');
  for (const ev of all_signal) { if (ev.entry_idx == null || !A) continue; const trig = a + ev.entry_idx - 1, ei = a + ev.entry_idx, long = ev.direction === 'UP', sg = long ? 1 : -1, entry = O[ei];
    const fl = (k) => { let ask = 0, bid = 0; for (let i = Math.max(a, trig - k + 1); i <= trig; i++) { ask += AV[i]; bid += BV[i]; } return ask + bid > 0 ? sg * (ask - bid) / (ask + bid) : null; };
    const flLeg = (() => { let ask = 0, bid = 0; for (let i = a + ev.leg_start; i <= trig; i++) { ask += AV[i]; bid += BV[i]; } return ask + bid > 0 ? sg * (ask - bid) / (ask + bid) : null; })();
    const vsum = (from, to) => { let s = 0; for (let i = Math.max(0, from); i <= to; i++) s += V[i]; return s; };
    const trail = trig - 1440 > 0 ? vsum(trig - 1440, trig) / 1440 : null, vr15 = trail ? vsum(trig - 14, trig) / 15 / trail : null, vrLeg = trail ? vsum(a + ev.leg_start, trig) / (trig - (a + ev.leg_start) + 1) / trail : null;
    const rng = (k) => { let s = 0; for (let i = trig - k + 1; i <= trig; i++) s += H[i] - Lw[i]; return s / k; }; const volReg = trig - 1440 > 0 ? rng(60) / rng(1440) : null;
    let pv = 0, vv = 0, sh = -Infinity, sl = Infinity; for (let i = a; i <= trig; i++) { pv += C[i] * V[i]; vv += V[i]; sh = Math.max(sh, H[i]); sl = Math.min(sl, Lw[i]); }
    const vwap = vv > 0 ? pv / vv : C[trig];
    const legs = detectRotationLegs(bars.slice(0, ev.entry_idx), 65), cur = legs[legs.length - 1], prev = legs[legs.length - 2];
    const anchorPrice = long ? Lw[a + ev.leg_start] : H[a + ev.leg_start], legPts = Math.abs(entry - anchorPrice);
    let priorExt = long ? -Infinity : Infinity; for (let i = a; i < a + ev.leg_start; i++) priorExt = long ? Math.max(priorExt, H[i]) : Math.min(priorExt, Lw[i]);
    const legExt = (() => { let e = long ? -Infinity : Infinity; for (let i = a + ev.leg_start; i <= trig; i++) e = long ? Math.max(e, H[i]) : Math.min(e, Lw[i]); return e; })();
    const early = TS[ei] < d + ' 09:30:00', lvE = early ? lvls.filter(x => x.n !== 'ONH' && x.n !== 'ONL') : lvls;   // ONH/ONL for trade date d span 18:00 prior evening .. 09:29, so they are NOT known before 09:30 (DeepSeek review 2026-10-20 caught this lookahead)
    const ahead = lvE.filter(x => long ? x.p > entry : x.p < entry).map(x => Math.abs(x.p - entry)).sort((p, q) => p - q)[0], behind = lvE.filter(x => long ? x.p < entry : x.p > entry).map(x => Math.abs(x.p - entry)).sort((p, q) => p - q)[0];
    const crossed = lvE.filter(x => (x.p - anchorPrice) * (x.p - entry) < 0).length;
    events.push({ d, ts: TS[ei], ep: T[ei], ei, entry, long, trig, len: ev.len, d50: ev.d50, A, flow5: fl(5), flow15: fl(15), flow30: fl(30), flowLeg: flLeg, volRatio15: vr15, volRatioLeg: vrLeg, volReg, vwapExt: sg * (entry - vwap) / A, legAtr: legPts / A,
      sessPos: sh > sl ? (long ? (entry - sl) / (sh - sl) : (sh - entry) / (sh - sl)) : null, legCount: legs.length, legVsPrior: prev ? cur.size / prev.size : null, breaksSessionExt: (long ? legExt > priorExt : legExt < priorExt) ? 1 : 0, barsSinceConfirm: cur ? (ev.entry_idx - 1 - cur.idx) : null,
      runwayAtr: ahead != null ? ahead / A : null, supportAtr: behind != null ? behind / A : null, levelsCrossed: crossed, vaPos: pdv && pdl ? (entry > pdv.p ? sg : entry < pdl.p ? -sg : 0) : null });
  }
}
events.sort((x, y) => x.ep - y.ep);
// ---- realistic-fill E1 outcome
for (let i = 0; i < events.length; i++) { const e = events[i], bound = Math.min(e.ep + 1440, i + 1 < events.length ? events[i + 1].ep : Infinity), fi = ub(T, e.ep), last = ub(T, bound) - 1; if (last - fi + 1 < 2) { e.pnl = null; continue; }
  let stop = e.long ? e.entry - 100 : e.entry + 100, armed = false, pnl = null;
  for (let k = fi; k <= last && pnl == null; k++) { if (!armed && k - fi >= 60) { armed = true; stop = e.entry; } if (e.long ? Lw[k] <= stop : H[k] >= stop) { const fill = e.long ? Math.min(stop, O[k]) : Math.max(stop, O[k]); pnl = (e.long ? fill - e.entry : e.entry - fill) * 2 - 2; } }
  if (pnl == null) pnl = (e.long ? C[last] - e.entry : e.entry - C[last]) * 2 - 2; e.pnl = pnl; e.era = e.d < SPLIT ? 'pre' : 'post'; }
const rows = events.filter(e => e.pnl != null); console.log(`events ${events.length}, usable ${rows.length}, skipped dates ${skipped}`);
const FEATS = ['flow5', 'flow15', 'flow30', 'flowLeg', 'volRatio15', 'volRatioLeg', 'volReg', 'vwapExt', 'legAtr', 'sessPos', 'legCount', 'legVsPrior', 'breaksSessionExt', 'barsSinceConfirm', 'runwayAtr', 'supportAtr', 'levelsCrossed', 'vaPos', 'len', 'd50'];
const hdr = ['d', 'ts', 'long', 'era', 'pnl', ...FEATS]; fs.writeFileSync('scratch/poc_join_context_features_20261020.csv', [hdr.join(','), ...rows.map(r => hdr.map(h => h === 'long' ? (r.long ? 1 : 0) : r[h] ?? '').join(','))].join('\n'));
// ---- single-feature cells
let seed = 99; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
function ci(arr, n = 1000) { const by = new Map(); for (const r of arr) (by.get(r.d) || by.set(r.d, []).get(r.d)).push(r.pnl); const ds = [...by.values()], S = ds.map(sum), Cn = ds.map(x => x.length), o = []; for (let b = 0; b < n; b++) { let s = 0, c = 0; for (let k = 0; k < ds.length; k++) { const j = (rnd() * ds.length) | 0; s += S[j]; c += Cn[j]; } if (c) o.push(s / c); } o.sort((a, b) => a - b); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
const q = (a, x) => { const s = [...a].sort((p, r) => p - r); return s[Math.floor(x * (s.length - 1))]; };
const cell = (label, arr) => { if (arr.length < 30) return console.log('  ' + label.padEnd(34), `thin N=${arr.length}`); const [lo, hi] = ci(arr), pre = arr.filter(r => r.era === 'pre'), post = arr.filter(r => r.era === 'post'); console.log('  ' + label.padEnd(34), String(arr.length).padStart(5), f(mean(arr.map(r => r.pnl)), 1).padStart(7) + (lo > 0 ? '*' : hi < 0 ? '!' : ' '), `[${f(lo, 0)},${f(hi, 0)}]`.padEnd(13), '| pre', f(mean(pre.map(r => r.pnl)), 1).padStart(6), `n${pre.length}`.padEnd(6), 'post', f(mean(post.map(r => r.pnl)), 1).padStart(6), `n${post.length}`); };
console.log('\nALL'); cell('all joins', rows); let nCells = 0;
for (const k of FEATS) { const v = rows.map(r => r[k]).filter(x => x != null); const uniq = new Set(v); console.log('\n' + k + (uniq.size <= 3 ? ' (categorical)' : ''));
  if (uniq.size <= 3) { for (const u of [...uniq].sort()) { cell(k + ' = ' + u, rows.filter(r => r[k] === u)); nCells++; } continue; }
  const t1 = q(v, 1 / 3), t2 = q(v, 2 / 3); cell(k + ' low (<=' + t1.toFixed(2) + ')', rows.filter(r => r[k] != null && r[k] <= t1)); cell(k + ' mid', rows.filter(r => r[k] != null && r[k] > t1 && r[k] <= t2)); cell(k + ' high (>' + t2.toFixed(2) + ')', rows.filter(r => r[k] != null && r[k] > t2)); nCells += 3; }
console.log(`\ncells examined: ${nCells} (read * as leads; a real driver should be monotone low->high and positive in BOTH eras)`); process.exit(0);
