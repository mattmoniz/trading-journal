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
    WHERE v.model_version = $1 AND ${boundaryClause}
    GROUP BY v.verdict
  `, params);

  const allTrades = await query(`
    SELECT COUNT(*) AS n,
      SUM(a.actual_pnl)::float AS total_pnl,
      AVG(a.actual_pnl)::float AS avg_pnl,
      100.0 * COUNT(*) FILTER (WHERE a.actual_pnl > 0) / NULLIF(COUNT(*), 0) AS win_rate
    FROM ml_verdicts v
    JOIN active_setups a ON a.id = v.active_setup_id
    WHERE v.model_version = $1 AND ${boundaryClause}
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
    WHERE v.model_version = $1 AND ${boundaryClause}
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
  const conditions = ['v.model_version = $1'];
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

  const positional = [modelVersion];
  const conditions = ['v.model_version = $1'];
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
  conditions.push(`(EXTRACT(hour FROM a.fired_at)*60 + EXTRACT(minute FROM a.fired_at)) >= 570`);
  conditions.push(`(EXTRACT(hour FROM a.fired_at)*60 + EXTRACT(minute FROM a.fired_at)) < 1080`);

  const sql = `
    SELECT a.id, a.setup_type, a.trade_date::text AS trade_date,
      TO_CHAR(a.fired_at, 'YYYY-MM-DD HH24:MI:SS') AS fired_at_str,
      a.actual_pnl::float AS actual_pnl, a.resolution, a.is_cluster_primary,
      v.probability::float AS ml_probability, v.verdict AS ml_verdict
    FROM ml_verdicts v
    JOIN active_setups a ON a.id = v.active_setup_id
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
    SELECT a.id, a.setup_type, a.trade_date::text AS trade_date,
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

export { getLatestModel, getComparison, getCumulativePnlSeries, getTradeList, getRangeTrades, getStepTrailComparison };
