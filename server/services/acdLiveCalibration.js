// Day-cached calibration/measurement readers used by acd.js's live level-fade detection
// engine (runSetupDetection) and detectGlobexSetup. Extracted from server/routes/acd.js
// 2026-09-05 (further acd.js-shrink cleanup following the DeepSeek-planned extraction
// earlier the same day -- see docs/OPEN_THREADS.md's 2026-09-05 entries). Pure relocation,
// behavior-identical -- verified line-for-line via diff before removing the originals.
// Zero external consumers outside acd.js itself for any of these except getPaceBaseline
// (imported directly by scripts/pilot_stackvol_horizon_profile.mjs) -- acd.js re-exports
// that one for backward compatibility.

import { query } from '../db.js';
import { loadVolatilityDefaultInputs, computeVolatilityDefaultRatios } from '../../scripts/update_optimal_stops.mjs';
import { computeVolumeBuildingMeasures, classifyVolumeBuilding } from './touchQuality.js';
import { computeProfile } from './developingValueService.js';
import { getCached, setCached, DAY_CACHE_TTL, getTouchQualityBaseline } from './acdShared.js';

// Trailing 20-day average OR-window (9:30-9:45am ET) volume, STRICTLY PRIOR days only
// (ts::date < tradeDate, no lookahead) -- the RVol baseline for Setup D's
// orRangeAtDetection/rvol20dAtDetection tagging (RESEARCH_CLAIM
// setup_d_range_rvol_combo_robust_across_windows). Day-cached like every other
// day-stable query in this file -- this doesn't change intraday, no reason to re-query
// every 15s poll.
export async function getOrVolBaseline20d(tradeDate) {
  const cached = getCached(tradeDate, 'orVolBaseline20d', DAY_CACHE_TTL);
  if (cached != null) return cached;
  const res = await query(`
    WITH dates AS (
      SELECT DISTINCT ts::date as dt FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date < $1
      ORDER BY dt DESC LIMIT 20
    )
    SELECT AVG(daily_vol) as avg_or_vol FROM (
      SELECT ts::date as dt, SUM(COALESCE(bid_volume,0) + COALESCE(ask_volume,0)) as daily_vol
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date IN (SELECT dt FROM dates)
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 584
      GROUP BY ts::date
    ) per_day
  `, [tradeDate]).catch(() => ({ rows: [] }));
  const val = res.rows[0]?.avg_or_vol != null ? +res.rows[0].avg_or_vol : null;
  return setCached(tradeDate, 'orVolBaseline20d', val);
}

// Volatility-scaled default stop/target — replaces the bare hardcoded 90pt/40pt literal
// fallback (OPEN_DECISION hardcoded_stop90_target40_fallback_needs_fix, DeepSeek blast-radius
// investigation 2026-08-19). Previously, a candidate with neither a real OPTIMAL_STOP row nor
// UNIFIED_BACKTEST mae_p75/mfe data fell straight through to a flat STOP=90/TARGET=40 (a 2.25:1
// risk:reward needing 69% WR to break even, vs this codebase's calibrated norm of ~0.85-1.2:1,
// and 9x the current 30-day NQ median bar range) -- confirmed live: OR10_LOW_FADE_LONG's
// first-ever touch (id 99881) fired straight into this fallback and lost -$182 on a 90pt
// stop-out. This reuses update_optimal_stops.mjs's own volatility-scaled-default formula
// (loadVolatilityDefaultInputs()/computeVolatilityDefaultRatios(), the SAME functions that
// script uses when a setup_type's real N is too thin to sweep a real optimum) rather than
// inventing a second formula -- "share modules instead of reimplementing." Cached once per
// trading day (DAY_CACHE_TTL) since the inputs (a system-wide ratio derived from all
// real-N-qualified setup_types' calibrated stops, plus a 30-day trailing median bar range) are
// not intraday-sensitive. Deliberately NOT touching computeStopTargetForType() itself (the
// function test_invariants.mjs re-derives expected values from) -- mirrors its 2-line
// vol-default branch (update_optimal_stops.mjs ~622-627) exactly, same precedent this codebase
// already used when loadVolatilityDefaultInputs() was extracted ("the two pre-existing inline
// copies were deliberately left as-is... only new callers should use this").
export async function getVolatilityScaledDefault(tradeDate) {
  const cached = getCached(tradeDate, 'volDefault', DAY_CACHE_TTL);
  if (cached) return cached;
  try {
    const { priorStoredByType, realNByType, medianBarRange } = await loadVolatilityDefaultInputs();
    const { volScaleRatio, targetStopRatio, canComputeVolDefault } = computeVolatilityDefaultRatios({ priorStoredByType, realNByType, medianBarRange });
    if (!canComputeVolDefault) return setCached(tradeDate, 'volDefault', null);
    const noiseFloorPt = 1.5 * medianBarRange;
    const stop = Math.max(Math.round(volScaleRatio * medianBarRange), Math.ceil(noiseFloorPt));
    const target = Math.round(stop * targetStopRatio);
    return setCached(tradeDate, 'volDefault', { stop, target });
  } catch (e) {
    console.error('[getVolatilityScaledDefault] failed, callers fall back to their own hardcoded default:', e.message);
    return setCached(tradeDate, 'volDefault', null);
  }
}

