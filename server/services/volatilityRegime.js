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
// signal_name='LATEST', which is the one this module reads. The LATEST row uses a trailing
// rolling window (GARCH_ROLLING_WINDOW in the Python script, currently 250 days) through that
// night's close (today included) to forecast the NEXT session — see that script's own header
// comment for the full expanding-vs-rolling investigation (flip-flopped twice, landed on
// rolling with real statistical evidence, not just a design preference) and for why a plain
// "today" row would already be stale by the next morning.

import { query } from '../db.js';

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

  return {
    scale: +scale.toFixed(4),
    asOfClose: as_of_close,
    degenerateFallback: !!degenerate_fallback,
    // Purely descriptive context (where this reading sits within its own recent historical
    // range) -- NOT a predictive classification. See header comment for why the discrete
    // HOT/COLD label was removed rather than kept alongside this.
    band: { p01: +p01.toFixed(4), p99: +p99.toFixed(4) },
  };
}
