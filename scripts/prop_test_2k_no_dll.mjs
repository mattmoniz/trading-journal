// Ad hoc research request (2026-07-17): open-ended $2k prop-account Monte Carlo sweep with
// the daily loss limit (DLL) disabled, to find which sizing/source configurations actually
// survive and perform best WITHOUT that guardrail. Reuses the real, live simulation engine
// (server/services/monteCarloService.js's simulateRun/loadAndTagTrades/applyFilters/
// groupByDay -- exported for this reuse, not reimplemented) with a new noDLL account flag
// (off by default, so this doesn't change behavior for the live ScenarioTesterView.jsx or
// any other existing consumer of runMonteCarlo).
//
// MAJOR FINDINGS DURING CALIBRATION (kept here, not just in chat, so a future session
// doesn't have to rediscover either one):
//
// 1. Pool quality: the engine's raw "ALL" trade pool includes every historical trade from
//    every setup_type ever fired, not filtered by live SETUP_STATUS. 36.4% of pipeline
//    trades in the raw pool come from setup_types now confirmed SUPPRESS/THIN_N (summed pnl
//    -$43,549 in this pool's units), while the currently-ACTIVE/PROMOTE/DAY_TYPE_MANAGED
//    subset alone is net +$9,355. This script filters to that live-trusted subset before
//    sweeping. Edge/level synthetic sources (EMA_SNAPBACK -- independently confirmed 0% WR
//    historically per project memory, ABSORPTION, LEVEL_* touches) have no SETUP_STATUS
//    calibration at all, so ACTIVE_PIPELINE_ONLY is the primary/recommended pool;
//    ALL_UNFILTERED/PIPELINE_UNFILTERED are kept only as a "what happens if you don't
//    respect live suppression" control group.
//
// 2. A real production bug, not just a pool-quality issue: even the FILTERED pool showed
//    0% survival at every tested config, every starting balance $2k-$25k, and even a real
//    non-resampled chronological replay -- despite the pool testing at 65%+ WR and positive
//    average pnl. Root cause: monteCarloService.js's tagTrade() computed a winning pipeline
//    trade's point size as Math.abs(t.pnl/5) -- assuming $5/pt, which matches neither this
//    codebase's real MNQ $2/pt nor standard NQ's $20/pt (the exact "$/pt constant matches
//    neither instrument" bug class documented in CLAUDE.md's P&L hard rule). Losses used a
//    real point distance (stopDist) and were unaffected -- only wins were silently
//    understated, by 60% (a real $97 winner was credited as $38.80). This affected the LIVE
//    ScenarioTesterView.jsx / /api/scenario/* endpoints, not just this research. Fixed in
//    monteCarloService.js by using the real entry-to-target point distance for pipeline
//    trades (same source data stopDist already uses correctly) instead of the wrong divisor.
//    Verified against 8 real trades: implied dollars now match actual_pnl within rounding.
//
// Trailing drawdown (account.trailingDrawdown) is kept realistic throughout -- "no DLL"
// means no INTRADAY daily-loss circuit breaker, not "no capital-preservation constraint at
// all." A prop account without any drawdown limit isn't a real scenario worth optimizing for.
//
// Two-phase design: a coarse sweep (lower run count) across the full grid to find promising
// regions, then a deep re-run (much higher run count) on the top candidates for statistically
// solid final numbers.
import { query } from '../server/db.js';
import { loadAndTagTrades, simulateRun, groupByDay } from '../server/services/monteCarloService.js';

const COARSE_RUNS = 400;
const DEEP_RUNS = 5000;
const TOP_N = 10;

const RISK_PCT_GRID = [0.005, 0.010, 0.015, 0.020, 0.025, 0.030];
const MAX_RISK_GRID = [0.03, 0.05, 0.08];
const POST_LOSS_GRID = [null, 0.5];
const CONVICTION_GRID = [true, false];
const TRAILING_DD_GRID = [1000, 1500, 2000];
const DLL_GRID = [true, false]; // true = noDLL (disabled), false = live DLL tiers active

function summarize(results, startingBalance) {
  const finals = results.map(r => r.final).sort((a, b) => a - b);
  const maxDDs = results.map(r => r.maxDD).sort((a, b) => a - b);
  const blown = results.filter(r => r.blown).length;
  const pct = (p) => finals[Math.min(finals.length - 1, Math.floor(p / 100 * finals.length))];
  return {
    n: results.length,
    survivalRate: +(100 * (results.length - blown) / results.length).toFixed(1),
    median: pct(50), p10: pct(10), p25: pct(25), p75: pct(75), p90: pct(90),
    min: finals[0], max: finals[finals.length - 1],
    medianReturnPct: +((pct(50) / startingBalance - 1) * 100).toFixed(0),
    avgMaxDD: Math.round(maxDDs.reduce((s, v) => s + v, 0) / maxDDs.length),
  };
}

