// Read-only export of the explore FLUSH backtest events with their own simulated exits (entry/exit times, entry price, dollars) for the capitulation replay A8/A7 (docs/CAPITULATION_EXIT_FLUSH_PREREG_20261109.md).
// Same events, filters and exit as scripts/study_flush_box_width_skip_20261109.mjs (buildGroupRows). Outcome-bearing (pnl): read only by capitulation_replay_a7.py --go.
import fs from 'fs';
import { loadLevels, loadBarsWithVolZ, groupBarsByDate, groupRthByDate, loadFollowingLevels, makeAdrBefore, buildRthBlindEvents, buildGlobexBlindEventsLive } from '../lib/flushStudyLib.mjs';
import { buildGroupRows } from '../lib/flushBoxWidthRows.mjs';
import { isInsideNqRollWeek } from '../../server/services/acdShared.js';
const EXPLORE_END = '2025-05-16';
const groupOf = (e) => (e.session === 'RTH' ? 'RTH' : e.mode === 'CONTINUATION' ? 'GLOBEX_CONT' : 'GLOBEX_REV');
const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');                  // bar timestamps are naive ET stored as UTC fields (cv-074)
const { getLevelsForDate } = await loadLevels(); const allBars = await loadBarsWithVolZ('1900-01-01');
const barsByDate = groupBarsByDate(allBars), rthByDate = groupRthByDate(allBars), adrBefore = makeAdrBefore(rthByDate);
let events = [...buildRthBlindEvents(rthByDate, getLevelsForDate, adrBefore), ...buildGlobexBlindEventsLive(barsByDate, await loadFollowingLevels(), adrBefore)]
  .filter((e) => e.date <= EXPLORE_END && e.adr).sort((a, b) => a.date.localeCompare(b.date) || a.entryTs - b.entryTs).filter((e) => !isInsideNqRollWeek(e.date));
const out = []; let id = 900000000;
for (const g of ['RTH', 'GLOBEX_CONT', 'GLOBEX_REV']) {
  for (const r of buildGroupRows(events.filter((e) => groupOf(e) === g))) {
    const f = iso(r.entryTs), rs = iso(r.exitTs), td = r.dir === 'LONG' || r.dir === 'SHORT' ? new Date(r.entryTs.getTime() + 6 * 3600000).toISOString().slice(0, 10) : r.date;
    out.push({ id: ++id, grp: g, setup_type: `${g}_FLUSH_${r.dir}`, side: r.dir === 'LONG' ? 1 : -1, td, f, rs, p0: r.entry, pnl: r.pnl, target: r.target, fireMin: r.fireMin });
  }
}
fs.writeFileSync('scratch/capitulation_replay_20261109/a7_flush_rows.json', JSON.stringify(out));
console.log('flush rows', out.length, Object.fromEntries(['RTH', 'GLOBEX_CONT', 'GLOBEX_REV'].map((g) => [g, out.filter((x) => x.grp === g).length]))); process.exit(0);
