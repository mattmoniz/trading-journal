// study_roster_replay_20261019.mjs -- TASK A: what would the CURRENT live RTH level-fade roster have earned on 3.5 years of history?
// Non-writing (reads only; never touches performance_audit/UNIFIED_BACKTEST). Independently built alongside Gemini's version (docs/OPEN_THREADS.md 2026-10-19 run-mode directive).
// Setups: every level in level_prices with a live OPTIMAL_STOP row `L_FADE_LONG/SHORT` (RTH). Stop/target = round(COALESCE(optimal_stop,p75_mae)) / round(COALESCE(optimal_target,p50_mfe)), latest row per name.
// Touch: first bar (>= max(9:35, formation gate), < 16:00, i>=5) with |close-L| <= 15pt, once per level per day. Direction: close[i-5] < close[i] -> SHORT fade else LONG. Entry = close[i].
// Resolve from bar i+1 to 15:59: stop/target by bar high/low, same-bar both -> STOP, unresolved -> mark-to-market at last close. $2/pt, $2 round trip.
// Placebo = identical procedure with direction FLIPPED (same distances) -- a driftless walk already favors the nearer barrier, so real edge = real - flipped.
// Roll gate: skip day if PD_CLOSE is >0.1 ATR20 away from the prior session's last RTH close.
// Run: node scripts/study_roster_replay_20261019.mjs [from] [to]
import fs from 'fs';
import { query } from '../server/db.js';

const FROM = process.argv[2] || '2023-03-06', TO = process.argv[3] || '2026-10-16', SPLIT = '2025-06-01', PROX = 15;
const GATE = { OR5: 575, OR10: 580, OR15: 585, OR30: 600, IB: 630 };
const formGate = (n) => { for (const k of Object.keys(GATE)) if (n.startsWith(k + '_')) return GATE[k]; return 575; };
const sum = (a) => { let s = 0; for (const x of a) s += x; return s; }, mean = (a) => a.length ? sum(a) / a.length : NaN;
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '  n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
const familyOf = (n) => /^(OR\d+|IB)_/.test(n) ? 'SAME_DAY_OR_IB' : /^PD_/.test(n) ? 'PD' : /^PW_|^W[PRS]|^WEEKLY/.test(n) ? 'WEEKLY' : /^PM_|^M[PRS]|^MONTHLY/.test(n) ? 'MONTHLY' : /^CAM_/.test(n) ? 'CAM' : /^FLOOR_/.test(n) ? 'FLOOR' : 'OTHER';

