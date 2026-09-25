// Opening-drive counter-trade gate (2026-09-25). During 9:31-10:00 ET, force SHADOW any new
// candidate whose direction OPPOSES a strong move-so-far since the 9:30 open ("don't fade the
// opening drive while it's still happening").
//
// Evidence (real ACTIVE+SHADOW cluster-primary trades, no lookahead): scratch/
// analyze_opening_drive_pctile_20260925.mjs + audit_deepseek_claims_opening_20260925.mjs,
// RESEARCH_CLAIM opening_drive_counter_trade_20260925. At P=0.70, 11 weeks: blocked N=52,
// EV -$46.73/trade, day-blocked per-day-savings CI [7.3, 88.7]; both directions negative (LONG
// into a down-drive -$55, SHORT into an up-drive -$34); the same-strength WITH-drive trades won
// +$68/trade; positive in all 3 disjoint periods. 0 of the blocked trades were live ACTIVE-origin
// historically, so this is protective going forward, not a measured change to past live P&L.
// NOT a first-30-minutes direction gate for the rest of the day -- that broader idea tested
// negative (RESEARCH_CLAIM first30_direction_blanket_gate_negative_20260925). Globex analog tested
// flat (18:31-19:30 vs move since 18:00), so this is RTH-only by evidence, not by default.
//
// Design decisions from the 2026-09-25 DeepSeek design critique
// (scratch/deepseek_response_opening_drive_design_20260925.md), audited before accepting:
// - P is FROZEN at 0.70 (mid-plateau of a smooth p60-p85 sweep). The daily recheck script
//   (scripts/recheck_opening_drive_gate.mjs) reports drift only; it never changes P live --
//   letting a daily job re-pick P is optional stopping.
// - Never blocks the insert path: reads whatever closed bar is available (no retry/sleep), and
//   fails OPEN (not blocked) on any missing data or thin (<10 session) baseline.
// - Percentile definition is pinned: cutoff = sorted[min(len-1, floor(P*len))] over the prior
//   sessions' |move-so-far| at the SAME minute -- identical to the tested script's q().
// - IB-based setups self-gate until 10:30, so this is a no-op for them.
// Force-SHADOW (never skip), so blocked candidates still insert, resolve, and keep producing
// forward data for the pre-registered revisit (OPEN_DECISION opening_drive_gate_6week_revisit_
// 20260925).
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';

export const OPENING_DRIVE_GATE = Object.freeze({
  OPEN_MIN: 570,          // 9:30 ET
  WINDOW_START_MIN: 571,  // first minute with a closed bar
  WINDOW_END_MIN: 600,    // exclusive, 10:00 ET
  LOOKBACK_SESSIONS: 20,
  MIN_SESSIONS: 10,
  PERCENTILE: 0.70,       // frozen -- see header
  REASON: 'OPENING_DRIVE_COUNTER',
});

// Per-session array of move-so-far (close of each minute's bar, forward-filled, minus the 9:30
// bar's open) for minutes 570..599. `bars` = [{hm:'HH:MM', o, c}] for ONE session, any order.
export function sessionMoveSoFar(bars) {
  const byMin = new Map();
  for (const b of bars) { const [h, m] = b.hm.split(':').map(Number); byMin.set(h * 60 + m, b); }
  const b0 = byMin.get(OPENING_DRIVE_GATE.OPEN_MIN);
  if (!b0) return null;
  const out = new Array(OPENING_DRIVE_GATE.WINDOW_END_MIN - OPENING_DRIVE_GATE.OPEN_MIN).fill(null);
  let last = null;
  for (let m = OPENING_DRIVE_GATE.OPEN_MIN; m < OPENING_DRIVE_GATE.WINDOW_END_MIN; m++) {
    const b = byMin.get(m); if (b) last = b.c;
    out[m - OPENING_DRIVE_GATE.OPEN_MIN] = last == null ? null : last - b0.o;
  }
  return out;
}

// Baseline: for each minute index, the sorted |move-so-far| across prior sessions.
export function buildBaseline(priorSessionMoves) {
  const n = OPENING_DRIVE_GATE.WINDOW_END_MIN - OPENING_DRIVE_GATE.OPEN_MIN;
  const perMin = [];
  for (let i = 0; i < n; i++) {
    perMin.push(priorSessionMoves.map(a => a?.[i]).filter(v => v != null).map(Math.abs).sort((x, y) => x - y));
  }
  return perMin;
}

