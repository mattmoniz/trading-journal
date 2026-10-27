// Flags active_setups rows whose own entry rested on a level that the 2026-10-25..27 repairs later proved wrong (docs/OPEN_THREADS.md 2026-10-27; convention:
// docs/CONVENTIONS_DETAIL.md "flag-and-preserve a boolean basis column"). Never deletes or edits a row, only sets stale_levels_basis = true.
// Evidence per row, no date-wide blanket: (1) LEVEL FADES: the setup_type names its level; the row is flagged only if that level's price on the row's trade_date changed by more than 0.5 points
// AND the row's entry (entry_zone_low) lies closer to the OLD value than to the corrected one (a row that fired on the correct value stays clean, e.g. a live row fired before a later stale rewrite).
// (2) VWAP: BACKFILL rows of WEEKLY_VWAP/MONTHLY_VWAP fade types (the backfill used the day-included VWAP, a lookahead; live rows used as-of-open and stay clean).
// (3) ACD family (A/C signals, TRT): rows on a date whose stored A/C flags were recomputed (the flags are what the setup keys on).
// Old values: level_prices_repair_backup_20261027 (state before the 10-27 repairs); ONH/ONL: level_prices_onh_onl_calendar_window_backup_20261026 (before the 10-25/26 fix).
// Usage: node scripts/flag_stale_levels_basis_20261027.mjs           (dry run: counts and examples only)
//        node scripts/flag_stale_levels_basis_20261027.mjs --apply   (adds the column, backs up the flagged ids, sets the flag)
import fs from 'fs';
import { query } from '../server/db.js';
const APPLY = process.argv.includes('--apply');
const diffRows = (await query(`
  SELECT c.trade_date::text d, c.level_name n, c.price::float nw, COALESCE(o2.price, o.price)::float od
  FROM level_prices c
  JOIN level_prices_repair_backup_20261027 o ON o.trade_date = c.trade_date AND o.level_name = c.level_name
  LEFT JOIN level_prices_onh_onl_calendar_window_backup_20261026 o2 ON o2.trade_date = c.trade_date AND o2.level_name = c.level_name
  WHERE c.level_name NOT IN ('WEEKLY_VWAP','MONTHLY_VWAP','RTH_VWAP') AND ABS(COALESCE(o2.price, o.price) - c.price) > 0.5`)).rows;
const diffByDate = new Map(); for (const r of diffRows) { let m = diffByDate.get(r.d); if (!m) diffByDate.set(r.d, (m = new Map())); m.set(r.n, r); }
const names = [...new Set(diffRows.map((r) => r.n))].sort((a, b) => b.length - a.length);
const cands = (type, changed) => { const out = []; for (const [n, r] of changed) { const base = n.replace(/\d+$/, ''); if (type.startsWith(n + '_') || (base !== n && type.startsWith(base + '_'))) out.push(r); } return out; };
const dates = [...diffByDate.keys()];
const rows = (await query(`SELECT id, setup_type t, trade_date::text d, entry_zone_low::float e, origin_status o, is_cluster_primary prim FROM active_setups WHERE trade_date = ANY($1::date[]) AND entry_zone_low IS NOT NULL`, [dates])).rows;
const flagged = new Map(); for (const r of rows) { const c = cands(r.t, diffByDate.get(r.d)); if (c.some((x) => Math.abs(r.e - x.od) < Math.abs(r.e - x.nw))) flagged.set(r.id, { rule: 'level', ...r }); }
const vw = (await query(`SELECT id, setup_type t, trade_date::text d, origin_status o, is_cluster_primary prim FROM active_setups WHERE origin_status='BACKFILL' AND setup_type ~ '^(WEEKLY|MONTHLY)_VWAP_FADE'`)).rows; for (const r of vw) flagged.set(r.id, { rule: 'vwap', ...r });
const ACD = /^(A_UP_STRONG|A_DOWN_WEAK|C_PAIRED_|C_REVERSAL_|C_STANDALONE_|TRT_)/;
const acdChanged = new Set((await query(`SELECT a.trade_date::text d FROM acd_daily_log a JOIN acd_daily_log_fired_repair_backup_20261027 b ON b.trade_date = a.trade_date WHERE a.a_up_fired IS DISTINCT FROM b.a_up_fired OR a.a_down_fired IS DISTINCT FROM b.a_down_fired OR a.c_up_confirmed IS DISTINCT FROM b.c_up_confirmed OR a.c_down_confirmed IS DISTINCT FROM b.c_down_confirmed`)).rows.map((r) => r.d));
const ac = (await query(`SELECT id, setup_type t, trade_date::text d, origin_status o, is_cluster_primary prim FROM active_setups WHERE trade_date = ANY($1::date[])`, [[...acdChanged]])).rows; for (const r of ac) if (ACD.test(r.t)) flagged.set(r.id, { rule: flagged.get(r.id)?.rule || 'acd', ...r });
const tally = {}; for (const f of flagged.values()) { const k = `${f.rule}/${f.o}/${f.prim === false ? 'sibling' : 'primary'}`; tally[k] = (tally[k] || 0) + 1; }
console.log(`level diffs ${diffRows.length} on ${dates.length} dates, names ${names.length}; ACD dates with changed flags ${acdChanged.size}; rows scanned ${rows.length}`); console.log('FLAGGED', flagged.size, JSON.stringify(tally, null, 0));
const real = [...flagged.values()].filter((f) => (f.o === 'ACTIVE' || f.o === 'SHADOW') && f.prim !== false); const byType = {}; for (const f of real) byType[f.t] = (byType[f.t] || 0) + 1; console.log('real primary (ACTIVE+SHADOW) flagged', real.length, 'of which ACTIVE', real.filter((f) => f.o === 'ACTIVE').length, '| top types', JSON.stringify(Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 10)));
fs.writeFileSync('scratch/stale_levels_flagged_20261027.json', JSON.stringify([...flagged.values()].map((f) => ({ id: f.id, rule: f.rule, t: f.t, d: f.d, o: f.o, prim: f.prim })))); 
if (APPLY) { await query(`ALTER TABLE active_setups ADD COLUMN IF NOT EXISTS stale_levels_basis boolean`); await query(`CREATE TABLE IF NOT EXISTS active_setups_stale_levels_flag_backup_20261027 (id integer PRIMARY KEY, rule text, flagged_at timestamp DEFAULT NOW())`);
  const ids = [...flagged.keys()]; for (let i = 0; i < ids.length; i += 500) { const part = ids.slice(i, i + 500); await query(`INSERT INTO active_setups_stale_levels_flag_backup_20261027 (id, rule) SELECT id, 'x' FROM unnest($1::int[]) AS id ON CONFLICT DO NOTHING`, [part]); await query(`UPDATE active_setups SET stale_levels_basis = true WHERE id = ANY($1::int[])`, [part]); }
  console.log('applied:', (await query(`SELECT COUNT(*)::int n FROM active_setups WHERE stale_levels_basis IS TRUE`)).rows[0].n, 'rows flagged'); }
process.exit(0);
