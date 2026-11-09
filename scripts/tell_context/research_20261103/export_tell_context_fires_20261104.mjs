// Exporter for docs/TELL_AS_DIRECTION_CONTEXT_PREREG_20261104.md: ACTIVE+SHADOW fires 2026-07-09..2026-10-19 (RTH 10:00-14:30 ET, with a pnl, no basis flag) and the 1-minute NQ closes of those trade dates (09:00-16:00 ET), both time bounds on every query (cv-009). Prints counts only.
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..'); const out = path.join(repo, 'scratch', 'watcher_marks_20261104'); fs.mkdirSync(out, { recursive: true });
const r = await query(`SELECT id, setup_type, origin_status, trade_date::text AS trade_date, fired_at::text AS fired_at, is_cluster_primary, actual_pnl::float AS pnl, entry_zone_low::float AS ez_lo, entry_zone_high::float AS ez_hi, stop_level::float AS stop_level
  FROM active_setups WHERE origin_status IN ('ACTIVE','SHADOW') AND fired_at >= '2026-07-09' AND fired_at < '2026-10-20' AND actual_pnl IS NOT NULL
    AND (EXTRACT(hour FROM fired_at) * 60 + EXTRACT(minute FROM fired_at)) >= 600 AND (EXTRACT(hour FROM fired_at) * 60 + EXTRACT(minute FROM fired_at)) < 870
    AND NOT (COALESCE(stale_entry_price_basis,false) OR COALESCE(late_fill_past_expiry_basis,false) OR COALESCE(bad_bars_basis,false) OR COALESCE(ib_window_stale_basis,false) OR COALESCE(stale_levels_basis,false))
  ORDER BY fired_at`);
const dates = [...new Set(r.rows.map(x => x.trade_date))]; const bars = {};
for (const d of dates) { const b = await query(`SELECT to_char(ts,'HH24:MI') AS hm, close::float AS c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp + interval '9 hours' AND ts < $1::timestamp + interval '16 hours' ORDER BY ts`, [d]); bars[d] = b.rows; }
fs.writeFileSync(path.join(out, 'shadow_fires_tellctx.json'), JSON.stringify({ fires: r.rows, bars }));
console.log(r.rows.length, 'fires on', dates.length, 'dates;', r.rows.filter(x => x.is_cluster_primary).length, 'declustered'); process.exit(0);
