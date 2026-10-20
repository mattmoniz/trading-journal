// study_value_traversal_20261019.mjs -- TASK B (OPEN_DECISION value_traversal_edge_to_edge_target_guidance_20261019): after price re-enters the prior-day value area from outside, how often does it
// travel to the OPPOSITE edge by the close, versus a placebo band (same width, shifted +/-0.3, +/-0.6 ATR20)? Pure bar-level, no stop/target machinery. RTH only, 9:35 on, roll days skipped.
// Event: first bar per day/side whose close is inside [VAL,VAH] while the previous bar closed outside on that side. Reach = any later bar touches the far edge before 15:59. Same event definition applied to each shifted band.
// Run: node scripts/study_value_traversal_20261019.mjs [from] [to]
import fs from 'fs';
import { query } from '../server/db.js';
const FROM = process.argv[2] || '2023-03-06', TO = process.argv[3] || '2026-10-16', SHIFTS = [-0.6, -0.3, 0.3, 0.6];
const sum = (a) => { let s = 0; for (const x of a) s += x; return s; }, mean = (a) => a.length ? sum(a) / a.length : NaN, f = (x, d = 3) => (x == null || Number.isNaN(x) ? ' n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
const days = new Map(); let cur = new Date(FROM + 'T00:00:00Z'); cur.setUTCDate(cur.getUTCDate() - 40); const end = new Date(TO + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 1);
while (cur < end) { const nxt = new Date(cur); nxt.setUTCDate(nxt.getUTCDate() + 31);
  for (const x of (await query(`SELECT ts::date::text d, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int m, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date AND ts::time BETWEEN '09:30' AND '15:59' ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)])).rows) { let d = days.get(x.d); if (!d) days.set(x.d, d = { h: [], l: [], c: [], m: [] }); d.h.push(x.h); d.l.push(x.l); d.c.push(x.c); d.m.push(x.m); } cur = nxt; }
const dates = [...days.keys()].filter(d => days.get(d).c.length > 60).sort();
const atrOf = new Map(); { const rng = []; for (const d of dates) { if (rng.length >= 20) atrOf.set(d, mean(rng.slice(-20))); const dd = days.get(d); rng.push(Math.max(...dd.h) - Math.min(...dd.l)); } }
const lv = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND level_name IN ('PD_VAH','PD_VAL','PD_CLOSE')`, [FROM, TO])).rows) (lv.get(r.d) || lv.set(r.d, {}).get(r.d))[r.n] = r.p;
function events(dd, VAH, VAL) {        // returns [{side:'fromAbove'|'fromBelow', reached, mins}]
  const out = [], seen = new Set();
  for (let i = 1; i < dd.c.length; i++) { if (dd.m[i] < 575) continue; const c = dd.c[i], p = dd.c[i - 1];
    for (const [side, cond] of [['fromAbove', c <= VAH && c >= VAL && p > VAH], ['fromBelow', c <= VAH && c >= VAL && p < VAL]]) {
      if (!cond || seen.has(side)) continue; seen.add(side); let reached = 0, mins = null;
      for (let j = i + 1; j < dd.c.length; j++) if (side === 'fromAbove' ? dd.l[j] <= VAL : dd.h[j] >= VAH) { reached = 1; mins = j - i; break; }
      out.push({ side, reached, mins, i }); } }
  return out;
}
const real = [], plc = []; let skipped = 0;
for (let di = 0; di < dates.length; di++) { const d = dates[di]; if (d < FROM || d > TO) continue; const atr = atrOf.get(d), L = lv.get(d); if (!atr || !L || L.PD_VAH == null || L.PD_VAL == null) continue;
  const prevD = dates[di - 1]; if (L.PD_CLOSE != null && prevD && Math.abs(L.PD_CLOSE - days.get(prevD).c[days.get(prevD).c.length - 1]) > 0.1 * atr) { skipped++; continue; }
  const dd = days.get(d), W = L.PD_VAH - L.PD_VAL; if (W <= 0) continue;
  for (const e of events(dd, L.PD_VAH, L.PD_VAL)) real.push({ d, ...e, wAtr: W / atr });
  for (const s of SHIFTS) for (const e of events(dd, L.PD_VAH + s * atr, L.PD_VAL + s * atr)) plc.push({ d, ...e, wAtr: W / atr }); }
function boot(R, P, n = 2000) {      // day-blocked CI of (real reach prob - placebo reach prob)
  const by = new Map(); for (const e of R) (by.get(e.d) || by.set(e.d, { r: [], p: [] }).get(e.d)).r.push(e.reached); for (const e of P) (by.get(e.d) || by.set(e.d, { r: [], p: [] }).get(e.d)).p.push(e.reached);
  const ds = [...by.values()]; let seed = 777; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, out = [];
  for (let b = 0; b < n; b++) { let rs = 0, rn = 0, ps = 0, pn = 0; for (let k = 0; k < ds.length; k++) { const x = ds[(rnd() * ds.length) | 0]; rs += sum(x.r); rn += x.r.length; ps += sum(x.p); pn += x.p.length; } if (rn && pn) out.push(rs / rn - ps / pn); }
  out.sort((a, b) => a - b); return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]]; }
const med = (a) => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
console.log(`Window ${FROM}..${TO}, ${skipped} roll days skipped. Real events ${real.length} on ${new Set(real.map(e => e.d)).size} days; placebo events ${plc.length}.`);
console.log('\nsegment'.padEnd(26), 'N    days  reach%real  reach%placebo  diff      95% CI           medMin real/plc');
const show = (label, R, P) => { if (R.length < 20) return console.log(label.padEnd(26), `thin (N=${R.length})`); const [lo, hi] = boot(R, P, 1000); console.log(label.padEnd(26), String(R.length).padStart(4), String(new Set(R.map(e => e.d)).size).padStart(5), (100 * mean(R.map(e => e.reached))).toFixed(1).padStart(8) + '%', (100 * mean(P.map(e => e.reached))).toFixed(1).padStart(10) + '%', f(mean(R.map(e => e.reached)) - mean(P.map(e => e.reached))).padStart(9), `[${f(lo)},${f(hi)}]`.padEnd(18), med(R.filter(e => e.reached).map(e => e.mins)), '/', med(P.filter(e => e.reached).map(e => e.mins))); };
show('ALL', real, plc); for (const s of ['fromAbove', 'fromBelow']) show(s, real.filter(e => e.side === s), plc.filter(e => e.side === s));
const w = real.map(e => e.wAtr).sort((a, b) => a - b), t1 = w[Math.floor(w.length / 3)], t2 = w[Math.floor(2 * w.length / 3)];
console.log(`\nterciles of W/ATR20 over real events: <${t1.toFixed(2)}, <${t2.toFixed(2)}, above. Placebo events use the SAME day's W so are binned with the real day's tercile.`);
for (const [nm, fn] of [['narrow', e => e.wAtr < t1], ['middle', e => e.wAtr >= t1 && e.wAtr < t2], ['wide', e => e.wAtr >= t2]]) show('W/ATR ' + nm, real.filter(fn), plc.filter(fn));
for (const [nm, fn] of [['pre-2025-06', e => e.d < '2025-06-01'], ['post-2025-06', e => e.d >= '2025-06-01']]) show(nm, real.filter(fn), plc.filter(fn));
fs.writeFileSync('scratch/value_traversal_claude_events_20261019.json', JSON.stringify({ real, plc })); process.exit(0);
