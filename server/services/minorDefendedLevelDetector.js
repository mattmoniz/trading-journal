// Minor defended-level order-flow-rejection live detector, 2026-09-15 (SHADOW-only).
//
// Backing research: RESEARCH_CLAIM orderflow_rejection_phase0_pretest_20260915 (bar-level
// pretest, positive for RTH) and orderflow_rejection_phase2_ev_backtest_20260915 (real
// bar-by-bar $ backtest, N=43 RTH trades/29 distinct days: best cell +$69.43/trade real vs
// +$17.98/trade placebo, but day-blocked bootstrap CI [-$16.58, $165.62] crosses zero --
// PROVISIONAL, not yet statistically decisive). See OPEN_DECISION
// orderflow_rejection_classifier_for_defended_levels_20260915 for the full design thread.
//
// DELIBERATELY DIFFERENT FROM majorPivotDefendedBreakDetector.js in one key way: this file
// has NO ATR-distance/ZigZag acceptance filter on which raw swing pivots get tracked -- every
// raw fractal pivot (findSwingPoints, swingWidth=5) is a candidate "minor" level. That's the
// whole point: majorPivotDefendedBreakDetector's ATR-scaled magnitude filter can get "stuck"
// on a stale reference pivot for a day+ during an elevated-volatility stretch (found live
// 2026-09-15 -- a real ~238pt RTH flush was missed entirely because the zigzag sequence hadn't
// rotated off the prior day's high), and a fresh 120-day threshold sensitivity re-check
// confirmed lowering that detector's own ATR multiplier would hurt its validated quality, not
// fix coverage. This detector doesn't compete with that mechanism -- it fills the gap left by
// having no distance floor at all, using order-flow rejection as its OWN acceptance criterion
// instead. MAJOR_PIVOT_DEFENDED_BREAK's threshold and mechanism are untouched by this file.
//
// SIGNATURE (matches the tested scripts exactly, do not re-derive by eye): while a raw pivot's
// band (atr*0.02) is in a "TOUCHING" state, a 1-min bar qualifies as a "push" if its bid/ask
// delta opposes the approach side, its total volume z-score (vs the existing 90-day trailing
// per-minute-of-day baseline, touchQuality.js's getVolumeBaseline -- reused, not reimplemented)
// clears Z_CUT, and its one-sidedness (|delta|/total) clears D_CUT. That push bar is the
// SIGNAL only if it shows "no reward" -- either it closes back against its own push within the
// same bar, or the very next bar's delta flips sign with its own z>1.0. This is evaluated
// live/bar-by-bar as the trigger itself (not backward-inferred from a later price-only denial
// bar -- an early framing during this design thread was explicitly corrected by the user: wait
// for the signature, don't guess which past bar it was).
//
// Z_CUT/D_CUT are NOT re-derived live -- they're the 75th-percentile cutoffs computed once
// across the full push-bar population in the Phase 0/2 calibration (2025-12-01 to 2026-09-15,
// N~104k push-bar samples). Same convention as majorPivotDefendedBreakDetector's own
// ZIGZAG_THRESHOLD=1.5 -- a plain literal derived from a real backtest, not a live query,
// documented with its source and date. Recalibrate if this detector's real N ever grows large
// enough to re-run the percentile derivation on fresh data.
//
// ATR here is DELIBERATELY the same "full calendar-day H-L range, 20-day trailing average"
// used by both backtest scripts -- NOT levelProximityService.js's getRollingATR() (which is
// RTH-only, 9:30am-4pm). Swapping in the RTH-only ATR would silently change the band width and
// target sizing from what was actually tested (this codebase's own standing rule: a backtest's
// population/definitions must match what live actually computes, window included).
//
// RTH-only (per the tested scope -- Globex showed the same direction but was heavily muted in
// both the pretest and the real-$ backtest; not wired for Globex).
//
// LIVE STATUS: inserts SHADOW unconditionally (hardcoded in the INSERT itself, not
// eligibility-derived -- no ACTIVE path anywhere in this file), matching
// majorPivotDefendedBreakDetector.js/momentumChaseDetector.js's own precedent for a brand-new
// setup type with real_n=0 (New setup type checklist item 3: N<20 resolved real trades => SHADOW
// only). No promotion-check wiring needed for the same reason -- the standing weekly
// backtest_setup_status.mjs scan will pick this setup_type up automatically once real fires
// accumulate.

