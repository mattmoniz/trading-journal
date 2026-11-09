// Rotation guide (2026-11-04, user: use the rotational VWAP as a GUIDE for the tell, then talk targets and stops). Display only: gates nothing, sizes nothing, places no order, is NOT VALIDATED.
// The state of the CURRENT confirmed 65-point leg from the REAL detector (rotationDetector.js detectRotationLegs, intrabar highs and lows, run over the RTH 1-minute bars from 09:30): its direction, the pivot where it
// started, when it was confirmed, the volume-weighted VWAP anchored at that pivot (typical price (high + low + close) / 3 weighted by volume), which side of it price is on, whether the leg has LOST its VWAP (an up-leg with
// price under its VWAP, a down-leg with price over it), the raw move of the VWAP and of price over the last MOVE_WINDOW_MIN minutes (the user's 'the slope of the VWAP flattens while price keeps rising'; raw numbers, no threshold),
// and how many legs were confirmed in the last hour (a quick flip-back, the 'tussle'). A flip is a new confirmed opposite leg: the VWAP re-anchors to the other side of price.
// Research note (docs/TELL_ROTATION_VWAP_PREREG_20261104.md section 7): as a net-dollar FILTER on 1,000 early explore fires nothing separated and the test could not have seen under about 22 dollars per trade; this is a reading aid.
// All price_bars_primary queries carry BOTH bounds (cv-009); the live board is cached (cv-044); the latest bar and its age are always returned (a stale feed is shown, never hidden, hr-014).
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { detectRotationLegs } from './rotationDetector.js';

export const MOVE_WINDOW_MIN = 10;      // display window of the VWAP / price move readout (display only, not a cutoff)
const LIVE_TTL_MS = 15_000, STALE_MIN = 10;
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10), r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
export const hhmm = (m) => `${String(Math.floor((m + 570) / 60)).padStart(2, '0')}:${String((m + 570) % 60).padStart(2, '0')}`;

/** rth = [{m (minute of RTH, 0 = 09:30), h, l, c, v}] ordered. Returns { legs, stateAt(i) } where i indexes rth (the state after COMPLETED minute i). */
export function rotationSeries(rth) {
  const legs = detectRotationLegs(rth.map((b) => ({ high: b.h, low: b.l })));
  const PV = [0], V = [0], P = [0];
  rth.forEach((b, i) => { const tp = (b.h + b.l + b.c) / 3, v = b.v || 0; PV.push(PV[i] + tp * v); V.push(V[i] + v); P.push(P[i] + tp); });
  const rv = (a, i) => (V[i + 1] - V[a] > 0 ? (PV[i + 1] - PV[a]) / (V[i + 1] - V[a]) : (P[i + 1] - P[a]) / (i + 1 - a));
  const stateAt = (i) => {
    if (i < 0 || i >= rth.length) return null;
    let li = -1; for (let k = 0; k < legs.length && legs[k].idx <= i; k++) li = k;
    if (li < 0) return { dir: null, note: 'no 65-point leg confirmed yet', price: rth[i].c, asOfM: rth[i].m };
    const L = legs[li], a = L.anchorIdx, up = L.dir === 'UP', price = rth[i].c, vw = rv(a, i), anchorPrice = up ? rth[a].l : rth[a].h;
    const j = i - MOVE_WINDOW_MIN, vwMove = j > a ? vw - rv(a, j) : null, priceMove = j >= 0 ? price - rth[j].c : null;
    return { dir: L.dir, anchorT: hhmm(rth[a].m), anchorPrice: r2(anchorPrice), confirmedT: hhmm(rth[L.idx].m), size: L.size, rvwap: r2(vw), price: r2(price), side: price >= vw ? 'ABOVE' : 'BELOW', distPts: r1(price - vw),
      supported: up ? price >= vw : price <= vw, vwapMove: r1(vwMove), priceMove: r1(priceMove), minutesSinceConfirm: i - L.idx, asOfM: rth[i].m, legsLastHour: legs.filter((x) => x.idx <= i && x.idx > i - 60).length };
  };
  return { legs: legs.map((L) => ({ dir: L.dir, anchorT: hhmm(rth[L.anchorIdx].m), anchorPrice: r2(L.dir === 'UP' ? rth[L.anchorIdx].l : rth[L.anchorIdx].h), confirmedT: hhmm(rth[L.idx].m), size: L.size })), stateAt };
}

const BARS_SQL = `SELECT (EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int - 570) AS m, high::float AS h, low::float AS l, close::float AS c, COALESCE(volume, 0)::float AS v, ts::text AS t FROM price_bars_primary`;

/** Live board for today's RTH: the current state, the legs so far and the feed age. */
export async function getRotationGuide() {
  const hit = cacheGet('rotguide:live'); if (hit != null) return hit;
  const rows = (await query(`${BARS_SQL} WHERE symbol='NQ' AND ts >= (CURRENT_DATE + TIME '09:30') AND ts < (CURRENT_DATE + TIME '16:00') ORDER BY ts`)).rows;
  let board;
  if (!rows.length) board = { state: 'NOT_STARTED', note: 'No RTH bar yet today.' };
  else {
    const s = rotationSeries(rows), last = rows[rows.length - 1];
    const a = (await query(`SELECT ROUND(EXTRACT(EPOCH FROM (now() - $1::timestamp)) / 60.0)::int AS age, (localtime >= TIME '09:40' AND localtime < TIME '16:00') AS live`, [last.t])).rows[0];
    board = { state: 'OK', asOf: String(last.t).slice(11, 16), ageMin: a.age, stale: a.live && a.age > STALE_MIN, moveWindowMin: MOVE_WINDOW_MIN, now: s.stateAt(rows.length - 1), legs: s.legs.slice(-8),
      notes: ['A reading aid: gates nothing, sizes nothing, not validated. Legs are the real 65-point detector on the RTH minute bars from 09:30; the VWAP is anchored at the start (pivot) of the current confirmed leg; a flip is a new confirmed opposite leg.',
              'As a net-dollar filter on about 1,000 early explore fires nothing separated and the test could not have seen under about $22 per trade (claim tell_rotation_vwap_not_shown_20261104).'] };
  }
  return cacheSet('rotguide:live', board, LIVE_TTL_MS);
}

/** The state at each tell fire of a trade date: the last COMPLETED minute strictly before the fire's minute. fires = [{ id, firedAt: 'YYYY-MM-DD HH:MM:SS[.fff]' }]. Returns { [id]: state | null }. */
export async function getRotationAtFires(date, fires) {
  if (!date || !fires?.length) return {};
  let rows = cacheGet(`rotguide:day:${date}`);
  if (rows == null) {
    rows = (await query(`${BARS_SQL} WHERE symbol='NQ' AND ts >= ($1::timestamp + interval '9 hours 30 minutes') AND ts < ($1::timestamp + interval '16 hours') ORDER BY ts`, [date])).rows;
    cacheSet(`rotguide:day:${date}`, rows, 5 * 60_000);
  }
  if (!rows.length) return Object.fromEntries(fires.map((f) => [f.id, null]));
  const s = rotationSeries(rows), out = {};
  for (const f of fires) {
    const hm = String(f.firedAt).slice(11, 16); if (hm.length < 5) { out[f.id] = null; continue; }
    const k = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) - 570; let i = -1; for (let q = 0; q < rows.length && rows[q].m < k; q++) i = q;
    out[f.id] = i >= 0 ? s.stateAt(i) : null;
  }
  return out;
}
