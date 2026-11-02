// Minute-bar extractor for docs/RANGE_BUDGET_PREREG_20261102.md. EXPLORE DATES ONLY (earliest 60% of the pinned overnight-to-RTH dataset); a hold-out date is refused.
// Writes scratch/range_budget_bars_20261102.json: {dates:[...], bars:{date:{o,h,l,c}}} with the 390 RTH one-minute bars (09:30-15:59) of each explore date. No outcome is computed here.
import fs from 'fs';
import { query } from '../server/db.js';
const ds = JSON.parse(fs.readFileSync(new URL('../scratch/overnight_rth_dataset_20261026.json', import.meta.url)));
const R = ds.rows, nExp = Math.floor(R.length * 0.6), explore = R.slice(0, nExp), holdoutFrom = R[nExp].date;
const out = { dates: [], bars: {}, dropped: [] };
for (const r of explore) {
  if (r.date >= holdoutFrom) throw new Error('hold-out date refused: ' + r.date);
  const rows = (await query(`SELECT open::float o, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp ORDER BY ts`, [`${r.date} 09:30:00`, `${r.date} 16:00:00`])).rows;
  if (rows.length < 371) { out.dropped.push([r.date, rows.length]); continue; }
  const hi = Math.max(...rows.map((b) => b.h)), lo = Math.min(...rows.map((b) => b.l));
  if (Math.abs((hi - lo) / r.atr - r.rthRangeAtr) > 1e-6) throw new Error(`loader check failed ${r.date}: ${(hi - lo) / r.atr} vs ${r.rthRangeAtr}`);
  out.dates.push(r.date); out.bars[r.date] = { o: rows.map((b) => b.o), h: rows.map((b) => b.h), l: rows.map((b) => b.l), c: rows.map((b) => b.c) };
}
fs.writeFileSync(new URL('../scratch/range_budget_bars_20261102.json', import.meta.url), JSON.stringify(out));
console.log(`explore days ${explore.length} (${explore[0].date}..${explore[nExp - 1].date}); extracted ${out.dates.length}; dropped (bars < 371) ${out.dropped.length}; hold-out ${R.length - nExp} days from ${holdoutFrom} NOT touched`);
process.exit(0);
