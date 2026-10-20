// Day type right now (informational only, never gates anything): how much of the session's range has been used so far, ranked against the
// previous 60 sessions at the same clock time, in the three bands frozen for forward-monitor rule R4 (docs/ROTATION_GATE_FORWARD_MONITOR_PREREG_20261020.md).
// Same definition as scripts/monitor_rotation_gate_forward.mjs: developing range = (highest high - lowest low from the 09:30 open through the last COMPLETED 1-minute bar) / ATR20
// (ATR20 = mean RTH range of the 20 previous sessions); rank = share of the previous 60 sessions' value at that same clock bar that is <= today's, needs >= 40 of them.
// LOW (< cuts.low) = balance-like, MID = middle, HIGH (>= cuts.high) = expansion-like. It measures how much range has been used, not whether the tape is choppy now: range only grows,
// so a day that expands early stays HIGH even when it goes sideways. Own file (not acd.js/setups.js): this is a display read, nothing consumes it.
import fs from 'fs';
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
const CUTS = JSON.parse(fs.readFileSync(new URL('../../docs/forward_monitor_frozen_cuts_20261020.json', import.meta.url), 'utf8')).R4_developing_range_rank_cuts;
const LOW = CUTS.low_mid, HIGH = CUTS.mid_high, MIN_PRIOR = 40, NPRIOR = 60, MIN_BARS_TODAY = 15;
const RTH_SQL = `ts::time >= '09:30' AND ts::time < '16:00'`;
function running(rows) {                              // rows: [{m,h,l}] in time order -> { byMinute: Map(m -> [hi, lo]) }
  const by = new Map(); let hi = -Infinity, lo = Infinity; for (const r of rows) { hi = Math.max(hi, r.h); lo = Math.min(lo, r.l); by.set(r.m, [hi, lo]); } return by; }
async function history() {                            // previous ~80 completed sessions (60 ranked + 20 for each one's ATR20); cached for the day
  const hit = cacheGet('dayTypeHistory'); if (hit) return hit;
  const rows = (await query(`SELECT ts::date::text d, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int m, high::float h, low::float l FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 140 AND ts < CURRENT_DATE AND ${RTH_SQL} ORDER BY ts`)).rows;
  const byDay = new Map(); for (const r of rows) (byDay.get(r.d) || byDay.set(r.d, []).get(r.d)).push(r);
  const sessions = [...byDay.entries()].filter(([, v]) => v.length > 300).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => { const by = running(v); const last = by.get(Math.max(...by.keys())); return { d, by, range: last[0] - last[1] }; });
  return cacheSet('dayTypeHistory', sessions, 6 * 3600 * 1000);
}
export async function getDayTypeNow() {
  const hist = await history(); const todayRows = (await query(`SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int m, high::float h, low::float l FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE AND ts < CURRENT_DATE + 1 AND ${RTH_SQL} ORDER BY ts`)).rows;
  const base = { cuts: { low: LOW, high: HIGH }, definition: 'range so far / ATR20, ranked vs the previous 60 sessions at the same clock time', priorSessions: 0 };
  if (hist.length < 20 + MIN_PRIOR) return { ...base, regime: null, reason: 'not enough history' };
  if (todayRows.length < MIN_BARS_TODAY) return { ...base, regime: null, reason: todayRows.length ? 'range still forming (first 15 minutes)' : 'no session yet today' };
  const nowMin = Number((await query(`SELECT (EXTRACT(hour FROM now())*60+EXTRACT(minute FROM now()))::int m`)).rows[0].m);
  const done = todayRows.filter((r) => r.m < Math.min(nowMin, 960)); if (done.length < MIN_BARS_TODAY) return { ...base, regime: null, reason: 'range still forming (first 15 minutes)' };
  const by = running(done), m = Math.max(...by.keys()), [hi, lo] = by.get(m);
  const atr = hist.slice(-20).reduce((t, s) => t + s.range, 0) / 20; if (!(atr > 0)) return { ...base, regime: null, reason: 'no ATR' };
  const cur = (hi - lo) / atr; const prior = hist.slice(-NPRIOR); const vals = []; for (let k = 0; k < prior.length; k++) { const j = hist.length - prior.length + k; const a = hist.slice(Math.max(0, j - 20), j); const pm = prior[k].by.get(m); if (!pm || a.length < 20) continue; const pa = a.reduce((t, s) => t + s.range, 0) / 20; vals.push((pm[0] - pm[1]) / pa); }
  if (vals.length < MIN_PRIOR) return { ...base, regime: null, reason: 'too few comparable sessions at this time', priorSessions: vals.length };
  const rank = vals.filter((v) => v <= cur).length / vals.length;
  const regime = rank < LOW ? 'LOW' : rank < HIGH ? 'MID' : 'HIGH';
  return { ...base, regime, label: regime === 'LOW' ? 'balance-like' : regime === 'MID' ? 'middle' : 'expansion-like', rank: Math.round(rank * 100) / 100, rangePoints: Math.round(hi - lo), rangeXAtr: Math.round(cur * 100) / 100, atr20Points: Math.round(atr), asOfMinute: m, sessionOver: nowMin >= 960, priorSessions: vals.length };
}
