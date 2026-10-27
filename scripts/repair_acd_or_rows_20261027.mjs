// Repairs acd_daily_log opening-range rows (or_high, or_low, a_up_level, a_down_level) that disagree with the 5-minute opening range of the current bars (the definition 863 of 914 rows follow), with the PRODUCTION
// computeORLevelsOnly(date, aMultiplier, { overwrite: true }) (server/services/acdService.js), the same call the 2026-10-05 rebuild used. Backup first: acd_daily_log_repair_backup_20261027.
// NOT repaired (reported): a_up_fired/a_down_fired/times, c_*_confirmed, daily_score, day_type, profile_shape and acd_setup_events on those dates were computed against the old prices.
import fs from 'fs';
import { query } from '../server/db.js';
import { computeORLevelsOnly } from '../server/services/acdService.js';
await query(`CREATE TABLE IF NOT EXISTS acd_daily_log_repair_backup_20261027 AS SELECT * FROM acd_daily_log`);
const rows = (await query(`SELECT a.trade_date::text d, a.or_high::float h, a.or_low::float l, a.a_multiplier::float m, a.a_up_fired, a.a_down_fired, a.day_type, o.h bh, o.l bl FROM acd_daily_log a JOIN (SELECT ts::date d, MAX(high)::float h, MIN(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 574 GROUP BY 1) o ON o.d = a.trade_date WHERE a.or_high IS NOT NULL ORDER BY 1`)).rows;
const bad = rows.filter((r) => Math.abs(r.h - r.bh) > 0.3 || Math.abs(r.l - r.bl) > 0.3); console.log(`rows ${rows.length}, opening range disagrees with the 5-minute bars on ${bad.length}`);
let fixed = 0; for (const r of bad) { const res = await computeORLevelsOnly(r.d, r.m, { overwrite: true }); if (res && Math.abs(res.orHigh - r.bh) < 0.01 && Math.abs(res.orLow - r.bl) < 0.01) fixed++; else console.log(r.d, 'not fixed', res); }
const after = (await query(`SELECT COUNT(*)::int n FROM acd_daily_log a JOIN (SELECT ts::date d, MAX(high)::float h, MIN(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 574 GROUP BY 1) o ON o.d = a.trade_date WHERE ABS(a.or_high - o.h) > 0.3 OR ABS(a.or_low - o.l) > 0.3`)).rows[0].n;
console.log(`repaired ${fixed} of ${bad.length}; rows still disagreeing: ${after}`);
console.log(`on the repaired dates: a_up_fired ${bad.filter((r) => r.a_up_fired).length}, a_down_fired ${bad.filter((r) => r.a_down_fired).length}, day_type set ${bad.filter((r) => r.day_type).length} (computed against the old prices; not changed)`);
fs.writeFileSync('scratch/acd_or_repaired_dates_20261027.json', JSON.stringify(bad.map((r) => r.d)));
process.exit(0);
