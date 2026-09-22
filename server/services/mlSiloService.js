// ML meta-labeling silo -- comparison/summary reads, deliberately isolated from the live
// trading path per this codebase's "isolate non-trading features" convention. This module
// only ever READS ml_models/ml_verdicts and joins them against active_setups for display --
// it never writes anything, and nothing here influences origin_status/status/suppression
// for any real row. Model training/scoring itself lives in scripts/ml_meta_labeling/
// (Python) -- this file is purely the read side for the comparison dashboard.
//
// Per the user's explicit request (2026-09-21): everything is scoped to the WHOLE roster
// (every setup_type), not just the 9 currently-ACTIVE ones -- the whole point of this silo
// is to see what the model does across trades that don't currently fire live at all.
import { query } from '../db.js';
import { resolveRangeDates } from './acdShared.js';

// Shared floor for any ML recalibration script's CONFIRMED/PROVISIONAL status gate --
// added 2026-09-22, resolves OPEN_DECISION ml_thread_ci_gate_and_cleanup_backlog_20260921's
// F2 finding (DeepSeek review): the day-blocked bootstrap CI excludesZero check alone reads
// raw N, never distinctDates, so a thin/day-clustered population (e.g. the old Globex TAKE
// N=14/2-distinct-dates) could flip CONFIRMED off what's really just "both trading days were
// negative," not a real statistical statement. Exported here (not duplicated per-script) so
// every recalibration script's status gate stays in sync -- see
// scripts/recalibrate_ml_globex_split.mjs / recalibrate_ml_walkforward.mjs /
// recalibrate_ml_probability_sizing_pretest.mjs for the 3 call sites this floor gates.
export const ML_CLAIM_DISTINCT_DATES_FLOOR = 8;

async function getLatestModel() {
  const r = await query(`
    SELECT model_version, trained_at::text, train_n, test_n,
      train_positive_rate::float, test_positive_rate::float, test_auc::float,
      approval_threshold::float, train_end_at::text, test_start_at::text,
      feature_list, test_metrics, notes
    FROM ml_models ORDER BY trained_at DESC LIMIT 1
  `);
  return r.rows[0] || null;
}

// Real, in-sample-vs-out-of-sample distinction, not glossed over -- the model has already
// seen train-period rows during fitting, so its verdict on them is a biased, optimistic
// read, not a genuine test of anything. `sample` lets a caller ask for either explicitly;
// the API layer defaults to 'test' (the only honest comparison) and requires an explicit
// opt-in to see the in-sample numbers at all.
// GLOBEX_EXCLUSION_SQL: matches getRangeTrades()'s own filter exactly (570-1080 minutes =
// 9:30am-6pm ET) -- factored out 2026-09-22 (OPEN_DECISION
// ml_silo_deepseek_followup_review_parked_20260921, item 2) so getComparison/
// getCumulativePnlSeries/getTradeList apply the SAME Globex exclusion getRangeTrades() already
// does, instead of silently pooling RTH+Globex. Does NOT match active_setups.is_rth (strictly
// 9:30am-4pm) -- see getRangeTrades()'s own comment on that deliberate difference.
const GLOBEX_EXCLUSION_SQL = `(EXTRACT(hour FROM a.fired_at)*60 + EXTRACT(minute FROM a.fired_at)) >= 570
      AND (EXTRACT(hour FROM a.fired_at)*60 + EXTRACT(minute FROM a.fired_at)) < 1080`;

