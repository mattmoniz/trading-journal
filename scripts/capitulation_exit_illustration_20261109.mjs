// DESCRIPTIVE ONE-SESSION ILLUSTRATION (user 2026-11-09: 'we might be able to use this type of capitulation when some of our other setups fire short ... the capitulation was the sign to get out of the short').
// For every SHORT setup that fired 2026-11-08 18:00 .. 2026-11-09 02:45: what it actually did, and what it would have done if it had been HELD with its own original stop until the capitulation
// signal (the Globex vacuum SHORT event #9, 02:45:30, entry ~26,836, preceded by 0.97 ADR20 of decline). Hindsight on one session: an illustration, NOT a test. Descriptive look logged (tests=0).
import { query } from '../server/db.js';
import { logLook } from './lib/look_ledger.mjs';

async function main() {
  await logLook({ family: 'capitulation_exit', dataWindow: 'SHORT setups fired 2026-11-08 18:00 .. 2026-11-09 02:45 (descriptive)', kind: 'EXPLORE', tests: 0,
    label: 'one-session illustration: hold shorts to the 02:45 capitulation signal with their own stop', script: 'scripts/capitulation_exit_illustration_20261109.mjs', ref: 'capitulation_exit_illustration_20261109' });
  const cap = (await query(`SELECT to_char(fired_at,'YYYY-MM-DD HH24:MI:SS') AS fired, entry_open::float AS entry FROM vacuum_live_events WHERE track='GBX' AND trade_date='2026-11-09' AND direction=-1 AND fired_at >= '2026-11-09 02:40' AND fired_at < '2026-11-09 02:50' ORDER BY fired_at LIMIT 1`)).rows[0];
  console.log(`capitulation signal: ${cap.fired}, exit at ~${cap.entry}`);
  const rows = (await query(`SELECT id, setup_type, origin_status AS o, to_char(fired_at,'MM-DD HH24:MI') AS t, fired_at::text AS fired, price_at_detection::float AS entry, stop_level::float AS stop, actual_pnl::float AS pnl, resolution
    FROM active_setups WHERE setup_type ~ '_SHORT' AND fired_at >= '2026-11-08 18:00' AND fired_at < '2026-11-09 02:45' AND origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary ORDER BY fired_at`)).rows;
  let sumActual = 0, sumHeld = 0;
  console.log('id     setup                              o      fired        entry     stop  | actual: resolution  pnl$ | HELD to 02:45 with its own stop: result      pts   $ (2 pt cost)  max adverse pts');
  for (const r of rows) {
    const bars = (await query(`SELECT to_char(ts,'HH24:MI') AS t, high::float AS high, low::float AS low FROM price_bars_primary WHERE symbol='NQ' AND ts >= date_trunc('minute', $1::timestamp) AND ts < $2::timestamp ORDER BY ts`, [r.fired, cap.fired.slice(0, 16) + ':00'])).rows;
    let mae = 0, stopped = null;
    for (const b of bars) { mae = Math.max(mae, b.high - r.entry); if (b.high >= r.stop) { stopped = b.t; break; } }
    const pts = stopped ? r.entry - r.stop : r.entry - cap.entry, usd = pts * 2 - 2;
    sumActual += r.pnl; sumHeld += usd;
    console.log(`${r.id} ${r.setup_type.padEnd(34)} ${r.o.padEnd(6)} ${r.t}  ${r.entry.toFixed(1)}  ${r.stop.toFixed(1)} | ${r.resolution.padEnd(10)} ${r.pnl.toFixed(0).padStart(5)} | ${(stopped ? 'STOPPED ' + stopped : 'held').padEnd(14)} ${pts.toFixed(1).padStart(7)} ${usd.toFixed(0).padStart(6)}   ${mae.toFixed(1).padStart(6)}`);
  }
  console.log(`\nsum actual $${sumActual.toFixed(0)} | sum if held to the capitulation $${sumHeld.toFixed(0)} (the shorts are different setups and would overlap in time: this is NOT a one-position-at-a-time number)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
