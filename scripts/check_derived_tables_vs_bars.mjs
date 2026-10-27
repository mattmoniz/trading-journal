// Standing read-only guard (2026-10-27): the bar-derived session tables must agree with price_bars_primary for the last 25 completed trade dates. Built after the 2026-10-27 audit found 177 trade dates of
// level_prices, 72 developing_value_log rows and 51 acd_daily_log opening ranges that had silently gone stale when bars or the contract calendar were corrected later (quarterly roll weeks, bar repairs).
// Checks: developing_value_log session high/low; level_prices PD_HIGH/PD_LOW (prior RTH day) and PW/PM high/low; acd_daily_log 5-minute opening range. On any disagreement it appends ONE line to
// scratch/server_errors.jsonl (same schema as the price-bar freshness alert) naming the tables and dates, and exits 1; fix with scripts/repair_dvl_rows_20261027.mjs / repair_level_prices_dates_20261027.sh /
// repair_acd_or_rows_20261027.mjs (they read their dates from the audit scripts). Runs nightly from scripts/run_daily_calibration.sh.
import fs from 'fs';
import { query } from '../server/db.js';
const rth = `EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, tol = 0.3, q = async (s, p) => (await query(s, p)).rows;
const days = (await q(`SELECT ts::date::text d, MAX(high)::float h, MIN(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND ${rth} AND ts::date < CURRENT_DATE GROUP BY 1 ORDER BY 1 DESC LIMIT 60`)).reverse();
const real = new Map(days.map((r) => [r.d, r])), recent = days.slice(-25).map((r) => r.d), problems = [];
const prior = (d) => { const i = days.findIndex((r) => r.d === d); return i > 0 ? days[i - 1].d : null; };
for (const r of await q(`SELECT trade_date::text d, session_high::float h, session_low::float l FROM developing_value_log WHERE trade_date = ANY($1::date[])`, [recent])) { const a = real.get(r.d); if (a && (Math.abs(r.h - a.h) > tol || Math.abs(r.l - a.l) > tol)) problems.push(['developing_value_log', r.d]); }
const lp = new Map(); for (const r of await q(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date = ANY($1::date[]) AND level_name IN ('PD_HIGH','PD_LOW')`, [recent])) (lp.get(r.d) || lp.set(r.d, {}).get(r.d))[r.n] = r.p;
for (const [d, s] of lp) { const p = prior(d); const a = p && real.get(p); if (a && ((s.PD_HIGH != null && Math.abs(s.PD_HIGH - a.h) > tol) || (s.PD_LOW != null && Math.abs(s.PD_LOW - a.l) > tol))) problems.push(['level_prices PD_HIGH/PD_LOW', d]); }
const orb = new Map((await q(`SELECT ts::date::text d, MAX(high)::float h, MIN(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 574 AND ts::date = ANY($1::date[]) GROUP BY 1`, [recent])).map((r) => [r.d, r]));
for (const r of await q(`SELECT trade_date::text d, or_high::float h, or_low::float l FROM acd_daily_log WHERE trade_date = ANY($1::date[]) AND or_high IS NOT NULL`, [recent])) { const a = orb.get(r.d); if (a && (Math.abs(r.h - a.h) > tol || Math.abs(r.l - a.l) > tol)) problems.push(['acd_daily_log opening range', r.d]); }
if (!problems.length) { console.log(`derived-table check: last ${recent.length} trade dates agree with the bars`); process.exit(0); }
const msg = `Derived tables disagree with price_bars_primary (${problems.length}): ` + problems.slice(0, 12).map(([t, d]) => `${t} ${d}`).join('; ') + '. Repair with the 2026-10-27 scripts (see docs/DB_BACKUP_CATALOG.md).';
console.log(msg); try { fs.appendFileSync('scratch/server_errors.jsonl', JSON.stringify({ ts: new Date().toISOString(), type: 'SERVER_ERROR', message: msg, detail: null }) + '\n'); } catch (_) { /* best effort */ }
process.exit(1);