async function buildPools() {
  const { rows: statusRows } = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation
    FROM performance_audit WHERE signal_type='SETUP_STATUS'
    ORDER BY signal_name, run_date DESC
  `);
  const statusMap = {};
  for (const r of statusRows) statusMap[r.signal_name] = r.recommendation;
  const isLiveTrusted = (setupType) => {
    const rec = statusMap[setupType];
    return rec === 'ACTIVE' || rec === 'PROMOTE' || rec === 'DAY_TYPE_MANAGED';
  };

  const { pipelineTrades, edgeTrades, levelTrades } = await loadAndTagTrades({
    sources: { pipelineSetups: true, edgeSignals: true, levelTrades: true }, dateRange: {},
  });

  const pools = {};

  // PRIMARY: only pipeline setup_types the live system currently trusts (respects the
  // unified suppression pipeline instead of ignoring it).
  const activePipeline = pipelineTrades.filter(t => isLiveTrusted(t.setup_type));
  pools.ACTIVE_PIPELINE_ONLY = { tradeDays: groupByDay(activePipeline), n: activePipeline.length };

  // CONTROL GROUPS: unfiltered pools, kept only to quantify how much the suppressed-setup
  // drag actually costs -- not scenarios to recommend.
  pools.ALL_UNFILTERED = { tradeDays: groupByDay([...pipelineTrades, ...edgeTrades, ...levelTrades]), n: pipelineTrades.length + edgeTrades.length + levelTrades.length };
  pools.PIPELINE_UNFILTERED = { tradeDays: groupByDay(pipelineTrades), n: pipelineTrades.length };

  return pools;
}

async function sweepPool(label, tradeDays, startingBalance, results) {
  for (const noDLL of DLL_GRID) {
    for (const riskPctPerTrade of RISK_PCT_GRID) {
      for (const maxRiskPct of MAX_RISK_GRID) {
        for (const postLossReduction of POST_LOSS_GRID) {
          for (const convictionScaling of CONVICTION_GRID) {
            for (const trailingDrawdown of TRAILING_DD_GRID) {
              const config = {
                account: { startingBalance, pointValue: 2, commission: 0.50, maxContracts: 20, trailingDrawdown, drawdownFreezeProfit: 3000, noDLL },
                sizing: { riskPctPerTrade, maxRiskPct, stopOverride: null, postLossReduction, convictionScaling },
              };
              const runs = [];
              for (let r = 0; r < COARSE_RUNS; r++) runs.push(simulateRun(tradeDays, config, true));
              const s = summarize(runs, startingBalance);
              results.push({ pool: label, noDLL, riskPctPerTrade, maxRiskPct, postLossReduction, convictionScaling, trailingDrawdown, ...s });
            }
          }
        }
      }
    }
  }
}

async function main() {
  console.log('=== $2k prop test sweep -- filtered to live-trusted setups, DLL on/off compared ===\n');
  const startingBalance = 2000;

  const pools = await buildPools();
  for (const [label, p] of Object.entries(pools)) console.log(`Pool ${label}: ${p.n} trades / ${p.tradeDays.length} days`);

  const totalCombos = RISK_PCT_GRID.length * MAX_RISK_GRID.length * POST_LOSS_GRID.length * CONVICTION_GRID.length * TRAILING_DD_GRID.length * DLL_GRID.length;
  console.log(`\nGrid per pool: ${totalCombos} combos x ${COARSE_RUNS} runs (coarse pass), primary pool = ACTIVE_PIPELINE_ONLY\n`);

  const coarseResults = [];
  const t0 = Date.now();
  await sweepPool('ACTIVE_PIPELINE_ONLY', pools.ACTIVE_PIPELINE_ONLY.tradeDays, startingBalance, coarseResults);
  console.log(`  ACTIVE_PIPELINE_ONLY done (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  await sweepPool('ALL_UNFILTERED', pools.ALL_UNFILTERED.tradeDays, startingBalance, coarseResults);
  console.log(`  ALL_UNFILTERED (control) done (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  await sweepPool('PIPELINE_UNFILTERED', pools.PIPELINE_UNFILTERED.tradeDays, startingBalance, coarseResults);
  console.log(`  PIPELINE_UNFILTERED (control) done (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);

  // Control-group summary: quantify the suppressed-setup drag directly.
  for (const pool of ['ACTIVE_PIPELINE_ONLY', 'ALL_UNFILTERED', 'PIPELINE_UNFILTERED']) {
    const rows = coarseResults.filter(r => r.pool === pool && !r.noDLL && r.riskPctPerTrade === 0.015 && r.maxRiskPct === 0.05 && r.trailingDrawdown === 1500);
    const r = rows[0];
    if (r) console.log(`[control check, default-ish sizing WITH DLL] ${pool.padEnd(22)} survival=${r.survivalRate}%  median=$${r.median}`);
  }

  const survivable = coarseResults.filter(r => r.survivalRate >= 90);
  console.log(`\n${survivable.length} of ${coarseResults.length} total combos (all pools) cleared >=90% survival.\n`);

  const noDLLSurvivable = survivable.filter(r => r.noDLL);
  console.log(`Of those, ${noDLLSurvivable.length} have the DLL DISABLED (the actual ask). Ranked by median final balance:\n`);
  const ranked = [...noDLLSurvivable].sort((a, b) => b.median - a.median);
  const top = ranked.slice(0, TOP_N);

  for (const r of top) {
    console.log(`pool=${r.pool.padEnd(22)} risk%=${r.riskPctPerTrade} maxRisk%=${r.maxRiskPct} postLoss=${r.postLossReduction ?? 'off'} conviction=${r.convictionScaling} trailDD=$${r.trailingDrawdown}  survival=${r.survivalRate}%  median=$${r.median} (${r.medianReturnPct >= 0 ? '+' : ''}${r.medianReturnPct}%)  p10=$${r.p10} p90=$${r.p90} avgMaxDD=$${r.avgMaxDD}`);
  }

  if (top.length === 0) {
    console.log('Still nothing cleared 90% survival without DLL, even on the filtered pool. Best-survival fallback (any DLL setting) among ACTIVE_PIPELINE_ONLY:');
    const fallback = coarseResults.filter(r => r.pool === 'ACTIVE_PIPELINE_ONLY').sort((a, b) => b.survivalRate - a.survivalRate).slice(0, 10);
    for (const r of fallback) {
      console.log(`noDLL=${r.noDLL} risk%=${r.riskPctPerTrade} maxRisk%=${r.maxRiskPct} postLoss=${r.postLossReduction ?? 'off'} conviction=${r.convictionScaling} trailDD=$${r.trailingDrawdown}  survival=${r.survivalRate}%  median=$${r.median}`);
    }
    process.exit(0);
  }

  // ── Deep re-run of the top no-DLL candidates ──
  console.log(`\n--- DEEP RE-RUN of top ${top.length} no-DLL candidates (${DEEP_RUNS} runs each) ---\n`);
  const deep = [];
  for (const cand of top) {
    const tradeDays = pools[cand.pool].tradeDays;
    const config = {
      account: { startingBalance, pointValue: 2, commission: 0.50, maxContracts: 20, trailingDrawdown: cand.trailingDrawdown, drawdownFreezeProfit: 3000, noDLL: true },
      sizing: { riskPctPerTrade: cand.riskPctPerTrade, maxRiskPct: cand.maxRiskPct, stopOverride: null, postLossReduction: cand.postLossReduction, convictionScaling: cand.convictionScaling },
    };
    const runs = [];
    for (let r = 0; r < DEEP_RUNS; r++) runs.push(simulateRun(tradeDays, config, true));
    deep.push({ ...cand, deep: summarize(runs, startingBalance) });
  }
  deep.sort((a, b) => b.deep.median - a.deep.median);

  for (const r of deep) {
    console.log(`pool=${r.pool.padEnd(22)} risk%=${r.riskPctPerTrade} maxRisk%=${r.maxRiskPct} postLoss=${r.postLossReduction ?? 'off'} conviction=${r.convictionScaling} trailDD=$${r.trailingDrawdown}`);
    console.log(`  survival=${r.deep.survivalRate}%  median=$${r.deep.median} (${r.deep.medianReturnPct >= 0 ? '+' : ''}${r.deep.medianReturnPct}%)  p10=$${r.deep.p10} p25=$${r.deep.p25} p75=$${r.deep.p75} p90=$${r.deep.p90}  min=$${r.deep.min} max=$${r.deep.max}  avgMaxDD=$${r.deep.avgMaxDD}`);
  }

  console.log('\n=== BEST OVERALL (deep-verified, no-DLL, live-trusted-setups-only) ===');
  console.log(JSON.stringify(deep[0], null, 2));

  // Same best config WITH DLL re-enabled, for a direct apples-to-apples comparison.
  const best = deep[0];
  const withDLLConfig = {
    account: { startingBalance, pointValue: 2, commission: 0.50, maxContracts: 20, trailingDrawdown: best.trailingDrawdown, drawdownFreezeProfit: 3000, noDLL: false },
    sizing: { riskPctPerTrade: best.riskPctPerTrade, maxRiskPct: best.maxRiskPct, stopOverride: null, postLossReduction: best.postLossReduction, convictionScaling: best.convictionScaling },
  };
  const withDLLRuns = [];
  for (let r = 0; r < DEEP_RUNS; r++) withDLLRuns.push(simulateRun(pools[best.pool].tradeDays, withDLLConfig, true));
  const withDLLSummary = summarize(withDLLRuns, startingBalance);
  console.log('\n=== SAME CONFIG, DLL RE-ENABLED (comparison) ===');
  console.log(`survival=${withDLLSummary.survivalRate}%  median=$${withDLLSummary.median} (${withDLLSummary.medianReturnPct >= 0 ? '+' : ''}${withDLLSummary.medianReturnPct}%)  p10=$${withDLLSummary.p10} p90=$${withDLLSummary.p90}  avgMaxDD=$${withDLLSummary.avgMaxDD}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
