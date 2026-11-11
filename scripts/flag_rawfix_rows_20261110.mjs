// Flags (never deletes, cv-001 / cv-041) the active_setups rows whose stored outcomes were computed from the contaminated NQ minute bars repaired on 2026-11-10
// (docs/NQ_RAW_BAR_REPAIR_20261110.md): rows fired on 2025-05-29..2025-08-25 and on 2026-04-28/29. bad_bars_basis = TRUE keeps them out of REAL_TRADE_FILTER stats.
// Stops (nothing written) if any ACTIVE or SHADOW row would be touched. Dry run by default; --write backs up (id + old flag) first.
import { getClient, query } from '../server/db.js';
const WRITE = process.argv.includes('--write');
const BACKUP = 'active_setups_rawfix_flag_backup_20261110';
const WHERE = `((fired_at::date BETWEEN '2025-05-29' AND '2025-08-25') OR fired_at::date IN ('2026-04-28','2026-04-29')) AND bad_bars_basis IS DISTINCT FROM TRUE`;
const by = (await query(`SELECT origin_status, coalesce(resolution_method,'-') rm, count(*)::int n FROM active_setups WHERE ${WHERE} GROUP BY 1,2 ORDER BY 1,2`)).rows;
console.table(by);
const tot = by.reduce((s, r) => s + r.n, 0), real = by.filter(r => r.origin_status === 'ACTIVE' || r.origin_status === 'SHADOW').reduce((s, r) => s + r.n, 0);
console.log(`rows to flag: ${tot}; ACTIVE/SHADOW among them: ${real}`);
if (real) { console.error('STOP: ACTIVE/SHADOW rows would be touched -- report instead of flagging'); process.exit(2); }
if (!WRITE) { console.log('Dry run only. Re-run with --write.'); process.exit(0); }
if ((await query(`SELECT to_regclass($1) t`, [BACKUP])).rows[0].t) { console.error(`${BACKUP} exists -- refusing`); process.exit(1); }
const c = await getClient();
try {
  await c.query('BEGIN');
  await c.query(`CREATE TABLE ${BACKUP} AS SELECT id, bad_bars_basis AS old_bad_bars_basis, origin_status, fired_at FROM active_setups WHERE ${WHERE}`);
  const b = (await c.query(`SELECT count(*)::int n FROM ${BACKUP}`)).rows[0].n; if (b !== tot) throw new Error(`backup ${b} != ${tot}`);
  const u = await c.query(`UPDATE active_setups SET bad_bars_basis = TRUE WHERE id IN (SELECT id FROM ${BACKUP})`); if (u.rowCount !== tot) throw new Error(`updated ${u.rowCount} != ${tot}`);
  await c.query('COMMIT'); console.log(`COMMIT ok: flagged ${u.rowCount}, backup ${BACKUP} (${b} rows; undo = set bad_bars_basis back to old_bad_bars_basis by id)`);
} catch (e) { await c.query('ROLLBACK'); console.error('ROLLED BACK:', e.message); process.exit(1); }
process.exit(0);
