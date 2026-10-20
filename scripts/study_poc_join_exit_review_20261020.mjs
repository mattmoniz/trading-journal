// study_poc_join_exit_review_20261020.mjs -- POC_ROTATION_JOIN review, part 1: (A) exit variants vs the live breakeven-hold exit over 3.5 years (the live exit was chosen on 2025-06+ data, so 2023-03..2025-05 is out of sample for it), and
// (B) which joins pay (features known at entry, outcome = the LIVE exit's P&L). Research only; writes nothing to the DB except the events JSON in scratch/.
// Events come from the REAL validated detector (detectSignalEvents, 65pt, standard, point-in-time THETA = median bar range of the prior 180 days), exactly like scratch/poc_rotation_breakeven_hold_20261008.mjs. Built alongside Gemini's version from the same spec.
// Run: node scripts/study_poc_join_exit_review_20261020.mjs [from] [to]
import fs from 'fs';
import { query } from '../server/db.js';
import { detectSignalEvents } from '../server/services/pocRotationService.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
const FROM = process.argv[2] || '2023-03-06', TO = process.argv[3] || '2026-10-16', SPLIT = '2025-06-01';
const sum = (a) => { let s = 0; for (const x of a) s += x; return s; }, mean = (a) => a.length ? sum(a) / a.length : NaN, f = (x, d = 1) => (x == null || Number.isNaN(x) ? ' n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
const epoch = (ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16)) / 60000;   // naive-as-UTC: only differences are used
// ---- all bars into flat arrays (monthly chunks)
const T = [], TS = [], O = [], H = [], Lw = [], C = [];
{ let cur = new Date(FROM + 'T00:00:00Z'); cur.setUTCDate(cur.getUTCDate() - 200); const end = new Date(TO + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 3);
  while (cur < end) { const nxt = new Date(cur); nxt.setUTCDate(nxt.getUTCDate() + 31);
    for (const x of (await query(`SELECT ts::text ts, open::float o, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)])).rows) { TS.push(x.ts); T.push(epoch(x.ts)); O.push(x.o); H.push(x.h); Lw.push(x.l); C.push(x.c); }
    cur = nxt; } }
const lowerBound = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };
const upperBound = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; };
// per-date trailing median bar range (THETA): median of (high-low) over bars in [d-180d, d) -- computed by SQL like the original script (cached per date)
const dates = (await query(`SELECT DISTINCT trade_date::text d FROM developing_value_log WHERE trade_date >= $1::date AND trade_date <= $2::date ORDER BY d`, [FROM, TO])).rows.map(r => r.d).filter(d => !isInsideNqRollWeek(d));
const events = []; let skipped = 0;
const addDay = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
for (const d of dates) {
  const a = lowerBound(TS, addDay(d, -1) + ' 18:00:00'), b = lowerBound(TS, d + ' 17:00:00'); const bars = [];
  for (let i = a; i < b; i++) bars.push({ ts: TS[i], open: O[i], high: H[i], low: Lw[i], close: C[i] });
  if (bars.length < 100) { skipped++; continue; }
  const span = T[b - 1] - T[a] + 1; if (bars.length < 0.9 * span) { skipped++; continue; }
  const th = (await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) m FROM price_bars_primary WHERE symbol='NQ' AND ts < $1::date AND ts >= $1::date - interval '180 days'`, [d])).rows[0]?.m;
  const theta = th ? Math.max(0.25, +th) : 6.75;
  const { all_signal } = detectSignalEvents(65, 'standard', theta, [{ t: d, bars }], 'fixed');
  for (const ev of all_signal) { if (ev.entry_idx == null) continue; const eb = bars[ev.entry_idx], long = ev.direction === 'UP', ls = bars[ev.leg_start];
    events.push({ d, ts: eb.ts, ep: epoch(eb.ts), entry: eb.open, long, len: ev.len, d50: ev.d50, pocDist: ev.poc_dist, legPts: Math.abs(eb.open - (long ? ls.low : ls.high)), L: ev.L }); }
}
events.sort((x, y) => x.ep - y.ep);
console.log(`dates ${dates.length}, skipped ${skipped}, events ${events.length} (long ${events.filter(e => e.long).length}, short ${events.filter(e => !e.long).length})`);
// ---- simulate
const PT = 2, COMM = 2, REALISTIC = process.env.REALISTIC === '1';   // REALISTIC: a stop that is already on the wrong side of the market when it takes effect (arming bar, ratchet, or a gap) fills at that bar's OPEN, not at the stop price (a real stop order cannot be placed beyond the market)
function sim(e, fi, last, cfg) {                  // forward bars fi..last (global indices); returns {pnl, armed, exitK}
  const long = e.long, entry = e.entry; let stop = long ? entry - cfg.stop : entry + cfg.stop, armed = false, best = long ? -Infinity : Infinity;
  const endK = cfg.timeBars != null ? Math.min(last, fi + cfg.timeBars) : last;
  for (let i = fi; i <= endK; i++) { const k = i - fi;
    if (cfg.mode !== 'fixed' && !armed && k >= 60) { armed = true; stop = entry; }
    if (armed && cfg.lockF != null && best !== (long ? -Infinity : Infinity)) { const s = entry + (long ? 1 : -1) * cfg.lockF * Math.abs(best - entry); stop = long ? Math.max(stop, s) : Math.min(stop, s); }
    if (armed && cfg.trailD != null && best !== (long ? -Infinity : Infinity)) { const s = long ? best - cfg.trailD : best + cfg.trailD; stop = long ? Math.max(stop, entry, s) : Math.min(stop, entry, s); }
    if (long ? Lw[i] <= stop : H[i] >= stop) { const fill = REALISTIC ? (long ? Math.min(stop, O[i]) : Math.max(stop, O[i])) : stop; return { pnl: (long ? fill - entry : entry - fill) * PT - COMM, armed, hit: true }; }
    best = long ? Math.max(best, H[i]) : Math.min(best, H[i] === undefined ? best : Lw[i]);
    if (long) best = Math.max(best, H[i]); else best = Math.min(best, Lw[i]);
  }
  const px = C[endK]; return { pnl: (long ? px - entry : entry - px) * PT - COMM, armed, hit: false };
}
const VARS = { E0_OLD: { stop: 20, timeBars: 60, mode: 'fixed' }, E2_FIXED100: { stop: 100, timeBars: 60, mode: 'fixed' }, E1_LIVE: { stop: 100, mode: 'be' }, L25: { stop: 100, mode: 'be', lockF: 0.25 }, L50: { stop: 100, mode: 'be', lockF: 0.5 }, L75: { stop: 100, mode: 'be', lockF: 0.75 }, T65: { stop: 100, mode: 'be', trailD: 65 }, T130: { stop: 100, mode: 'be', trailD: 130 } };
const rows = [];
for (let i = 0; i < events.length; i++) { const e = events[i], bound = Math.min(e.ep + 1440, i + 1 < events.length ? events[i + 1].ep : Infinity);
  const fi = upperBound(T, e.ep), last = upperBound(T, bound) - 1; if (last - fi + 1 < 2) continue;
  const r = { ...e, session: (() => { const m = +e.ts.slice(11, 13) * 60 + +e.ts.slice(14, 16); return m >= 570 && m < 960 ? 'RTH' : 'GLOBEX'; })(), era: e.d < SPLIT ? 'pre' : 'post', pnl: {}, armed: false };
  for (const [nm, cfg] of Object.entries(VARS)) { const s = sim(e, fi, last, cfg); r.pnl[nm] = s.pnl; if (nm === 'E1_LIVE') r.armed = s.armed; }
  // MFE within the live walk (for context) and 60-minute mark
  r.fwdMfe = (() => { let m = 0; for (let k = fi; k <= last; k++) m = Math.max(m, e.long ? H[k] - e.entry : e.entry - Lw[k]); return m; })();
  rows.push(r); }
console.log(`replayed ${rows.length} events`);
let seed = 20261020; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
function ci(arr, fn, n = 1500) { const by = new Map(); for (const r of arr) (by.get(r.d) || by.set(r.d, []).get(r.d)).push(fn(r)); const ds = [...by.values()], S = ds.map(sum), Cn = ds.map(x => x.length), o = []; for (let b = 0; b < n; b++) { let s = 0, c = 0; for (let k = 0; k < ds.length; k++) { const j = (rnd() * ds.length) | 0; s += S[j]; c += Cn[j]; } if (c) o.push(s / c); } o.sort((a, b) => a - b); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
const days = (a) => new Set(a.map(r => r.d)).size;
console.log('\n=== A. EXIT VARIANTS: mean $/trade (sum/N) and PAIRED delta vs live E1 (day-blocked 95% CI; * excludes zero) ===');
const show = (label, arr) => { console.log('\n' + label + `  N=${arr.length} days=${days(arr)}`); console.log('variant'.padEnd(13), 'mean $/tr'.padStart(10), 'delta vs E1'.padStart(12), ' CI'.padEnd(18), 'delta vs E0'.padStart(12), 'better%'.padStart(8));
  for (const nm of Object.keys(VARS)) { const m = mean(arr.map(r => r.pnl[nm])), d1 = (r) => r.pnl[nm] - r.pnl.E1_LIVE, [lo, hi] = nm === 'E1_LIVE' ? [NaN, NaN] : ci(arr, d1, 800), d0 = mean(arr.map(r => r.pnl[nm] - r.pnl.E0_OLD)); console.log(nm.padEnd(13), f(m, 2).padStart(10), (nm === 'E1_LIVE' ? '' : f(mean(arr.map(d1)), 2)).padStart(12), (nm === 'E1_LIVE' ? '' : `[${f(lo, 1)},${f(hi, 1)}]` + (lo > 0 ? '*' : hi < 0 ? '!' : '')).padEnd(18), f(d0, 2).padStart(12), (100 * arr.filter(r => r.pnl[nm] > r.pnl.E1_LIVE + 0.001).length / arr.length).toFixed(0).padStart(7) + '%'); } };
show('ALL', rows); show('PRE-2025-06 (out of sample for the live exit design)', rows.filter(r => r.era === 'pre')); show('POST-2025-06 (design window)', rows.filter(r => r.era === 'post'));
show('RTH entries', rows.filter(r => r.session === 'RTH')); show('GLOBEX entries', rows.filter(r => r.session === 'GLOBEX')); show('LONG', rows.filter(r => r.long)); show('SHORT', rows.filter(r => !r.long));
const rt = rows.filter(r => r.armed); console.log(`\narmed (survived 60 min with the 100pt stop intact): ${rt.length} of ${rows.length}; of those, live E1 ended <= +$5: ${rt.filter(r => r.pnl.E1_LIVE <= 5).length}, and L50 rescued (L50 - E1 > 20): ${rt.filter(r => r.pnl.L50 - r.pnl.E1_LIVE > 20).length}; hurt (< -20): ${rt.filter(r => r.pnl.L50 - r.pnl.E1_LIVE < -20).length}`);
const srt = [...rows].sort((a, b) => Math.abs(b.pnl.L50 - b.pnl.E1_LIVE) - Math.abs(a.pnl.L50 - a.pnl.E1_LIVE)); console.log('top-5 share of total L50-E1 delta:', (100 * sum(srt.slice(0, 5).map(r => r.pnl.L50 - r.pnl.E1_LIVE)) / sum(rows.map(r => r.pnl.L50 - r.pnl.E1_LIVE))).toFixed(0) + '%');
fs.writeFileSync(REALISTIC ? 'scratch/poc_join_review_rows_realistic_20261020.json' : 'scratch/poc_join_review_rows_20261020.json', JSON.stringify(rows.map(r => ({ ...r, ts: r.ts })))); 
// ---- B
console.log('\n=== B. WHICH JOINS PAY (outcome = LIVE exit E1 P&L; features known at entry). mean $/trade (sum/N), * = day-blocked CI excludes zero ===');
const q = (a, x) => { const s = [...a].sort((p, r) => p - r); return s[Math.floor(x * (s.length - 1))]; };
const cell = (label, arr) => { if (arr.length < 20) return console.log('  ' + label.padEnd(28), `thin N=${arr.length}`); const [lo, hi] = ci(arr, r => r.pnl.E1_LIVE, 800); const pre = arr.filter(r => r.era === 'pre'), post = arr.filter(r => r.era === 'post'); console.log('  ' + label.padEnd(28), String(arr.length).padStart(5), String(days(arr)).padStart(5), f(mean(arr.map(r => r.pnl.E1_LIVE)), 1).padStart(8) + (lo > 0 ? '*' : hi < 0 ? '!' : ' '), `[${f(lo, 0)},${f(hi, 0)}]`.padEnd(14), '| pre', f(mean(pre.map(r => r.pnl.E1_LIVE)), 1).padStart(7), `(n${pre.length})`.padEnd(7), 'post', f(mean(post.map(r => r.pnl.E1_LIVE)), 1).padStart(7), `(n${post.length})`); };
console.log('  cell'.padEnd(30), '    N  days   mean     CI              | era split');
cell('ALL', rows); cell('LONG', rows.filter(r => r.long)); cell('SHORT', rows.filter(r => !r.long)); cell('RTH', rows.filter(r => r.session === 'RTH')); cell('GLOBEX', rows.filter(r => r.session === 'GLOBEX'));
const hr = (r) => { const m = +r.ts.slice(11, 13) * 60 + +r.ts.slice(14, 16); return m >= 1080 ? '18:00-23:59' : m < 570 ? '00:00-09:29' : m < 960 ? '09:30-15:59' : '16:00-16:59'; };
for (const b of ['18:00-23:59', '00:00-09:29', '09:30-15:59', '16:00-16:59']) cell('entry ' + b, rows.filter(r => hr(r) === b));
for (const [key, nm] of [['len', 'leg length (bars)'], ['d50', 'convergence d50'], ['pocDist', 'POC distance'], ['legPts', 'leg points to entry']]) { const v = rows.map(r => r[key]), t1 = q(v, 1 / 3), t2 = q(v, 2 / 3); cell(nm + ' low third (<=' + t1.toFixed(1) + ')', rows.filter(r => r[key] <= t1)); cell(nm + ' mid third', rows.filter(r => r[key] > t1 && r[key] <= t2)); cell(nm + ' top third (>' + t2.toFixed(1) + ')', rows.filter(r => r[key] > t2)); }
for (let dw = 1; dw <= 5; dw++) cell('weekday ' + ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][dw], rows.filter(r => new Date(r.d + 'T12:00:00Z').getUTCDay() === dw));
console.log('\n(cells examined in B: about 28; read * cells as leads, not findings)');
process.exit(0);
