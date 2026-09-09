// Standalone daily volatility-regime reading (GARCH(1,1) walk-forward), 2026-09-08.
//
// Deliberately isolated from acd.js/acdShared.js and every other setup-related module —
// user's explicit direction ("I don't think its meant to tailor to our setups... put it in
// its own class, not acd"). This reads NOTHING from and writes NOTHING to any live setup's
// stop/target/sizeMultiplier. It exists purely to answer one question for a human glancing at
// a dashboard: "is volatility running hot or cold right now, relative to normal?"
//
// A dual-barrier (stop+target scaled together) hypothesis built on this same GARCH series was
// tested and rejected the same day (RESEARCH_CLAIM
// garch_dual_barrier_subgroup_symmetry_negative_20260908, docs/OPEN_THREADS.md) — the pooled
// improvement was carried by SHADOW-origin trades that never fired live. That result is about
// whether GARCH scaling helps THIS system's specific setups; it says nothing about whether the
// underlying volatility reading itself is useful to look at, which is the only thing this
// module does.
//
// Source data: scripts/backfill_garch_vol_scale_history.py, run nightly (run_daily_calibration.sh,
// 8:20 PM ET) — writes a `performance_audit` row per historical trading day
// (signal_type='GARCH_VOL_SCALE', signal_name=that day's date) plus one extra row per run under
// signal_name='LATEST', which is the one this module reads. The LATEST row uses the full return
// series through that night's close (today included) to forecast the NEXT session — see that
// script's own header comment for why a plain "today" row would already be stale by the next
// morning.

import { query } from '../db.js';

// Distance-from-1.0 classification bands, derived from the scale series' own p01/p99
// calibration band (persisted alongside the reading, not a separate hardcoded threshold) --
// matches this codebase's standing no-static-thresholds rule.
function classify(scale, p01, p99) {
  if (scale >= p99) return 'HOT';
  if (scale <= p01) return 'COLD';
  const mid = (p01 + p99) / 2;
  const span = (p99 - p01) / 2;
  const distFromMid = Math.abs(scale - mid) / span;
  if (distFromMid >= 0.5) return scale > mid ? 'WARM' : 'COOL';
  return 'NORMAL';
}

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
    label: classify(scale, p01, p99),
    asOfClose: as_of_close,
    degenerateFallback: !!degenerate_fallback,
    band: { p01: +p01.toFixed(4), p99: +p99.toFixed(4) },
  };
}
