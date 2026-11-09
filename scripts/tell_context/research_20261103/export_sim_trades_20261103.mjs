// Exporter for docs/SIM_TRADES_BY_DAY_SHAPE_PREREG_20261103.md: the real sim broker-filled rows of active_setups, the broker entry fill, and the 1-minute RTH bars of each trade date (for the shape of days not covered by the 500-contract bar files).
// Output scratch/sim_trades_20261103/{trades.json,bars_1m.json}
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..'); const out = path.join(repo, 'scratch', 'sim_trades_20261103'); fs.mkdirSync(out, { recursive: true });
const r = await query(`SELECT s.id, s.setup_type, s.fired_at::text AS fired_at, s.resolved_at::text AS resolved_at, s.trade_date::text AS trade_date, s.is_rth, s.session, s.price_at_detection::float AS entry_price, s.broker_pnl::float AS broker_pnl, s.actual_pnl::float AS actual_pnl,
    s.is_cluster_primary, (COALESCE(s.stale_entry_price_basis,false) OR COALESCE(s.late_fill_past_expiry_basis,false) OR COALESCE(s.bad_bars_basis,false) OR COALESCE(s.ib_window_stale_basis,false) OR COALESCE(s.stale_levels_basis,false)) AS basis_flag,
    (SELECT o.avg_fill_price::float FROM order_placements o WHERE o.setup_id = s.id AND o.purpose ILIKE 'ENTRY%' AND o.avg_fill_price IS NOT NULL ORDER BY o.id LIMIT 1) AS entry_fill
  FROM active_setups s WHERE s.origin_status='ACTIVE' AND s.pnl_source='BROKER' AND s.broker_pnl IS NOT NULL ORDER BY s.fired_at`);
fs.writeFileSync(path.join(out, 'trades.json'), JSON.stringify(r.rows)); console.log(r.rows.length, 'trades', r.rows.filter(x => x.entry_fill != null).length, 'with a broker entry fill');
const dates = [...new Set(r.rows.map(x => x.trade_date))]; const bars = {};
for (const d of dates) { const b = await query(`SELECT to_char(ts,'HH24:MI') AS t, open::float AS o, high::float AS h, low::float AS l, close::float AS c, volume::float AS v FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp + interval '9 hours 30 minutes' AND ts < $1::timestamp + interval '16 hours' ORDER BY ts`, [d]); bars[d] = b.rows; }
fs.writeFileSync(path.join(out, 'bars_1m.json'), JSON.stringify(bars)); console.log(dates.length, 'trade dates;', Object.values(bars).map(x => x.length).join(',')); process.exit(0);
