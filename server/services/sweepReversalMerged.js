// Merged sweep-reversal detector (2026-10-21, SHADOW-only, user decision "lets do 1").
//
// ONE setup for what the user calls a reversal sweep / stop sweep: the FAILED_SWEEP_REVERSAL rule (a bar in the
// last 10 poked more than 3 points beyond a level and price is back on the original side) over the UNION of both
// old rules' levels (the market levels ONL, ONH, PDL, PDH, IB low/high plus the pivot/POC/OR levels), with the
// two conditions the user described: it only happens 1-2 times a day, usually after the market has been driven
// hard into the level.
//   - hard-drive condition: M60 = distance price was driven in the sweep direction in the 60 bars before the sweep
//     extreme, in ATR20 units, must be at or above a cutoff that is NOT a typed number: it is the 80th percentile of
//     M60 over the trailing candidate events, recomputed by scripts/calibrate_sweep_drive_cutoff.mjs and stored in
//     performance_audit (signal_type 'SWEEP_DRIVE_CUTOFF'). No calibration row = the detector stays silent.
//   - frequency: at most one fire per direction per trading day (a plain active_setups existence check; this type
//     only ever fires through acd.js's shadowCandidates loop, which none of the usual dedup mechanisms cover).
// Stop/target are the existing FAILED_SWEEP_REVERSAL exit (OPTIMAL_STOP row or the 68/250 seed). The type name is
// unchanged on purpose: FAILED_SWEEP_REVERSAL_LONG/SHORT are SUPPRESS in SETUP_STATUS and on MANUAL_SUPPRESS_OVERRIDE,
// so every fire is SHADOW and cannot reach the order pipeline. The separate STOP_SWEEP_LONG/SHORT rule is left
// running (paused, shadow) only so its 109-row evidence stream keeps accumulating (OPEN_DECISION
// reversal_sweep_stopsweep_merge_into_one_setup_20261021); retire it once this setup has its own rows.
//
// Evidence status (be honest): the research (docs/SWEEP_PRIOR_MOVE_SELECTOR_PREREG_20261021.md and the other
// 2026-10-21 sweep studies) did NOT show an edge for the loose rule or for this selector; this is a forward-
// collection experiment shaped like the user's description. Feature definition is shared with the calibration
// script through computeDriveAtrUnits() so live and calibration cannot drift.
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getPriorDayRthRange } from './queries.js';
import { getRollingRthRange } from './dailyRthStats.js';

export const SWEEP_LEVEL_PRIORITY = ['ONL', 'ONH', 'PD_LOW', 'PD_HIGH', 'IB_LOW', 'IB_HIGH', 'PD_POC', 'PD_VAH', 'PD_VAL', 'FLOOR_PIVOT', 'FLOOR_R1', 'FLOOR_S1', 'OR5_HIGH', 'OR5_LOW'];
export const SWEEP_POKE_POINTS = 3;       // same 3-point poke as the existing FSR / StopSweep rules
export const SWEEP_LOOKBACK_BARS = 10;    // sweep window (bars), same as the existing rules
export const SWEEP_DRIVE_BARS = 60;       // hour-long drive measured on the 60 bars before the extreme
export const SWEEP_MIN_DRIVE_BARS = 30;   // need at least this many bars before the extreme to measure a drive
const IB_FORMED_ET_MIN = 631;             // IB levels are lookahead before 10:31
const FSR_TYPES = ['FAILED_SWEEP_REVERSAL_LONG', 'FAILED_SWEEP_REVERSAL_SHORT'];

/** Distance price was driven in the sweep direction before the sweep extreme, in ATR20 units. bars ascending [{high,low}],
 *  extIdx = index of the extreme bar. long: sweep below a level, drive = (highest high before the extreme - extreme)/atr20. */
export function computeDriveAtrUnits(bars, extIdx, isLong, extreme, atr20) {
  if (!(atr20 > 0)) return null;
  const prior = bars.slice(Math.max(0, extIdx - SWEEP_DRIVE_BARS), extIdx);
  if (prior.length < SWEEP_MIN_DRIVE_BARS) return null;
  if (isLong) { let hi = -Infinity; for (const b of prior) if (b.high > hi) hi = b.high; return (hi - extreme) / atr20; }
  let lo = Infinity; for (const b of prior) if (b.low < lo) lo = b.low; return (extreme - lo) / atr20;
}

/** Pure core. levels {NAME: price}, bars ascending [{high,low}] ending at the current bar (needs the 10-bar sweep window plus
 *  the drive window before it), price = current price, atr20, etMin, blockedDirs Set of 'LONG'/'SHORT' already fired today,
 *  cutoff (null = report the candidate without applying the drive condition). Returns the FIRST priority level that triggers
 *  in a direction not blocked, or null. */
