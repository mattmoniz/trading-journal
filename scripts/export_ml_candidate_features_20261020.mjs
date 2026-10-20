// export_ml_candidate_features_20261020.mjs -- point-in-time candidate ML inputs for docs/ML_INPUT_ABLATION_PREREG_20261020.md. Research only.
// For every active_setups row that has an ML extended label, at the decision bar (the last completed 1-minute bar before the fire minute), RTH fires 09:35-15:59 ET only:
//  ctx_rank / dev_range_atr: developing range (RTH open..decision bar) / ATR20 and its rank vs the previous 60 sessions at the same clock bar (R4 definition, needs >= 40 prior)
//  adv_rank_15 / adv_rank_30: adverse aggressor-volume imbalance over 15 / 30 bars, aligned to the trade direction, ranked the same way (R5 definition)
//  rot_agree / leg_age_bars / rot_count: 65pt rotation gate AGREE (1/0), bars since the current leg began, number of 65pt legs since the 18:00 session start (rotationDetector.detectRotationLegs)
// Writes scratch/ml_candidate_features_20261020.csv (id, ...); missing = empty.
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex, lb, addDay } from './lib/pocJoinLoader.mjs';
import { detectRotationLegs } from '../server/services/rotationDetector.js';
const rows = (await query(`SELECT id, fired_at::text f, trade_date::text d, (stop_level < entry_zone_low) is_long FROM active_setups WHERE ml_extended_label IS NOT NULL AND ml_pd_features IS NOT NULL AND ml_intraday_features IS NOT NULL AND stop_level IS NOT NULL AND entry_zone_low IS NOT NULL ORDER BY fired_at`)).rows;
const d0 = rows[0].d, d1 = rows[rows.length - 1].d; console.log(`ML rows ${rows.length}, ${d0}..${d1}`);
const D = await loadBars(d0, d1), S = sessionIndex(D); const idxOf = new Map(); for (let i = 0; i < D.TS.length; i++) idxOf.set(D.TS[i], i);
const BV = new Float64Array(D.TS.length), AV = new Float64Array(D.TS.length);
for (const x of (await query(`SELECT ts::text ts, bid_volume::float b, ask_volume::float a FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - 215 AND ts < $2::date + 3`, [d0, d1])).rows) { const i = idxOf.get(x.ts); if (i != null) { BV[i] = x.b || 0; AV[i] = x.a || 0; } }
const csum = (a) => { const o = new Float64Array(a.length + 1); for (let i = 0; i < a.length; i++) o[i + 1] = o[i] + a[i]; return o; }; const cB = csum(BV), cA = csum(AV);
const devRange = (d, e) => { const a = lb(D.TS, d + ' 09:30:00'); if (e < a) return null; let hi = -Infinity, lo = Infinity; for (let i = a; i <= e; i++) { if (D.H[i] > hi) hi = D.H[i]; if (D.L[i] < lo) lo = D.L[i]; } const atr = S.atr20(d); return atr ? (hi - lo) / atr : null; };
const adv = (e, W, long) => { const sell = cB[e + 1] - cB[e + 1 - W], buy = cA[e + 1] - cA[e + 1 - W], a = long ? sell : buy, fv = long ? buy : sell; return (a - fv) / ((a + fv) || 1); };
const prior60 = (d) => { const k = lb(S.dates, d); return S.dates.slice(Math.max(0, k - 60), k); };
const legCache = new Map(); const legsOf = (d) => { if (legCache.has(d)) return legCache.get(d); const a = lb(D.TS, addDay(d, -1) + ' 18:00:00'), b = lb(D.TS, d + ' 17:00:00'); const bars = []; for (let i = a; i < b; i++) bars.push({ high: D.H[i], low: D.L[i] }); const o = { a, legs: bars.length ? detectRotationLegs(bars, 65) : [] }; legCache.set(d, o); return o; };
const out = ['id,ctx_rank,dev_range_atr,adv_rank_15,adv_rank_30,rot_agree,leg_age_bars,rot_count']; let nOk = 0;
for (const r of rows) { const ts = r.f.slice(0, 16) + ':00', m = +ts.slice(11, 13) * 60 + +ts.slice(14, 16); const blank = () => out.push(`${r.id},,,,,,,`); if (m < 575 || m > 959) { blank(); continue; }
  const gi = lb(D.TS, ts); if (D.TS[gi] !== ts || gi < 40) { blank(); continue; } const e = gi - 1, d = D.TS[gi].slice(0, 10), clock = D.TS[e].slice(10), past = prior60(d); if (!S.rth.get(d)) { blank(); continue; }
  const cur = devRange(d, e); const pr = [], p15 = [], p30 = []; for (const pd of past) { const j = idxOf.get(pd + clock); if (j == null || j < 40) continue; const v = devRange(pd, j); if (v != null) pr.push(v); p15.push(adv(j, 15, r.is_long)); p30.push(adv(j, 30, r.is_long)); }
  const rk = (x, a, k = 40) => (x != null && a.length >= k ? a.filter((v) => v <= x).length / a.length : ''); const { a, legs } = legsOf(d); let dir = null, startIdx = null, n = 0; for (const l of legs) { if (a + l.idx <= gi) { dir = l.dir; startIdx = a + l.idx; n++; } else break; }
  out.push([r.id, rk(cur, pr), cur == null ? '' : cur.toFixed(4), rk(adv(e, 15, r.is_long), p15), rk(adv(e, 30, r.is_long), p30), dir == null ? '' : ((dir === 'UP') === r.is_long ? 1 : 0), startIdx == null ? '' : gi - startIdx, n].join(',')); nOk++; }
fs.writeFileSync('scratch/ml_candidate_features_20261020.csv', out.join('\n') + '\n'); console.log(`rows with features ${nOk} of ${rows.length}`);
process.exit(0);
