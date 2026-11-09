// Exporter for docs/POC_JOIN_DAY_TELL_PREREG_20261104.md: per trade date, the times (ET, HH:MM) of the REAL detector's POC rotation joins (R=65, pocJoinLoader.buildEvents, the same dates it uses: developing_value_log dates outside roll weeks)
// and of the confirmed R=65 rotation legs (detectRotationLegs) over the session 18:00 previous day -> 17:00. Output scratch/poc_join_day_tell_20261104/events.json {date: {joins: [[hhmm, long]], rots: [hhmm]}}
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
import { detectRotationLegs } from '../../../server/services/rotationDetector.js';
import { isInsideNqRollWeek } from '../../../server/services/acdShared.js';
import { loadBars, buildEvents, addDay, lb } from '../../lib/pocJoinLoader.mjs';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..'); const out = path.join(repo, 'scratch', 'poc_join_day_tell_20261104'); fs.mkdirSync(out, { recursive: true });
const from = '2023-03-07', to = '2026-10-19'; const D = await loadBars(from, to); console.log('bars loaded', D.TS.length);
const ev = await buildEvents(D, from, to); console.log('join events', ev.length);
const dates = (await query(`SELECT DISTINCT trade_date::text d FROM developing_value_log WHERE trade_date >= $1::date AND trade_date <= $2::date ORDER BY d`, [from, to])).rows.map(r => r.d).filter(d => !isInsideNqRollWeek(d));
const res = {}; for (const d of dates) res[d] = { joins: [], rots: [] };
for (const e of ev) if (res[e.d]) res[e.d].joins.push([D.TS[e.ei].slice(11, 16), e.long ? 1 : 0]);
for (const d of dates) { const a = lb(D.TS, addDay(d, -1) + ' 18:00:00'), b = lb(D.TS, d + ' 17:00:00'); if (b - a < 100) { res[d].skipped = true; continue; }
  const bars = []; for (let i = a; i < b; i++) bars.push({ high: D.H[i], low: D.L[i], ts: D.TS[i] }); res[d].nbars = bars.length; res[d].rots = detectRotationLegs(bars, 65).map(g => bars[g.idx].ts.slice(11, 16)); }
fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(res)); console.log(dates.length, 'dates;', Object.values(res).filter(x => x.skipped).length, 'skipped for thin bars'); process.exit(0);