// ── Value-area regime stamping (measurement layer only, 2026-07-31) ────────────────
// Tags every setup with its position relative to the TRUE volume-weighted value area
// (vah/val/poc from computeVolumeProfileForRange, computed nightly by
// scripts/compute_value_area_regime_snapshots.mjs into value_area_regime_snapshots) at
// 7 lookbacks. Deliberately informational-only -- see docs/OPEN_THREADS.md's 2026-07-31
// entry and docs/REGIME_INTELLIGENCE_SPEC.md (marked REJECTED): the original spec's
// gating/routing engine did not survive audit, but tagging every setup so real forward
// data can be judged over the next few months does not depend on that engine at all.
// Nothing reads these columns to suppress or size anything -- do not wire that until a
// real forward sample clears this codebase's actual rigor bar (computeRigor +
// computeReplication), not a backtest sweep.
const REGIME_LOOKBACKS = [10, 20, 30, 45, 60, 90, 180];
export async function getValueAreaRegimeMap(tradeDate) {
  const cached = getCached(tradeDate, 'valueAreaRegimeMap', DAY_CACHE_TTL);
  if (cached) return cached;
  const rows = await query(`
    SELECT lookback_days, vah::float, val::float FROM value_area_regime_snapshots
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM value_area_regime_snapshots WHERE snapshot_date <= $1)
  `, [tradeDate]).catch(() => ({ rows: [] }));
  const map = {};
  for (const r of rows.rows) map[r.lookback_days] = { vah: r.vah, val: r.val };
  return setCached(tradeDate, 'valueAreaRegimeMap', map);
}
// price outside [val, vah] gives pos < 0 or > 1 (a real extension beyond the value area),
// not clamped -- the magnitude of the overshoot is itself informative, not noise to hide.
export function computeRegimeStamp(price, vaMap) {
  const stamp = {};
  for (const L of REGIME_LOOKBACKS) {
    const va = vaMap[L];
    const width = va ? va.vah - va.val : null;
    const pos = (va && width > 0) ? (price - va.val) / width : null;
    stamp[`regime_pos_${L}d`] = pos != null ? +pos.toFixed(4) : null;
    stamp[`regime_label_${L}d`] = pos != null ? (pos >= 0 && pos <= 1 ? 'Mid' : 'Edge') : null;
  }
  return stamp;
}
export const REGIME_STAMP_COLS = REGIME_LOOKBACKS.flatMap(L => [`regime_pos_${L}d`, `regime_label_${L}d`]);
export function regimeStampValues(stamp) { return REGIME_STAMP_COLS.map(c => stamp[c] ?? null); }

