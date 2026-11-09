// Exporter for docs/SHADOW_FIRES_BY_DAY_TYPE_PREREG_20261103.md: all ACTIVE+SHADOW fires since 2026-07-09 with a pnl, and the 1-minute RTH bars of trade dates after 2026-10-19 (the 500-contract bars cover the rest).
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..'); const out = path.join(repo, 'scratch', 'shadow_fires_20261103'); fs.mkdirSync(out, { recursive: true });
const r = await query(`SELECT id, setup_type, origin_status, trade_date::text AS trade_date, fired_at::text AS fired_at, is_rth, session, resolution, resolution_method, actual_pnl::float AS pnl, is_cluster_primary,
    (COALESCE(stale_entry_price_basis,false) OR COALESCE(late_fill_past_expiry_basis,false) OR COALESCE(bad_bars_basis,false) OR COALESCE(ib_window_stale_basis,false) OR COALESCE(stale_levels_basis,false)) AS basis_flag
  FROM active_setups WHERE origin_status IN ('ACTIVE','SHADOW') AND fired_at >= '2026-07-09' ORDER BY fired_at`);
fs.writeFileSync(path.join(out, 'fires.json'), JSON.stringify(r.rows)); console.log(r.rows.length, 'fires,', r.rows.filter(x => x.pnl != null).length, 'with pnl');
const dates = [...new Set(r.rows.map(x => x.trade_date))].filter(d => d > '2026-10-19').sort(); const bars = {};
for (const d of dates) { const b = await query(`SELECT open::float AS o, high::float AS h, low::float AS l, close::float AS c, volume::float AS v FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp + interval '9 hours 30 minutes' AND ts < $1::timestamp + interval '16 hours' ORDER BY ts`, [d]); bars[d] = b.rows; }
fs.writeFileSync(path.join(out, 'bars_1m.json'), JSON.stringify(bars)); console.log(dates.length, 'late dates with 1-minute bars:', dates.map(d => d.slice(5) + ':' + bars[d].length).join(' ')); process.exit(0);
