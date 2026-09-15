// Extension of scripts/backtest_garch_scaled_stop_all_setups.mjs -- scales BOTH the stop
// AND target distance by the same day's GARCH_VOL_SCALE ratio (clamped to a rolling p01/p99
// band), instead of only the stop. The stop-only version narrows risk:reward on volatile
// days (bigger risk, same reward) since the target never moves -- this is the "triple-barrier
// method" (Lopez de Prado) done properly, scaling both barriers together so R:R is preserved
// across regimes. Read docs/OPEN_THREADS.md's 2026-09-08 "triple GARCH" entry for the full
// scoping history and the DeepSeek design critique this was built from -- summarized here:
//
//   - Scale DISTANCES (opt.stop/opt.target, which OPTIMAL_STOP already stores as point
//     distances, not price levels), never multiply stop_level/t1_level directly -- entry != 0
//     makes that meaningless. This script only ever computes hypothetical bar-walk PnL from
//     mae_points/mfe_points (both already distances from entry), so this concern doesn't even
//     arise here -- flagged for whoever eventually wires this into a live price-level
//     computation.
//   - This is the cheap, backtest-only diagnostic step (DeepSeek's finding #9) that must
//     clear rigor before any live shadow-tracking infrastructure gets built -- this script
//     does NOT touch active_setups, does NOT write a RESEARCH_CLAIM automatically, and does
//     NOT promote anything. It answers one question: does dual-scaling look promising at all,
//     on the CURRENT (post-catch-up-backfill, mid-July-through-today) GARCH_VOL_SCALE data.
//   - Also reports real (origin_status IN ACTIVE/SHADOW) N per setup_type, and cross-references
//     against the LATEST SETUP_STATUS recommendation -- a candidate that's already SUPPRESSED
//     has zero live relevance regardless of how good its backtest number looks (the exact
//     mistake almost made with the stop-only version's "5 both-improved" list, all 5 of which
//     turned out to be SUPPRESS/THIN_N).
//
// Run: node scripts/backtest_garch_dual_barrier_all_setups.mjs
import fs from 'fs';
import { query } from '../server/db.js';
import { computeEvAtStopTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';

const MIN_N = 20;

async function main() {
  const todayRes = await query(`SELECT CURRENT_DATE::text as today`);
  const todayStr = todayRes.rows[0].today;

  console.log("Loading GARCH scales...");
  const scaleRes = await query(`
    SELECT signal_name::text as date, (notes::jsonb->>'scale')::float as scale
    FROM performance_audit
    WHERE signal_type = 'GARCH_VOL_SCALE'
  `);
  const scales = [];
  const scaleMap = {};
  for (const r of scaleRes.rows) {
    scales.push(r.scale);
    scaleMap[r.date] = r.scale;
  }
  scales.sort((a, b) => a - b);
  const p01 = scales[Math.floor(scales.length * 0.01)] || 1;
  const p99 = scales[Math.floor(scales.length * 0.99)] || 1;
  console.log(`Scale coverage: ${scales.length} days (${scaleRes.rows[0]?.date} .. latest). p01=${p01.toFixed(3)} p99=${p99.toFixed(3)}`);

  console.log("Loading optimal stops...");
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, optimal_stop, optimal_target
    FROM performance_audit
    WHERE signal_type = 'OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const optMap = {};
  for (const r of optRes.rows) {
    optMap[r.setup_type] = { stop: parseFloat(r.optimal_stop), target: parseFloat(r.optimal_target) };
  }

  console.log("Loading live SETUP_STATUS recommendations...");
  const statusRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation
    FROM performance_audit WHERE signal_type='SETUP_STATUS'
    ORDER BY signal_name, run_date DESC
  `);
  const statusMap = Object.fromEntries(statusRes.rows.map(r => [r.signal_name, r.recommendation]));

  console.log("Loading setup type trade stats...");
  const statsRes = await query(`
    SELECT setup_type, COUNT(*) as n
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND status = 'RESOLVED'
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
    GROUP BY setup_type
    HAVING COUNT(*) >= ${MIN_N}
  `);
  const setupTypes = statsRes.rows.map(r => r.setup_type).filter(st => optMap[st]);
  console.log(`Found ${setupTypes.length} valid setup types.`);

  console.log("Loading real (ACTIVE/SHADOW) trade counts per type...");
  const realNRes = await query(`
    SELECT setup_type, COUNT(*) n
    FROM active_setups
    WHERE ${REAL_TRADE_FILTER}
      AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND status = 'RESOLVED' AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
    GROUP BY setup_type
  `);
  const realNMap = Object.fromEntries(realNRes.rows.map(r => [r.setup_type, +r.n]));

  console.log("Loading dpp stats...");
  const dppRes = await query(`
    SELECT setup_type,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(entry_zone_low - stop_level), 0))
        FILTER (WHERE replay_resolution = 'STOP_HIT')                                    AS stop_dpp,
      COUNT(*) FILTER (WHERE replay_resolution = 'STOP_HIT')                             AS n_stop,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(t1_level - entry_zone_low), 0))
        FILTER (WHERE replay_resolution = 'TARGET_HIT')                                  AS target_dpp,
      COUNT(*) FILTER (WHERE replay_resolution = 'TARGET_HIT')                           AS n_target
    FROM active_setups
    WHERE status = 'RESOLVED' AND entry_zone_low IS NOT NULL
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND actual_pnl IS NOT NULL
    GROUP BY setup_type
  `);
  const dppByType = {};
  for (const r of dppRes.rows) {
    const stopDpp   = (+r.n_stop >= MIN_N && r.stop_dpp != null) ? +r.stop_dpp : DEFAULT_DPP;
    const targetDpp = (+r.n_target >= MIN_N && r.target_dpp != null) ? +r.target_dpp : DEFAULT_DPP;
    dppByType[r.setup_type] = { stopDpp, targetDpp };
  }

  console.log("Loading trades...");
  const tradesRes = await query(`
    SELECT setup_type, fired_at::date::text as date, mae_points::float as mae_points, mfe_points::float as mfe_points, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND status = 'RESOLVED'
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
  `);
  const rawByType = {};
  for (const t of tradesRes.rows) {
    if (!rawByType[t.setup_type]) rawByType[t.setup_type] = [];
    rawByType[t.setup_type].push(t);
  }

  console.log("Loading volatility regimes...");
  const regimeRes = await query(`
    SELECT signal_name::text as date, notes::jsonb->>'regime' as regime
    FROM performance_audit
    WHERE signal_type = 'VOL_REGIME_HIST'
  `);
  const regimeMap = {};
  for (const r of regimeRes.rows) regimeMap[r.date] = r.regime;

  const results = [];
  let improvedEvCount = 0, worseEvCount = 0, reducedSpreadCount = 0, worseSpreadCount = 0, bothCount = 0;

  for (const st of setupTypes) {
    const opt = optMap[st];
    const dpp = dppByType[st] || { stopDpp: DEFAULT_DPP, targetDpp: DEFAULT_DPP };
    const trades = rawByType[st] || [];

    const validTrades = trades.filter(t => scaleMap[t.date] !== undefined && regimeMap[t.date] !== undefined);
    if (validTrades.length < MIN_N) continue;

    const fixedEv = computeEvAtStopTarget(validTrades, opt.stop, opt.target, dpp.stopDpp, dpp.targetDpp);

    // DUAL-SCALED: both stop AND target distances scaled by the same clamped ratio --
    // this is the only real change from the stop-only version.
    let scaledEvSum = 0;
    const rigorEvents = [];
    for (const t of validTrades) {
      let scale = scaleMap[t.date];
      scale = Math.min(p99, Math.max(p01, scale));
      const dynamicStop = opt.stop * scale;
      const dynamicTarget = opt.target * scale;

      let pnl = 0;
      if (t.mae_points > dynamicStop) pnl = -dynamicStop * dpp.stopDpp;
      else if (t.mfe_points >= dynamicTarget) pnl = dynamicTarget * dpp.targetDpp;
      else pnl = t.actual_pnl;

      scaledEvSum += pnl;
      rigorEvents.push({ date: t.date, pnl });
    }
    const scaledEv = scaledEvSum / validTrades.length;

    const fixedEvents = validTrades.map(t => {
      let pnl = 0;
      if (t.mae_points > opt.stop) pnl = -opt.stop * dpp.stopDpp;
      else if (t.mfe_points >= opt.target) pnl = opt.target * dpp.targetDpp;
      else pnl = t.actual_pnl;
      return { date: t.date, pnl };
    });

    const scaledRigor = computeRigor(rigorEvents, { pnlFn: e => e.pnl });

    const byRegime = {};
    for (let i = 0; i < validTrades.length; i++) {
      const t = validTrades[i];
      const r = regimeMap[t.date];
      if (!byRegime[r]) byRegime[r] = { fixed: [], scaled: [] };
      byRegime[r].fixed.push(fixedEvents[i].pnl);
      byRegime[r].scaled.push(rigorEvents[i].pnl);
    }

    const regimeEvsFixed = [], regimeEvsScaled = [];
    let validRegimeCount = 0;
    for (const [, events] of Object.entries(byRegime)) {
      if (events.fixed.length >= MIN_N) {
        validRegimeCount++;
        regimeEvsFixed.push(events.fixed.reduce((a, b) => a + b, 0) / events.fixed.length);
        regimeEvsScaled.push(events.scaled.reduce((a, b) => a + b, 0) / events.scaled.length);
      }
    }

    let spreadF = null, spreadS = null, spreadDiff = null;
    if (validRegimeCount >= 2) {
      spreadF = Math.max(...regimeEvsFixed) - Math.min(...regimeEvsFixed);
      spreadS = Math.max(...regimeEvsScaled) - Math.min(...regimeEvsScaled);
      spreadDiff = spreadS - spreadF;
      if (spreadS < spreadF) reducedSpreadCount++; else worseSpreadCount++;
    }

    const evDiff = scaledEv - fixedEv;
    const isClean = scaledRigor.clean;
    if (evDiff > 0 && isClean) improvedEvCount++; else worseEvCount++;
    if (evDiff > 0 && isClean && spreadS !== null && spreadS < spreadF) bothCount++;

    results.push({
      setup_type: st,
      n: validTrades.length,
      realN: realNMap[st] || 0,
      status: statusMap[st] || 'UNKNOWN',
      fixedEv, scaledEv, evDiff, isClean,
      validRegimeCount, spreadF, spreadS, spreadDiff,
    });
  }

  results.sort((a, b) => b.evDiff - a.evDiff);

  const liveNetPositive = results.filter(r =>
    ['ACTIVE', 'PROMOTE', 'DAY_TYPE_MANAGED'].includes(r.status) && r.evDiff > 0 && r.isClean && r.scaledEv > 0
  );

  let md = `# GARCH Dual-Barrier (stop+target) Backtest Findings — ${todayStr}