// ── va_overlap_streak (live tagging, 2026-09-06) ────────────────────────────────────
// Count of consecutive PRIOR sessions (strictly before tradeDate) whose final value areas
// overlap, walked backward from the day before tradeDate. Column already existed on
// active_setups (scripts/backfill_compression_metrics.mjs, docs/COMPRESSION_TAIL_MFE_SPEC.md)
// but was backfill-only -- that spec's own text flagged live tagging as "a natural follow-up
// once Part 2 shows whether this is worth tracking at all." Part 2 now has a real answer
// (RESEARCH_CLAIM va_overlap_streak_predicts_breakout_bar_level_20260906, CONFIRMED,
// bar-level, chronologically stable): an extended overlap streak (3+) predicts a real lift
// toward tomorrow being a TREND day. NOT yet validated against real setup EV -- zero real
// trades have occurred on a qualifying LONG-streak day since live tracking began
// (RESEARCH_CLAIM updated 2026-09-06 with this exact gap) -- so this is deliberately
// informational-only, same posture as regime_pos_Nd above: tag every real setup now so the
// next time the market enters an extended streak, real trades are already tagged and this
// can be tested immediately instead of needing another backfill-and-wait cycle. Do not use
// this column to gate or size anything until a real forward sample exists.
//
// Entirely built from FINAL, fully-known prior-day profiles (never today's own developing
// profile) -- no lookahead concern, and genuinely day-stable, so cached like every other
// day-stable value in this file rather than recomputed per poll.
const VA_OVERLAP_TRAILING_WINDOW = 60;
function vaOverlap(a, b) { return a.val <= b.vah && a.vah >= b.val; }
export async function getVaOverlapStreak(tradeDate) {
  const cached = getCached(tradeDate, 'vaOverlapStreak', DAY_CACHE_TTL);
  if (cached != null) return cached;
  try {
    const res = await query(`
      SELECT ts::date::text as d,
        (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
        high::float as high, low::float as low, volume::float as volume
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date < $1
        AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
        AND ts::date >= (
          SELECT dt FROM (
            SELECT DISTINCT ts::date as dt FROM price_bars_primary
            WHERE symbol='NQ' AND ts::date < $1
              AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
            ORDER BY dt DESC LIMIT ${VA_OVERLAP_TRAILING_WINDOW + 1}
          ) sub ORDER BY dt ASC LIMIT 1
        )
      ORDER BY ts ASC
    `, [tradeDate]);
    const barsByDay = new Map();
    for (const b of res.rows) {
      if (!barsByDay.has(b.d)) barsByDay.set(b.d, []);
      barsByDay.get(b.d).push(b);
    }
    const priorDays = [...barsByDay.keys()].sort(); // ascending, all strictly < tradeDate
    let streak = 0;
    if (priorDays.length >= 2) {
      const profileOf = (d) => {
        const bars = barsByDay.get(d);
        return bars && bars.length >= 10 ? computeProfile(bars) : null;
      };
      let prev = profileOf(priorDays[priorDays.length - 1]); // day before tradeDate
      for (let i = priorDays.length - 2; i >= 0 && prev; i--) {
        const cur = profileOf(priorDays[i]);
        if (!cur || !vaOverlap(prev, cur)) break;
        streak++;
        prev = cur;
      }
    }
    return setCached(tradeDate, 'vaOverlapStreak', streak);
  } catch (e) {
    console.error('[getVaOverlapStreak] failed, callers get null:', e.message);
    return setCached(tradeDate, 'vaOverlapStreak', null);
  }
}

// Latest VOLUME_BUILDING_CALIBRATION/ROSTER_WIDE_FADE row (scripts/backtest_volume_building_
// signal.mjs, weekly). Cached per day -- recalibration only runs weekly, no reason to hit the
// DB on every 15s poll. Returns null if never calibrated yet (classifyVolumeBuilding() handles
// null calib by returning agreesMedian/agreesP60: null, never throwing).
export async function getVolumeBuildingCalibration(tradeDate) {
  const cached = getCached(tradeDate, 'volBuildingCalib', DAY_CACHE_TTL);
  if (cached) return cached;
  const res = await query(`
    SELECT notes FROM performance_audit
    WHERE signal_type='VOLUME_BUILDING_CALIBRATION' AND signal_name='ROSTER_WIDE_FADE'
    ORDER BY run_date DESC LIMIT 1
  `);
  let calib = null;
  try { calib = res.rows[0]?.notes ? JSON.parse(res.rows[0].notes) : null; } catch (_) { calib = null; }
  return setCached(tradeDate, 'volBuildingCalib', calib);
}

