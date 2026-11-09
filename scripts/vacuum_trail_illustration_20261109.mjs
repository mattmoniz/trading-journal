// DESCRIPTIVE ONE-SESSION ILLUSTRATION (user question 2026-11-09: 'if it had trailed it we would have had a bigger gain... what was the MAE on the longs?'). NOT a test and NOT evidence: one session, hindsight.
// For each Globex vacuum event of the 2026-11-08/09 session: the full-run MAE and MFE from the fire to the Globex session end (09:29), and what a RATCHET of the live stop would have done
// (live stop = signal close -/+ 2.5 x ETR; ratchet = the stop follows the running extreme at the same distance, gap-aware at the bar open, exit at the session end if never hit). Cost 2 pts.
// Ledger: logged as a descriptive look (tests=0) because it reads the events table's outcome columns.
import { query } from '../server/db.js';
import { logLook } from './lib/look_ledger.mjs';

const f1 = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : Number(v).toFixed(1));
async function main() {
  await logLook({ family: 'vacuum_live', dataWindow: 'GBX events of the 2026-11-08 18:00 .. 2026-11-09 09:29 session (descriptive illustration)', kind: 'EXPLORE', tests: 0,
    label: 'one-session illustration: full-run MAE/MFE and a ratcheted 2.5 x ETR stop on the Globex vacuum events', script: 'scripts/vacuum_trail_illustration_20261109.mjs', ref: 'vacuum_trail_illustration_20261109' });
  const ev = (await query(`SELECT id, direction, to_char(fired_at,'YYYY-MM-DD HH24:MI:SS') AS fired, taken, entry_open::float AS entry, signal_close::float AS sc, etr::float AS etr, net_nostop::float AS n30, net_stop25::float AS n30s, mae30::float AS mae30, mfe30::float AS mfe30
    FROM vacuum_live_events WHERE track='GBX' AND trade_date = '2026-11-09' ORDER BY fired_at`)).rows;
  console.log('id dir fired               taken entry    | 30-bar (logged): net/no-stop net/stop MAE MFE | full run to 09:29: MAE  MFE(peak)  | ratcheted live stop: exit time  exit px   P&L');
  for (const e of ev) {
    const bars = (await query(`SELECT to_char(ts,'HH24:MI') AS t, high::float AS high, low::float AS low, close::float AS close, open::float AS open FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= date_trunc('minute', $1::timestamp) AND ts < '2026-11-09 09:30:00' ORDER BY ts`, [e.fired])).rows;
    if (!bars.length) continue;
    const d = e.direction, dist = 2.5 * e.etr;
    let stop = e.sc - d * dist, ext = e.entry, mae = 0, mfe = 0, exitPx = null, exitT = null;
    for (const b of bars) {
      const adverse = d === 1 ? e.entry - b.low : b.high - e.entry, fav = d === 1 ? b.high - e.entry : e.entry - b.low;
      mae = Math.max(mae, adverse); mfe = Math.max(mfe, fav);
      if (exitPx == null) {
        const hit = d === 1 ? b.low <= stop : b.high >= stop;
        if (hit) { exitPx = d === 1 ? Math.min(stop, b.open) : Math.max(stop, b.open); exitT = b.t; }
        else { ext = d === 1 ? Math.max(ext, b.high) : Math.min(ext, b.low); const ns = ext - d * dist; stop = d === 1 ? Math.max(stop, ns) : Math.min(stop, ns); }
      }
    }
    if (exitPx == null) { exitPx = bars[bars.length - 1].close; exitT = 'end ' + bars[bars.length - 1].t; }
    const pnl = (exitPx - e.entry) * d - 2;
    console.log(`${String(e.id).padStart(2)} ${d === 1 ? 'LONG ' : 'SHORT'} ${e.fired} ${e.taken ? 'yes' : 'no '}  ${e.entry.toFixed(1)} | ${f1(e.n30).padStart(7)} ${f1(e.n30s).padStart(7)} ${f1(e.mae30).padStart(5)} ${f1(e.mfe30).padStart(5)} | ${f1(mae).padStart(6)} ${f1(mfe).padStart(7)} | ${String(exitT).padEnd(9)} ${exitPx.toFixed(1).padStart(8)} ${f1(pnl).padStart(7)}`);
  }
  const hi = (await query(`SELECT max(high)::float AS hi, min(low)::float AS lo FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2026-11-09 02:00:00' AND ts < '2026-11-09 09:30:00'`)).rows[0];
  const hiNow = (await query(`SELECT max(high)::float AS hi FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2026-11-09 02:00:00' AND ts < now() + interval '1 minute'`)).rows[0];
  console.log(`\nGlobex 02:00-09:29: low ${hi.lo}, high ${hi.hi} (${(hi.hi - hi.lo).toFixed(1)} pts); high through now (incl. RTH) ${hiNow.hi} (${(hiNow.hi - hi.lo).toFixed(1)} pts from the low)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
