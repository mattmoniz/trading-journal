// Read-only "what the system sees now" board for the Monitor & Learning page (key `dayContext` of GET /api/setups/monitor-summary). Display only: nothing here gates, sizes or signals anything.
// Contents: the latest bar and its age (a stale feed is shown, never hidden, hr-014), the ADR (median RTH range of the last 20 completed sessions), tonight's overnight range in ADR, the initial-balance state once the first RTH hour is
// complete (docs/IB_TIGHTEN_LEVELS_PREREG_20261104.md: NORMAL / VARIATION / TREND / NEUTRAL, side 'extended' beyond 0.1 IBR), the watcher's current state, and the UNFINISHED BUSINESS of the last 5 completed sessions that no later completed session has
// filled (single-print zones and poor highs / lows by the TradingView TPO rules, a JS port of scripts/tell_context/tpo_lib.py; parity test: scripts/test_day_context.mjs).
// Research reading, stated on the card: carried-forward levels pulled price only about 3 points more often than equal-distance random levels, pre-open context predicts the day's WIDTH but not balance vs imbalance (claims
// carried_levels_small_pull_20261104, daytype_forecast_v1_explore_20261104). All price_bars_primary queries carry BOTH bounds (cv-009); day-stable parts are cached per trade date (cv-044).
import { query } from '../db.js';
import { getDayStateSnapshot } from './dayStateService.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getRotationGuide } from './rotationGuide.js';

const TICK = 0.25, TOL = 0.1, LOOKBACK_SESSIONS = 5, ADR_N = 20, LIVE_TTL_MS = 30_000;
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10), r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
/** Python's round(): halves go to the even integer (the research code used it for the row size). */
export function pyRound(x) { const f = Math.floor(x), d = x - f; if (d < 0.5) return f; if (d > 0.5) return f + 1; return f % 2 === 0 ? f : f + 1; }

/** TradingView TPO rules on RTH 1-minute bars [{m (minute of RTH), h, l}]: 30-minute blocks, auto row size ~80 rows (increment 5 up to 100 ticks per row, then 50), a row counts one block per bracket in which price traversed it.
 *  Returns { poorHigh, poorLow, zones: [[lowPrice, highPrice]] } (single-print zones = runs of >= 2 consecutive non-extreme rows with exactly one block) or null. */
export function tpoLevels(bars) {
  if (!bars || bars.length < 30) return null;
  let lo = Infinity, hi = -Infinity; for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  const rt = (hi - lo) / TICK / 80; if (!(rt > 0)) return null;
  const inc = rt <= 100 ? 5 : 50, tpr = rt >= 1 ? Math.max(inc, pyRound(rt / inc) * inc) : 1, rs = tpr * TICK, nrow = Math.floor((hi - lo) / rs) + 1, cnt = new Array(nrow).fill(0);
  const byBr = new Map(); for (const b of bars) { const k = Math.floor(b.m / 30); (byBr.get(k) || byBr.set(k, []).get(k)).push(b); }
  for (const arr of byBr.values()) { const seen = new Array(nrow).fill(false); for (const b of arr) { const a = Math.max(0, Math.floor((b.l - lo) / rs)), z = Math.min(nrow - 1, Math.floor((b.h - lo) / rs)); for (let r = a; r <= z; r++) seen[r] = true; } for (let r = 0; r < nrow; r++) if (seen[r]) cnt[r] += 1; }
  const poorHigh = cnt[nrow - 1] >= 2 ? hi : null, poorLow = cnt[0] >= 2 ? lo : null, runs = []; let s0 = null, pv = null;
  for (let r = 1; r <= nrow - 2; r++) { if (cnt[r] !== 1) continue; if (s0 === null) { s0 = pv = r; } else if (r === pv + 1) pv = r; else { runs.push([s0, pv]); s0 = pv = r; } }
  if (s0 !== null) runs.push([s0, pv]);
  return { poorHigh, poorLow, zones: runs.filter(([a, b]) => b - a >= 1).map(([a, b]) => [lo + a * rs, lo + (b + 1) * rs]) };
}