// sessionBars: chronological bars since THIS candidate's session open through now/the touch
// bar, each needs { mod, volume } at minimum (extra fields are ignored).
// Returns the classifyVolumeBuilding() shape, or a fully-null shape if too little session
// history exists yet (mirrors computeVolumeBuildingMeasures' own touchIdx>=2*APPROACH_BARS guard,
// updated 2026-08-28 alongside that fix -- short-circuits before the baseline/calibration queries
// rather than making them and getting nulls back anyway).
export async function computeLiveVolumeBuildingSignal(tradeDate, sessionBars) {
  // FIXED 2026-08-30 (DeepSeek code review): this early-return omitted compositeStrengthPriorAvg,
  // which the normal return path below always includes -- left inconsistent key sets on the
  // stored JSONB across rows depending on which path produced them. Both paths now return the
  // exact same shape.
  if (!sessionBars || sessionBars.length < 21) return { avgVolZ: null, volZTrend: null, avgDayVolZ: null, dayVolZTrend: null, agreesMedian: null, agreesP60: null, compositeStrength: null, compositeStrengthPriorAvg: null, momentumContext: null };
  const [baseline, calib] = await Promise.all([
    getTouchQualityBaseline(tradeDate),
    getVolumeBuildingCalibration(tradeDate),
  ]);
  const touchIdx = sessionBars.length - 1;
  const measures = computeVolumeBuildingMeasures(sessionBars, touchIdx, baseline);
  const classified = classifyVolumeBuilding(measures, calib);
  const compositeStrength = [measures.avgVolZ, measures.volZTrend, measures.avgDayVolZ, measures.dayVolZTrend].every(v => v != null)
    ? measures.avgVolZ + measures.volZTrend + measures.avgDayVolZ + measures.dayVolZTrend
    : null;

  // Momentum-context (RESEARCH_CLAIM building_strength_momentum_feeds_momentum /
  // momentum_feeds_momentum_robust_across_daytype, 2026-08-29, independently confirmed by Gemini
  // and re-run locally 2026-08-29): an ACTIVE-then-spike (this bar riding on an already-elevated
  // recent backdrop) predicts a bigger move than a QUIET-then-spike, and holds across every
  // day-type -- the more robust of the two building-strength findings. Informational only, not
  // wired to any gating/sizing decision. Prior-30-bar average is bounded to THIS session only
  // (never reaches into a prior session across a multi-hour gap) -- stricter than the retrospective
  // research scripts, which scanned a flat bar array and could occasionally leak across a session
  // boundary for spikes very early in a session.
  let compositeStrengthPriorAvg = null, momentumContext = null;
  if (compositeStrength != null && touchIdx >= 30 && calib?.momentumContextPriorAvgMedian != null) {
    const priorScores = [];
    for (let k = touchIdx - 30; k < touchIdx; k++) {
      const pm = computeVolumeBuildingMeasures(sessionBars, k, baseline);
      if ([pm.avgVolZ, pm.volZTrend, pm.avgDayVolZ, pm.dayVolZTrend].every(v => v != null)) {
        priorScores.push(pm.avgVolZ + pm.volZTrend + pm.avgDayVolZ + pm.dayVolZTrend);
      }
    }
    if (priorScores.length >= 20) {
      compositeStrengthPriorAvg = priorScores.reduce((a, b) => a + b, 0) / priorScores.length;
      momentumContext = compositeStrengthPriorAvg >= calib.momentumContextPriorAvgMedian ? 'ACTIVE' : 'QUIET';
    }
  }

  return {
    ...classified,
    compositeStrength: compositeStrength != null ? +compositeStrength.toFixed(4) : null,
    compositeStrengthPriorAvg: compositeStrengthPriorAvg != null ? +compositeStrengthPriorAvg.toFixed(4) : null,
    momentumContext,
  };
}