Extension of the stop-only version (scripts/backtest_garch_scaled_stop_all_setups.mjs) —
scales BOTH stop and target distances by the same clamped ratio, run against the
post-catch-up GARCH_VOL_SCALE data (${scales.length} days, mid-July gap now closed).

## Summary
1. **EV Improvement**: ${improvedEvCount} setup types showed a rigor-clean all-time EV improvement, ${worseEvCount} did not or got worse.
2. **Regime Consistency**: ${reducedSpreadCount} reduced regime spread, ${worseSpreadCount} did not.
3. **Both**: ${bothCount} showed both.
4. **Live-relevant** (rigor-clean improved AND currently ACTIVE/PROMOTE/DAY_TYPE_MANAGED AND still net-positive after scaling): **${liveNetPositive.length}**

## Live-relevant candidates (the only ones that matter for a real decision)
`;
  if (liveNetPositive.length === 0) {
    md += '_None. No currently-live setup_type clears rigor-clean EV improvement while remaining net-positive after dual-scaling on this data._\n';
  } else {
    for (const r of liveNetPositive) {
      md += `- **${r.setup_type}** [${r.status}] (backtest N=${r.n}, real N=${r.realN}): Fixed EV $${r.fixedEv.toFixed(2)} -> Dual-Scaled EV $${r.scaledEv.toFixed(2)} (Diff: +$${r.evDiff.toFixed(2)})\n`;
    }
  }

  md += `\n## Top 10 by EV diff (any status, for reference)\n`;
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    md += `- **${r.setup_type}** [${r.status}] (N=${r.n}, real N=${r.realN}): $${r.fixedEv.toFixed(2)} -> $${r.scaledEv.toFixed(2)} (${r.evDiff >= 0 ? '+' : ''}$${r.evDiff.toFixed(2)})\n`;
  }

  fs.writeFileSync('scratch/garch_dual_barrier_findings.md', md);
  console.log(`Wrote findings to scratch/garch_dual_barrier_findings.md — ${liveNetPositive.length} live-relevant candidates`);
}

main().catch(console.error);
