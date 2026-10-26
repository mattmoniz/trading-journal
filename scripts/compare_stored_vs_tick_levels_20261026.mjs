// Stored level_prices (bar-spread allocation, RTH) vs the SAME definitions rebuilt from real tick volume (volume_at_price_daily, RTH column).
// Definitions copied from scripts/compute_levels.js: PD = prior business day with RTH bars; PW = prior Mon-Fri week; PM = prior calendar month; 3M = (date - 3 calendar months) .. (date - 1).
// A level is compared only if the tick table covers at least 97 percent of the period's RTH trading days. Output: per family and statistic the distribution of |tick - stored| in points.
import fs from 'fs';
import { query } from '../server/db.js';
import { profileFromRows } from '../server/services/tickVolumeProfile.js';
const vap = new Map(); // date -> Map(priceKey -> rthVol)
for (const r of (await query(`SELECT trade_date::text d, (price*4)::int k, vol_rth v FROM volume_at_price_daily WHERE vol_rth > 0`)).rows) { let m = vap.get(r.d); if (!m) vap.set(r.d, (m = new Map())); m.set(r.k, r.v); }
const rthDays = (await query(`SELECT DISTINCT ts::date::text d FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY 1`)).rows.map((r) => r.d);
const stored = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE level_name ~ '^(PD|PW|PM|3M)_(VAH|VAL|POC)$'`)).rows) { let m = stored.get(r.d); if (!m) stored.set(r.d, (m = {})); m[r.n] = r.p; }
const add = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonths = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
function profile(a, b) {
  const days = rthDays.filter((d) => d >= a && d <= b); if (!days.length) return null; let have = 0; const acc = new Map();
  for (const d of days) { const m = vap.get(d); if (!m) continue; have++; for (const [k, v] of m) acc.set(k, (acc.get(k) || 0) + v); }
  if (have / days.length < 0.97) return null;
  return profileFromRows([...acc].map(([k, v]) => ({ price: k / 4, vol: v })));
}
const prior = (d) => { let lo = 0, hi = rthDays.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rthDays[m] < d) lo = m + 1; else hi = m; } return lo ? rthDays[lo - 1] : null; };
const weekBounds = (s) => { const d = new Date(s + 'T12:00:00Z'), dow = d.getUTCDay(), back = dow === 0 ? 6 : dow - 1; const mon = add(s, -back); return [mon, add(mon, 4)]; };
const monthBounds = (s) => { const d = new Date(s + 'T12:00:00Z'); return [new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10), new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)]; };
const res = { PD: [], PW: [], PM: [], '3M': [] };
for (const [d, st] of [...stored].sort()) {
  const defs = { PD: () => { const p = prior(d); return p && profile(p, p); }, PW: () => { const [mo, fr] = weekBounds(d); return profile(add(mo, -7), add(fr, -7)); }, PM: () => { const [a, b] = monthBounds(addMonths(d, -1)); return profile(a, b); }, '3M': () => profile(addMonths(d, -3), add(d, -1)) };
  for (const fam of Object.keys(defs)) { if (st[`${fam}_POC`] == null) continue; const t = defs[fam](); if (!t) continue; res[fam].push({ d, poc: t.poc - st[`${fam}_POC`], vah: t.vah - st[`${fam}_VAH`], val: t.val - st[`${fam}_VAL`] }); }
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const lines = [`Stored vs tick-volume levels (RTH, same definitions), |tick - stored| in points. Dates compared per family: ${Object.entries(res).map(([k, v]) => k + ' ' + v.length).join(', ')}`];
for (const fam of Object.keys(res)) for (const st of ['poc', 'vah', 'val']) { const a = res[fam].map((x) => Math.abs(x[st])); if (!a.length) continue; lines.push(`${fam.padEnd(3)} ${st.toUpperCase()} n=${String(a.length).padStart(4)} median ${q(a, 0.5).toFixed(1).padStart(6)}  p90 ${q(a, 0.9).toFixed(1).padStart(7)}  max ${Math.max(...a).toFixed(0).padStart(5)}  share >25pt ${(100 * a.filter((x) => x > 25).length / a.length).toFixed(0)}%  >100pt ${(100 * a.filter((x) => x > 100).length / a.length).toFixed(0)}%`); }
console.log(lines.join('\n')); fs.writeFileSync('reports/stored_vs_tick_levels_20261026.txt', lines.join('\n') + '\n');
const last = res['3M'].slice(-1)[0]; console.log('latest 3M comparison', last);
process.exit(0);
