// Rebuilds scripts/lib/data/nq_roll_stitches.json: every NQ contract stitch and every bad-bar date (mixed volume-bar rows, broken adjacent-minute
// steps) in price_bars_primary, read from the bars (scripts/lib/nqRollStitch.mjs). Price-only: reads no outcome label, so it
// logs no ledger look. Prints which stitch dates the calendar helper (acdShared.getNqRollWeekDates) does not cover.
// Usage: node scripts/build_nq_roll_stitches.mjs [--from 2022-12-01]
import fs from 'fs';
import { query } from '../server/db.js';
import { getNqRollWeekDates } from '../server/services/acdShared.js';
import { scanNqStitches, NQ_STITCH_FILE } from './lib/nqRollStitch.mjs';

async function main() {
  const i = process.argv.indexOf('--from');
  const from = i > 0 ? process.argv[i + 1] : '2022-12-01';
  const to = (await query(`SELECT (CURRENT_DATE + 1)::text d`)).rows[0].d;
  const { stitches, bad_dates } = await scanNqStitches(query, { from, to });
  const cal = new Set();
  for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) for (const d of getNqRollWeekDates(y)) cal.add(d);
  for (const s of stitches) s.in_calendar_helper = cal.has(s.ts.slice(0, 10)) && cal.has(s.prev_ts.slice(0, 10));
  const out = { built_at: (await query(`SELECT NOW()::timestamp::text t`)).rows[0].t, symbol: 'NQ', from, to, stitches, bad_dates };
  fs.writeFileSync(NQ_STITCH_FILE, JSON.stringify(out, null, 1));
  console.log(`stitches ${stitches.length}, bad-bar dates ${bad_dates.length} -> ${NQ_STITCH_FILE}`);
  for (const s of stitches) console.log(`STITCH ${s.prev_ts} => ${s.ts} ${s.from}>${s.to} step ${s.step_pts} hole ${s.hole_min} min ${s.in_calendar_helper ? '' : 'NOT COVERED BY CALENDAR HELPER'}`);
  let run = null; const flush = () => { if (run) console.log(`BAD    ${run.a} .. ${run.b}: ${run.n} dates [${[...run.r].join(', ')}]`); run = null; };
  for (const x of bad_dates) {
    const gap = run ? (Date.parse(x.date) - Date.parse(run.b)) / 86400000 : 0;
    if (!run || gap > 4) { flush(); run = { a: x.date, b: x.date, n: 0, r: new Set() }; }
    run.b = x.date; run.n++; x.reasons.forEach(z => run.r.add(z));
  }
  flush();
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
