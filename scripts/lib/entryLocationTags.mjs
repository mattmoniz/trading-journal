// Entry-LOCATION tags of the capitulation-exit work (register row 30; docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md and docs/CAPITULATION_REPLACES_TARGET_PREREG_20261109.md), extracted from
// scripts/capitulation_exit_shadow.mjs on 2026-11-09 night (cv-079) so the forward logger and the historical backfill use ONE implementation. Behavior identical to the logger's frozen build-time tags.
import { query } from '../../server/db.js';
import { emOf } from './floorEngine.mjs';
import { load5m, pivotTimeline, indexByDate, pivotAt } from './pivotContext.mjs';
import { fmtUTC, tsMs, sessionStartMs } from './levelContext.mjs';
export const AT_BOUNDARY_ADR = 0.05;
/** row = { td, f (naive ET string), side (+1/-1), entry }; adr = ADR20. at_boundary: entry within AT_BOUNDARY_ADR x ADR20 of the prior RTH high/low/VAH/VAL (level_prices PD_*) or the overnight high/low (fired 02:00-17:00 ET, causal). */
export async function levelsFor(row, adr) {
  const pd = (await query(`SELECT level_name, price::float p FROM level_prices WHERE trade_date = $1::date AND level_name IN ('PD_HIGH','PD_LOW','PD_VAH','PD_VAL')`, [row.td])).rows; const L = Object.fromEntries(pd.map((x) => [x.level_name, x.p]));
  const ms = tsMs(row.f), mod = +row.f.slice(11, 13) * 60 + +row.f.slice(14, 16);
  if (mod >= 120 && mod < 1020) {                                // overnight extremes only once the overnight is >= 8 hours old (fired 02:00-17:00 ET), computed causally from the session start
    const lim = Math.min(ms, Date.UTC(+row.td.slice(0, 4), +row.td.slice(5, 7) - 1, +row.td.slice(8, 10), 9, 30, 0));
    const r = await query(`SELECT max(high)::float h, min(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp`, [fmtUTC(sessionStartMs(row.td)), fmtUTC(lim)]);
    if (r.rows[0]?.h != null) { L.ONH = r.rows[0].h; L.ONL = r.rows[0].l; }
  }
  const names = row.side === -1 ? ['PD_HIGH', 'PD_VAH', 'ONH'] : ['PD_LOW', 'PD_VAL', 'ONL']; let best = null;
  for (const n of names) if (L[n] != null) { const d = Math.abs(row.entry - L[n]); if (!best || d < best.d) best = { n, d }; }
  return best ? { at: best.d <= AT_BOUNDARY_ADR * adr, name: best.n, distAdr: best.d / adr, dPts: best.d } : { at: null, name: null, distAdr: null, dPts: null };
}

/** Pivot candidates (live confirmed swing pivots) for the given trade dates, from 5-minute bars between `from` and `to` (the logger passes the last 140 days). */
export async function loadPivotCands(from, to, dates) {
  const b = await load5m(from, to); const tl = await pivotTimeline(b.bars5m, b.atr); if (!tl.same) console.warn('WARNING: pivot timeline differs from the shared walk');
  return indexByDate(tl.piv, dates);
}
/** pivot_live: a live, confirmed (>= 30 min) swing pivot of the fade side (HIGH for a short, LOW for a long) whose band holds the entry; tests = completed prior tests. Returns { live, tests, dist } (live null when no candidates were loaded). */
export function pivotTag(cands, side, entry, fStr) {
  const T = emOf(fStr.slice(0, 19)), pv = cands ? pivotAt(cands.get(fStr.slice(0, 10)) || [], side === -1 ? 'HIGH' : 'LOW', entry, T) : null;
  return { live: pv ? true : (cands ? false : null), tests: pv ? pv.p.tests.filter((t) => t <= T).length : null, dist: pv ? pv.dist : null };
}