// Pure classifier, shared by the live wrapper and the recheck script.
// etMin = the candidate's fire minute (ET); moveSoFar = last CLOSED bar's close - 9:30 open.
export function classifyOpeningDriveCounter({ direction, etMin, moveSoFar, baseline, percentile = OPENING_DRIVE_GATE.PERCENTILE }) {
  const none = { applies: false, blocked: false };
  if (direction !== 'LONG' && direction !== 'SHORT') return none;
  if (etMin < OPENING_DRIVE_GATE.WINDOW_START_MIN || etMin >= OPENING_DRIVE_GATE.WINDOW_END_MIN) return none;
  if (moveSoFar == null || !baseline) return none;
  const idx = etMin - 1 - OPENING_DRIVE_GATE.OPEN_MIN;
  const v = baseline[idx];
  if (!v || v.length < OPENING_DRIVE_GATE.MIN_SESSIONS) return none;
  const cutoff = v[Math.min(v.length - 1, Math.floor(percentile * v.length))];
  const against = moveSoFar !== 0 && (direction === 'LONG' ? -1 : 1) === Math.sign(moveSoFar);
  const strong = Math.abs(moveSoFar) >= cutoff;
  return { applies: true, blocked: against && strong, against, strong, moveSoFar, cutoff, sessions: v.length };
}

function etNow() {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { etMin: nowET.getHours() * 60 + nowET.getMinutes(), todayET: nowET.toLocaleDateString('en-CA') };
}

// Prior-session baseline for `todayET`, cached for the day (strictly < today -- never includes
// today's forming bars).
async function getBaseline(todayET) {
  const key = `openingDriveBaseline:${todayET}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const { rows } = await query(`
    SELECT ts::date::text AS d, to_char(ts, 'HH24:MI') AS hm, open::float AS o, close::float AS c
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts >= ($1::date - 45) AND ts < $1::date
      AND ts::time >= '09:30' AND ts::time < '10:00'
    ORDER BY ts`, [todayET]);
  const byDay = new Map();
  for (const r of rows) { if (!byDay.has(r.d)) byDay.set(r.d, []); byDay.get(r.d).push(r); }
  const moves = [...byDay.keys()].sort().map(d => sessionMoveSoFar(byDay.get(d))).filter(Boolean)
    .slice(-OPENING_DRIVE_GATE.LOOKBACK_SESSIONS);
  return cacheSet(key, buildBaseline(moves), 6 * 3600_000);
}

// Evaluates the gate for an explicit trading date + ET fire minute (live wrapper below passes the
// real clock; tests/backfills pass a historical date). Uses whichever bar before `etMin` is
// already ingested -- never waits for a late bar. Fails open on any error or missing data.
export async function evaluateOpeningDrive(direction, todayET, etMin) {
  try {
    if (etMin < OPENING_DRIVE_GATE.WINDOW_START_MIN || etMin >= OPENING_DRIVE_GATE.WINDOW_END_MIN) return { applies: false, blocked: false };
    if (direction !== 'LONG' && direction !== 'SHORT') return { applies: false, blocked: false };
    const [baseline, px] = await Promise.all([
      getBaseline(todayET),
      query(`
        SELECT (SELECT open::float FROM price_bars_primary WHERE symbol='NQ' AND ts = $1::date + TIME '09:30') AS open930,
               (SELECT close::float FROM price_bars_primary WHERE symbol='NQ'
                  AND ts >= $1::date + TIME '09:30' AND ts < $1::date + make_interval(mins => $2::int)
                ORDER BY ts DESC LIMIT 1) AS last_close`, [todayET, etMin]),
    ]);
    const { open930, last_close } = px.rows[0] ?? {};
    if (open930 == null || last_close == null) return { applies: false, blocked: false };
    return classifyOpeningDriveCounter({ direction, etMin, moveSoFar: last_close - open930, baseline });
  } catch (_) {
    return { applies: false, blocked: false };
  }
}

// Live check. Returns quickly (no queries) outside 9:31-10:00 ET.
export async function isOpeningDriveCounterTrade(direction) {
  try {
    const { etMin, todayET } = etNow();
    return await evaluateOpeningDrive(direction, todayET, etMin);
  } catch (_) {
    return { applies: false, blocked: false };
  }
}