export function evaluateSweepReversal({ levels, bars, price, atr20, etMin, blockedDirs = new Set(), cutoff = null, requireTight = true }) {
  const n = bars.length;
  if (n < SWEEP_LOOKBACK_BARS + SWEEP_MIN_DRIVE_BARS || !(price > 0)) return null;
  const recent = bars.slice(n - SWEEP_LOOKBACK_BARS);
  let lo = Infinity, loIdx = -1, hi = -Infinity, hiIdx = -1;
  recent.forEach((b, k) => { if (b.low < lo) { lo = b.low; loIdx = n - SWEEP_LOOKBACK_BARS + k; } if (b.high > hi) { hi = b.high; hiIdx = n - SWEEP_LOOKBACK_BARS + k; } });
  for (const name of SWEEP_LEVEL_PRIORITY) {
    const p = levels[name];
    if (p == null) continue;
    if ((name === 'IB_LOW' || name === 'IB_HIGH') && etMin < IB_FORMED_ET_MIN) continue;
    let dir = null;
    if (lo < p - SWEEP_POKE_POINTS && price > p) dir = 'LONG';
    else if (hi > p + SWEEP_POKE_POINTS && price < p) dir = 'SHORT';
    if (!dir || blockedDirs.has(dir)) continue;
    const isLong = dir === 'LONG', extreme = isLong ? lo : hi, extIdx = isLong ? loIdx : hiIdx;
    const drive = computeDriveAtrUnits(bars, extIdx, isLong, extreme, atr20);
    if (drive == null) continue;
    if (requireTight && !(cutoff != null && drive >= cutoff)) continue;
    return { name, dir, level: p, extreme, drive };
  }
  return null;
}

async function getSweepDriveCutoff() {
  const hit = cacheGet('sweepDriveCutoff');
  if (hit != null) return hit.value;
  const r = await query(`SELECT DISTINCT ON (signal_name) notes FROM performance_audit WHERE signal_type = 'SWEEP_DRIVE_CUTOFF' AND signal_name = 'M60_P80_POOLED' ORDER BY signal_name, run_date DESC, id DESC`);
  let value = null;
  try { const n = typeof r.rows[0]?.notes === 'string' ? JSON.parse(r.rows[0].notes) : r.rows[0]?.notes; if (Number.isFinite(n?.cutoff)) value = n.cutoff; } catch { /* leave null */ }
  cacheSet('sweepDriveCutoff', { value }, 60 * 60 * 1000);
  return value;
}

// ONL/ONH = the calendar day's bars before 09:30 (exactly how the live StopSweep rule defines them); fixed after the open.
async function getOvernightLevels(todayET) {
  const key = `sweepOvernight:${todayET}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const r = await query(`SELECT MIN(low)::float AS lo, MAX(high)::float AS hi FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $1::date + interval '9 hours 30 minutes'`, [todayET]);
  return cacheSet(key, { ONL: r.rows[0]?.lo ?? null, ONH: r.rows[0]?.hi ?? null }, 6 * 60 * 60 * 1000);
}

/** Live wrapper. fsrLevels = [{name, price}] the existing pivot/POC/OR levels; ibLow/ibHigh from the caller. Returns the setup object
 *  acd.js's shadowCandidates expects, or null. Never throws (a failure here must cost this setup's fire, nothing else). */
export async function detectSweepReversal({ todayET, etMin, currentPrice, fsrLevels, ibLow, ibHigh, opt }) {
  try {
    if (!currentPrice || etMin < 600) return null;
    const cutoff = await getSweepDriveCutoff();
    if (cutoff == null) return null; // not calibrated yet: stay silent
    const [atrRow, on, pd] = await Promise.all([getRollingRthRange({ beforeDate: todayET }), getOvernightLevels(todayET), getPriorDayRthRange(todayET)]);
    const atr20 = atrRow?.atr;
    if (!(atr20 > 0)) return null;
    const levels = { ONL: on.ONL, ONH: on.ONH, PD_LOW: pd?.pdLow ?? null, PD_HIGH: pd?.pdHigh ?? null, IB_LOW: ibLow ?? null, IB_HIGH: ibHigh ?? null };
    for (const l of fsrLevels || []) levels[l.name] = l.price;
    const fired = await query(`SELECT setup_type FROM active_setups WHERE trade_date = $1 AND setup_type = ANY($2) AND fired_at::time < '16:00'`, [todayET, FSR_TYPES]);
    const blockedDirs = new Set(fired.rows.map((r) => (r.setup_type.endsWith('LONG') ? 'LONG' : 'SHORT')));
    if (blockedDirs.size === 2) return null;
    const barsRes = await query(`SELECT high::float AS high, low::float AS low FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date + make_interval(mins => $2::int) AND ts < $1::date + make_interval(mins => $3::int) ORDER BY ts`, [todayET, etMin - 110, etMin + 2]);
    const ev = evaluateSweepReversal({ levels, bars: barsRes.rows, price: currentPrice, atr20, etMin, blockedDirs, cutoff, requireTight: true });
    if (!ev) return null;
    const type = `FAILED_SWEEP_REVERSAL_${ev.dir}`;
    const stopPts = opt?.[type]?.stop ?? 68, targetPts = opt?.[type]?.target ?? 250;
    const isLong = ev.dir === 'LONG';
    return {
      type, direction: ev.dir, entry: currentPrice,
      stop: Math.round(isLong ? currentPrice - stopPts : currentPrice + stopPts),
      target: Math.round(isLong ? currentPrice + targetPts : currentPrice - targetPts),
      targetLabel: `${ev.name} sweep reversal (Setup B) | drive ${ev.drive.toFixed(2)} ATR20`,
      description: `Price ${isLong ? 'swept below' : 'swept above'} ${ev.name} (${Math.round(ev.level)}) after a ${ev.drive.toFixed(2)} ATR20 drive into it (cutoff ${cutoff.toFixed(2)}), now reclaimed. Merged sweep setup, SHADOW forward collection.`,
      history: { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
    };
  } catch (e) {
    console.error('[sweepReversalMerged] error (isolated, not fatal):', e.message);
    return null;
  }
}
