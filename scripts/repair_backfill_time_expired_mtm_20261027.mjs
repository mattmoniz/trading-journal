// Repair: BACKFILL TIME_EXPIRED rows are scored at exactly 0 dollars (13 generator/repair scripts, see reports/time_expired_zero_audit_20261027.md).
// This re-scores them as a mark to market at the expiry-bar close, using the same engine conventions as the True-MTM studies:
//   dry run by default (counts per bucket, buckets must sum to the total); --commit backs the rows up first (active_setups_backfill_time_expired_mtm_backup_20261027) and updates
//   actual_pnl and pnl_source = 'BF_MTM' ONLY (resolution, status, timestamps and every other column are untouched). Idempotent: only rows still at actual_pnl = 0 with pnl_source NULL are touched,
//   so it can be re-run after any generator re-creates zeros.
// A row is repaired only if (1) its entry price sits inside the fired minute's bar (BACKFILL VWAP-family rows with fired_at stored 4-5 hours early are located with a +4/5h shift, used ONLY to find the bar;
// the stored timestamps are not changed), (2) it is outside roll weeks / the sparse-bar window, (3) a fresh walk with its own stop and target does NOT resolve before expiry (otherwise the stored TIME_EXPIRED
// label disagrees with the bars and the row is left alone and reported), (4) the session is complete in the data.
import { query } from '../server/db.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { loadBars, prep, indexBars, emOf, SPARSE } from './lib/floorEngine.mjs';
const COMMIT = process.argv.includes('--commit');
const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-11-01', '2026-08-31')));
const clk = (i) => +NQ.T[i].slice(11, 13) * 60 + +NQ.T[i].slice(14, 16), clsOf = (c) => (c >= 570 && c < 960 ? 'R' : c >= 960 && c < 1020 ? 'P' : c >= 1080 || c < 570 ? 'G' : null), ENDC = { R: 959, P: 1019, G: 569 };
const cap = new Map(); let maxTD = ''; for (let i = 0; i < NQ.n; i++) { const k = clsOf(clk(i)); if (!k) continue; if (NQ.TD[i] > maxTD) maxTD = NQ.TD[i]; cap.set(NQ.TD[i] + '|' + k, i); }
const etOff = (d) => (new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).format(new Date(d + 'T12:00:00Z')).includes('EDT') ? 4 : 5), inBar = (t, e) => t !== undefined && e >= NQ.L[t] - 0.5 && e <= NQ.H[t] + 0.5;
// commission per setup_type = median of (gross - stored pnl) over that type's resolved BACKFILL target hits (the stored convention differs by repair wave), fallback global
const commRows = (await query(`SELECT setup_type, COALESCE(entry_zone_low, entry_zone_high)::float e, t1_level::float t1, actual_pnl::float p, stop_level::float s FROM active_setups WHERE origin_status='BACKFILL' AND resolution='TARGET_HIT' AND actual_pnl IS NOT NULL AND t1_level IS NOT NULL`)).rows;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; }, byType = new Map();
for (const r of commRows) { const d = resolveDirection({ setup_type: r.setup_type, stop_level: r.s, t1_level: r.t1 }); if (!d) continue; const g = (d === 'LONG' ? 1 : -1) * (r.t1 - r.e) * 2; (byType.get(r.setup_type) || byType.set(r.setup_type, []).get(r.setup_type)).push(g - r.p); }
const commGlobal = med([...byType.values()].flat()), commOf = (t) => { const a = byType.get(t); return a && a.length >= 5 ? med(a) : commGlobal; };
const rows = (await query(`SELECT id, setup_type, trade_date::text td, fired_at::text fa, expires_at::text ea, COALESCE(entry_zone_low, entry_zone_high)::float entry, stop_level::float stop, t1_level::float t1 FROM active_setups WHERE origin_status='BACKFILL' AND resolution='TIME_EXPIRED' AND actual_pnl = 0 AND pnl_source IS NULL ORDER BY id`)).rows;
const bucket = {}; const bump = (k) => (bucket[k] = (bucket[k] || 0) + 1), fix = [];
for (const r of rows) {
  if (r.stop == null || r.t1 == null || r.entry == null) { bump('left: no stop / target / entry stored'); continue; }
  const dd = resolveDirection({ setup_type: r.setup_type, stop_level: r.stop, t1_level: r.t1 }); if (!dd) { bump('left: no direction'); continue; } const d = dd === 'LONG' ? 1 : -1;
  const em0 = emOf(r.fa.slice(0, 16) + ':00'); let t = NQ.byEm.get(em0), shift = 0; if (t === undefined) { bump('left: no bar at the fired minute'); continue; }
  if (!inBar(t, r.entry)) { const sh = etOff(r.td) * 60, t2 = NQ.byEm.get(em0 + sh); if (inBar(t2, r.entry)) { t = t2; shift = sh; } else { bump('left: entry price not inside the fired bar (also not after the +4/5h shift)'); continue; } }
  const TD = NQ.TD[t], cls = clsOf(clk(t)); if (!cls) { bump('left: no bar at the fired minute'); continue; }
  if (isInsideNqRollWeek(TD) || SPARSE(TD)) { bump('left: roll week / sparse-bar window'); continue; }
  const ci = cap.get(TD + '|' + cls); if (ci === undefined || (clk(ci) !== ENDC[cls] && TD >= maxTD)) { bump('left: session not complete in the data'); continue; }
  let e = r.ea ? NQ.byEm.get(emOf(r.ea.slice(0, 16) + ':00') + shift) : undefined; e = Math.min(e ?? ci, ci); if (e < t) e = ci; // a missing / earlier-than-entry expiry falls back to the session cap
  let resolved = null; if (d > 0 ? NQ.L[t] <= r.stop : NQ.H[t] >= r.stop) resolved = 'STOP'; for (let i = t + 1; i <= e && !resolved; i++) { const op = NQ.O[i]; if (d > 0 ? op <= r.stop || NQ.L[i] <= r.stop : op >= r.stop || NQ.H[i] >= r.stop) resolved = 'STOP'; else if (d > 0 ? op >= r.t1 || NQ.H[i] >= r.t1 : op <= r.t1 || NQ.L[i] <= r.t1) resolved = 'TGT'; }
  if (resolved) { bump(`left: bars show a ${resolved} before expiry (stored TIME_EXPIRED label disagrees with the bars)`); continue; }
  const comm = commOf(r.setup_type), pnl = Math.round((d * (NQ.C[e] - r.entry) * 2 - comm) * 100) / 100; bump(shift ? 'repair: located with the +4/5h timestamp shift' : 'repair: located directly'); fix.push({ id: r.id, pnl, comm, setup: r.setup_type });
}
const tot = Object.values(bucket).reduce((a, b) => a + b, 0);
console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'}: ${rows.length} BACKFILL TIME_EXPIRED rows at 0 with pnl_source NULL; buckets sum to ${tot} (${tot === rows.length ? 'OK' : 'MISMATCH'})`); console.table(Object.entries(bucket).map(([k, v]) => ({ bucket: k, rows: v })));
const pn = fix.map((f) => f.pnl); console.log(`rows to repair ${fix.length}: mean new P&L ${(pn.reduce((a, b) => a + b, 0) / pn.length).toFixed(2)}, share positive ${(pn.filter((x) => x > 0).length / pn.length).toFixed(2)}, commission used: global median ${commGlobal}, per-type values ${[...new Set(fix.map((f) => f.comm))].join(', ')}`);
if (tot !== rows.length) { console.error('buckets do not sum -- aborting'); process.exit(1); }
if (COMMIT) {
  await query(`CREATE TABLE IF NOT EXISTS active_setups_backfill_time_expired_mtm_backup_20261027 AS SELECT * FROM active_setups WHERE id = ANY($1::int[])`, [fix.map((f) => f.id)]);
  const b = (await query(`SELECT COUNT(*)::int n FROM active_setups_backfill_time_expired_mtm_backup_20261027`)).rows[0].n; console.log('backup rows:', b);
  let n = 0; for (let i = 0; i < fix.length; i += 200) { const ch = fix.slice(i, i + 200); const r = await query(`UPDATE active_setups a SET actual_pnl = v.pnl, pnl_source = 'BF_MTM' FROM (SELECT UNNEST($1::int[]) id, UNNEST($2::numeric[]) pnl) v WHERE a.id = v.id AND a.origin_status='BACKFILL' AND a.resolution='TIME_EXPIRED' AND a.actual_pnl = 0 AND a.pnl_source IS NULL`, [ch.map((f) => f.id), ch.map((f) => f.pnl)]); n += r.rowCount; }
  console.log('updated rows:', n);
}
process.exit(0);
