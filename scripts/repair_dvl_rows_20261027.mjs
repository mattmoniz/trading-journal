// Repairs developing_value_log rows that disagree with the RTH bars (scripts/audit_dvl_acd_vs_bars_20261027.mjs -> scratch/dvl_bad_dates_20261027.json) with the PRODUCTION function
// computeAndPersistSession(date) (server/services/developingValueService.js), in chronological order, each bad date and the next dvl date (its "vs prior" fields depend on the bad row).
// Skipped on purpose: 2026-07-03 and 2026-09-07 (holiday half-days: high/low match, only the close definition differs). Backup first: developing_value_log_repair_backup_20261027.
// Writes scratch/level_recompute_dates_2_20261027.txt = the next trading date after each repaired row (their PD levels read it) for the compute_levels rerun.
import fs from 'fs';
import { query } from '../server/db.js';
import { computeAndPersistSession } from '../server/services/developingValueService.js';
await query(`CREATE TABLE IF NOT EXISTS developing_value_log_repair_backup_20261027 AS SELECT * FROM developing_value_log`);
const bad = JSON.parse(fs.readFileSync('scratch/dvl_bad_dates_20261027.json')).dvl.filter((d) => d !== '2026-07-03' && d !== '2026-09-07');
const all = (await query(`SELECT trade_date::text d FROM developing_value_log ORDER BY 1`)).rows.map((r) => r.d), nextOf = (d) => { const i = all.indexOf(d); return i >= 0 ? all[i + 1] : null; };
const todo = [...new Set([...bad, ...bad.map(nextOf).filter(Boolean)])].sort(); const before = new Map((await query(`SELECT trade_date::text d, session_high::float h, session_low::float l, session_close::float c, poc::float poc FROM developing_value_log`)).rows.map((r) => [r.d, r]));
let ok = 0, nul = 0, changed = 0; const levelDates = new Set();
for (const d of todo) { try { const r = await computeAndPersistSession(d); if (!r) { nul++; console.log(d, 'function returned null (fewer than 60 bars): row left as is'); continue; } ok++; const b = before.get(d); if (b && (Math.abs(b.h - r.sessionHigh) > 0.3 || Math.abs(b.l - r.sessionLow) > 0.3 || Math.abs(b.c - r.sessionClose) > 0.3 || Math.abs(b.poc - r.poc) > 0.3)) changed++; const n = nextOf(d); if (n) levelDates.add(n); } catch (e) { console.log(d, 'ERROR', e.message); } }
fs.writeFileSync('scratch/level_recompute_dates_2_20261027.txt', [...levelDates].sort().join('\n') + '\n');
console.log(`dvl rows recomputed ${ok} of ${todo.length} (null ${nul}), rows whose values changed ${changed}; next-day level dates to recompute: ${levelDates.size}`);
process.exit(0);