/** IB state after the RTH bars so far: IB = the RTH high / low of the first 60 minutes; a side is 'extended' beyond TOL x IBR; VARIATION up to 2 IBR, TREND beyond. null until the first RTH hour is complete. */
export function ibState(rth) {
  const ib = rth.filter((b) => b.m < 60); if (ib.length < 30 || rth[rth.length - 1].m < 59) return null;
  const ibh = Math.max(...ib.map((b) => b.h)), ibl = Math.min(...ib.map((b) => b.l)), ibr = ibh - ibl; if (!(ibr > 0)) return null;
  const xu = Math.max(0, Math.max(...rth.map((b) => b.h)) - ibh) / ibr, xd = Math.max(0, ibl - Math.min(...rth.map((b) => b.l))) / ibr, su = xu > TOL, sd = xd > TOL;
  const state = !su && !sd ? 'NORMAL' : su && sd ? 'NEUTRAL' : Math.max(xu, xd) <= 2 ? 'VARIATION' : 'TREND';
  return { state, ibh, ibl, ibr, extensionUp: r2(xu), extensionDown: r2(xd) };
}

async function sessionsPart(cd, completeToday) {
  const key = `dayctx:sessions:${cd}:${completeToday ? 1 : 0}`, hit = cacheGet(key); if (hit != null) return hit;
  const days = (await query(`SELECT ts::date::text AS d, MAX(high)::float AS h, MIN(low)::float AS l, COUNT(*)::int AS n FROM price_bars_primary WHERE symbol='NQ' AND ts >= (CURRENT_DATE - 45)::timestamp AND ts < (CURRENT_DATE + 1)::timestamp
    AND ts::time >= '09:30' AND ts::time < '16:00' GROUP BY 1 HAVING COUNT(*) > 300 ORDER BY 1`)).rows.filter((x) => x.d < cd || (completeToday && x.d === cd));
  const adr = median(days.slice(-ADR_N).map((x) => x.h - x.l)), last = days.slice(-LOOKBACK_SESSIONS); let levels = [];
  if (last.length) {
    const rows = (await query(`SELECT ts::date::text AS d, (EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int - 570) AS m, high::float AS h, low::float AS l FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp + interval '9 hours 30 minutes'
      AND ts < $2::timestamp + interval '16 hours' AND ts::time >= '09:30' AND ts::time < '16:00' ORDER BY ts`, [last[0].d, last[last.length - 1].d])).rows;
    const by = new Map(); for (const x of rows) (by.get(x.d) || by.set(x.d, []).get(x.d)).push(x);
    for (let i = 0; i < last.length; i++) {
      const t = tpoLevels(by.get(last[i].d)); if (!t) continue; const later = last.slice(i + 1), add = (kind, lo, hi, typ) => {
        const filled = later.some((s) => (typ === 'z' ? s.l <= lo && s.h >= hi : typ === 'h' ? s.h > hi : s.l < lo)); if (!filled) levels.push({ date: last[i].d, kind, lo, hi });
      };
      for (const z of t.zones) add('single prints', z[0], z[1], 'z'); if (t.poorHigh != null) add('poor high', t.poorHigh, t.poorHigh, 'h'); if (t.poorLow != null) add('poor low', t.poorLow, t.poorLow, 'l');
    }
  }
  return cacheSet(key, { adr, sessions: days.slice(-8).map((x) => ({ d: x.d, range: r1(x.h - x.l) })), levels }, 10 * 60_000);
}

