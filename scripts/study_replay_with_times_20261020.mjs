// study_replay_with_times_20261020.mjs -- the same replay as study_rotation_gate_roster_replay_20261020.mjs (identical touch/trade generation, equivalence check kept) but saving touch time and level; analysis removed. Original header: runs docs/ROTATION_GATE_ROSTER_REPLAY_PREREG_20261020.md (committed 7758670 before any gate outcome on this population).
// RTH level-fade touches replayed over 3.5 years (as study_roster_replay_20261019.mjs) with REALISTIC fills, each tagged AGREE/DISAGREE with the direction of the in-progress 65pt rotation leg at the touch (rotationDetector.detectRotationLegs on the 18:00-anchored detector session; verified equivalent to the live gate's detectSignalEvents all_leg_records.at(-1).direction on random samples first).
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex, mean, sum, f, lb, addDay, rnd } from './lib/pocJoinLoader.mjs';
import { detectRotationLegs } from '../server/services/rotationDetector.js';
import { detectSignalEvents } from '../server/services/pocRotationService.js';
const FROM = '2023-03-06', TO = '2026-10-16', SPLIT = '2025-06-01', PROX = 15;
const GATE = { OR5: 575, OR10: 580, OR15: 585, OR30: 600, IB: 630 }; const formGate = (n) => { for (const k of Object.keys(GATE)) if (n.startsWith(k + '_')) return GATE[k]; return 575; };
const D = await loadBars(FROM, TO), S = sessionIndex(D);
const opt = new Map((await query(`SELECT DISTINCT ON (signal_name) signal_name, ROUND(COALESCE(optimal_stop,p75_mae))::int stp, ROUND(COALESCE(optimal_target,p50_mfe))::int tgt FROM performance_audit WHERE signal_type='OPTIMAL_STOP' ORDER BY signal_name, run_date DESC, id DESC`)).rows.filter(r => r.stp > 0 && r.tgt > 0).map(r => [r.signal_name, r]));
const LV = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND price IS NOT NULL AND level_name <> 'RTH_VWAP'`, [FROM, TO])).rows) (LV.get(r.d) || LV.set(r.d, []).get(r.d)).push(r);
const mod = (gi) => +D.TS[gi].slice(11, 13) * 60 + +D.TS[gi].slice(14, 16);
function simTrade(gi, endIdx, long, entry, stp, tgt) { const { O, H, L, C } = D, stopP = long ? entry - stp : entry + stp, tgtP = long ? entry + tgt : entry - tgt;
  for (let k = gi + 1; k <= endIdx; k++) { if (long ? L[k] <= stopP : H[k] >= stopP) { const fill = long ? Math.min(stopP, O[k]) : Math.max(stopP, O[k]); return (long ? fill - entry : entry - fill) * 2 - 2; }
    if (long ? H[k] >= tgtP : L[k] <= tgtP) { const fill = long ? Math.max(tgtP, O[k]) : Math.min(tgtP, O[k]); return (long ? fill - entry : entry - fill) * 2 - 2; } }
  return (long ? D.C[endIdx] - entry : entry - D.C[endIdx]) * 2 - 2; }
const legCache = new Map(); function legsOf(d) { if (legCache.has(d)) return legCache.get(d); const a = lb(D.TS, addDay(d, -1) + ' 18:00:00'), b = lb(D.TS, d + ' 17:00:00'); const bars = []; for (let i = a; i < b; i++) bars.push({ high: D.H[i], low: D.L[i] }); const out = { a, legs: bars.length ? detectRotationLegs(bars, 65) : [] }; legCache.set(d, out); return out; }
const rotDir = (d, gi) => { const { a, legs } = legsOf(d); let dir = null; for (const l of legs) { if (a + l.idx <= gi) dir = l.dir; else break; } return dir; };   // 'UP'|'DOWN'|null
const trades = []; let skipped = 0, noLeg = 0; const touches = [];
for (let di = 0; di < S.dates.length; di++) { const d = S.dates[di]; if (d < FROM || d > TO) continue; const atr = S.atr20(d), L = LV.get(d); if (!atr || !L) continue; const [a, b] = S.rth.get(d); const prev = S.dates[di - 1], pdc = L.find(x => x.n === 'PD_CLOSE');
  if (pdc && prev && Math.abs(pdc.p - D.C[S.rth.get(prev)[1] - 1]) > 0.1 * atr) { skipped++; continue; }
  for (const lev of L) { if (!opt.has(lev.n + '_FADE_LONG') && !opt.has(lev.n + '_FADE_SHORT')) continue; const g = formGate(lev.n);
    for (let gi = a + 5; gi < b; gi++) { if (mod(gi) < Math.max(575, g)) continue; if (Math.abs(D.C[gi] - lev.p) > PROX) continue;
      const long = !(D.C[gi - 5] < D.C[gi]), type = `${lev.n}_FADE_${long ? 'LONG' : 'SHORT'}`, o = opt.get(type); if (!o) break; const entry = D.C[gi];
      touches.push({ d, gi, long, type, lvl: lev.n }); trades.push({ d, ts: D.TS[gi], gi, lvl: lev.n, type, long, pnl: simTrade(gi, b - 1, long, entry, o.stp, o.tgt), plc: simTrade(gi, b - 1, !long, entry, o.stp, o.tgt), rd: rotDir(d, gi), era: d < SPLIT ? 'PRE' : 'POST', yr: d.slice(0, 4) }); break; } } }
console.log(`roll/mismatch days skipped ${skipped}; replayed touches ${trades.length}`);
// ---- equivalence check vs the live gate's detectSignalEvents(all_leg_records.at(-1).direction), random (date, bar) samples
{ let seed = 99; const r2 = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; let ok = 0, bad = 0, nulls = 0; const sample = []; for (let k = 0; k < 220; k++) sample.push(touches[Math.floor(r2() * touches.length)]);
  for (const t of sample) { const a = lb(D.TS, addDay(t.d, -1) + ' 18:00:00'), bars = []; for (let i = a; i <= t.gi; i++) bars.push({ ts: D.TS[i], open: D.O[i], high: D.H[i], low: D.L[i], close: D.C[i], volume: D.V[i] });
    const { all_leg_records } = detectSignalEvents(65, 'standard', 6.75, [{ t: t.d, bars }], 'fixed'); const live = all_leg_records.length ? all_leg_records[all_leg_records.length - 1].direction : null, mine = rotDir(t.d, t.gi); if (live == null && mine == null) { nulls++; ok++; } else if (live === mine) ok++; else bad++; }
  console.log(`equivalence check vs live gate logic on ${sample.length} random touches: match ${ok} (both-null ${nulls}), MISMATCH ${bad}`); if (bad > 0) { console.log('STOP: direction logic is not equivalent to the live gate; fix before reporting.'); process.exit(1); } }
const T = trades; for (const t of T) t.agree = t.rd ? (t.rd === 'UP') === t.long : null;
fs.writeFileSync('scratch/rotation_gate_replay_rows_ts_20261020.json', JSON.stringify(T.map(t => ({ d: t.d, ts: t.ts, lvl: t.lvl, type: t.type, long: t.long, rd: t.rd, agree: t.agree, pnl: t.pnl, era: t.era })))); console.log('rows saved', T.length); process.exit(0);
