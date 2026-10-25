// One-time repair of level_prices ONH/ONL (OPEN_DECISION onh_onl_levels_monday_sunday_and_0800_snapshot_20261026): recompute each row's overnight high/low from the bars over the TRUE
// Globex window (18:00 on the prior CALENDAR day .. 09:29 on the trade date) and update only rows that differ. Backup: level_prices_onh_onl_calendar_window_backup_20261026 (all ONH/ONL rows).
//   node scripts/repair_onh_onl_calendar_window_20261026.mjs           dry run (prints the summary, writes nothing)
//   node scripts/repair_onh_onl_calendar_window_20261026.mjs --apply   backup + update + read-back verification
import { query } from '../server/db.js';
const APPLY = process.argv.includes('--apply'), MIN_BARS = 60, BACKUP = 'level_prices_onh_onl_calendar_window_backup_20261026';
const dates = (await query(`SELECT DISTINCT trade_date::text d, EXTRACT(dow FROM trade_date)::int dow FROM level_prices WHERE level_name='ONH' ORDER BY d`)).rows;
const todo = [], skipped = []; const byDow = {};
for (const x of dates) {
  const r = (await query(`SELECT max(high)::float h, min(low)::float l, count(*)::int n FROM price_bars_primary WHERE symbol='NQ' AND ts >= ($1::date - 1)::timestamp + interval '18 hours' AND ts < $1::date + interval '9 hours 30 minutes'`, [x.d])).rows[0];
  if (r.n < MIN_BARS) { skipped.push({ d: x.d, bars: r.n }); continue; }
  const cur = Object.fromEntries((await query(`SELECT level_name, price::float p FROM level_prices WHERE trade_date=$1 AND level_name IN ('ONH','ONL')`, [x.d])).rows.map((q) => [q.level_name, q.p]));
  const dh = cur.ONH == null ? null : +(r.h - cur.ONH).toFixed(2), dl = cur.ONL == null ? null : +(cur.ONL - r.l).toFixed(2);
  if ((dh !== null && Math.abs(dh) > 0.001) || (dl !== null && Math.abs(dl) > 0.001)) { todo.push({ d: x.d, dow: x.dow, h: r.h, l: r.l, dh, dl }); (byDow[x.dow] ||= []).push(Math.max(dh || 0, dl || 0)); }
}
console.log(`ONH/ONL dates ${dates.length}; skipped (fewer than ${MIN_BARS} bars in the window) ${skipped.length}; rows to change ${todo.length}`);
console.log('by weekday (1=Mon): ' + Object.entries(byDow).map(([k, v]) => `${k}: ${v.length} rows, max widening ${Math.max(...v)} pts`).join(' | '));
console.log('widened in the right direction only (stored never wider than true):', todo.every((t) => (t.dh === null || t.dh >= -0.001) && (t.dl === null || t.dl >= -0.001)));
if (skipped.length) console.log('skipped sample:', skipped.slice(0, 8));
if (!APPLY) { console.log('DRY RUN: nothing written. First 10 changes:', todo.slice(0, 10)); process.exit(0); }
const have = (await query(`SELECT to_regclass('public.${BACKUP}') t`)).rows[0].t; if (have) throw new Error(`${BACKUP} already exists; refusing to overwrite`);
await query(`CREATE TABLE ${BACKUP} AS SELECT * FROM level_prices WHERE level_name IN ('ONH','ONL')`);
const nb = (await query(`SELECT count(*)::int n FROM ${BACKUP}`)).rows[0].n; console.log(`backup ${BACKUP}: ${nb} rows`);
for (const t of todo) {
  await query(`UPDATE level_prices SET price=$2, computed_at=NOW() WHERE trade_date=$1 AND level_name='ONH'`, [t.d, t.h]);
  await query(`UPDATE level_prices SET price=$2, computed_at=NOW() WHERE trade_date=$1 AND level_name='ONL'`, [t.d, t.l]);
}
let bad = 0;
for (const t of todo) { const c = Object.fromEntries((await query(`SELECT level_name, price::float p FROM level_prices WHERE trade_date=$1 AND level_name IN ('ONH','ONL')`, [t.d])).rows.map((q) => [q.level_name, q.p])); if (Math.abs(c.ONH - t.h) > 0.001 || Math.abs(c.ONL - t.l) > 0.001) bad++; }
console.log(`updated ${todo.length} dates; read-back mismatches ${bad}`);
process.exit(bad ? 1 : 0);
