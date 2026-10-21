// Point-in-time level-distance features for docs/ML_LEVEL_DISTANCE_FEATURES_PREREG_20261021.md. Research only.
// Writes scratch/ml_level_features_20261021.csv: id, d_onh, d_onl, d_pw_vah, d_pw_val, d_pw_high, d_pw_low  = (entry - level)/ATR20 (positive = entry above the level).
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex, lb, addDay } from './lib/pocJoinLoader.mjs';
const rows = (await query(`SELECT id, fired_at::text f, trade_date::text d, entry_zone_low::float e FROM active_setups WHERE ml_extended_label IS NOT NULL AND ml_pd_features IS NOT NULL AND ml_intraday_features IS NOT NULL AND stop_level IS NOT NULL AND entry_zone_low IS NOT NULL ORDER BY fired_at`)).rows;
const D = await loadBars(rows[0].d, rows[rows.length - 1].d), S = sessionIndex(D);
const lv = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE level_name IN ('PW_VAH','PW_VAL','PW_HIGH','PW_LOW') AND trade_date >= $1::date - 2 AND trade_date <= $2::date + 3`, [rows[0].d, rows[rows.length - 1].d])).rows) { if (!lv.has(r.d)) lv.set(r.d, {}); lv.get(r.d)[r.n] = r.p; }
const atrDate = (d) => { let a = S.atr20(d); if (a) return a; const k = lb(S.dates, d); return k > 0 ? S.atr20(S.dates[Math.min(k, S.dates.length - 1)]) : null; };
const out = ['id,d_onh,d_onl,d_pw_vah,d_pw_val,d_pw_high,d_pw_low']; let nOn = 0, nPw = 0;
for (const r of rows) {
  const day = r.f.slice(0, 10), minute = +r.f.slice(11, 13) * 60 + +r.f.slice(14, 16), ts = r.f.slice(0, 16) + ':00', fi = lb(D.TS, ts), atr = atrDate(r.d) || atrDate(day);
  let onh = null, onl = null;
  if (atr && fi > 20) {
    if (minute >= 570 && minute < 1080) { const a = lb(D.TS, day + ' 00:00:00'), b = lb(D.TS, day + ' 09:30:00'); if (b - a >= 10) { let h = -Infinity, l = Infinity; for (let k = a; k < b; k++) { if (D.H[k] > h) h = D.H[k]; if (D.L[k] < l) l = D.L[k]; } onh = h; onl = l; } }
    else { const startDay = minute >= 1080 ? day : addDay(day, -1), a = lb(D.TS, startDay + ' 18:00:00'); if (fi - a >= 10) { let h = -Infinity, l = Infinity; for (let k = a; k < fi; k++) { if (D.H[k] > h) h = D.H[k]; if (D.L[k] < l) l = D.L[k]; } onh = h; onl = l; } }
  }
  const pw = lv.get(r.d) || {}; const dist = (p) => (p == null || !atr ? '' : ((r.e - p) / atr).toFixed(4));
  if (onh != null) nOn++; if (pw.PW_VAH != null) nPw++;
  out.push([r.id, dist(onh), dist(onl), dist(pw.PW_VAH), dist(pw.PW_VAL), dist(pw.PW_HIGH), dist(pw.PW_LOW)].join(','));
}
fs.writeFileSync('scratch/ml_level_features_20261021.csv', out.join('\n') + '\n'); console.log(`rows ${rows.length}; with overnight levels ${nOn} (${(nOn / rows.length * 100).toFixed(0)}%), with prior-week levels ${nPw} (${(nPw / rows.length * 100).toFixed(0)}%)`); process.exit(0);
