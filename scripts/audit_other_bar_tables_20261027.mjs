// Audit of the other bar-derived tables against price_bars_primary (read-only): acd_monthly_pivot (prior month RTH high/low/close), acd_daily_log (opening range: tests the 5/10/15/30-minute definitions and
// reports which one the table follows, then the share of rows that disagree with it), acd_weekly_log (week close, opening-range of the first day), session_analysis (session high/low).
import { query } from '../server/db.js';
const rth = `EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`;
const q = async (s, p) => (await query(s, p)).rows;
// monthly pivot
const mp = await q(`SELECT month_year::text m, prior_month_high::float h, prior_month_low::float l, prior_month_close::float c FROM acd_monthly_pivot ORDER BY 1`);
let bad = []; for (const r of mp) { const mo = r.m.slice(0, 7); const [y, mm] = mo.split('-').map(Number); const py = mm === 1 ? y - 1 : y, pm = mm === 1 ? 12 : mm - 1, a = `${py}-${String(pm).padStart(2, '0')}-01`, b = new Date(Date.UTC(py, pm, 0)).toISOString().slice(0, 10);
  const x = (await q(`SELECT MAX(high)::float h, MIN(low)::float l, (array_agg(close ORDER BY ts DESC))[1]::float c FROM price_bars_primary WHERE symbol='NQ' AND ts::date BETWEEN $1 AND $2 AND ${rth}`, [a, b]))[0]; if (!x.h) continue;
  if (Math.abs(r.h - x.h) > 0.3 || Math.abs(r.l - x.l) > 0.3 || Math.abs(r.c - x.c) > 0.3) bad.push(`${r.m} [${r.h}/${r.l}/${r.c}] vs [${x.h}/${x.l}/${x.c}]`); }
console.log(`acd_monthly_pivot: ${mp.length} rows, ${bad.length} disagree with the prior month's RTH bars`, bad.slice(0, 6).join(' | '));
// opening range definition
const acd = await q(`SELECT trade_date::text d, or_high::float h, or_low::float l, session_close::float c FROM acd_daily_log WHERE or_high IS NOT NULL ORDER BY 1`);
const win = { 5: 574, 10: 579, 15: 584, 30: 599 }, hit = { 5: 0, 10: 0, 15: 0, 30: 0 }, orBars = new Map();
for (const [k, end] of Object.entries(win)) for (const r of await q(`SELECT ts::date::text d, MAX(high)::float h, MIN(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND ${end} GROUP BY 1`)) orBars.set(k + '|' + r.d, r);
for (const r of acd) for (const k of Object.keys(win)) { const x = orBars.get(k + '|' + r.d); if (x && Math.abs(r.h - x.h) <= 0.3 && Math.abs(r.l - x.l) <= 0.3) hit[k]++; }
console.log(`acd_daily_log opening range: rows ${acd.length}; exact matches to the 5/10/15/30-minute definitions:`, JSON.stringify(hit));
const best = Object.entries(hit).sort((a, b) => b[1] - a[1])[0][0]; const off = acd.filter((r) => { const x = orBars.get(best + '|' + r.d); return x && (Math.abs(r.h - x.h) > 0.3 || Math.abs(r.l - x.l) > 0.3); });
console.log(`  closest definition ${best}-minute: ${off.length} rows disagree; first:`, off.slice(0, 6).map((r) => `${r.d} [${r.h}/${r.l}] vs [${orBars.get(best + '|' + r.d).h}/${orBars.get(best + '|' + r.d).l}]`).join(' | '));
const byMonth = {}; for (const r of off) byMonth[r.d.slice(0, 7)] = (byMonth[r.d.slice(0, 7)] || 0) + 1; console.log('  by month:', JSON.stringify(byMonth));
// session analysis
const sa = await q(`SELECT trade_date::text d, session_type t, session_high::float h, session_low::float l FROM session_analysis ORDER BY 1`); const types = {}; for (const r of sa) types[r.t] = (types[r.t] || 0) + 1; console.log('session_analysis rows', sa.length, JSON.stringify(types));
let sbad = 0, sn = 0, samples = []; for (const r of sa) { const x = (await q(`SELECT MAX(high)::float h, MIN(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND ${rth}`, [r.d]))[0]; if (!x.h || !/rth|day/i.test(String(r.t))) continue; sn++; if (Math.abs(r.h - x.h) > 0.3 || Math.abs(r.l - x.l) > 0.3) { sbad++; samples.push(`${r.d} [${r.h}/${r.l}] vs [${x.h}/${x.l}]`); } }
console.log(`session_analysis (RTH-type rows checked ${sn}): ${sbad} disagree`, samples.slice(0, 5).join(' | '));
process.exit(0);
