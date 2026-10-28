// Independent reference: runs the REAL developingValueService.computeProfile() (the codebase's single
// volume-profile implementation) over the exact same RTH bars loader.py reads, and writes each
// session's own VAH/VAL/POC to a JSON file. run_audit.py compares loader.compute_va_fn against it.
// Usage: node crosscheck_va_node.mjs <out.json> [start] [endExclusive]
import fs from 'fs';
import { query } from '../../server/db.js';
import { computeProfile } from '../../server/services/developingValueService.js';

const out = process.argv[2];
const start = process.argv[3] || '2023-01-01';
const end = process.argv[4] || '2026-10-27';
const res = {};
let s = new Date(start + 'T00:00:00Z');
const e = new Date(end + 'T00:00:00Z');
while (s < e) {
  const n = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
  const hi = n < e ? n : e;
  const iso = d => d.toISOString().slice(0, 10);
  const r = await query(`
    SELECT to_char(ts,'YYYY-MM-DD') AS d, high::float AS high, low::float AS low, volume::float AS volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1 AND ts < $2 AND ts::time >= '09:30' AND ts::time < '16:00'
    ORDER BY ts`, [iso(s), iso(hi)]);
  const byDay = {};
  for (const row of r.rows) (byDay[row.d] ||= []).push(row);
  for (const [d, bars] of Object.entries(byDay)) {
    const p = computeProfile(bars);
    res[d] = p ? { vah: p.vah, val: p.val, poc: p.poc } : null;
  }
  s = n;
}
fs.writeFileSync(out, JSON.stringify(res));
console.log(`wrote ${Object.keys(res).length} sessions to ${out}`);
process.exit(0);
