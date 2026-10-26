// Builds the blind picks set (docs/FOUR_HOUR_PICKS_BLIND_RATING_PREREG_20261026.md): 60 seeded-random first-K3 four-hour events (30 floors, 30 tops), charts with date and absolute price hidden, NO outcome anywhere.
// Writes scratch/picks_20261026/moments.json (goes into the page) and sample_keys.json (id -> event key, kept out of the page; outcomes are joined later from scratch/four_hour_events_20261026.json).
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars } from './lib/floorEngine.mjs';
import { build4h, firstK3Events, d20Of, pinnedLimit } from './lib/fourHourLevels.mjs';
const SHOW = 30, PER_SIDE = 30, SLOT_CLOCK = ['18:00', '22:00', '02:00', '06:00', '10:00', '14:00'];
async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 3)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), d20 = d20Of(NQ), { bars, h4 } = build4h(NQ), LIM = pinnedLimit(NQ, endRow);
  const events = firstK3Events(NQ, bars, h4, d20, 0.25, LIM).filter((e) => NQ.byEm.get(NQ.EM[e.i0] + 1439) !== undefined && e.t >= SHOW - 1);
  console.log(`events usable ${events.length} (floors ${events.filter((e) => e.side === 'floor').length}, tops ${events.filter((e) => e.side === 'top').length}); end ${endRow}`);
  const rng = mulberry32(hashSeed('picks20261026')), shuf = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
  const pick = [...shuf(events.filter((e) => e.side === 'floor')).slice(0, PER_SIDE), ...shuf(events.filter((e) => e.side === 'top')).slice(0, PER_SIDE)], order = shuf(pick);
  const moments = [], keys = {};
  order.forEach((e, k) => {
    const id = 'P' + String(k + 1).padStart(2, '0'), lo = e.t - SHOW + 1, L = e.level;
    const u = (x) => +((x - L) / e.d20).toFixed(4), win = bars.slice(lo, e.t + 1).map((b, j) => [SLOT_CLOCK[b.slot], u(b.O) , u(b.H), u(b.L), u(b.C), 0, b.relBase ? +(b.V / b.relBase).toFixed(2) : null, j > 0 && b.slot === 0 ? 1 : 0]); // prices in D20 units above/below the level (era cannot be read from raw points); raw volume is NOT shipped (slot 5 is a zero placeholder)
    const def = e.defIdx.map((i) => i - lo).filter((j) => j >= 0 && j < SHOW).sort((a, b) => a - b);
    moments.push({ id, side: e.side, dir: e.dir > 0 ? 'LONG' : 'SHORT', band: +(e.band / e.d20).toFixed(4), bars: win, def });
    keys[id] = e.key;
  });
  fs.mkdirSync('scratch/picks_20261026', { recursive: true });
  fs.writeFileSync('scratch/picks_20261026/moments.json', JSON.stringify(moments)); fs.writeFileSync('scratch/picks_20261026/sample_keys.json', JSON.stringify({ endRow, keys }));
  console.log(`moments ${moments.length}; payload bytes ${fs.statSync('scratch/picks_20261026/moments.json').size}; contains a date field: ${/"date"|"td"|"day"/.test(fs.readFileSync('scratch/picks_20261026/moments.json', 'utf8'))}; defended bars per moment (min/max): ${Math.min(...moments.map((m) => m.def.length))}/${Math.max(...moments.map((m) => m.def.length))}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