import { query } from '../db.js';
import { findSwingPoints } from './swingPivots.js';
import { getVolumeBaseline } from './touchQuality.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getBetClass } from '../config/setupTypes.js';
import { dropToTimeline, etNaiveTimestampToMs, getNqRollWeekDates } from './acdShared.js';

const SWING_WIDTH = 5;
// 75th-percentile cutoffs from the 2025-12-01..2026-09-15 calibration -- see file header.
const Z_CUT = 0.44;
const D_CUT = 0.259;
// CORRECTED 2026-09-15 (DeepSeek code review, same day as initial build -- caught before this
// ever fired live): originally 5 days, based on an unmeasured assumption that "minor levels are
// short-lived by construction." Directly measured against the real pivot-formation-to-denial lag
// distribution over the full calibration window (N=16,686 denial events): median lag is genuinely
// tiny (0.18 days), but the tail is real -- p90=3.9 days, p95=7.9 days, p99=31.3 days, observed
// max=48.9 days. 5 days covers only 92.4% of real denials; this is the exact same shape of bug
// majorPivotDefendedBreakDetector.js already found and fixed once (a 25-day lookback missing a
// real 34-day pivot->break lag). Widened with real margin past the observed max, matching that
// same fix's own philosophy -- not tuned to just barely cover the p99.
const LOOKBACK_DAYS = 60;
const RECENT_SIGNAL_WINDOW_MIN = 60; // only attempt inserting signals from the last hour
const REFIRE_COOLDOWN_MIN = 15; // matches the backtest's own >15-1m-bar dedup between signals
const CACHE_KEY = 'minorDefendedLevel:signals';
const CACHE_TTL_MS = 90 * 1000; // shorter than majors' 4min -- these touches are fast-moving

// Best cell from orderflow_rejection_phase2_ev_backtest_20260915's full grid sweep (by real EV,
// which was also the largest real-vs-placebo delta -- not just the raw max).
const CONFIG = { stopMult: 2.0, targetMult: 1.0, holdMin: 240 };
const MIN_STOP_ATR_FRAC = 0.1; // floor so a tight touch doesn't produce a near-zero stop

function etModOf(dateObj) {
  return dateObj.getUTCHours() * 60 + dateObj.getUTCMinutes();
}
const isRTHMod = (mod) => mod >= 570 && mod < 960; // 9:30am-4:00pm ET, matches the backtest exactly

// Full calendar-day (NOT RTH-only) 20-day trailing H-L range average -- deliberately distinct
// from levelProximityService.js's getRollingATR(), see file header for why.
async function getFullDayATR(dateStr) {
  const { rows } = await query(`
    SELECT AVG(range)::float as atr, COUNT(*)::int as n FROM (
      SELECT ts::date as d, (MAX(high) - MIN(low)) as range
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date < $1
      GROUP BY ts::date
      ORDER BY d DESC LIMIT 20
    ) recent
  `, [dateStr]);
  const { atr, n } = rows[0] || {};
  return (atr != null && n >= 20) ? atr : null;
}