async function getComparison(modelVersion, sample = 'test') {
  const model = await query(`SELECT test_start_at, train_end_at FROM ml_models WHERE model_version = $1`, [modelVersion]);
  if (!model.rows[0]) return null;
  const { test_start_at, train_end_at } = model.rows[0];

  const boundaryClause = sample === 'test' ? 'a.fired_at >= $2::timestamp'
    : sample === 'train' ? 'a.fired_at <= $2::timestamp'
    : '1=1'; // 'all' -- includes both, caller's explicit choice, not a default
  const boundaryParam = sample === 'test' ? test_start_at : sample === 'train' ? train_end_at : null;
  const params = boundaryParam ? [modelVersion, boundaryParam] : [modelVersion];

  const byVerdict = await query(`
    SELECT v.verdict, COUNT(*) AS n,
      SUM(a.actual_pnl)::float AS total_pnl,
      AVG(a.actual_pnl)::float AS avg_pnl,
      100.0 * COUNT(*) FILTER (WHERE a.actual_pnl > 0) / NULLIF(COUNT(*), 0) AS win_rate
    FROM ml_verdicts v
    JOIN active_setups a ON a.id = v.active_setup_id
    WHERE v.model_version = $1 AND ${boundaryClause} AND ${GLOBEX_EXCLUSION_SQL}
    GROUP BY v.verdict
  `, params);

  const allTrades = await query(`
    SELECT COUNT(*) AS n,
      SUM(a.actual_pnl)::float AS total_pnl,
      AVG(a.actual_pnl)::float AS avg_pnl,
      100.0 * COUNT(*) FILTER (WHERE a.actual_pnl > 0) / NULLIF(COUNT(*), 0) AS win_rate
    FROM ml_verdicts v
    JOIN active_setups a ON a.id = v.active_setup_id
    WHERE v.model_version = $1 AND ${boundaryClause} AND ${GLOBEX_EXCLUSION_SQL}
  `, params);

  return {
    sample,
    boundary: boundaryParam,
    allTrades: allTrades.rows[0],
    byVerdict: byVerdict.rows,
  };
}

// Cumulative P&L over time, both populations, for a real vs. ML-gated equity-curve chart.
async function getCumulativePnlSeries(modelVersion, sample = 'test') {
  const model = await query(`SELECT test_start_at, train_end_at FROM ml_models WHERE model_version = $1`, [modelVersion]);
  if (!model.rows[0]) return null;
  const { test_start_at, train_end_at } = model.rows[0];
  const boundaryClause = sample === 'test' ? 'a.fired_at >= $2::timestamp'
    : sample === 'train' ? 'a.fired_at <= $2::timestamp' : '1=1';
  const boundaryParam = sample === 'test' ? test_start_at : sample === 'train' ? train_end_at : null;
  const params = boundaryParam ? [modelVersion, boundaryParam] : [modelVersion];

  const r = await query(`
    SELECT a.trade_date::text AS trade_date,
      SUM(a.actual_pnl)::float AS all_pnl,
      SUM(a.actual_pnl) FILTER (WHERE v.verdict = 'TAKE')::float AS ml_pnl
    FROM ml_verdicts v
    JOIN active_setups a ON a.id = v.active_setup_id
    WHERE v.model_version = $1 AND ${boundaryClause} AND ${GLOBEX_EXCLUSION_SQL}
    GROUP BY a.trade_date
    ORDER BY a.trade_date ASC
  `, params);

  let allCum = 0, mlCum = 0;
  return r.rows.map(row => {
    allCum += row.all_pnl || 0;
    mlCum += row.ml_pnl || 0;
    return { tradeDate: row.trade_date, allCumPnl: Math.round(allCum * 100) / 100, mlCumPnl: Math.round(mlCum * 100) / 100 };
  });
}