// Rolling 20-day, per-minute-of-day baseline for trailing-5-bar net price movement
// ("pace") — same convention as getVolumeBaseline, just on |close - close_5| instead of
// volume. Backs the STACK_VOL_BREAK_LIVE pace factor (RESEARCH_CLAIM
// loose_confluence_pace_rth_promising_not_confirmed) — reused directly from
// scratch/pilot_loose_confluence_pace.mjs's getPaceBaseline(), not reimplemented.
// lag: bar-lag for the net-move window (default 5, matches the original STACK_VOL_BREAK_LIVE
// caller). A second caller (fade_touch_quality_test_slice_filter_active_setups, 2026-08-27)
// needs a 10-bar window to match what was actually backtested — cached separately per lag so
// neither caller's baseline contaminates the other's.
export async function getPaceBaseline(tradeDate, lag = 5) {
  const cacheKey = lag === 5 ? 'paceBaseline' : `paceBaseline${lag}`;
  const cached = getCached(tradeDate, cacheKey, DAY_CACHE_TTL);
  if (cached) return cached;
  const res = await query(`
    WITH raw_bars AS (
      SELECT ts, (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod, close,
        LAG(close, $2) OVER (PARTITION BY ts::date ORDER BY ts) as close_lag
      FROM price_bars_primary
      WHERE ts::date >= $1::date - INTERVAL '20 days' AND ts::date < $1::date AND symbol = 'NQ'
    )
    SELECT mod, AVG(ABS(close - close_lag))::float as avg_pace, STDDEV(ABS(close - close_lag))::float as std_pace
    FROM raw_bars WHERE close_lag IS NOT NULL GROUP BY 1
  `, [tradeDate, lag]);
  const baseline = new Map(res.rows.map(r => [r.mod, r]));
  return setCached(tradeDate, cacheKey, baseline);
}

// ── prior_day_profile live read (2026-09-06) ────────────────────────────────────────
// auction_reads.prior_day_profile for tradeDate -- ALREADY a look-back field stored on the
// CURRENT day's own row (confirmed earlier this session, no date-shifting needed). Feeds a
// real, confirmed regime-risk finding into live sizing: RESEARCH_CLAIM
// prior_day_trend_profile_anticipates_rotation_day (market-level, chi2~=10.01, p~=0.0016,
// N=436) AND, more directly relevant to sizing, the real-setup replication check that found
// the broad fade roster (19 setup_types, N=1027) nets WORSE on TREND-preceded days
// (avg EV diff -$10.86/trade, only 37% of types individually favorable) -- see
// docs/OPEN_THREADS.md's 2026-09-06 entries and DeepSeek's design critique
// (scratch/deepseek_response.md as of that date) for the full reasoning behind shipping a
// POOLED gate here rather than a per-(setup_type, profile) DAY_TYPE_ALPHA-style mirror: the
// per-cell version would decompose the real N=1027 pooled effect into cells mostly below
// this codebase's own N>=20 floor and fail to act on a real, already-confirmed finding.
//
// DELIBERATE CACHING NOTE: unlike every other day-cached value in this file, a genuinely
// null prior_day_profile (no pre-market ACD read done yet) is indistinguishable from a cache
// miss when read back via `getCached() != null` -- both return null. This means a null-profile
// day re-queries auction_reads every call instead of caching the null, which is a minor
// performance cost (one cheap indexed single-row lookup per call), NOT a correctness bug --
// the function still returns the correct value (null) every time regardless. Not worth a
// sentinel-value workaround for this low a stakes/frequency tradeoff.
export async function getPriorDayProfile(tradeDate) {
  const cached = getCached(tradeDate, 'priorDayProfile', DAY_CACHE_TTL);
  if (cached != null) return cached;
  try {
    const res = await query(
      `SELECT prior_day_profile FROM auction_reads WHERE trade_date=$1`,
      [tradeDate]
    );
    const val = res.rows[0]?.prior_day_profile ?? null;
    if (val != null) setCached(tradeDate, 'priorDayProfile', val);
    return val;
  } catch (e) {
    console.error('[getPriorDayProfile] failed:', e.message);
    return null;
  }
}
