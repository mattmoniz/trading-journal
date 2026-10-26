// Overnight tripwire (2026-10-26, user: "I was sleeping and wouldn't see that. I need a tripwire for the system to acknowledge and start watching").
// Standalone and informational: it NEVER gates, sizes or delays any trade (every test of "wait for confirmation on heavy-volume nights" so far came back no better or inconclusive,
// see RESEARCH_CLAIM overnight_orderflow_high_volume_evening_not_better_20261026). It watches the current Globex night and says out loud when it is unusual.
// "Unusual" is DATA-DERIVED: tonight's cumulative volume and 65-point rotation-leg count at the latest 30-minute checkpoint are ranked against the same checkpoint on the prior 60
// completed nights (overnight_checkpoint_stats, built by scripts/build_overnight_checkpoint_stats.mjs). HEAVY = both at or above the 90th percentile of that baseline; BUSY = exactly one.
// The 90th percentile is an alert-sensitivity choice (about one night in ten per measure), not a trading threshold. Nothing is evaluated before 2 hours into the session (too few legs).
import { query } from '../db.js';
import { detectRotationLegs } from './rotationDetector.js';
import { nextTradingDay } from './acdShared.js';

export const CHECKPOINT_STEP = 30, MIN_ELAPSED = 120, BASELINE_NIGHTS = 60, ALERT_PCTL = 0.9;
// mid-rank percentile of x within arr (ties count half), in [0,1]
export function midRank(arr, x) { if (!arr.length) return null; let lt = 0, eq = 0; for (const v of arr) { if (v < x) lt++; else if (v === x) eq++; } return (lt + 0.5 * eq) / arr.length; }
export function classify({ vol, legs, baseVols, baseLegs, pctl = ALERT_PCTL }) {
  const volRank = midRank(baseVols, vol), legsRank = midRank(baseLegs, legs);
  if (volRank == null || legsRank == null || baseVols.length < 20) return { level: 'UNKNOWN', volRank, legsRank };
  const a = volRank >= pctl, b = legsRank >= pctl;
  return { level: a && b ? 'HEAVY' : (a || b) ? 'BUSY' : 'NORMAL', volRank, legsRank };
}
// session identity for a clock time: the evening date the night opened on, its trade date, and minutes since 18:00 ET
export function nightOf(nowET) {
  const hh = nowET.getUTCHours(), mm = nowET.getUTCMinutes(), ymd = nowET.toISOString().slice(0, 10);
  const evening = hh >= 18 ? ymd : new Date(Date.parse(ymd + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const elapsed = hh >= 18 ? (hh - 18) * 60 + mm : (hh + 6) * 60 + mm;
  const tradeDate = hh >= 18 ? nextTradingDay(new Date(evening + 'T12:00:00')) : ymd;
  return { evening, tradeDate, elapsed };
}
export async function getTripwireState(nowET) {
  const { evening, tradeDate, elapsed } = nightOf(nowET);
  if (elapsed > 930) return { level: 'OFF', reason: 'outside the overnight window', tradeDate };
  if (elapsed < MIN_ELAPSED) return { level: 'WARMING', elapsed, tradeDate };
  const cp = Math.min(Math.floor(elapsed / CHECKPOINT_STEP) * CHECKPOINT_STEP, 930);
  const nowStr = nowET.toISOString().slice(0, 19).replace('T', ' ');
  const bars = (await query(`SELECT ts::text t, high::float high, low::float low, volume::float v FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 AND ts < $2 ORDER BY ts`, [evening + ' 18:00', nowStr])).rows;
  const t0 = Date.parse(evening + 'T18:00:00Z'), cutoff = t0 + cp * 60000, upto = bars.filter((b) => Date.parse(b.t.replace(' ', 'T').slice(0, 19) + 'Z') < cutoff);
  if (upto.length < cp * 0.6) return { level: 'UNKNOWN', reason: `only ${upto.length} bars by checkpoint ${cp}`, tradeDate };
  const vol = Math.round(upto.reduce((s, b) => s + (b.v || 0), 0)), legs = detectRotationLegs(upto).length;
  const base = (await query(`SELECT volume::float v, legs FROM overnight_checkpoint_stats WHERE checkpoint_min = $1 AND trade_date < $2::date AND trade_date >= $2::date - 120 ORDER BY trade_date DESC LIMIT $3`, [cp, tradeDate, BASELINE_NIGHTS])).rows;
  const c = classify({ vol, legs, baseVols: base.map((r) => r.v), baseLegs: base.map((r) => r.legs) });
  const medVol = base.length ? [...base.map((r) => r.v)].sort((x, y) => x - y)[Math.floor(base.length / 2)] : null;
  return { ...c, tradeDate, evening, elapsed, checkpoint: cp, vol, legs, volRatio: medVol ? +(vol / medVol).toFixed(2) : null, baselineNights: base.length };
}
// poll body: record the first time each level is reached tonight and notify once for HEAVY. Returns the state.
export async function runTripwireCheck(nowET, notify) {
  const st = await getTripwireState(nowET);
  if (st.level === 'BUSY' || st.level === 'HEAVY') {
    const ins = await query(`INSERT INTO tripwire_events (trade_date, level, elapsed_min, vol_rank, legs_rank, vol_ratio, legs) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (trade_date, level) DO NOTHING RETURNING id`,
      [st.tradeDate, st.level, st.elapsed, st.volRank, st.legsRank, st.volRatio, st.legs]);
    if (ins.rows[0] && st.level === 'HEAVY' && notify) {
      const msg = `Heavy Globex night: volume ${st.volRatio}x the typical night at this hour (above ${(100 * st.volRank).toFixed(0)}% of the last ${st.baselineNights}), ${st.legs} swings of 65+ points (above ${(100 * st.legsRank).toFixed(0)}%). Watching.`;
      const r = await notify('NQ overnight: heavy night', msg).catch((e) => ({ ok: false, note: String(e.message || e) }));
      await query(`UPDATE tripwire_events SET notified=$2, notify_note=$3 WHERE id=$1`, [ins.rows[0].id, !!r?.ok, r?.note || null]);
    }
  }
  return st;
}
