// DESCRIPTIVE ONE-SESSION LOOK (user 2026-11-09: 'that short at the low was capitulation... the system should be watching the preceding move too'). For each Globex vacuum event of the
// 2026-11-08/09 session: how far price had ALREADY moved in the event's direction before the signal (from the opposite extreme of the session so far, and of the last 240 minutes), in points
// and in units of the 20-session ADR (mean RTH range). One session, hindsight: an illustration of the question, not a test. Logged as a descriptive look (tests=0).
import { query } from '../server/db.js';
import { logLook } from './lib/look_ledger.mjs';

async function main() {
  await logLook({ family: 'vacuum_live', dataWindow: 'GBX events of the 2026-11-08 18:00 .. 2026-11-09 09:29 session (descriptive)', kind: 'EXPLORE', tests: 0,
    label: 'one-session look: how extended was the move before each Globex vacuum event', script: 'scripts/vacuum_preceding_move_illustration_20261109.mjs', ref: 'vacuum_preceding_move_illustration_20261109' });
  const adr = (await query(`SELECT AVG(r)::float AS adr FROM (SELECT max(high)-min(low) AS r FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2026-10-08' AND ts < '2026-11-09'
    AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 959 GROUP BY ts::date ORDER BY ts::date DESC LIMIT 20) q`)).rows[0].adr;
  const ev = (await query(`SELECT id, direction, to_char(fired_at,'MM-DD HH24:MI') AS t, fired_at::text AS fired, taken, entry_open::float AS entry, net_nostop::float AS n30 FROM vacuum_live_events WHERE track='GBX' AND trade_date='2026-11-09' ORDER BY fired_at`)).rows;
  console.log(`ADR20 (mean RTH range, 20 sessions) ${adr.toFixed(0)} pts\nid dir   time        entry    | already moved BEFORE the signal, in the signal direction: since session start (pts, ADR) | last 240 min (pts, ADR) | 30-bar result (no stop)`);
  for (const e of ev) {
    const sess = (await query(`SELECT max(high)::float AS hi, min(low)::float AS lo FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2026-11-08 18:00:00' AND ts < date_trunc('minute', $1::timestamp)`, [e.fired])).rows[0];
    const w = (await query(`SELECT max(high)::float AS hi, min(low)::float AS lo FROM price_bars_primary WHERE symbol='NQ' AND ts >= GREATEST('2026-11-08 18:00:00'::timestamp, $1::timestamp - interval '240 minutes') AND ts < date_trunc('minute', $1::timestamp)`, [e.fired])).rows[0];
    const ext = (x) => (e.direction === 1 ? e.entry - x.lo : x.hi - e.entry);   // LONG: how far above the recent low; SHORT: how far below the recent high
    const a = ext(sess), b = ext(w);
    console.log(`${String(e.id).padStart(2)} ${e.direction === 1 ? 'LONG ' : 'SHORT'} ${e.t}  ${e.entry.toFixed(1)} | ${a.toFixed(0).padStart(5)} pts ${(a / adr).toFixed(2)} ADR | ${b.toFixed(0).padStart(5)} pts ${(b / adr).toFixed(2)} ADR | ${e.n30.toFixed(1).padStart(7)} ${e.taken ? '(taken)' : ''}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
