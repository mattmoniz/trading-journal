// Descriptive profile of the V1 tell (explore 2023-03..2025-05-16, saved events only). No hypothesis test, no P&L:
// when it fires, how busy the market is, what days, relation to the open, follows or flips the day's direction.
import fs from 'fs';
import { query } from '../../server/db.js';
import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_profile_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 0, label: 'Descriptive tell profile: timing, activity, day type, gap/open, follows-or-flips (no outcomes)', script: 'scripts/amt_context/tell_profile_20261102.mjs', ref: 'tell_profile_20261102' });
console.log('look', id);
const csv = f => { const [h, ...r] = fs.readFileSync(f, 'utf8').trim().split('\n'); const k = h.split(','); return r.map(l => Object.fromEntries(l.split(',').map((v, i) => [k[i], v]))); };
const trades = csv('scripts/amt_vbars/trades_V1_explore.csv'), pts = csv('scripts/amt_context/p1_points.csv');
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
// 1. timing + activity (decision points)
console.log('\n== TIMING: share of decision points with a tell in the last 30 min, by hour; activity A when tell vs not');
const dates = new Set(pts.map(p => p.date));
for (const h of [10, 11, 12, 13, 14]) {
  const P = pts.filter(p => +p.hour === h), T = P.filter(p => p.tell30 === '1');
  console.log(`${h}h: points ${P.length} tell30 ${pct(T.length, P.length)} | A tell mean ${mean(T.map(p => +p.A)).toFixed(2)} vs no-tell ${mean(P.filter(p => p.tell30 === '0').map(p => +p.A)).toFixed(2)}`);
}
const T = pts.filter(p => p.tell30 === '1'), A = T.map(p => +p.A);
console.log(`A (baseline s/bar over recent s/bar) when tell: p10 ${q(A, .1).toFixed(2)} p50 ${q(A, .5).toFixed(2)} p90 ${q(A, .9).toFixed(2)}; all points p50 ${q(pts.map(p => +p.A), .5).toFixed(2)}`);
// 2. fires per day, first fire, direction flips
const byDate = {}; for (const t of trades) (byDate[t.date] ||= []).push(t);
const nd = Object.keys(byDate).length, per = Object.values(byDate).map(a => a.length);
console.log(`\n== FIRES: ${trades.length} V1 entries on ${nd} of ${dates.size} sessions (${pct(nd, dates.size)}); per active day mean ${mean(per).toFixed(1)} median ${q(per, .5)} p90 ${q(per, .9)} max ${Math.max(...per)}`);
let pairs = 0, flip = 0; for (const a of Object.values(byDate)) for (let i = 1; i < a.length; i++) { pairs++; if (a[i].dir !== a[i - 1].dir) flip++; }
console.log(`consecutive fires same day: ${pairs}, opposite direction ${pct(flip, pairs)}`);
const risk = trades.map(t => +t.risk);
console.log(`stop distance (size of the structure behind it): p10 ${q(risk, .1)} p50 ${q(risk, .5)} p90 ${q(risk, .9)} pts`);
// 3. bars: RTH open, prior close, 10:00 open
const lo = '2023-03-01', hi = '2025-05-17';
const b = await query(`SELECT to_char(ts,'YYYY-MM-DD') d, to_char(ts,'HH24:MI') m, open::float o, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp AND to_char(ts,'HH24:MI') IN ('09:30','15:59') ORDER BY ts`, [lo, hi]);
const open = {}, close = {}; for (const r of b.rows) { if (r.m === '09:30') open[r.d] = r.o; else close[r.d] = r.c; }
const ds = Object.keys(open).sort(); const prevClose = {}; let pc = null; for (const d of ds) { prevClose[d] = pc; if (close[d] != null) pc = close[d]; }
const dl = await query(`SELECT trade_date::text d, day_type, profile_shape FROM acd_daily_log WHERE trade_date >= $1::date AND trade_date < $2::date`, [lo, hi]);
const dt = Object.fromEntries(dl.rows.map(r => [r.d, r]));
console.log(`\nbars: open known ${ds.length} sessions; acd_daily_log rows ${dl.rows.length}, day_type non-null ${dl.rows.filter(r => r.day_type).length}`);
// 4. day type (known only at close: describes where it lives, not a usable gate)
console.log('\n== DAY TYPE (end-of-day label): sessions, share with a tell fire, fires per session');
const allD = [...dates]; const types = {};
for (const d of allD) { const k = dt[d]?.day_type || 'NO_LABEL'; (types[k] ||= { days: 0, fired: 0, fires: 0 }); types[k].days++; if (byDate[d]) { types[k].fired++; types[k].fires += byDate[d].length; } }
for (const [k, v] of Object.entries(types).sort((a, b) => b[1].days - a[1].days)) console.log(`${k.padEnd(14)} sessions ${String(v.days).padStart(4)} | any fire ${pct(v.fired, v.days).padStart(6)} | fires/session ${(v.fires / v.days).toFixed(2)}`);
// 5. relation to the open: gap buckets (data-derived terciles of |gap|) and direction vs day-so-far
const gaps = {}; for (const d of allD) if (open[d] != null && prevClose[d] != null) gaps[d] = open[d] - prevClose[d];
const ag = Object.values(gaps).map(Math.abs), c1 = q(ag, 1 / 3), c2 = q(ag, 2 / 3);
console.log(`\n== OPEN: |gap| terciles cut at ${c1.toFixed(1)} / ${c2.toFixed(1)} pts (${ag.length} sessions)`);
const gb = d => { const g = Math.abs(gaps[d]); return g < c1 ? 'small' : g < c2 ? 'mid' : 'large'; };
for (const k of ['small', 'mid', 'large']) { const D = allD.filter(d => gaps[d] != null && gb(d) === k); console.log(`${k.padEnd(6)} sessions ${D.length} | any fire ${pct(D.filter(d => byDate[d]).length, D.length)} | fires/session ${(D.reduce((s, d) => s + (byDate[d]?.length || 0), 0) / D.length).toFixed(2)}`); }
let al = 0, ag2 = 0, n = 0, drop = 0, gA = 0, gN = 0, gapAligned = 0;
for (const t of trades) {
  const o = open[t.date]; if (o == null || Math.abs(+t.entry - o) > 600) { drop++; continue; }
  n++; const sod = Math.sign(+t.entry - o); if (sod === +t.dir) al++; else ag2++;
  if (gaps[t.date] != null) { gN++; if (Math.sign(gaps[t.date]) === +t.dir) gapAligned++; }
}
console.log(`\n== FOLLOW OR FLIP: tell direction vs the day so far (entry vs 09:30 open), ${n} fires (${drop} dropped, no open or roll-basis mismatch)`);
console.log(`with the day-so-far direction ${pct(al, n)} | against it ${pct(ag2, n)}`);
console.log(`tell direction same sign as the opening gap: ${pct(gapAligned, gN)} of ${gN}`);
// by distance from open in units of the median stop? simply by |entry-open| terciles
const ex = trades.filter(t => open[t.date] != null && Math.abs(+t.entry - open[t.date]) <= 600).map(t => ({ d: Math.abs(+t.entry - open[t.date]), w: Math.sign(+t.entry - open[t.date]) === +t.dir }));
const e1 = q(ex.map(x => x.d), 1 / 3), e2 = q(ex.map(x => x.d), 2 / 3);
for (const [nm, f] of [['near open', x => x.d < e1], ['mid', x => x.d >= e1 && x.d < e2], ['far from open', x => x.d >= e2]]) { const s = ex.filter(f); console.log(`${nm.padEnd(14)} (${s.length}) with day-so-far ${pct(s.filter(x => x.w).length, s.length)}`); }
process.exit(0);
