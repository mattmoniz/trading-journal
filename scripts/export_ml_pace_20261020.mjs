// export_ml_pace_20261020.mjs -- point-in-time price-pace inputs for docs/ML_SIMPLE_RULE_AND_FAMILY_PREREG_20261020.md (step 3). Research only.
// pace_W (W=5,15 one-minute bars) = how far price travelled INTO the level over the last W bars (long: C[e-W]-C[e]; short: C[e]-C[e-W]) / median |C[k]-C[k-W]| over the 240 bars before the decision bar e.
// e = last completed 1-minute bar before the fire minute. Blank if fewer than 240 prior bars. Writes scratch/ml_pace_20261020.csv (id,pace_5,pace_15).
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, lb } from './lib/pocJoinLoader.mjs';
const rows = (await query(`SELECT id, fired_at::text f, trade_date::text d, (stop_level < entry_zone_low) is_long FROM active_setups WHERE ml_extended_label IS NOT NULL AND ml_pd_features IS NOT NULL AND ml_intraday_features IS NOT NULL AND stop_level IS NOT NULL AND entry_zone_low IS NOT NULL ORDER BY fired_at`)).rows;
const D = await loadBars(rows[0].d, rows[rows.length - 1].d); console.log(`ML rows ${rows.length}, bars ${D.TS.length}`);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const out = ['id,pace_5,pace_15']; let ok = 0;
for (const r of rows) {
  const ts = r.f.slice(0, 16) + ':00', gi = lb(D.TS, ts); if (gi >= D.TS.length || D.TS[gi] !== ts || gi < 260) { out.push(`${r.id},,`); continue; }
  const e = gi - 1, v = [];
  for (const W of [5, 15]) { const mv = r.is_long ? D.C[e - W] - D.C[e] : D.C[e] - D.C[e - W]; const dev = []; for (let k = e - 240; k < e; k++) dev.push(Math.abs(D.C[k] - D.C[k - W])); const sc = med(dev); v.push(sc > 0 ? (mv / sc).toFixed(4) : ''); }
  out.push(`${r.id},${v.join(',')}`); ok++;
}
fs.writeFileSync('scratch/ml_pace_20261020.csv', out.join('\n') + '\n'); console.log(`rows with pace ${ok} of ${rows.length}`); process.exit(0);
