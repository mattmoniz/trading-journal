// Standalone daily volatility-regime reading (GARCH(1,1) walk-forward), 2026-09-08.
//
// Deliberately isolated from acd.js/acdShared.js and every other setup-related module —
// user's explicit direction ("I don't think its meant to tailor to our setups... put it in
// its own class, not acd"). This reads NOTHING from and writes NOTHING to any live setup's
// stop/target/sizeMultiplier. It exists purely to answer one question for a human glancing at
// a dashboard: "is volatility running hotter or cooler right now than its own recent normal?"
//
// A dual-barrier (stop+target scaled together) hypothesis built on this same GARCH series was
// tested and rejected the same day (RESEARCH_CLAIM
// garch_dual_barrier_subgroup_symmetry_negative_20260908, docs/OPEN_THREADS.md) — the pooled
// improvement was carried by SHADOW-origin trades that never fired live. That result is about
// whether GARCH scaling helps THIS system's specific setups; it says nothing about whether the
// underlying volatility reading itself is useful to look at, which is the only thing this
// module does.
//
// NO qualitative HOT/WARM/NORMAL/COOL/COLD label -- there used to be one (a classify() function
// bucketing against the p01/p99 band), removed the same day it was added. Directly tested
// whether the label actually predicted next-day realized moves (scratch/
// test_garch_label_calibration.py): it didn't, for either window choice -- non-monotonic
// (the COLD bucket showed a HIGHER average realized move than HOT in one run), correlation
// between the continuous scale and realized |return| only ~0.14-0.15. A confident-sounding
// word next to a number that's been shown not to reliably predict anything is worse than no
// word at all -- shows the raw scale only, which is an honest description of the reading
// itself, not a claim about what happens next.
//
// Source data: scripts/backfill_garch_vol_scale_history.py, run nightly (run_daily_calibration.sh,
// 8:20 PM ET) — writes a `performance_audit` row per historical trading day
// (signal_type='GARCH_VOL_SCALE', signal_name=that day's date) plus one extra row per run under
// signal_name='LATEST', which is the one this module reads. The LATEST row fits on the FULL
// EXPANDING return series (all history through that night's close, today included) to forecast
// the NEXT session — see that script's own header comment for the full expanding-vs-rolling
// investigation (flip-flopped FOUR times on 2026-09-08: expanding, then rolling-250 on a
// statistically real-looking p=0.0054 result, then back to expanding once two real data bugs
// contaminating that comparison were found and fixed — the clean data reverses the finding,
// p=0.018 favoring expanding) and for why a plain "today" row would already be stale by the
// next morning.

import { query } from '../db.js';
import { isInsideNqRollWeek, getNqRollWeekBounds } from './acdShared.js';

// Returns the most recent volatility-regime reading, or null if none has ever been computed
// (e.g. the nightly job hasn't run yet on a fresh environment). Never throws — a monitoring
// feature failing open (returning null) is the right default, not a 500.
export async function getLatestVolRegime() {
  const result = await query(`
    SELECT run_date::text as as_of_run_date, notes
    FROM performance_audit
    WHERE signal_type = 'GARCH_VOL_SCALE' AND signal_name = 'LATEST'
    ORDER BY run_date DESC
    LIMIT 1
  `).catch(() => ({ rows: [] }));

  const row = result.rows[0];
  if (!row) return null;

  const notes = JSON.parse(row.notes);
  const { scale, p01, p99, as_of_close, degenerate_fallback } = notes;

  // Roll-week awareness (2026-09-14, user-caught: "GARCH looks frozen"). backfill_garch_vol_
  // scale_history.py deliberately excludes NQ's quarterly contract-roll week from its return
  // series (blended front/next-month prices produce fake single-day moves) -- so asOfClose
  // legitimately stalls at the day BEFORE the roll week for its full ~5-trading-day duration,
  // every quarter. That's correct behavior, not a stuck job, but showing a stale-looking date
  // with zero context reads exactly like one -- this flags it so a caller can say so honestly.
  // Checked against TODAY (not asOfClose) -- once the roll week passes, asOfClose will still
  // look "a few days old" for one more day until that night's run catches up; the pause banner
  // should disappear at that point even though the date itself hasn't advanced yet.
  const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const inRollWeek = isInsideNqRollWeek(todayET);
  const rollWeekBounds = inRollWeek ? getNqRollWeekBounds(todayET) : null;

  return {
    scale: +scale.toFixed(4),
    asOfClose: as_of_close,
    degenerateFallback: !!degenerate_fallback,
    // Purely descriptive context (where this reading sits within its own recent historical
    // range) -- NOT a predictive classification. See header comment for why the discrete
    // HOT/COLD label was removed rather than kept alongside this.
    band: { p01: +p01.toFixed(4), p99: +p99.toFixed(4) },
    rollWeekPaused: inRollWeek,
    rollWeekResumesAfter: rollWeekBounds?.end ?? null,
  };
}

