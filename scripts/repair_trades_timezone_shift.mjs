// One-time repair for the sierraParser.js ambient-timezone bug (fixed 2026-07-16, see
// CLAUDE.md's timestamp-handling convention and docs/OPEN_THREADS.md for the full account).
//
// Every trade imported before 2026-06-09 has entry_time/exit_time stored as the RAW,
// unshifted Sierra Chart ET wall-clock digits (e.g. real 12:15:48 ET stored literally as
// "12:15:48"). Every trade imported 2026-06-09 onward has these shifted by the real
// ET->UTC offset for that date (+4h EDT / +5h EST), because the ingestion bug happened to
// start producing the "correct" convention the frontend expects (real ET time + correct
// UTC offset, labeled UTC) by accident once the ambient process timezone became
// America/New_York. This script brings every pre-06-09 row onto that same correct
// convention, so the frontend's existing display logic (UTC -> America/New_York) renders
// them correctly instead of 4-5 hours early.
//
// Verified (Claude + Gemini cross-check, 2026-07-16): 4,100 rows created in the
// 2026-06-09 10:00-12:00 batch are exact duplicates of a pre-existing row (matched on
// account/direction/quantity/pnl/entry_time minute+second, differing by exactly +4h or
// +5h) - re-imports of already-correct historical data through the by-then-buggy parser.
// After this shift, those pairs become byte-identical; a separate pass deletes the
// duplicate copy.
import { query } from '../server/db.js';

const DRY_RUN = process.argv.includes('--dry-run');

// Same logic as sierraParser.js's etNaiveStringToUtcIso, applied to an already-stored
// naive (but ET-wall-clock-correct, pre-bug) timestamp instead of a fresh import string.
function etNaiveToUtcIso(y, mo, d, h, mi, s) {
  const utcGuess = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(utcGuess).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const etWallClockOfGuess = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    parts.hour === '24' ? 0 : +parts.hour, +parts.minute, +parts.second
  );
  const targetWallClock = Date.UTC(y, mo - 1, d, h, mi, s);
  const diffMs = targetWallClock - etWallClockOfGuess;
  return new Date(utcGuess.getTime() + diffMs).toISOString();
}

function shiftNaiveTimestamp(ts) {
  if (!ts) return ts;
  const d = new Date(ts);
  return etNaiveToUtcIso(
    d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()
  );
}

async function run() {
  const { rows } = await query(`
    SELECT id, entry_time, exit_time FROM trades WHERE created_at < '2026-06-09'
  `);
  console.log(`Found ${rows.length} pre-2026-06-09 rows to shift.`);

  let updated = 0;
  const sampleOffsets = {};
  for (const r of rows) {
    const newEntry = shiftNaiveTimestamp(r.entry_time);
    const newExit = r.exit_time ? shiftNaiveTimestamp(r.exit_time) : null;

    const offsetHrs = Math.round((new Date(newEntry) - new Date(r.entry_time)) / 3600000 * 10) / 10;
    sampleOffsets[offsetHrs] = (sampleOffsets[offsetHrs] || 0) + 1;

    if (!DRY_RUN) {
      await query(
        `UPDATE trades SET entry_time = $1::timestamp, exit_time = $2::timestamp WHERE id = $3`,
        [newEntry.replace('T', ' ').replace('Z', ''), newExit ? newExit.replace('T', ' ').replace('Z', '') : null, r.id]
      );
    }
    updated++;
  }

  console.log(`${DRY_RUN ? '[DRY RUN] Would have updated' : 'Updated'} ${updated} rows.`);
  console.log('Offset distribution (hours shifted):', sampleOffsets);
}

run().catch(err => { console.error(err); process.exit(1); });
