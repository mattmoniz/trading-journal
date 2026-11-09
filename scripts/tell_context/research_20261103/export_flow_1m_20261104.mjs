// Exporter for docs/TRADE_WATCHER_MARKS_AND_LABELS_SCOPE_20261104.md step 1: RTH (09:30-15:59 ET) NQ 1-minute OHLC, volume, bid and ask volume per explore trade date plus the dates passed on the command line (today). Output scratch/watcher_marks_20261104/rth_1m_flow.json. Reads no outcome labels. Both time bounds on every query (cv-009).
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');
const F = JSON.parse(fs.readFileSync(path.join(repo, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json'), 'utf8'));
const dates = [...new Set([...Object.keys(F), ...process.argv.slice(2)])].sort(); const out = {}; const CH = 40;
for (let i = 0; i < dates.length; i += CH) {
  const ch = dates.slice(i, i + CH); const lo = ch[0] + ' 09:30:00', hi = ch[ch.length - 1] + ' 16:00:00';
  const r = await query(`SELECT ts::date::text AS d, (EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int - 570) AS m, open::float AS o, high::float AS h, low::float AS l, close::float AS c, volume::float AS v, bid_volume::float AS b, ask_volume::float AS a FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp AND ts::time >= '09:30' AND ts::time < '16:00' ORDER BY ts`, [lo, hi]);
  for (const x of r.rows) {
    if (!dates.includes(x.d)) continue;
    const o = out[x.d] || (out[x.d] = { m: [], o: [], h: [], l: [], c: [], v: [], b: [], a: [] });
    for (const k of ['m', 'o', 'h', 'l', 'c', 'v', 'b', 'a']) o[k].push(x[k]);
  }
}
fs.writeFileSync(path.join(repo, 'scratch', 'watcher_marks_20261104', 'rth_1m_flow.json'), JSON.stringify(out));
const n = Object.values(out).map(x => x.m.length); console.log(Object.keys(out).length, 'dates; bars per date min/median/max', Math.min(...n), n.sort((p, q) => p - q)[n.length >> 1], Math.max(...n));
process.exit(0);
