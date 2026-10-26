// Is POC_ROTATION_JOIN's event detection causal enough that the 40-bar warm-up (MIN_SESSION_BARS) is unnecessary? For recent sessions, take every event whose entry bar is
// within the first 40 session bars (what the warm-up delays), re-run detectSignalEvents on ONLY the bars up to and including that entry bar (what a live poll would have
// seen the moment the entry bar printed), and check the same event (direction, entry index, entry price) comes out.
import { query } from '../server/db.js';
import { detectSignalEvents } from '../server/services/pocRotationService.js';
import { getTheta } from '../server/services/pocRotationJoinDetector.js';
const theta = await getTheta();
const days = (await query(`SELECT DISTINCT trade_date::text d FROM active_setups WHERE trade_date >= CURRENT_DATE - 200 AND trade_date < CURRENT_DATE ORDER BY 1 DESC LIMIT 140`)).rows.map((r) => r.d).sort();
let sessions = 0, early = 0, same = 0, diffs = [], prefixOnlyExtra = 0;
for (const d of days) {
  const bars = (await query(`SELECT ts::text as ts, open::float, high::float, low::float, close::float, volume::float as volume FROM price_bars_primary WHERE symbol='NQ' AND (
      (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR (ts::date = $1::date AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) < 1020)) AND ts >= $1::date - 1 AND ts < $1::date + 1 ORDER BY ts ASC`, [d])).rows;
  if (bars.length < 200) continue; sessions++;
  const full = detectSignalEvents(65, 'standard', theta, [{ t: d, bars }], 'fixed').all_signal.filter((e) => e.entry_idx != null);
  for (const e of full.filter((x) => x.entry_idx < 40)) {
    early++;
    const pre = detectSignalEvents(65, 'standard', theta, [{ t: d, bars: bars.slice(0, e.entry_idx + 1) }], 'fixed').all_signal.filter((x) => x.entry_idx != null);
    const m = pre.find((x) => x.entry_idx === e.entry_idx && x.direction === e.direction);
    if (m && bars[m.entry_idx].open === bars[e.entry_idx].open) same++; else diffs.push({ d, entry_idx: e.entry_idx, dir: e.direction, ts: bars[e.entry_idx].ts, preHas: pre.map((x) => `${x.entry_idx}${x.direction}`).join(',') });
  }
}
console.log(`sessions ${sessions}, events with entry bar inside the first 40 session bars ${early}, identical when computed from the prefix only ${same}, different ${diffs.length}`);
console.log(JSON.stringify(diffs.slice(0, 12)));
process.exit(0);
