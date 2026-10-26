// Idempotent loader: scratch/vap_daily/YYYY-MM-DD.tsv (build_vap_daily_20261026.py) -> volume_at_price_daily / volume_at_price_days. Skips dates already loaded.
// Usage: node scripts/load_vap_daily.mjs [START END]   (default: every file present)
import fs from 'fs';
import { query } from '../server/db.js';
const dir = 'scratch/vap_daily', db = JSON.parse(fs.readFileSync('scratch/db_session_volume_20261026.json', 'utf8'));
const [a, b] = [process.argv[2] || '0000', process.argv[3] || '9999'];
const have = new Set((await query(`SELECT trade_date::text d FROM volume_at_price_days`)).rows.map((r) => r.d));
let n = 0, rows = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tsv')).sort()) {
  const d = f.slice(0, 10); if (d < a || d > b || have.has(d)) continue;
  const P = [], A = [], R = []; let tot = 0;
  for (const line of fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n')) { if (!line) continue; const [p, va, vr] = line.split('\t'); P.push(+p); A.push(+va); R.push(+vr); tot += +va; }
  await query('BEGIN');
  await query(`INSERT INTO volume_at_price_daily (trade_date, price, vol_all, vol_rth) SELECT $1::date, p, a, r FROM unnest($2::numeric[], $3::int[], $4::int[]) AS t(p, a, r)`, [d, P, A, R]);
  await query(`INSERT INTO volume_at_price_days (trade_date, tick_volume, db_volume, source) VALUES ($1, $2, $3, $4)`, [d, tot, Math.round(db[d]?.v || 0), 'scratch/vap_daily']);
  await query('COMMIT'); n++; rows += P.length;
}
console.log(`loaded ${n} dates, ${rows} rows`);
process.exit(0);
