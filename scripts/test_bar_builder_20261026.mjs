// buildBars(NQ, 240) must reproduce build4h(NQ) exactly (same bars, ranges, volumes, scale); checked on 2025 data. Also prints bar counts for 60 and 120 minutes.
import { query } from '../server/db.js';
import { loadBars, prep, indexBars } from './lib/floorEngine.mjs';
import { build4h } from './lib/fourHourLevels.mjs';
import { buildBars } from './lib/barBuilder.mjs';
const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2025-01-01', '2025-04-30'))), a = build4h(NQ), b = buildBars(NQ, 240);
let bad = a.bars.length !== b.bars.length ? 1 : 0; for (let i = 0; i < Math.min(a.bars.length, b.bars.length); i++) { const x = a.bars[i], y = b.bars[i]; if (x.td !== y.td || x.i0 !== y.i0 || x.i1 !== y.i1 || x.H !== y.H || x.L !== y.L || x.V !== y.V || (x.relBase ?? null) !== (y.relBase ?? null)) { bad++; if (bad < 4) console.log('diff', i, x, y); } }
const hk = Object.keys(a.h4).filter((k) => Math.abs(a.h4[k] - b.h[k]) > 1e-9).length;
console.log(`240-minute: build4h ${a.bars.length} bars, buildBars ${b.bars.length} bars, mismatching bars ${bad}, mismatching scale days ${hk}`);
console.log('60-minute bars', buildBars(NQ, 60).bars.length, '| 120-minute bars', buildBars(NQ, 120).bars.length);
process.exit(bad || hk ? 1 : 0);