export async function getDayContextBoard() {
  const live = cacheGet('dayctx:live'); if (live != null) return live;
  const c = (await query(`SELECT CURRENT_DATE::text AS cd, EXTRACT(hour FROM now())::int AS h, EXTRACT(minute FROM now())::int AS mi, (CASE WHEN EXTRACT(hour FROM now()) >= 18 THEN CURRENT_DATE + 1 ELSE CURRENT_DATE END)::text AS td,
    (CASE WHEN EXTRACT(hour FROM now()) >= 18 THEN CURRENT_DATE ELSE CURRENT_DATE - 1 END)::text AS ond`)).rows[0];
  const completeToday = c.h >= 16, sp = await sessionsPart(c.cd, completeToday);
  const ov = (await query(`SELECT ts::text AS t, open::float AS o, high::float AS h, low::float AS l, close::float AS c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp + interval '18 hours' AND ts < $1::timestamp + interval '42 hours' ORDER BY ts`, [c.ond])).rows;
  const rthStarted = c.h < 18 && c.h * 60 + c.mi >= 570 + 1;
  const rth = rthStarted ? (await query(`SELECT (EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int - 570) AS m, high::float AS h, low::float AS l, close::float AS c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp + interval '9 hours 30 minutes'
    AND ts < $1::timestamp + interval '16 hours' ORDER BY ts`, [c.cd])).rows : [];
  const overnight = ov.filter((b) => !rthStarted || b.t.slice(11, 16) < '09:30');
  const lastBar = ov[ov.length - 1] || null, lastTs = lastBar ? lastBar.t : null;      // ov spans the whole session so far (overnight and RTH), so its last row is the latest bar
  const ageMin = lastTs ? (await query(`SELECT ROUND(EXTRACT(EPOCH FROM (now() - $1::timestamp)) / 60.0)::int AS a`, [lastTs])).rows[0].a : null;
  const price = lastBar ? lastBar.c : null, adr = sp.adr;
  let on = null; if (overnight.length) { const hi = Math.max(...overnight.map((b) => b.h)), lo = Math.min(...overnight.map((b) => b.l)), first = overnight[0].o, last = overnight[overnight.length - 1].c; on = { open: first, high: hi, low: lo, last, range: r1(hi - lo), rangeAdr: adr ? r2((hi - lo) / adr) : null, net: r1(last - first), lowToLast: r1(last - lo), highToLast: r1(hi - last), bars: overnight.length }; }
  const ib = rth.length ? ibState(rth) : null;
  const ibNote = !rthStarted ? 'RTH not started' : (ib ? null : 'first RTH hour not complete (IB forming)');
  const w = (await query(`SELECT state, to_char(bar_end_et, 'HH24:MI') AS t FROM tell_watcher_states WHERE trade_date = $1::date ORDER BY bar_idx DESC LIMIT 1`, [c.td])).rows[0] || null;
  // unfinished business relative to the latest price; 'touched' = tonight's / today's range has already traded into it (it may be partly filled since the sessions that left it)
  const cur = rth.length ? { lo: Math.min(...rth.map((b) => b.l), on ? on.low : Infinity), hi: Math.max(...rth.map((b) => b.h), on ? on.high : -Infinity) } : (on ? { lo: on.low, hi: on.high } : null);
  const tag = (L) => ({ date: L.date, kind: L.kind, lo: L.lo, hi: L.hi, width: r1(L.hi - L.lo), touched: !!cur && cur.hi >= L.lo && cur.lo <= L.hi });
  const above = [], below = [];
  if (price != null) for (const L of sp.levels) { const t = tag(L); if (L.lo > price) above.push({ ...t, distPts: r1(L.lo - price), distAdr: adr ? r2((L.lo - price) / adr) : null }); else if (L.hi < price) below.push({ ...t, distPts: r1(price - L.hi), distAdr: adr ? r2((price - L.hi) / adr) : null }); }
  above.sort((a, b) => a.distPts - b.distPts); below.sort((a, b) => a.distPts - b.distPts);
  const stale = ageMin != null && ageMin > 10;
  let dayState; try { dayState = await getDayStateSnapshot(); } catch (e) { dayState = { error: e.message }; }                       // the symmetric liquidation / melt-up state (dayState.js); a failure here never takes the card down
  let rotation; try { rotation = await getRotationGuide(); } catch (e) { rotation = { state: 'ERROR', error: e.message }; }       // a failure here never takes the day-context card down
  const board = { state: price == null ? 'NO_DATA' : 'OK', rotation, dayState, asOf: lastTs, ageMin, stale, price, adr: r1(adr), tradeDate: c.td, overnight: on, ib, ibNote, watcher: w, above: above.slice(0, 6), below: below.slice(0, 6), unfilledTotal: sp.levels.length, recentSessions: sp.sessions,
    notes: ['Display only, with ONE exception: while the RTH day state is a liquidation (DOWN_EARLY / DOWN_CONFIRMED) the AMT tell sends no LONG order on Sim1; the skipped tell is still scored (order state SKIPPED_LIQ). Everything else here gates nothing, sizes nothing, is not a signal. Unfilled business is context.', 'Research so far: carried-forward levels pull price about 3 points more often than equal-distance random levels (small); the pre-open context predicts how WIDE the day will be, not whether it is balance or imbalance.', 'Levels are the last 5 completed RTH sessions\' single-print zones and poor highs / lows (TradingView TPO rules), not yet filled by a later completed session.'] };
  return cacheSet('dayctx:live', board, LIVE_TTL_MS);
}