// Per-trade drill-down -- the "why did ML gate this one" view. limit/offset for pagination
// (this can be thousands of rows across the whole roster). Params are built as a single
// positional array in the same order the $N placeholders are appended, per this codebase's
// own standing rule to dry-run/verify $N param counts rather than count them by hand.
async function getTradeList({ modelVersion, sample = 'test', setupType = null, verdict = null, limit = 100, offset = 0 }) {
  const model = await query(`SELECT test_start_at, train_end_at FROM ml_models WHERE model_version = $1`, [modelVersion]);
  if (!model.rows[0]) return null;
  const { test_start_at, train_end_at } = model.rows[0];
  const boundaryParam = sample === 'test' ? test_start_at : sample === 'train' ? train_end_at : null;

  const positional = [modelVersion];
  const conditions = ['v.model_version = $1', GLOBEX_EXCLUSION_SQL];
  if (boundaryParam) {
    positional.push(boundaryParam);
    conditions.push(`a.fired_at ${sample === 'test' ? '>=' : '<='} $${positional.length}::timestamp`);
  }
  if (setupType) { positional.push(setupType); conditions.push(`a.setup_type = $${positional.length}`); }
  if (verdict) { positional.push(verdict); conditions.push(`v.verdict = $${positional.length}`); }
  positional.push(limit); const limitIdx = positional.length;
  positional.push(offset); const offsetIdx = positional.length;

  const sql = `
    SELECT a.id, a.setup_type, a.fired_at::text AS fired_at, a.trade_date::text AS trade_date,
      a.actual_pnl::float AS actual_pnl, a.resolution,
      v.probability::float AS ml_probability, v.verdict AS ml_verdict
    FROM ml_verdicts v
    JOIN active_setups a ON a.id = v.active_setup_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.fired_at DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;
  const r = await query(sql, positional);
  return r.rows;
}

// Range-filterable trade list, added 2026-09-21 (user request: "the same views... for ML,
// with charts, pnl and different timeframes" -- mirroring /api/setups/range-summary's own
// today/week/month/year/all tabs). Reuses the shared resolveRangeDates() (acdShared.js) so
// this doesn't reimplement that same session-boundary date math a third time.
//
// Deliberately does NOT exclude is_cluster_primary=false rows, unlike the main Performance
// section's own getDecidedRows() (quick-check.html) -- that exclusion exists to avoid
// double-counting ONE real market touch as several trades in an ACCOUNT-level P&L total.
// This silo's whole point (per the same-day individual-level fix) is the opposite: each
// level touched in a cluster is its OWN scored candidate, and the user explicitly asked to
// see them individually, not collapsed to one cluster "winner." is_cluster_primary is
// returned in the row so a consumer that DOES want account-level totals can filter it
// itself, but the default here is per-level.
async function getRangeTrades({ modelVersion, sample = 'test', range = 'today' }) {
  const model = await query(`SELECT test_start_at, train_end_at FROM ml_models WHERE model_version = $1`, [modelVersion]);
  if (!model.rows[0]) return null;
  const { test_start_at, train_end_at } = model.rows[0];
  const boundaryParam = sample === 'test' ? test_start_at : sample === 'train' ? train_end_at : null;

  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const resolved = resolveRangeDates(range, nowET);

  // Deliberately NOT `v.model_version = $1` (found 2026-09-22, user-caught live: "Today"
  // showed 8 scored candidates right after an intraday retrain, when 67 of 68 real touches
  // that day actually had a real verdict -- just mostly under the PRIOR model_version from
  // earlier the same day). ml_verdicts is keyed by model_version with no cross-version
  // carryover, and the fire-time incremental scorer (mlFireTimeScoring.js) only looks back
  // 15 minutes, so it can never "catch up" same-day fires to a freshly-retrained model on
  // its own -- only the once-daily backfill does, which hadn't run yet. Using each trade's
  // own MOST RECENT verdict (any model_version, picked below via a LATERAL join) instead of
  // requiring an exact match to the CURRENT latest model fixes this without needing to
  // enumerate every model_version that fired today. Sample-boundary values (test_start_at/
  // train_end_at) still come from the current model specifically -- in practice this split
  // point has stayed frozen across every retrain observed so far (all point at the same
  // 2026-09-09 boundary), so this doesn't change what counts as in-sample vs out-of-sample.
  // Scoped to just THIS function, not the other 6 `v.model_version = $1` call sites in this
  // file (getComparison/getCumulativePnlSeries/getTradeList/getStepTrailComparison/
  // getDayRankComparison) -- those drive the model's own train/test comparison stats, whose
  // semantics need separate, deliberate thought before changing; see
  // OPEN_DECISION ml_silo_model_version_scoping_other_5_functions_20260922.
  const positional = [];
  const conditions = [];
  if (boundaryParam) {
    positional.push(boundaryParam);
    conditions.push(`a.fired_at ${sample === 'test' ? '>=' : '<='} $${positional.length}::timestamp`);
  }
  if (resolved.mode === 'dates') {
    positional.push(resolved.dates);
    conditions.push(`a.trade_date = ANY($${positional.length})`);
  } else if (resolved.mode === 'since') {
    positional.push(resolved.sinceStr);
    conditions.push(`a.trade_date >= $${positional.length}::date`);
  }

  // Globex omitted entirely (2026-09-21, user request: "eliminate globex view from
  // rth...similar to how we do it for all trades? The pnl is different for rth in the ml
  // view") -- matches /api/setups/range-summary's own already-established 2026-09-16
  // decision to exclude Globex from the main Performance section entirely, unconditionally,
  // not just filter it out of a toggle. Same exact RTH-window boundary (570-1080 minutes =
  // 9:30am-6pm ET) as that endpoint's own query, so the two are now genuinely
  // apples-to-apples comparable instead of silently pooling two different populations.
  //
  // DOES NOT MATCH active_setups.is_rth (flagged 2026-09-22, OPEN_DECISION
  // ml_thread_ci_gate_and_cleanup_backlog_20260921 F1) -- that generated column is strictly
  // [9:30am,4pm) ET (server/schema.sql), while this dashboard filter deliberately runs through
  // 6pm to match range-summary's own convention. The two "RTH" populations differ by the
  // 4pm-6pm post-RTH window: `getRangeTrades()` here counts trades fired in that window as
  // "RTH," the recalibration scripts' own `is_rth`-based split (scripts/recalibrate_ml_
  // globex_split.mjs) does not. This is deliberate, not a bug -- but do NOT directly compare
  // a number from this dashboard view against a number from an `is_rth`-based script and
  // assume they describe the same population.
  conditions.push(GLOBEX_EXCLUSION_SQL);

  const sql = `
    SELECT a.id, a.setup_type, a.trade_date::text AS trade_date,
      TO_CHAR(a.fired_at, 'YYYY-MM-DD HH24:MI:SS') AS fired_at_str,
      a.actual_pnl::float AS actual_pnl, a.resolution, a.is_cluster_primary,
      v.probability::float AS ml_probability, v.verdict AS ml_verdict,
      v.model_version AS ml_model_version
    FROM active_setups a
    JOIN LATERAL (
      SELECT probability, verdict, model_version
      FROM ml_verdicts
      WHERE active_setup_id = a.id
      ORDER BY scored_at DESC
      LIMIT 1
    ) v ON true
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.fired_at ASC
  `;
  const r = await query(sql, positional);
  return { rangeLabel: resolved.rangeLabel, trades: r.rows };
}

// "ML gates entry, a validated trail mechanism decides how far to let it run" -- the
// coupling step the user asked for next, 2026-09-21. NEITHER piece is validated on its own
// yet (this model's walk-forward CI still crosses zero; step_trail_shadow's own
// RESEARCH_CLAIM step_trail_runner_shadow_parallel_20260904 is PROVISIONAL, not promoted --
// see CLAUDE.md's "Step-trail runner extension" entry), so this stays exactly what the rest
// of the silo already is: a read-only, isolated RESEARCH COMPARISON, never live-wired.
// Composes two already-computed, already-persisted pieces (ml_verdicts.verdict='TAKE' +
// active_setups.step_trail_shadow's own hypothetical_pnl, written independently by
// acd.js's resolveSetupsByPrice()/completeStepTrailShadows() on every real trade that
// reaches the existing 1.5x wider target) rather than inventing new trade machinery --
// answers "what would ML-gated entry + the step-trail exit have done" vs. "what did
// ML-gated entry + the normal exit actually do," on the same real trade population.
async function getStepTrailComparison(modelVersion, sample = 'test') {
  const model = await query(`SELECT test_start_at, train_end_at FROM ml_models WHERE model_version = $1`, [modelVersion]);
  if (!model.rows[0]) return null;
  const { test_start_at, train_end_at } = model.rows[0];
  const boundaryClause = sample === 'test' ? 'a.fired_at >= $2::timestamp'
    : sample === 'train' ? 'a.fired_at <= $2::timestamp' : '1=1';
  const boundaryParam = sample === 'test' ? test_start_at : sample === 'train' ? train_end_at : null;
  const params = boundaryParam ? [modelVersion, boundaryParam] : [modelVersion];

  const r = await query(`
    SELECT a.id, a.setup_type, a.trade_date::text AS trade_date, a.cluster_touch_id,
      a.actual_pnl::float AS normal_pnl,
      (a.step_trail_shadow->>'hypothetical_pnl')::float AS trail_pnl
    FROM ml_verdicts v
    JOIN active_setups a ON a.id = v.active_setup_id
    WHERE v.model_version = $1 AND v.verdict = 'TAKE'
      AND a.step_trail_shadow IS NOT NULL
      AND ${boundaryClause}
    ORDER BY a.fired_at ASC
  `, params);

  const rows = r.rows;
  const n = rows.length;
  const normalTotal = rows.reduce((s, x) => s + x.normal_pnl, 0);
  const trailTotal = rows.reduce((s, x) => s + x.trail_pnl, 0);
  return {
    sample, n,
    normalTotal: +normalTotal.toFixed(2),
    trailTotal: +trailTotal.toFixed(2),
    normalAvg: n ? +(normalTotal / n).toFixed(2) : null,
    trailAvg: n ? +(trailTotal / n).toFixed(2) : null,
    rows,
  };
}

// Within-(day x session) relative-ranking DIAGNOSTIC view -- item 3 of the 2026-09-21
// DeepSeek ML silo review, built 2026-09-22 per a focused follow-up design critique
// (OPEN_DECISION ml_silo_deepseek_followup_review_parked_20260921 has the full account).
// Deliberately a SEPARATE view from getComparison()'s TAKE/VETO breakdown above, never
// merged into it -- `verdict` answers "does this clear an absolute, frozen threshold";
// `day_rank_pct` (computed retrospectively, batch-only, by run_silo_scoring.py's
// compute_day_rank_pct()) answers "how does this compare to its own day's same-session
// peers" -- two genuinely different questions this thread learned NOT to conflate under
// one field. DAY_RANK_TOP_QUARTILE=0.75 matches this thread's own existing
// APPROVAL_PERCENTILE convention (train.py), not a newly-invented number. Rows with a NULL
// day_rank_pct (thin same-day-session cohort, below run_silo_scoring.py's MIN_COHORT_N
// floor) are excluded from both buckets -- a meaningless rank shouldn't silently count as
// "bottom" or "top."
const DAY_RANK_TOP_QUARTILE = 0.75;

async function getDayRankComparison(modelVersion, sample = 'test') {
  const model = await query(`SELECT test_start_at, train_end_at FROM ml_models WHERE model_version = $1`, [modelVersion]);
  if (!model.rows[0]) return null;
  const { test_start_at, train_end_at } = model.rows[0];
  const boundaryClause = sample === 'test' ? 'a.fired_at >= $2::timestamp'
    : sample === 'train' ? 'a.fired_at <= $2::timestamp' : '1=1';
  const boundaryParam = sample === 'test' ? test_start_at : sample === 'train' ? train_end_at : null;
  const params = boundaryParam ? [modelVersion, boundaryParam] : [modelVersion];

  const r = await query(`
    SELECT
      COUNT(*) FILTER (WHERE v.day_rank_pct >= ${DAY_RANK_TOP_QUARTILE}) AS top_n,
      SUM(a.actual_pnl) FILTER (WHERE v.day_rank_pct >= ${DAY_RANK_TOP_QUARTILE})::float AS top_pnl,
      AVG(a.actual_pnl) FILTER (WHERE v.day_rank_pct >= ${DAY_RANK_TOP_QUARTILE})::float AS top_avg_pnl,
      100.0 * COUNT(*) FILTER (WHERE v.day_rank_pct >= ${DAY_RANK_TOP_QUARTILE} AND a.actual_pnl > 0)
        / NULLIF(COUNT(*) FILTER (WHERE v.day_rank_pct >= ${DAY_RANK_TOP_QUARTILE}), 0) AS top_win_rate,
      COUNT(*) FILTER (WHERE v.day_rank_pct IS NOT NULL AND v.day_rank_pct < ${DAY_RANK_TOP_QUARTILE}) AS rest_n,
      SUM(a.actual_pnl) FILTER (WHERE v.day_rank_pct IS NOT NULL AND v.day_rank_pct < ${DAY_RANK_TOP_QUARTILE})::float AS rest_pnl,
      AVG(a.actual_pnl) FILTER (WHERE v.day_rank_pct IS NOT NULL AND v.day_rank_pct < ${DAY_RANK_TOP_QUARTILE})::float AS rest_avg_pnl,
      100.0 * COUNT(*) FILTER (WHERE v.day_rank_pct IS NOT NULL AND v.day_rank_pct < ${DAY_RANK_TOP_QUARTILE} AND a.actual_pnl > 0)
        / NULLIF(COUNT(*) FILTER (WHERE v.day_rank_pct IS NOT NULL AND v.day_rank_pct < ${DAY_RANK_TOP_QUARTILE}), 0) AS rest_win_rate,
      COUNT(*) FILTER (WHERE v.day_rank_pct IS NULL) AS thin_cohort_excluded_n
    FROM ml_verdicts v
    JOIN active_setups a ON a.id = v.active_setup_id
    WHERE v.model_version = $1 AND ${boundaryClause} AND ${GLOBEX_EXCLUSION_SQL} AND a.actual_pnl IS NOT NULL
  `, params);

  return { sample, topQuartileThreshold: DAY_RANK_TOP_QUARTILE, ...r.rows[0] };
}

export { getLatestModel, getComparison, getCumulativePnlSeries, getTradeList, getRangeTrades, getStepTrailComparison, getDayRankComparison };