// ---- bars (chunked by month, RTH only)
const days = new Map();
let cur = new Date(FROM + 'T00:00:00Z'); cur.setUTCDate(cur.getUTCDate() - 40);
const end = new Date(TO + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 1);
while (cur < end) {
  const nxt = new Date(cur); nxt.setUTCDate(nxt.getUTCDate() + 31);
  const r = (await query(`SELECT ts::date::text d, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int m, high::float h, low::float l, close::float c FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date AND ts::time BETWEEN '09:30' AND '15:59' ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)])).rows;
  for (const x of r) { let d = days.get(x.d); if (!d) days.set(x.d, d = { h: [], l: [], c: [], m: [] }); d.h.push(x.h); d.l.push(x.l); d.c.push(x.c); d.m.push(x.m); }
  cur = nxt;
}
const dates = [...days.keys()].filter(d => days.get(d).c.length > 60).sort();
const atrOf = new Map(); { const rng = []; for (const d of dates) { if (rng.length >= 20) atrOf.set(d, mean(rng.slice(-20))); const dd = days.get(d); rng.push(Math.max(...dd.h) - Math.min(...dd.l)); } }

// ---- live calibration: stop/target per setup type + current SETUP_STATUS
const opt = new Map((await query(`SELECT DISTINCT ON (signal_name) signal_name, ROUND(COALESCE(optimal_stop,p75_mae))::int stp, ROUND(COALESCE(optimal_target,p50_mfe))::int tgt
  FROM performance_audit WHERE signal_type='OPTIMAL_STOP' ORDER BY signal_name, run_date DESC, id DESC`)).rows.filter(r => r.stp > 0 && r.tgt > 0).map(r => [r.signal_name, r]));
const status = new Map((await query(`SELECT DISTINCT ON (signal_name) signal_name, recommendation rec, notes FROM performance_audit WHERE signal_type='SETUP_STATUS' ORDER BY signal_name, run_date DESC, id DESC`)).rows.map(r => {
  let n = {}; try { n = JSON.parse(r.notes || '{}'); } catch (_) {} return [r.signal_name, { rec: r.rec, realN: n.all_time_real_n, realEv: n.all_time_real_ev }]; }));
const lv = (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND price IS NOT NULL AND level_name <> 'RTH_VWAP'`, [FROM, TO])).rows;
const byDay = new Map(); for (const r of lv) (byDay.get(r.d) || byDay.set(r.d, []).get(r.d)).push(r);

// ---- simulate
function sim(dd, i, dir, entry, stp, tgt) {                 // returns pnl $ ; dir 'LONG'|'SHORT'
  const long = dir === 'LONG', stopP = long ? entry - stp : entry + stp, tgtP = long ? entry + tgt : entry - tgt;
  for (let j = i + 1; j < dd.c.length; j++) {
    const sh = long ? dd.l[j] <= stopP : dd.h[j] >= stopP, th = long ? dd.h[j] >= tgtP : dd.l[j] <= tgtP;
    if (sh) return { pnl: -stp * 2 - 2, win: 0 };
    if (th) return { pnl: tgt * 2 - 2, win: 1 };
  }
  const last = dd.c[dd.c.length - 1]; return { pnl: (long ? last - entry : entry - last) * 2 - 2, win: 0 };
}
const trades = []; let skipped = 0; const skippedDates = [];
for (let di = 0; di < dates.length; di++) {
  const d = dates[di]; if (d < FROM || d > TO) continue;
  const atr = atrOf.get(d), L = byDay.get(d); if (!atr || !L) continue; const dd = days.get(d);
  const pdc = L.find(x => x.n === 'PD_CLOSE'), prevD = dates[di - 1];
  if (pdc && prevD && Math.abs(pdc.p - days.get(prevD).c[days.get(prevD).c.length - 1]) > 0.1 * atr) { skipped++; skippedDates.push(d); continue; }
  for (const lev of L) {
    if (!opt.has(lev.n + '_FADE_LONG') && !opt.has(lev.n + '_FADE_SHORT')) continue;
    const g = formGate(lev.n);
    for (let i = 5; i < dd.c.length; i++) {
      if (dd.m[i] < Math.max(575, g)) continue;
      if (Math.abs(dd.c[i] - lev.p) > PROX) continue;
      const dir = dd.c[i - 5] < dd.c[i] ? 'SHORT' : 'LONG', type = `${lev.n}_FADE_${dir}`, o = opt.get(type);
      if (!o) break;                                          // no live calibration for this direction -> no setup (live wouldn't fire it either)
      const flip = dir === 'LONG' ? 'SHORT' : 'LONG', entry = dd.c[i];
      const real = sim(dd, i, dir, entry, o.stp, o.tgt), plc = sim(dd, i, flip, entry, o.stp, o.tgt);
      trades.push({ d, type, lvl: lev.n, dir, fam: familyOf(lev.n), pnl: real.pnl, win: real.win, plc: plc.pnl, yr: d.slice(0, 4), era: d < SPLIT ? 'pre' : 'post' });
      break;
    }
  }
}
function boot(arr, key, n = 2000) {                         // day-blocked, per-trade mean of pooled resampled days
  const byD = new Map(); for (const t of arr) (byD.get(t.d) || byD.set(t.d, []).get(t.d)).push(t[key]);
  const ds = [...byD.values()], S = ds.map(sum), C = ds.map(x => x.length); let seed = 20261019; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; const out = [];
  for (let b = 0; b < n; b++) { let s = 0, c = 0; for (let k = 0; k < ds.length; k++) { const j = (rnd() * ds.length) | 0; s += S[j]; c += C[j]; } if (c) out.push(s / c); }
  out.sort((a, b) => a - b); return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
}
const row = (arr) => { const m = mean(arr.map(t => t.pnl)), p = mean(arr.map(t => t.plc)), [lo, hi] = arr.length >= 5 ? boot(arr, 'pnl', 800) : [NaN, NaN]; return { n: arr.length, days: new Set(arr.map(t => t.d)).size, wr: mean(arr.map(t => t.win)), m, lo, hi, p }; };
console.log(`Window ${FROM}..${TO}; ${dates.length} RTH sessions loaded; skipped ${skipped} roll/mismatch days: ${skippedDates.join(' ')}`);
console.log(`Replayed ${trades.length} touches over ${new Set(trades.map(t => t.d)).size} days, ${new Set(trades.map(t => t.type)).size} setup types (stop/target = today's OPTIMAL_STOP).`);
const printRow = (label, r) => console.log(label.padEnd(34), String(r.n).padStart(5), String(r.days).padStart(5), (100 * r.wr).toFixed(0).padStart(4) + '%', f(r.m).padStart(8), `[${f(r.lo, 1)},${f(r.hi, 1)}]`.padEnd(16), 'flipped', f(r.p).padStart(8), 'edge', f(r.m - r.p).padStart(8));
console.log('\n=== POOLED ==='); console.log('group'.padEnd(34), '    N  days   WR   $/trade  95% CI           flippedPlacebo   real-flipped');
printRow('ALL', row(trades)); printRow('ALL pre-2025-06 (uncalibrated)', row(trades.filter(t => t.era === 'pre'))); printRow('ALL post-2025-06', row(trades.filter(t => t.era === 'post')));
for (const y of ['2023', '2024', '2025', '2026']) printRow('year ' + y, row(trades.filter(t => t.yr === y)));
for (const dr of ['LONG', 'SHORT']) { printRow(dr, row(trades.filter(t => t.dir === dr))); printRow(dr + ' pre', row(trades.filter(t => t.dir === dr && t.era === 'pre'))); }
console.log('\n=== BY LEVEL FAMILY (all / pre-2025-06 / post) ==='); for (const fam of [...new Set(trades.map(t => t.fam))].sort()) { const a = trades.filter(t => t.fam === fam); printRow(fam, row(a)); printRow('  pre', row(a.filter(t => t.era === 'pre'))); printRow('  post', row(a.filter(t => t.era === 'post'))); }
// per type
const types = [...new Set(trades.map(t => t.type))].sort(); const per = [];
for (const ty of types) { const a = trades.filter(t => t.type === ty), r = row(a), pre = row(a.filter(t => t.era === 'pre')), post = row(a.filter(t => t.era === 'post')), st = status.get(ty) || {}; per.push({ ty, ...r, preN: pre.n, preM: pre.m, postN: post.n, postM: post.m, st }); }
console.log('\n=== PER SETUP TYPE (sorted by $/trade) ==='); console.log('type'.padEnd(30), '   N days   WR  $/trade  CI              | pre N  $/t   | post N  $/t   | flipped  edge | live status realN realEV');
for (const p of per.sort((a, b) => b.m - a.m)) console.log(p.ty.padEnd(30), String(p.n).padStart(4), String(p.days).padStart(4), (100 * p.wr).toFixed(0).padStart(3) + '%', f(p.m).padStart(7), `[${f(p.lo, 0)},${f(p.hi, 0)}]`.padEnd(14), '|', String(p.preN).padStart(4), f(p.preM, 1).padStart(7), '|', String(p.postN).padStart(4), f(p.postM, 1).padStart(7), '|', f(p.p, 1).padStart(7), f(p.m - p.p, 1).padStart(7), '|', (p.st.rec || '-').padEnd(9), p.st.realN ?? '-', p.st.realEv ?? '-');
const thin = per.filter(p => p.n < 20).length, big = per.filter(p => p.n >= 20), pos = big.filter(p => p.lo > 0).length, neg = big.filter(p => p.hi < 0).length;
console.log(`\nTypes with N>=20: ${big.length} (thin: ${thin}). CI wholly above zero: ${pos}; wholly below zero: ${neg}; chance alone would give ~${(0.025 * big.length).toFixed(1)} each side.`);
const bothSig = big.filter(p => p.preN >= 20 && p.postN >= 20); console.log(`Types with N>=20 in BOTH eras: ${bothSig.length}; sign agrees across eras: ${bothSig.filter(p => Math.sign(p.preM) === Math.sign(p.postM)).length}; correlation pre vs post $/trade: ${(() => { const x = bothSig.map(p => p.preM), y = bothSig.map(p => p.postM), mx = mean(x), my = mean(y); return (sum(x.map((v, i) => (v - mx) * (y[i] - my))) / Math.sqrt(sum(x.map(v => (v - mx) ** 2)) * sum(y.map(v => (v - my) ** 2)))).toFixed(3); })()}`);
fs.writeFileSync('scratch/roster_replay_claude_trades_20261019.json', JSON.stringify({ trades, skippedDates }));
process.exit(0);
