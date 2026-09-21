// Entry-time buying/selling pressure — the SAME dirImbalance construct as the shipped
// exit-side WIDER_TARGET_PRESSURE_GATE (scripts/calibrate_wider_target_pressure_gate.mjs),
// measured one bar before entry instead of at the T1-touch bar. Extracted into its own
// function (2026-08-24, RESEARCH_CLAIM pressure_entry_sizing_direction_asymmetric — SHORT
// side genuinely out-of-sample validated, LONG side discarded as spurious) per this
// codebase's "export the real function, never reimplement" rule: shared by
// scripts/calibrate_pressure_entry_sizing_short.mjs (weekly recalibration) and several
// backtest/pilot scripts (backtest_pressure_entry_sizing_*.mjs, backtest_poc_rotation_*,
// pilot_approach_pressure_zero_mfe_veto.mjs, etc.). CORRECTED 2026-09-20 (DeepSeek review
// caught this line going stale): server/routes/acd.js's sizeMultiplier no longer calls this
// -- entryPressureShortBoost/entryPressureShortCalib were removed the same day as confirmed
// dead weight (RESEARCH_CLAIM sizemultiplier_orphaned_factors_removed_20260920), since they
// fed only that now-simplified sizing calc and a write-only monitoring field. This function
// itself is not orphaned -- the script consumers above still call it.
//
// bar: one bid_volume/ask_volume-bearing bar object (field names vary by caller — pass the
// raw counts directly, not the bar). isLong: true for LONG, false for SHORT.
// Returns null if the bar has no volume data (never treat null as "low pressure" — the
// gate this feeds must fail closed on missing data, matching the corrected convention from
// the wider-target stage-2 critique, not the exit gate's known fail-open bug).
export function computeDirImbalance(bidVolume, askVolume, isLong) {
  const bid = bidVolume || 0;
  const ask = askVolume || 0;
  const total = bid + ask;
  if (total <= 0) return null;
  const favorable = isLong ? ask : bid;
  const adverse = isLong ? bid : ask;
  return (favorable - adverse) / total;
}