// Returns the walk-forward daily scale series for charting (2026-09-08, direct user request
// after seeing the single-number card: "is there a chart in quick check"). Each row's `scale`
// is the forecast made using data strictly BEFORE that date (see backfill script's own header),
// i.e. this is the SAME walk-forward series the window-choice/big-move RESEARCH_CLAIMs were
// validated against -- not a separately computed convenience series. Excludes signal_name=
// 'LATEST' (that's a same-day forward-only reading with no historical date of its own, handled
// separately by getLatestVolRegime()). Capped at `days` most-recent rows (default 180 --
// covers roughly the whole rolling-250-vs-expanding investigation window without ever returning
// an unbounded scan; the full series is currently only ~320 rows total so this is a defensive
// cap, not a real constraint on what's shown) and returned in ascending (chronological) order,
// ready for a line chart's x-axis to read left-to-right without the caller needing to reverse it.
export async function getVolRegimeHistory(days = 180) {
  const result = await query(`
    SELECT run_date::text as date, notes
    FROM performance_audit
    WHERE signal_type = 'GARCH_VOL_SCALE' AND signal_name != 'LATEST'
    ORDER BY run_date DESC
    LIMIT $1
  `, [days]).catch(() => ({ rows: [] }));

  return result.rows
    .map((r) => {
      const notes = JSON.parse(r.notes);
      return { date: r.date, scale: +Number(notes.scale).toFixed(4) };
    })
    .reverse();
}

// Live LOW/MEDIUM/HIGH regime classification (2026-09-09), added when the user asked to trade
// on a real backtested finding (Setup 6 momentum-chase, RESEARCH_CLAIM
// setup6_momentum_chase_medium_regime_positive_20260909) that was validated conditioned on this
// exact LOW/MEDIUM/HIGH split. The cutoffs are NOT hardcoded (this codebase's own standing
// no-static-thresholds rule) -- p30/p80 are recomputed from the real historical GARCH_VOL_SCALE
// series every call, the same percentile-of-history convention every scratch/backtest_* script
// in that research thread used. This is the one function this monitor's own header comment
// warns NOT to build (a discrete classification of the continuous scale) -- deliberately
// different from that warning: THAT one was a HOT/WARM/NORMAL/COOL/COLD label tested and found
// not to predict next-day moves; THIS one is the exact LOW/MEDIUM/HIGH split a real, validated,
// regime-conditioned trading finding depends on, not a fresh, unvalidated interpretive label.
export async function getCurrentGarchRegime() {
  const [latest, history] = await Promise.all([getLatestVolRegime(), getVolRegimeHistory(2000)]);
  if (!latest || history.length === 0) return null;
  // Roll-week fail-safe (2026-09-14): during NQ's quarterly contract-roll week, `latest.scale`
  // is a stale reading (see getLatestVolRegime()'s own comment -- the underlying series
  // legitimately can't advance for the roll week's full duration). A LOW/MEDIUM/HIGH
  // classification built on it would be confidently wrong, not just outdated -- and the one
  // live consumer of this function (momentumChaseDetector.js) already fails safe on a null
  // return (`if (!regimeInfo || ...) return null`), so returning null here is a pure
  // no-new-behavior fix: the detector simply won't fire during the roll week instead of
  // firing (or not firing) off a classification nobody actually computed fresh. Also protects
  // real forward-data integrity for this SHADOW-only, real-N-awaiting setup -- a fire tagged
  // "MEDIUM regime" during the roll week would be tagging it against a 5-day-old reading, not
  // a genuine live one.
  if (latest.rollWeekPaused) return null;

  // Linear-interpolation percentile, matching pandas' Series.quantile() default exactly (the
  // method every scratch/backtest_* script in this research thread used) -- a simple nearest-
  // rank index would silently diverge from what was actually validated.
  const scales = history.map((r) => r.scale).sort((a, b) => a - b);
  const percentile = (p) => {
    const pos = p * (scales.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return scales[lo];
    return scales[lo] + (scales[hi] - scales[lo]) * (pos - lo);
  };
  const p30 = percentile(0.30);
  const p80 = percentile(0.80);

  let regime;
  if (latest.scale < p30) regime = 'LOW';
  else if (latest.scale <= p80) regime = 'MEDIUM';
  else regime = 'HIGH';

  return { regime, scale: latest.scale, asOfClose: latest.asOfClose, p30, p80 };
}
