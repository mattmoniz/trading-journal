// build_label_set_20261020.mjs -- builds the blind labelling pilot: roster level-fade trades the user rates (TAKE / STEP ASIDE / UNSURE) from a chart that stops at the entry minute, outcome hidden.
// Selection (seeded, outcome never used): 32 BLIND trades from the hold-out period 2025-06-01..2026-10-06 (one per day, 16 long / 16 short, date hidden), 8 VERIFY trades from the last 8 replay sessions (date shown, so the user can compare with their own chart).
// Writes scratch/label_set_20261020/moments_blind.json (no outcome anywhere in it) and outcomes.json (id -> replay pnl, kept out of the page).
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex } from './lib/pocJoinLoader.mjs';
const SEED = 20261020; let seed = SEED; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const rows0 = JSON.parse(fs.readFileSync('scratch/rotation_gate_replay_rows_ts_20261020.json', 'utf8'));
const haveOrders = new Set(fs.readdirSync('scratch/orders_20261020').map(f => f.slice(0, 10)));
const D = await loadBars('2025-05-01', '2026-10-17'), S = sessionIndex(D); const { O, H, L, C, TS } = D; const idxOf = new Map(); for (let i = 0; i < TS.length; i++) idxOf.set(TS[i], i);
const opt = new Map((await query(`SELECT DISTINCT ON (signal_name) signal_name, ROUND(COALESCE(optimal_stop,p75_mae))::int stp, ROUND(COALESCE(optimal_target,p50_mfe))::int tgt FROM performance_audit WHERE signal_type='OPTIMAL_STOP' ORDER BY signal_name, run_date DESC, id DESC`)).rows.filter(r => r.stp > 0 && r.tgt > 0).map(r => [r.signal_name, r]));
const ok = (r) => haveOrders.has(r.d) && opt.has(r.type) && idxOf.has(r.ts) && S.rth.get(r.d) && /^\d\d:/.test(r.ts.slice(11)) && r.ts.slice(11, 16) >= '09:45' && r.ts.slice(11, 16) <= '15:30';
const byDay = (R) => { const m = new Map(); for (const r of R) (m.get(r.d) || m.set(r.d, []).get(r.d)).push(r); return m; };
// ---- BLIND: 16 long + 16 short, one per day, hold-out period, date hidden
const poolB = rows0.filter(r => r.d >= '2025-06-01' && r.d <= '2026-10-06' && ok(r)); const dayMapB = byDay(poolB); const daysB = shuffle([...dayMapB.keys()]);
const blind = []; const nL = { LONG: 0, SHORT: 0 };
for (const d of daysB) { if (blind.length >= 32) break; const cand = shuffle(dayMapB.get(d)); const pick = cand.find(r => nL[r.long ? 'LONG' : 'SHORT'] < 16); if (pick) { blind.push({ ...pick, set: 'BLIND' }); nL[pick.long ? 'LONG' : 'SHORT']++; } }
// ---- VERIFY: last 8 replay sessions, one random trade each
const lastDays = [...new Set(rows0.filter(ok).map(r => r.d))].sort().slice(-8); const dayMapV = byDay(rows0.filter(r => lastDays.includes(r.d) && ok(r)));
const verify = lastDays.map(d => ({ ...shuffle(dayMapV.get(d))[0], set: 'VERIFY' }));
const all = shuffle([...blind, ...verify]).map((r, i) => ({ ...r, id: 'M' + String(i + 1).padStart(2, '0') }));
// ---- bars with bid/ask volume for the chosen dates
const dates = [...new Set(all.map(r => r.d))]; const bav = new Map();
for (const x of (await query(`SELECT ts::text ts, bid_volume::float b, ask_volume::float a, volume::float v FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date + 1 AND ts::date = ANY($3::date[]) ORDER BY ts`, [dates[0] < dates[dates.length - 1] ? dates.slice().sort()[0] : dates[0], dates.slice().sort().pop(), dates])).rows) bav.set(x.ts, x);
const lv = await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date = ANY($1::date[])`, [dates]); const LV = new Map(); for (const x of lv.rows) (LV.get(x.d) || LV.set(x.d, []).get(x.d)).push([x.n, x.p]);
const moments = [], outcomes = {};
for (const r of all) {
  const e = idxOf.get(r.ts), rr = S.rth.get(r.d); const Tm = +r.ts.slice(11, 13) * 60 + +r.ts.slice(14, 16); const bars = []; let cumD = 0, pv = 0, vv = 0;
  for (let i = rr[0]; i <= e; i++) { const t = TS[i], m = +t.slice(11, 13) * 60 + +t.slice(14, 16); const x = bav.get(t) || { b: 0, a: 0, v: 0 }; cumD += (x.a || 0) - (x.b || 0); const typ = (H[i] + L[i] + C[i]) / 3; pv += typ * (x.v || 0); vv += x.v || 0; bars.push([m, O[i], H[i], L[i], C[i], Math.round(cumD), vv ? +(pv / vv).toFixed(2) : C[i]]); }
  const entry = C[e], o = opt.get(r.type); const dayLv = (LV.get(r.d) || []).filter(([n, p]) => Number.isFinite(p)); const own = dayLv.find(([n]) => n === r.lvl);
  const lo = Math.min(...bars.map(b => b[3])), hi = Math.max(...bars.map(b => b[2])); const rng = hi - lo;
  const near = dayLv.filter(([n, p]) => p >= lo - rng * 0.05 && p <= hi + rng * 0.05 && n !== r.lvl).sort((a, b) => Math.abs(a[1] - entry) - Math.abs(b[1] - entry)).slice(0, 10);
  const orders = []; for (const line of fs.readFileSync(`scratch/orders_20261020/${r.d}.tsv`, 'utf8').split('\n')) { if (!line) continue; const c = line.split('\t'); const sec = +c[1], sz = +c[2]; if (sz >= 70 && sec < (Tm + 1) * 60) orders.push([c[0], Math.round(sec * 10) / 10, sz, +(+c[3]).toFixed(2)]); }
  moments.push({ id: r.id, set: r.set, date: r.set === 'VERIFY' ? r.d : null, entryMin: Tm, setup: r.type, dir: r.long ? 'LONG' : 'SHORT', level: r.lvl, levelPrice: own ? own[1] : null, entry, stop: o.stp, target: o.tgt, levels: near, bars, orders });
  outcomes[r.id] = { pnl: r.pnl, date: r.d, ts: r.ts, setup: r.type, agree: r.agree, long: r.long, set: r.set };
}
fs.writeFileSync('scratch/label_set_20261020/moments_blind.json', JSON.stringify(moments)); fs.writeFileSync('scratch/label_set_20261020/outcomes.json', JSON.stringify(outcomes));
console.log(`moments ${moments.length} (blind ${blind.length}: long ${nL.LONG}, short ${nL.SHORT}; verify ${verify.length}: ${lastDays.join(', ')}); payload bytes ${fs.statSync('scratch/label_set_20261020/moments_blind.json').size}`);
console.log('own level price found for', moments.filter(m => m.levelPrice != null).length, 'of', moments.length, '; blind moments contain a date field:', moments.some(m => m.set === 'BLIND' && m.date));
process.exit(0);
