// A1.1 check (docs/VACUUM_CONTEXT_EXIT_PREREG_20261109.md): the 500V-bar extension numerator vs the same quantity from the minute table. Naive ET strings built by arithmetic only (no timezone conversion, cv-074).
import fs from 'fs';
import { query } from '../../server/db.js';
const S = JSON.parse(fs.readFileSync(new URL('../../scratch/vacuum_sim_20261108/context_exit_phase1_sample.json', import.meta.url)));
const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const diffs = [], rel = []; let miss = 0;
for (const x of S) {
  const [y, m, d] = x.date.split('-').map(Number); const start = Date.UTC(y, m - 1, d - 1, 18, 0, 0);
  const t1 = Math.floor((start + x.t * 1000) / 60000) * 60000, t0 = Math.floor((start + (x.t - 14400) * 1000) / 60000) * 60000;
  const q = async (ms) => (await query(`SELECT close::float AS c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp ORDER BY ts LIMIT 1`, [fmt(ms), fmt(ms + 60000)])).rows[0]?.c;
  const c1 = await q(t1), c0 = await q(t0);
  if (c1 == null || c0 == null) { miss++; continue; }
  const bar = x.E * x.adr, min = x.dir * (c1 - c0);
  diffs.push(Math.abs(bar - min)); rel.push(Math.abs(bar - min) / x.adr);
}
const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
const q9 = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length * 0.9)]; };
console.log(`sample ${S.length}, matched ${diffs.length}, missing minute bars ${miss}; |bar-based minus minute-table| numerator: median ${med(diffs).toFixed(2)} pt, p90 ${q9(diffs).toFixed(2)} pt; in ADR20 units median ${med(rel).toFixed(4)}, p90 ${q9(rel).toFixed(4)}`);
process.exit(0);