// Re-derives denial events + order-flow signature matches from a bounded recent lookback.
// Exported for direct verification against the backtest's own known-good output.
export async function computeMinorDefendedLevelSignals() {
  const barsRes = await query(`
    SELECT to_char(ts, 'YYYY-MM-DD HH24:MI:SS') as tc, to_char(ts,'YYYY-MM-DD') as d,
           (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod,
           open::float, high::float, low::float, close::float,
           COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts >= NOW() - INTERVAL '${LOOKBACK_DAYS} days' AND ts <= NOW()
    ORDER BY ts ASC
  `);
  const bars1m = barsRes.rows;
  if (bars1m.length < 50) return [];

  const bars5m = [];
  const map5mEnd1mIdx = [];
  let cur = null;
  for (let i = 0; i < bars1m.length; i++) {
    const row = bars1m[i];
    const tsStr = row.tc;
    const minPart = parseInt(tsStr.substring(14, 16), 10);
    const bucketMin = Math.floor(minPart / 5) * 5;
    const bucketStr = tsStr.substring(0, 14) + bucketMin.toString().padStart(2, '0') + ':00';
    if (!cur || cur.tsStr !== bucketStr) {
      if (cur) { bars5m.push(cur); map5mEnd1mIdx.push(i - 1); }
      cur = { tsStr: bucketStr, dateStr: row.d, open: row.open, high: row.high, low: row.low, close: row.close };
    } else {
      cur.high = Math.max(cur.high, row.high); cur.low = Math.min(cur.low, row.low); cur.close = row.close;
    }
  }
  if (cur) { bars5m.push(cur); map5mEnd1mIdx.push(bars1m.length - 1); }
  if (bars5m.length < SWING_WIDTH * 2 + 5) return [];

  const rollDates = new Set();
  const years = new Set(bars5m.map(b => parseInt(b.dateStr.slice(0, 4), 10)));
  for (const y of years) for (const d of getNqRollWeekDates(y)) rollDates.add(d);

  const atrCache = new Map();
  const uniqueDates = Array.from(new Set(bars5m.map(b => b.dateStr)));
  for (const d of uniqueDates) atrCache.set(d, await getFullDayATR(d));

  const baselineCache = new Map();
  for (const d of uniqueDates) baselineCache.set(d, await getVolumeBaseline(query, d));

  const { highs, lows } = findSwingPoints(bars5m, SWING_WIDTH);
  const merged = [...highs.map(p => ({ ...p, type: 'HIGH' })), ...lows.map(p => ({ ...p, type: 'LOW' }))].sort((a, b) => a.idx - b.idx);

  const candidateEvents = [];
  for (const pivot of merged) {
    if (rollDates.has(bars5m[pivot.idx].dateStr)) continue;
    const confirmIdx = pivot.idx + SWING_WIDTH;
    if (confirmIdx >= bars5m.length) continue;
    const atr = atrCache.get(bars5m[pivot.idx].dateStr);
    if (!atr) continue;
    const band = atr * 0.02;
    const top = pivot.price + band, bot = pivot.price - band;
    const approachSide = pivot.type === 'HIGH' ? 1 : -1;
    let state = 'IDLE', extremePrice = null, barsHeld = 0, side = null, touchStart1mIdx = null;

    for (let i = confirmIdx; i < bars5m.length; i++) {
      if (rollDates.has(bars5m[i].dateStr)) break;
      const bar = bars5m[i];
      const start1mIdx = (i === 0) ? 0 : map5mEnd1mIdx[i - 1] + 1;
      const end1mIdx = map5mEnd1mIdx[i];

      if (state === 'IDLE') {
        if (bar.high >= bot && bar.low <= top) {
          const prevClose = i > 0 ? bars5m[i - 1].close : bar.open;
          state = 'TOUCHING'; touchStart1mIdx = start1mIdx;
          if (prevClose > top) { side = 1; extremePrice = bar.high; }
          else if (prevClose < bot) { side = -1; extremePrice = bar.low; }
          else { side = approachSide; extremePrice = side === 1 ? bar.high : bar.low; }
        }
      } else if (state === 'TOUCHING') {
        extremePrice = side === 1 ? Math.max(extremePrice, bar.high) : Math.min(extremePrice, bar.low);
        if (side === 1) {
          if (bar.close > top) { candidateEvents.push({ pivot, start1mIdx: touchStart1mIdx, end1mIdx, side, atr }); state = 'IDLE'; }
          else if (bar.close < bot) { state = 'BREAKING'; barsHeld = 0; }
        } else {
          if (bar.close < bot) { candidateEvents.push({ pivot, start1mIdx: touchStart1mIdx, end1mIdx, side, atr }); state = 'IDLE'; }
          else if (bar.close > top) { state = 'BREAKING'; barsHeld = 0; }
        }
      } else if (state === 'BREAKING') {
        if (side === 1) {
          if (bar.close < bot) { barsHeld++; if (barsHeld === 2) break; }
          else if (bar.close > top) { state = 'IDLE'; }
          else { state = 'TOUCHING'; touchStart1mIdx = start1mIdx; }
        } else {
          if (bar.close > top) { barsHeld++; if (barsHeld === 2) break; }
          else if (bar.close < bot) { state = 'IDLE'; }
          else { state = 'TOUCHING'; touchStart1mIdx = start1mIdx; }
        }
      }
    }
  }

  const signals = [];
  for (const ev of candidateEvents) {
    const bl = baselineCache.get(bars1m[ev.end1mIdx].d);
    if (!bl) continue;
    let actualExtreme = ev.side === 1 ? -Infinity : Infinity;
    for (let i = ev.start1mIdx; i <= ev.end1mIdx; i++) {
      if (ev.side === 1) actualExtreme = Math.max(actualExtreme, bars1m[i].high);
      else actualExtreme = Math.min(actualExtreme, bars1m[i].low);
    }
    let matchedSigIdx = null;
    for (let i = ev.start1mIdx; i <= ev.end1mIdx; i++) {
      const b = bars1m[i];
      const m = bl.get(Number(b.mod));
      if (!m || !m.std_vol) continue;
      const tot = b.bid_volume + b.ask_volume;
      const z = (tot - m.avg_vol) / m.std_vol;
      const delta = b.ask_volume - b.bid_volume;
      const isPush = (ev.side === -1 && delta > 0) || (ev.side === 1 && delta < 0);
      if (isPush && z >= Z_CUT && (Math.abs(delta) / tot) >= D_CUT) {
        const closePos = (b.close - b.low) / ((b.high - b.low) || 1);
        const failsSameBar = (ev.side === -1 && closePos < 0.5) || (ev.side === 1 && closePos > 0.5);
        let flipsNextBar = false;
        // CORRECTED 2026-09-15 (DeepSeek code review): the original condition
        // `i+1<=ev.end1mIdx || i+1<bars1m.length` is logically just `i+1<bars1m.length` --
        // not an off-by-one, just a redundant OR left over from drafting. Simplified to match
        // the tested scripts' own equivalent guard.
        if (i + 1 < bars1m.length) {
          const nx = bars1m[i + 1];
          const ndelta = nx.ask_volume - nx.bid_volume;
          const nm = bl.get(Number(nx.mod));
          const nz = nm && nm.std_vol > 0 ? (nx.bid_volume + nx.ask_volume - nm.avg_vol) / nm.std_vol : 0;
          if (ndelta * delta < 0 && nz > 1.0) flipsNextBar = true;
        }
        if (failsSameBar || flipsNextBar) { matchedSigIdx = i; break; }
      }
    }
    if (matchedSigIdx === null) continue;
    if (!isRTHMod(bars1m[matchedSigIdx].mod)) continue; // RTH-only, per the tested scope
    signals.push({
      idx: matchedSigIdx,
      entryTsStr: bars1m[matchedSigIdx].tc,
      entryPrice: bars1m[matchedSigIdx].close,
      direction: ev.pivot.type === 'HIGH' ? 'SHORT' : 'LONG',
      pivotPrice: ev.pivot.price,
      actualExtreme,
      atr: ev.atr,
    });
  }

  // Dedup: drop any signal within REFIRE_COOLDOWN_MIN minutes (1m bars) of an earlier one --
  // matches the backtest's own >15-bar dedup between denial events.
  signals.sort((a, b) => a.idx - b.idx);
  const deduped = [];
  for (const s of signals) {
    const last = deduped[deduped.length - 1];
    if (!last || s.idx - last.idx > REFIRE_COOLDOWN_MIN) deduped.push(s);
  }
  return deduped;
}

