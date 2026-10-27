// Idempotent loader: scratch/vap_30m/YYYY-MM-DD.tsv (build_vap_30m_20261026.py; lines: ET date, HH:MM, price, volume) -> volume_at_price_30m / volume_at_price_30m_days. Skips loaded dates.
import fs from 'fs';
import { query } from '../server/db.js';
const dir = 'scratch/vap_30m', [a, b] = [process.argv[2] || '0000', process.argv[3] || '9999'];
const have = new Set((await query(`SELECT trade_date::text d FROM volume_at_price_30m_days`)).rows.map((r) => r.d));
let n = 0, rows = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tsv')).sort()) {
  const d = f.slice(0, 10); if (d < a || d > b || have.has(d)) continue;
  const T = [], P = [], V = []; let tot = 0;
  for (const line of fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n')) { if (!line) continue; const [day, hm, p, v] = line.split('\t'); T.push(`${day} ${hm}:00`); P.push(+p); V.push(+v); tot += +v; }
  await query('BEGIN');
  for (let i = 0; i < T.length; i += 20000) await query(`INSERT INTO volume_at_price_30m (bar_start, price, vol) SELECT t::timestamp, p, v FROM unnest($1::text[], $2::numeric[], $3::int[]) AS x(t, p, v)`, [T.slice(i, i + 20000), P.slice(i, i + 20000), V.slice(i, i + 20000)]);
  await query(`INSERT INTO volume_at_price_30m_days (trade_date, tick_volume) VALUES ($1, $2)`, [d, tot]);
  await query('COMMIT'); n++; rows += T.length;
}
console.log(`loaded ${n} dates, ${rows} rows`);
process.exit(0);
