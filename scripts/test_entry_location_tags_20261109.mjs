// Reproduction test: scripts/lib/entryLocationTags.mjs (levelsFor, pivotTag) vs the 48 stored retro rows of capitulation_exit_shadow, 0 mismatches on 2026-11-09. Run again after any change to the tag functions.
import { query } from '../server/db.js';
import { adr20 } from './lib/levelContext.mjs';
import { levelsFor, loadPivotCands, pivotTag } from './lib/entryLocationTags.mjs';
const rows = (await query(`SELECT setup_id, c.side, c.fired_at::text f, c.entry_px::float entry, c.at_boundary, c.boundary_name, c.boundary_dist_adr::float bd, c.pivot_live, c.pivot_tests, a.trade_date::text td FROM capitulation_exit_shadow c JOIN active_setups a ON a.id = c.setup_id ORDER BY c.fired_at`)).rows;
const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10), from = new Date(Date.now() - 140 * 86400000).toISOString().slice(0, 10);
const cands = await loadPivotCands(from, to, [...new Set(rows.map((r) => r.f.slice(0, 10)))]);
let bad = 0;
for (const r of rows) {
  const adr = await adr20(r.td), lv = await levelsFor({ td: r.td, f: r.f, side: r.side, entry: r.entry }, adr), pv = pivotTag(cands, r.side, r.entry, r.f);
  const okB = lv.at === r.at_boundary && lv.name === r.boundary_name && (lv.distAdr == null ? r.bd == null : Math.abs(lv.distAdr - r.bd) < 1e-3), okP = pv.live === r.pivot_live && (pv.tests ?? null) === (r.pivot_tests ?? null);
  if (!okB || !okP) { bad++; console.log('MISMATCH', r.setup_id, JSON.stringify({ lv, pv }), JSON.stringify({ at: r.at_boundary, name: r.boundary_name, bd: r.bd, piv: r.pivot_live, t: r.pivot_tests })); }
}
console.log('rows compared', rows.length, 'mismatches', bad); process.exit(0);
