// Independent SQL recomputation of dataset fields for sample dates (no JS loader, no computeProfile).
import fs from 'fs';
import { query } from '../server/db.js';
const R = JSON.parse(fs.readFileSync(new URL('../scratch/overnight_rth_dataset_20261026.json', import.meta.url))).rows;
const pick = [0, 57, 131, 244, 301, 388, 466, 520, 610, 700, 771].map((i) => R[Math.min(i, R.length - 1)]);
let bad = 0;
for (const r of pick) {
  const q = await query(`
    WITH pd AS (SELECT max(trade_date) d FROM daily_rth_stats WHERE trade_date < $1::date),
    on_b AS (SELECT * FROM price_bars_primary, pd WHERE symbol='NQ' AND ts > (pd.d::text||' 16:00:00')::timestamp AND ts < ($1::date::text||' 09:30:00')::timestamp
             AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 1080 OR EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 570)),
    rth AS (SELECT * FROM price_bars_primary WHERE symbol='NQ' AND ts >= ($1::date::text||' 09:30:00')::timestamp AND ts < ($1::date::text||' 16:00:00')::timestamp),
    atr AS (SELECT avg(rth_range) a FROM (SELECT rth_range FROM daily_rth_stats WHERE trade_date < $1::date ORDER BY trade_date DESC LIMIT 20) x)
    SELECT (SELECT max(high) FROM on_b)::float onH, (SELECT min(low) FROM on_b)::float onL, (SELECT count(*) FROM on_b)::int onBars,
      (SELECT open FROM rth ORDER BY ts LIMIT 1)::float O, (SELECT close FROM rth ORDER BY ts OFFSET 59 LIMIT 1)::float c60, (SELECT close FROM rth ORDER BY ts DESC LIMIT 1)::float cEnd,
      (SELECT a FROM atr)::float atr`, [r.date]);
  const x = q.rows[0], r60 = (x.c60 - x.o) / x.atr; const O = x.o ?? x.O;
  const sql = { onH: x.onh, onL: x.onl, onBars: x.onbars, O: x.o, r60: (x.c60 - x.o) / x.atr, rClose: (x.cend - x.o) / x.atr, atr: x.atr };
  const diffs = Object.entries(sql).map(([k, v]) => [k, v, r[k], Math.abs(v - r[k])]).filter(([, , , d]) => !(d < 1e-6));
  console.log(r.date, diffs.length ? 'MISMATCH ' + JSON.stringify(diffs) : 'ok');
  bad += diffs.length ? 1 : 0; void O; void r60;
}
console.log(bad ? `${bad} dates mismatched` : `all ${pick.length} sampled dates match the SQL recomputation (onH, onL, onBars, O, r60, rClose, atr)`);
process.exit(0);
