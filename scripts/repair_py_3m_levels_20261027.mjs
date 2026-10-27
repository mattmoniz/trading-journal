// Pass 4 of the 2026-10-27 level repair: PY_VAH/VAL/POC and 3M_VAH/VAL/POC rows whose stored price differs from the production recomputation (scripts/compute_levels.js <date> --dry, saved in scratch/level_dry/).
// Why trusted: the prior-year level must be constant within a calendar year (stored values drifted inside one year); where tick-volume coverage is complete the recomputation lands within ~10-150 points of the real
// tick profile and the stored value is 280-500 off (2024 year, 2025-12..2026-02 3M windows). Stored rows were built from bars that were repaired afterwards. Values are the production code's own output, applied by UPDATE.
// Backup first (level_prices_pass4_backup_20261027, only the rows touched). Idempotent.
import fs from 'fs';
import { query } from '../server/db.js';
const dir = 'scratch/level_dry'; const upd = [];
const stored = new Map((await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date >= '2023-11-01' AND (level_name LIKE 'PY\\_%' OR level_name LIKE '3M\\_%')`)).rows.map((r) => [r.d + '|' + r.n, r.p]));
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.txt')).sort()) { const d = f.slice(0, 10), txt = fs.readFileSync(`${dir}/${f}`, 'utf8'); if (!txt.includes('DRY RUN')) continue;
  for (const line of txt.split('\n')) { const m = line.match(/^\s{2}((?:PY|3M)_\w+)\s+(-?[\d.]+)\s+\[/); if (!m) continue; const s = stored.get(d + '|' + m[1]); if (s != null && Math.abs(s - +m[2]) > 0.01) upd.push({ d, n: m[1], from: s, to: +m[2] }); } }
console.log('rows to update', upd.length, 'on', new Set(upd.map((x) => x.d)).size, 'dates');
await query(`CREATE TABLE IF NOT EXISTS level_prices_pass4_backup_20261027 AS SELECT * FROM level_prices WHERE false`);
const keys = upd.map((x) => `('${x.d}','${x.n}')`).join(','); const have = (await query(`SELECT COUNT(*)::int n FROM level_prices_pass4_backup_20261027`)).rows[0].n;
if (!have && upd.length) await query(`INSERT INTO level_prices_pass4_backup_20261027 SELECT * FROM level_prices WHERE (trade_date::text, level_name) IN (${keys})`);
let n = 0; for (const x of upd) { const r = await query(`UPDATE level_prices SET price=$3 WHERE trade_date=$1 AND level_name=$2`, [x.d, x.n, x.to]); n += r.rowCount; }
console.log('updated', n, '; backup rows', (await query(`SELECT COUNT(*)::int n FROM level_prices_pass4_backup_20261027`)).rows[0].n);
// consistency: PY must be constant within a calendar year
const py = (await query(`SELECT EXTRACT(year FROM trade_date)::int y, level_name n, COUNT(DISTINCT price)::int k FROM level_prices WHERE level_name LIKE 'PY\\_%' GROUP BY 1,2 ORDER BY 1,2`)).rows; console.log('distinct PY values per year and level (want 1):', py.map((r) => `${r.y} ${r.n}:${r.k}`).join(' | '));
process.exit(0);
