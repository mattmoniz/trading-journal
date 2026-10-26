// Live sanity check (2026-10-26, user: "I found a floor ... you're saying nothing"): run the four-hour defended-level detector on the latest bars (NOT the study's frozen end date) and print the levels
// it holds right now and every event of the last few days, with times and prices, so it can be compared with what the user saw on the chart.
import { query } from '../server/db.js';
import { loadBars, prep, indexBars, clock } from './lib/floorEngine.mjs';
import { build4h, negBars, runLevels } from './lib/fourHourLevels.mjs';
const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2026-07-01', (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d)));
const { bars, h4 } = build4h(NQ), t = (i) => NQ.T[i].slice(5, 16);
console.log(`bars to ${NQ.T[NQ.n - 1]} ; 4-hour bars ${bars.length}; latest bar starts ${t(bars[bars.length - 1].i0)}`);
for (const [nm, S] of [['FLOORS', bars], ['TOPS', negBars(bars)]]) {
  const sign = nm === 'FLOORS' ? 1 : -1, { ev } = runLevels(S, h4, 0.25), recent = ev.filter((e) => e.t >= bars.length - 40);
  console.log(`\n${nm}: events in the last 40 four-hour bars (about 7 days):`);
  for (const e of recent) { const b = bars[e.t]; console.log(`  ${e.kind.padEnd(4)} level ${(sign * e.level).toFixed(2)}  K=${e.K}  bar closed ${t(b.i1)} ET  (level id ${e.id})`); }
}
process.exit(0);
