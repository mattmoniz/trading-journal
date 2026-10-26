// Stored level_prices (bar-spread allocation, RTH) vs the SAME definitions rebuilt from real tick volume (volume_at_price_daily, RTH column).
// Definitions copied from scripts/compute_levels.js: PD = prior business day with RTH bars; PW = prior Mon-Fri week; PM = prior calendar month; 3M = (date - 3 calendar months) .. (date - 1).
// A level is compared only if the tick table covers at least 97 percent of the period's RTH trading days. Output: per family and statistic the distribution of |tick - stored| in points.
import fs from 'fs';
import { query } from '../server/db.js';
import { loadTick } from './lib/tickLevelFamilies.mjs';
const { families } = await loadTick();
const stored = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE level_name ~ '^(PD|PW|PM|3M)_(VAH|VAL|POC)$'`)).rows) { let m = stored.get(r.d); if (!m) stored.set(r.d, (m = {})); m[r.n] = r.p; }
const res = { PD: [], PW: [], PM: [], '3M': [] };
for (const [d, st] of [...stored].sort()) {
  const defs = families;
  for (const fam of Object.keys(defs)) { if (st[`${fam}_POC`] == null) continue; const t = defs[fam](d); if (!t) continue; res[fam].push({ d, poc: t.poc - st[`${fam}_POC`], vah: t.vah - st[`${fam}_VAH`], val: t.val - st[`${fam}_VAL`] }); }
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const lines = [`Stored vs tick-volume levels (RTH, same definitions), |tick - stored| in points. Dates compared per family: ${Object.entries(res).map(([k, v]) => k + ' ' + v.length).join(', ')}`];
for (const fam of Object.keys(res)) for (const st of ['poc', 'vah', 'val']) { const a = res[fam].map((x) => Math.abs(x[st])); if (!a.length) continue; lines.push(`${fam.padEnd(3)} ${st.toUpperCase()} n=${String(a.length).padStart(4)} median ${q(a, 0.5).toFixed(1).padStart(6)}  p90 ${q(a, 0.9).toFixed(1).padStart(7)}  max ${Math.max(...a).toFixed(0).padStart(5)}  share >25pt ${(100 * a.filter((x) => x > 25).length / a.length).toFixed(0)}%  >100pt ${(100 * a.filter((x) => x > 100).length / a.length).toFixed(0)}%`); }
console.log(lines.join('\n')); fs.writeFileSync('reports/stored_vs_tick_levels_20261026.txt', lines.join('\n') + '\n');
const last = res['3M'].slice(-1)[0]; console.log('latest 3M comparison', last);
process.exit(0);
