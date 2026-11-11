// OUTCOME-BLIND tag backfill for amendment A10 (docs/CAPITULATION_REPLACES_TARGET_PREREG_20261109.md, Phase 1): entry-location tags (at_boundary, pivot_live) for the 5,191 real rows of a6_rows.json, using the SAME shared functions as the forward logger
// (scripts/lib/entryLocationTags.mjs; reproduces the 48 stored retro rows with 0 mismatches). Reads fired_at, entry price, levels and bars only: no P&L, no resolution. Writes scratch/capitulation_replay_20261109/a10_tags.json.
import fs from 'fs';
import { levelsFor, loadPivotCands, pivotTag } from './lib/entryLocationTags.mjs';
const D = 'scratch/capitulation_replay_20261109'; const [, , ROWS = `${D}/a6_rows.json`, OUT = `${D}/a10_tags.json`, PFROM = '2026-03-01', PTO = '2026-10-10'] = process.argv; const rows = JSON.parse(fs.readFileSync(ROWS));
const sideOf = (r) => (r.setup_type.includes('_SHORT') ? -1 : r.setup_type.includes('_LONG') ? 1 : (r.t1 != null && r.p0 != null ? (r.t1 > r.p0 ? 1 : -1) : 0));
const cands = await loadPivotCands(PFROM, PTO, [...new Set(rows.map((r) => r.f.slice(0, 10)))]);
const out = {}; let n = 0, skipped = 0;
for (const r of rows) {
  const side = sideOf(r); if (!side || r.p0 == null || !(r.adr > 0)) { skipped++; continue; }
  const lv = await levelsFor({ td: r.td, f: r.f, side, entry: r.p0 }, r.adr), pv = pivotTag(cands, side, r.p0, r.f);
  out[r.id] = { side, at_boundary: lv.at, boundary_name: lv.name, boundary_dist_adr: lv.distAdr, pivot_live: pv.live, pivot_tests: pv.tests }; n++;
}
fs.writeFileSync(OUT, JSON.stringify(out));
const v = Object.values(out); console.log('tagged', n, 'skipped', skipped, '| at_boundary', v.filter((x) => x.at_boundary).length, '| pivot_live', v.filter((x) => x.pivot_live).length, '| both', v.filter((x) => x.at_boundary && x.pivot_live).length, '| boundary null', v.filter((x) => x.at_boundary == null).length);
process.exit(0);
