// Replace-the-target arms for the forward capitulation logger (register row 30, amendment A10/A11: docs/CAPITULATION_REPLACES_TARGET_PREREG_20261109.md, docs/CAPITULATION_REPLACE_TARGET_FORWARD_PREREG_20261109.md).
// C0 = hold from the row's entry with its ORIGINAL stop (gap-aware), NO target, to its expiry (exit at that minute bar's open). H = C0 plus exit at the next 500V open (`entry_open`) after the first same-direction EXTENDED vacuum thrust.
// Same rules as the historical replay `scripts/vacuum_sim/capitulation_replay_a10.py` (parity-checked on historical rows). Dollars per 1 MNQ, cost $2. Naive ET strings; both ts bounds on every price_bars_primary query (cv-009).
import { query } from '../../server/db.js';
import { fmtUTC, tsMs } from './levelContext.mjs';
/** The flat time used when a row has no expires_at: 15:55 ET for RTH-fired rows, 09:29:50 ET (next morning when fired after 16:00) for Globex-fired rows. */
export function flatTime(f) {
  const m = +f.slice(11, 13) * 60 + +f.slice(14, 16), d = f.slice(0, 10);
  if (m >= 570 && m < 960) return `${d} 15:55:00`;
  if (m < 570) return `${d} 09:29:50`;
  return fmtUTC(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + 1, 9, 29, 50));
}
/** minute bars strictly after the entry second and up to two minutes past the expiry */
export async function loadHoldBars(f, exp) {
  const r = await query(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, open::float o, high::float h, low::float l FROM price_bars_primary WHERE symbol='NQ' AND ts > $1::timestamp AND ts < $2::timestamp ORDER BY ts`, [f.slice(0, 19), fmtUTC(tsMs(exp) + 120000)]);
  const bars = r.rows.map((x) => ({ ms: tsMs(x.t), o: x.o, h: x.h, l: x.l })), expMs = tsMs(exp);
  if (!bars.some((b) => b.ms >= expMs)) {                       // the expiry fell in a market closure (weekend, daily break): the exit is the first bar at or after it, whenever that is (same as the replay)
    const e = await query(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, open::float o, high::float h, low::float l FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp ORDER BY ts LIMIT 1`, [exp.slice(0, 19), fmtUTC(expMs + 4 * 86400000)]);
    for (const x of e.rows) bars.push({ ms: tsMs(x.t), o: x.o, h: x.h, l: x.l });
  }
  return bars;
}
/** C0 path: { state: 'EXP'|'STOP', ms (exit bar start), px } or null while open. Expiry is checked before the stop in a bar, as in the replay. */
export function simulateC0(bars, side, stop, fMs, expMs) {
  for (const b of bars) {
    if (b.ms <= fMs) continue;
    if (b.ms >= expMs) return { state: 'EXP', ms: b.ms, px: b.o };
    if (side === 1 ? b.l <= stop : b.h >= stop) return { state: 'STOP', ms: b.ms, px: side === 1 ? Math.min(stop, b.o) : Math.max(stop, b.o) };
  }
  return null;
}
/** Both arms for one row. events = the logger's `loadEvents()` list ({id, ms, dir, eo, qual}). Returns { c0, h, hc0, ha } with states OPEN / STOP / EXP / SIGNAL. */
export function computeArms({ side, entry, stop, f, exp, events, bars, actualPnl }) {
  const fMs = tsMs(f), expMs = tsMs(exp || flatTime(f)), cost = (px) => side * (px - entry) * 2 - 2, lastBarMs = bars.length ? bars[bars.length - 1].ms : null;
  const p = simulateC0(bars, side, stop, fMs, expMs);
  const c0 = p ? { state: p.state, ms: p.ms, px: p.px, pnl: cost(p.px) } : { state: 'OPEN', ms: null, px: null, pnl: null };
  // a thrust counts only before the C0 exit (a stop bar starting at or before the thrust wins); while C0 is open it must lie at or before the last known bar
  const thr = events.find((e) => e.qual && e.dir === side && e.ms > fMs && e.eo != null && (p ? e.ms < p.ms : (lastBarMs != null && e.ms <= lastBarMs)));
  const h = thr ? { state: 'SIGNAL', ms: thr.ms, px: thr.eo, pnl: cost(thr.eo), eventId: thr.id } : (p ? { ...c0 } : { state: 'OPEN', ms: null, px: null, pnl: null });
  const hTerm = h.state !== 'OPEN', cTerm = c0.state !== 'OPEN';
  return { c0, h, hc0: hTerm && cTerm ? h.pnl - c0.pnl : null, ha: hTerm && actualPnl != null ? h.pnl - actualPnl : null };
}
