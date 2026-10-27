// Audit of the bar-derived session tables against price_bars_primary RTH bars (09:30-15:59 ET): developing_value_log (session_high/low/close) and acd_daily_log (session_close). A row that disagrees was
// computed from different bars than the ones now in price_bars_primary (an old contract calendar, a later bar repair). Read-only; lists mismatching dates (|diff| > 0.3 point).
import fs from 'fs';
import { query } from '../server/db.js';
const act = new Map(); for (const r of (await query(`SELECT d, h, l, (SELECT close::float FROM price_bars_primary p2 WHERE p2.symbol='NQ' AND p2.ts::date = b.d AND EXTRACT(hour FROM p2.ts)*60+EXTRACT(minute FROM p2.ts) BETWEEN 570 AND 959 ORDER BY p2.ts DESC LIMIT 1) c FROM (SELECT ts::date d, MAX(high)::float h, MIN(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 GROUP BY 1) b`)).rows) act.set(r.d.toISOString ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10), r);
const dvl = (await query(`SELECT trade_date::text d, session_high::float h, session_low::float l, session_close::float c FROM developing_value_log WHERE trade_date >= '2023-03-06' ORDER BY 1`)).rows, acd = (await query(`SELECT trade_date::text d, session_close::float c FROM acd_daily_log WHERE trade_date >= '2023-03-06' ORDER BY 1`)).rows;
const key = (d) => d.slice(0, 10), badD = [], badA = [];
for (const r of dvl) { const a = act.get(key(r.d)); if (!a) continue; const bad = Math.abs(r.h - a.h) > 0.3 || Math.abs(r.l - a.l) > 0.3 || Math.abs(r.c - a.c) > 0.3; if (bad) badD.push({ d: r.d, stored: [r.h, r.l, r.c], real: [a.h, a.l, a.c] }); }
for (const r of acd) { const a = act.get(key(r.d)); if (!a || r.c == null) continue; if (Math.abs(r.c - a.c) > 0.3) badA.push({ d: r.d, stored: r.c, real: a.c }); }
console.log(`developing_value_log: ${dvl.length} rows, ${badD.length} disagree with the RTH bars:`, badD.slice(0, 8).map((x) => `${x.d} [${x.stored.join('/')}] vs [${x.real.join('/')}]`).join(' | '));
console.log(`acd_daily_log session_close: ${acd.length} rows, ${badA.length} disagree:`, badA.slice(0, 8).map((x) => `${x.d} ${x.stored} vs ${x.real}`).join(' | '));
const badPD = JSON.parse(fs.readFileSync('scratch/level_bad_dates_20261027.json')).PD; const prior = (d) => { const ds = [...act.keys()].sort(); let lo = 0, hi = ds.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ds[m] < d) lo = m + 1; else hi = m; } return ds[lo - 1]; };
const dvlBad = new Set(badD.map((x) => key(x.d))), priorOfBad = badPD.map(prior); console.log(`the ${badPD.length} still-bad prior-day dates: their prior day is a mismatching dvl row for ${priorOfBad.filter((d) => dvlBad.has(d)).length} of them`);
fs.writeFileSync('scratch/dvl_bad_dates_20261027.json', JSON.stringify({ dvl: badD.map((x) => key(x.d)), acd: badA.map((x) => key(x.d)) }));
process.exit(0);
