// study_early_globex_rotation_20261019.mjs -- TASK C (OPEN_DECISION early_globex_rotation_direction_session_bias_20261019). When the FIRST 65pt rotation leg of a Globex session confirms within 10 min of the 18:00 ET open,
// does its direction D predict (1) the rest of Globex to 09:29 and (2) the next RTH session (open->close), versus sessions whose first leg came later, and versus a direction-shuffle placebo?
// Leg rule (causal, same reversal rule as rotationDetector/pocRotationService, R=65): running high/low from each bar's HIGH/LOW; first leg confirms when high-runLow>=65 (UP) or runHigh-low>=65 (DOWN); both on one bar -> not confirmed on that bar.
// Session for trade date D = prior calendar evening 18:00 .. D 09:29; requires >=90% of expected minutes. Outcomes signed by D in ATR20 units (ATR20 of trade date D, RTH ranges of prior 20 sessions).
// Run: node scripts/study_early_globex_rotation_20261019.mjs [from] [to]
import fs from 'fs';
import { query } from '../server/db.js';
const FROM = process.argv[2] || '2023-03-06', TO = process.argv[3] || '2026-10-16', R = 65;
const sum = (a) => { let s = 0; for (const x of a) s += x; return s; }, mean = (a) => a.length ? sum(a) / a.length : NaN, f = (x, d = 3) => (x == null || Number.isNaN(x) ? ' n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
const addDay = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// load all bars from FROM-1 evening to TO 15:59 in monthly chunks, store per calendar date: evening (>=18:00) bars, morning (<09:30) bars, rth bars
const eve = new Map(), mor = new Map(), rth = new Map();
let cur = new Date(FROM + 'T00:00:00Z'); cur.setUTCDate(cur.getUTCDate() - 45); const end = new Date(TO + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 1);
while (cur < end) { const nxt = new Date(cur); nxt.setUTCDate(nxt.getUTCDate() + 31);
  for (const x of (await query(`SELECT ts::date::text d, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int m, open::float o, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)])).rows) {
    const tgt = x.m >= 1080 ? eve : x.m < 570 ? mor : x.m < 960 ? rth : null; if (!tgt) continue; let a = tgt.get(x.d); if (!a) tgt.set(x.d, a = []); a.push(x); }
  cur = nxt; }
const rthDates = [...rth.keys()].filter(d => rth.get(d).length > 60).sort();
const atrOf = new Map(); { const rng = []; for (const d of rthDates) { if (rng.length >= 20) atrOf.set(d, mean(rng.slice(-20))); const b = rth.get(d); rng.push(Math.max(...b.map(x => x.h)) - Math.min(...b.map(x => x.l))); } }
function firstLeg(bars) { let hi = -Infinity, lo = Infinity;
  for (let i = 0; i < bars.length; i++) { const b = bars[i]; hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); const up = b.h - lo >= R, dn = hi - b.l >= R;
    if (up && !dn) return { dir: 1, i, m: b.m, c: b.c }; if (dn && !up) return { dir: -1, i, m: b.m, c: b.c }; if (up && dn) { /* ambiguous bar: not confirmed; keep scanning with extremes as-is */ } }
  return null; }
const sess = []; let sparse = 0, noLeg = 0;
for (const D of rthDates) { if (D < FROM || D > TO) continue; const atr = atrOf.get(D); if (!atr) continue;
  const bars = [...(eve.get(addDay(D, -1)) || []), ...(mor.get(D) || [])]; const expected = 930;
  if (bars.length < 0.9 * expected) { sparse++; continue; }
  const leg = firstLeg(bars); if (!leg) { noLeg++; continue; }
  const r = rth.get(D), o930 = r[0].o, c1559 = r[r.length - 1].c, c929 = bars[bars.length - 1].c;
  const early = (leg.m >= 1080 ? leg.m - 1080 : 1e9) <= 10;                     // confirmed at 18:10 or earlier (evening minute count)
  sess.push({ d: D, dir: leg.dir, early, confMin: leg.m >= 1080 ? leg.m - 1080 : leg.m + 360, glob: (c929 - leg.c) / atr, rthMove: (c1559 - o930) / atr, atr }); }
console.log(`Window ${FROM}..${TO}; sessions with first leg: ${sess.length}; dropped sparse (<90% minutes): ${sparse}; no leg confirmed: ${noLeg}. Sessions with sufficient density by year:`, ['2023', '2024', '2025', '2026'].map(y => y + ':' + sess.filter(s => s.d.startsWith(y)).length).join(' '));
const A = sess.filter(s => s.early), C = sess.filter(s => !s.early);
let seed = 4242; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const ci = (vals) => { const o = []; for (let b = 0; b < 2000; b++) { let s = 0; for (let k = 0; k < vals.length; k++) s += vals[(rnd() * vals.length) | 0]; o.push(s / vals.length); } o.sort((a, b) => a - b); return [o[50], o[1949]]; };
function perm(arr, key) { const raw = arr.map(s => s[key] * s.dir), obs = mean(arr.map(s => s[key])), nulls = []; // shuffle direction labels
  for (let b = 0; b < 2000; b++) { let s = 0; for (const x of raw) s += (rnd() < 0.5 ? 1 : -1) * x; nulls.push(s / raw.length); } return nulls.filter(x => x >= obs).length / nulls.length; }
console.log(`\nGroup A (first leg by 18:10): ${A.length} sessions, ${A.filter(s => s.dir > 0).length} up / ${A.filter(s => s.dir < 0).length} down. Control (later first leg): ${C.length} sessions.`);
console.log('\nmetric (D-signed, ATR20 units)'.padEnd(46), 'group   N   mean     95% CI            perm p(>=)   share>0');
for (const [label, key] of [['leg confirm -> 09:29 close (rest of Globex)', 'glob'], ['next RTH 09:30 open -> 15:59 close', 'rthMove']]) {
  const ra = A.map(s => s[key] * s.dir), rc = C.map(s => s[key] * s.dir);
  // note: the signed value s[key]*dir -- perm() recomputes from raw
  const pa = (() => { const raw = A.map(s => s[key]); const obs = mean(ra), nulls = []; for (let b = 0; b < 2000; b++) { let s = 0; for (const x of raw) s += (rnd() < 0.5 ? 1 : -1) * x; nulls.push(s / raw.length); } return nulls.filter(x => x >= obs).length / nulls.length; })();
  const [la, ha] = ci(ra), [lc, hc] = ci(rc);
  console.log(label.padEnd(46), 'A    ', String(A.length).padStart(4), f(mean(ra)).padStart(8), `[${f(la)},${f(ha)}]`.padEnd(18), pa.toFixed(3).padStart(8), (100 * ra.filter(x => x > 0).length / ra.length).toFixed(0) + '%');
  console.log(''.padEnd(46), 'ctrl ', String(C.length).padStart(4), f(mean(rc)).padStart(8), `[${f(lc)},${f(hc)}]`.padEnd(18), '        ', (100 * rc.filter(x => x > 0).length / rc.length).toFixed(0) + '%'); }
// drift check: unsigned mean of the raw windows (overnight/RTH drift independent of direction label)
console.log('\ndrift check (UNSIGNED means over ALL sessions with a leg): rest-of-Globex', f(mean(sess.map(s => s.glob))), ' RTH', f(mean(sess.map(s => s.rthMove))), '; and by direction of first leg:');
for (const dir of [1, -1]) { const g = sess.filter(s => s.dir === dir); console.log(`  first leg ${dir > 0 ? 'UP  ' : 'DOWN'}  N=${g.length}  rest-of-Globex ${f(mean(g.map(s => s.glob)))}  RTH ${f(mean(g.map(s => s.rthMove)))}`); }
for (const [nm, fn] of [['pre-2025-06', s => s.d < '2025-06-01'], ['post-2025-06', s => s.d >= '2025-06-01']]) { const a = A.filter(fn); console.log(`${nm}: A N=${a.length} signed rest-of-Globex ${f(mean(a.map(s => s.glob * s.dir)))}  signed RTH ${f(mean(a.map(s => s.rthMove * s.dir)))}`); }
fs.writeFileSync('scratch/early_globex_claude_sessions_20261019.json', JSON.stringify(sess)); process.exit(0);
