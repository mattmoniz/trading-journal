// Shared exit simulation + control sampling for the four-hour studies (extracted 2026-10-26 from study_four_hour_moonshot_exit_20261026.mjs so the stored-level study uses the SAME code).
import { clock, mean, walk } from './floorEngine.mjs';
export const COST = 1.5, PTV = 2, NDRAW = 30; // points per trade, MNQ dollars per point, controls per event
export const ARMS = { M: { stop: 0.5, hold: 1440 }, S25: { stop: 0.25, hold: 1440 }, S100: { stop: 1.0, hold: 1440 }, H240: { stop: 0.5, hold: 240 }, H2880: { stop: 0.5, hold: 2880 }, T100: { stop: 0.5, hold: 2880, tgt: 1.0 }, STRUCT: { struct: true, hold: 1440 }, FREE: { stop: null, hold: 1440 }, M_LEN: { stop: 0.5, hold: 1440, lenient: true }, FREE_LEN: { stop: null, hold: 1440, lenient: true } };
export function makeSim(NQ) {
  // lenient = exit at the last bar at or before the target minute (maintenance gap, weekend)
  const capOf = (i0, hold, lenient) => { let cap = NQ.byEm.get(NQ.EM[i0] + hold - 1); if (cap === undefined && lenient) for (let m = NQ.EM[i0] + hold - 2; m > NQ.EM[i0] + 60 && cap === undefined; m--) cap = NQ.byEm.get(m); return cap; };
  const run = (i0, dir, stopPts, tgtPts, arm) => { const cap = capOf(i0, arm.hold, arm.lenient); if (cap === undefined) return null; const r = walk(NQ, i0, dir, NQ.O[i0], stopPts, tgtPts, cap); return { pnl: r.pts - COST, res: r.res }; };
  const stopOf = (e, arm) => (arm.struct ? Math.max(1, e.dir > 0 ? NQ.O[e.i0] - (e.level - e.band) : e.level + e.band - NQ.O[e.i0]) : arm.stop == null ? Infinity : arm.stop * e.d20);
  const strictOK = (e) => NQ.byEm.get(NQ.EM[e.i0] + 1439) !== undefined;
  return { capOf, run, stopOf, strictOK };
}
// blind clock-matched entry draws inside the event's own partition (A = explore dates at least 4 days before the cut, H = after the cut)
export function blindDraws(NQ, samp, rng, e, okDay) { const ec = clock(NQ.T[e.i0]), out = []; for (let t = 0; t < 3000 && out.length < NDRAW; t++) { const b = samp[Math.floor(rng() * samp.length)]; if (NQ.TD[b] === e.day || !okDay(e.part, NQ.TD[b]) || Math.abs(clock(NQ.T[b]) - ec) > 30) continue; out.push(b + 1); } return out; }
export function poolDraws(rng, pool, n = NDRAW) { const out = []; for (let t = 0; t < 3 * n && pool.length && out.length < Math.min(n, pool.length); t++) { const k = pool[Math.floor(rng() * pool.length)]; if (!out.includes(k)) out.push(k); } return out; }
