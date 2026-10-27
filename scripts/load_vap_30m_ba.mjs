// Idempotent loader: scratch/vap_30m_ba/YYYY-MM-DD.tsv (ET date, HH:MM, price, bid_volume, ask_volume) -> volume_at_price_30m_ba / volume_at_price_30m_ba_days. Skips loaded dates.
import fs from 'fs';
import { query } from '../server/db.js';
const dir = 'scratch/vap_30m_ba', [a, b] = [process.argv[2] || '0000', process.argv[3] || '9999'];
const have = new Set((await query(`SELECT trade_date::text d FROM volume_at_price_30m_ba_days`)).rows.map((r) => r.d));
let n = 0, rows = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tsv')).sort()) {
  const d = f.slice(0, 10); if (d < a || d > b || have.has(d)) continue;
  const T = [], P = [], B = [], A = []; let tb = 0, ta = 0;
  for (const line of fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n')) { if (!line) continue; const [day, hm, p, bv, av] = line.split('\t'); T.push(`${day} ${hm}:00`); P.push(+p); B.push(+bv); A.push(+av); tb += +bv; ta += +av; }
  await query('BEGIN');
  for (let i = 0; i < T.length; i += 20000) await query(`INSERT INTO volume_at_price_30m_ba (bar_start, price, bid_vol, ask_vol) SELECT t::timestamp, p, b, a FROM unnest($1::text[], $2::numeric[], $3::int[], $4::int[]) AS x(t, p, b, a)`, [T.slice(i, i + 20000), P.slice(i, i + 20000), B.slice(i, i + 20000), A.slice(i, i + 20000)]);
  await query(`INSERT INTO volume_at_price_30m_ba_days (trade_date, bid_volume, ask_volume) VALUES ($1, $2, $3)`, [d, tb, ta]);
  await query('COMMIT'); n++; rows += T.length;
}
console.log(`loaded ${n} dates, ${rows} rows`);
process.exit(0);
