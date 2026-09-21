import { computeProfile, computeRunningVwapSeries } from './developingValueService.js';

// Feature-snapshot computation for the DeepSeek meta-labeling filter thread
// (docs/1. Deepseek_ML_Meta_Labeling_SPEC.md, Section 3). Per the DeepSeek Phase 0 design
// critique (2026-09-20/21): only about half the spec's ~35 features are already stored on
// active_setups (nl30_at_detection, structural_state_at_detection, confluence_score_at_
// detection, minutes_from_open, rvol_20d_at_detection, va_width_pctile_60d,
// ib_range_pctile_60d, regime_pos/label_10d-180d, touch_quality[_vol_z],
// exhaustion_signal_at_detection, hivol_lopace_at_detection, etc.) -- the rest need computing
// fresh via the real existing functions, per this codebase's "export the real function,
// never reimplement" rule.
//
// SCOPED TONIGHT to prior-day reference-level distances only -- the genuinely safe subset.
// These are computed from developing_value_log rows with trade_date STRICTLY BEFORE the
// candidate's own trade_date, so there is zero lookahead risk by construction (matches the
// exact query shape acd.js's own live PD-level reads already use:
// `WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`). Deliberately does NOT yet cover
// the spec's same-session/intraday features (POC migration WITHIN today, cumulative-delta
// slope, VWAP distance, range percentiles, swing structure) -- those need "as of this exact
// moment, using only bars strictly before fired_at" computation, a meaningfully higher
// lookahead-risk profile that deserves its own careful pass (ideally with a live human in
// the loop to catch a subtle mistake), not a rushed unsupervised addition. See
// docs/OPEN_THREADS.md's 2026-09-21 entry for the full scoping rationale.
//
// One correction to the DeepSeek critique's own framing: it called POC-migration a missing
// feature needing fresh computation -- it isn't. developing_value_log already persists
// poc_delta_vs_prior/migration_dir_vs_prior/va_overlap_pct_vs_prior (the day-over-day
// migration this system already computes for its own developing-value tracking) -- this
// function just copies those through rather than recomputing them a second time.

// entry: the candidate's own real entry price (entry_zone_high ?? entry_zone_low).
// pdRow: a developing_value_log row for the trade_date STRICTLY PRIOR to this candidate's
//   own trade_date (caller's responsibility to fetch with `trade_date < $1 ORDER BY
//   trade_date DESC LIMIT 1`, matching the live convention exactly). Returns null if pdRow
//   is null (no prior-day data exists yet -- e.g. the very first trading day in history).
export function computePriorDayLevelFeatures(entry, pdRow) {
  if (entry == null || pdRow == null) return null;
  const poc = numOrNull(pdRow.poc), vah = numOrNull(pdRow.vah), val = numOrNull(pdRow.val);
  const pdh = numOrNull(pdRow.session_high), pdl = numOrNull(pdRow.session_low), pdc = numOrNull(pdRow.session_close);

  return {
    pdTradeDate: pdRow.trade_date,
    distToPdHigh: dist(entry, pdh),
    distToPdLow: dist(entry, pdl),
    distToPdClose: dist(entry, pdc),
    distToPdPoc: dist(entry, poc),
    distToPdVah: dist(entry, vah),
    distToPdVal: dist(entry, val),
    pdRange: (pdh != null && pdl != null) ? round1(pdh - pdl) : null,
    // Copied through, not recomputed -- developing_value_log already computes these for its
    // own day-over-day tracking (see this file's own header for why this ISN'T a fresh
    // computation despite the meta-labeling spec's own Section 3 listing it as a feature).
    pocDeltaVsPrior: numOrNull(pdRow.poc_delta_vs_prior),
    migrationDirVsPrior: pdRow.migration_dir_vs_prior ?? null,
    vaOverlapPctVsPrior: numOrNull(pdRow.va_overlap_pct_vs_prior),
  };
}

function dist(entry, level) { return (entry != null && level != null) ? round1(entry - level) : null; }
function round1(x) { return Math.round(x * 10) / 10; }
function numOrNull(x) { return x == null ? null : Number(x); }

// ── Same-session (intraday) features, added 2026-09-21 with the user watching ──────────
// This is the higher-lookahead-risk half deferred the night before -- built now with the
// user present rather than unsupervised, per docs/OPEN_THREADS.md's own stated reason for
// the deferral. Lookahead-safety here rests entirely on the CALLER: `bars` must be every
// price_bars_primary row for the candidate's own session, STRICTLY BEFORE `fired_at`
// (never including or after it -- mirrors the extended-label walker's own `ts > fired_at`
// boundary, just the opposite side of the same fired_at instant). computeDevelopingValueFeatures()
// itself has no awareness of "now" or "fired_at" -- it only ever sees whatever bars array
// it's handed, so passing the wrong bars is the only way this could leak the future; the
// backfill script's own query is what actually enforces the boundary (see
// backfill_ml_intraday_features.mjs's `ts < $1::timestamp`).
//
// Reuses the real, already-validated functions, per this codebase's "export the real
// function, never reimplement" rule -- computeProfile()/computeRunningVwapSeries() are
// developingValueService.js's own canonical POC/VAH/VAL and running-VWAP implementations
// (spread-volume approximation, same method used for developing_value_log itself), not a
// second, independent reimplementation of the same math.
//
// Deliberately NOT included in this pass (still genuinely deferred, more machinery needed
// than tonight's slice): range-percentile-vs-60-day-baseline (needs a rolling historical
// comparison, not just today's own bars -- va_width_pctile_60d/ib_range_pctile_60d already
// exist but only cover ~17% of real rows, a one-time historical backfill never kept
// current, not a reliable feature to lean on) and swing-structure/bars-since-swing (needs
// swingPivots.js integration). Both flagged as open follow-ons, not silently dropped.
//
// bars: ascending-ts array of { high, low, close, volume, bid_volume, ask_volume } for
//   price_bars_primary rows strictly before the candidate's own fired_at, same session only
//   (caller determines the session-open boundary via the candidate's own `is_rth` column --
//   RTH boundary mod 570, Globex boundary mod 1080, matching this codebase's existing
//   session-boundary convention elsewhere).
// entry: the candidate's own real entry price.
export function computeDevelopingValueFeatures(bars, entry) {
  if (!bars || bars.length === 0 || entry == null) return null;

  const profile = computeProfile(bars.map(b => ({ high: b.high, low: b.low, volume: (Number(b.bid_volume) || 0) + (Number(b.ask_volume) || 0) })));
  const vwapSeries = computeRunningVwapSeries(bars.map(b => ({ high: b.high, low: b.low, close: b.close, volume: (Number(b.bid_volume) || 0) + (Number(b.ask_volume) || 0) })));
  const devVwap = vwapSeries[vwapSeries.length - 1] ?? null;

  let sessionDelta = 0;
  for (const b of bars) sessionDelta += (Number(b.ask_volume) || 0) - (Number(b.bid_volume) || 0);
  const recentBars = bars.slice(-15);
  let recentDelta = 0;
  for (const b of recentBars) recentDelta += (Number(b.ask_volume) || 0) - (Number(b.bid_volume) || 0);

  return {
    barsInSessionSoFar: bars.length,
    distToDevPoc: profile ? dist(entry, profile.poc) : null,
    distToDevVah: profile ? dist(entry, profile.vah) : null,
    distToDevVal: profile ? dist(entry, profile.val) : null,
    distToDevVwap: dist(entry, devVwap),
    sessionCumulativeDelta: round1(sessionDelta),
    recentDelta15Bars: round1(recentDelta),
  };
}