async function getSignalsCached() {
  const cached = cacheGet(CACHE_KEY);
  if (cached != null) return cached;
  const signals = await computeMinorDefendedLevelSignals();
  return cacheSet(CACHE_KEY, signals, CACHE_TTL_MS);
}

// Full detect-and-insert, called from acd.js's runSetupDetection as a single line, matching
// majorPivotDefendedBreakDetector.js's convention.
export async function computeMinorDefendedLevelSignal(todayET, etMin) {
  try {
    // CORRECTED 2026-09-15 (DeepSeek code review): the original `!isRTHMod(etMin)` gate used
    // the POLL minute, so the 15:59 bar (mod 959) was never processed -- it only completes at
    // ~16:00, when the poll's own etMin is already 960 and isRTHMod excludes it. The backtest's
    // RTH filter is on the SIGNAL bar's own mod (570<=mod<960), which DOES include 15:59.
    // Widened by one minute so this poll-time gate can no longer exclude a bar the tested
    // scripts would have counted; the per-signal isRTHMod() check later in the pipeline is the
    // real, correct filter.
    if (etMin < 570 || etMin >= 961) return null; // RTH-only gate, cheap early exit before any heavy work
    const signals = await getSignalsCached();
    if (!signals.length) return null;

    const nowMs = Date.now();
    const recent = signals.filter(s => {
      const entryMs = etNaiveTimestampToMs(s.entryTsStr);
      return nowMs - entryMs <= RECENT_SIGNAL_WINDOW_MIN * 60000 && nowMs - entryMs >= 0;
    });
    if (!recent.length) return null;

    const inserted = [];
    for (const s of recent) {
      const setupType = `MINOR_DEFENDED_LEVEL_${s.direction}`;

      // REMOVED 2026-09-15 (DeepSeek code review): a DB-level dupeCheck used to live here
      // (`fired_at >= NOW() - INTERVAL '15 minutes'`), inherited from acd.js's own pattern at
      // other insert sites -- but it compared naive-ET `fired_at` against genuinely-UTC `NOW()`
      // with no timezone conversion, so under a UTC-ambient session it was off by ~4-5h and
      // never actually blocked anything during RTH (the same footgun documented and fixed
      // elsewhere via etNaiveTimestampToMs). It was also redundant: the real protection is the
      // in-memory dedup above (drops any signal within REFIRE_COOLDOWN_MIN of a prior one) plus
      // the unconditional `idx_as_unique_touch_instant` unique index on
      // (trade_date, setup_type, fired_at), which the bare `ON CONFLICT DO NOTHING` below already
      // relies on. Deleting the dead check rather than fixing its timezone bug, since it added
      // nothing the other two mechanisms don't already guarantee.

      const sign = s.direction === 'LONG' ? 1 : -1;
      const distToExtreme = Math.abs(s.entryPrice - s.actualExtreme);
      const minStopDist = s.atr * MIN_STOP_ATR_FRAC;
      const stopDist = Math.max(distToExtreme * CONFIG.stopMult, minStopDist);
      const stopPx = s.entryPrice - sign * stopDist;
      const targetPx = s.entryPrice + sign * CONFIG.targetMult * s.atr;
      const entryDate = new Date(s.entryTsStr.replace(' ', 'T') + 'Z');
      const expiresAt = new Date(entryDate.getTime() + CONFIG.holdMin * 60000);
      const t1Label = `Minor defended level, order-flow rejection: ${CONFIG.targetMult}x ATR target, ${CONFIG.holdMin}min hold, stop ${CONFIG.stopMult}x touch-extreme`.slice(0, 100);

      const ins = await query(`
        INSERT INTO active_setups (
          trade_date, setup_type, fired_at, expires_at, status, origin_status,
          entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
          price_at_detection, structural_level_touched, structural_level_type, bet_class
        ) VALUES ($1,$2,$3,$4,'SHADOW','SHADOW',$5,$5,$6,$7,$8,$5,$9,'MINOR_RAW_PIVOT',$10)
        ON CONFLICT DO NOTHING
        RETURNING id, trade_date, fired_at::text as fired_at, expires_at::text as expires_at, entry_zone_low, stop_level, t1_level, t1_label
      `, [
        s.entryTsStr.slice(0, 10), setupType, s.entryTsStr, expiresAt.toISOString().slice(0, 19).replace('T', ' '),
        s.entryPrice, stopPx, targetPx, t1Label, s.pivotPrice, getBetClass(setupType),
      ]);
      if (ins.rows[0]) {
        try { await dropToTimeline(ins.rows[0]); } catch (_) {}
        inserted.push(ins.rows[0]);
      }
    }
    return inserted.length ? inserted : null;
  } catch (_) { return null; /* new detector, never block the response */ }
}
