// Read-only export for the A10.3 replication (docs/CAPITULATION_REPLACES_TARGET_REPLICATION_PREREG_20261109.md): the 2023-25 explore BACKFILL level-fade rows, geometry only; actual_pnl (synthetic, ITT-descriptive only) in a separate file read by --go. Minute bars for the window too.
import fs from 'fs';
import { query } from '../../server/db.js';
import { adr20 } from '../lib/levelContext.mjs';
const D = 'scratch/capitulation_replay_20261109';
const r = await query(`SELECT id, setup_type, bet_class, origin_status, trade_date::text td, fired_at::text f, resolved_at::text rs, expires_at::text exp, COALESCE(price_at_detection, entry_zone_high)::float p0, stop_level::float stp, t1_level::float t1
  FROM active_setups WHERE origin_status = 'BACKFILL' AND is_cluster_primary AND resolved_at IS NOT NULL AND trade_date BETWEEN '2023-04-10' AND '2025-05-16' AND setup_type ~ '_(LONG|SHORT)' ORDER BY fired_at`);
const cache = new Map(); for (const x of r.rows) { if (!cache.has(x.td)) cache.set(x.td, await adr20(x.td)); x.adr = cache.get(x.td); }
fs.writeFileSync(`${D}/a11_rows.json`, JSON.stringify(r.rows)); console.log('a11 rows', r.rows.length);
const p = await query(`SELECT id, actual_pnl::float pnl FROM active_setups WHERE id = ANY($1)`, [r.rows.map((x) => x.id)]); fs.writeFileSync(`${D}/a11_pnl.json`, JSON.stringify(p.rows)); console.log('a11 pnl file written (not read before --go)');
const out = []; for (let d = new Date('2023-04-01T00:00:00Z'); d < new Date('2025-05-17T00:00:00Z'); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
  const a = d.toISOString().slice(0, 10), nx = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)), b = nx.toISOString().slice(0, 10) > '2025-05-17' ? '2025-05-17' : nx.toISOString().slice(0, 10);
  const m = await query(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, open::float o, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date ORDER BY ts`, [a, b]); for (const x of m.rows) out.push(`${x.t}\t${x.o}\t${x.h}\t${x.l}\t${x.c}`);
}
fs.writeFileSync(`${D}/a11_minute_bars.tsv`, out.join('\n')); console.log('minute bars', out.length); process.exit(0);
