// Tests whether a GARCH(1,1) walk-forward volatility-scaled stop improves EV, and/or
// reduces regime-to-regime EV variance, for every individual level-fade setup_type
// (not just the TRIPLE+/QUAD_PLUS confluence-zone aggregate that
// backtest_confluence_garch_stop.py already validated separately).
//
// Promoted from scratch/ 2026-07-18 after passing through 4 real bugs, found and
// fixed in sequence -- read before re-running or trusting a variant of this:
//   1. The GARCH_VOL_SCALE series it reads (scripts/backfill_garch_vol_scale_history.py)
//      originally used a frozen baseline_vol (anchored once, never updated) instead of
//      each day's own self-consistent unconditional variance -- inflated the earlier
//      confluence-zone result by capturing multi-month vol drift, not real daily signal.
//   2. The daily bar query feeding that GARCH fit had no `symbol='NQ'` filter, mixing
//      in documented ES contamination (price_bars_primary, 2023-11-16 to 2023-12-14)
//      that sat inside the walk-forward warmup window and got carried forward by every
//      subsequent day's expanding-window fit.
//   3. Even after fixing both, the raw self-consistent scale is numerically degenerate
//      on ~44/317 days where alpha+beta is very close to 1 (near-unit-root) -- the
//      unconditional-variance formula blows up (scale swung 0.13x-284x). Fixed with a
//      persistence-floor fallback (carry forward the last valid day's unc_vol).
//   4. This script's OWN `OPTIMAL_STOP` query originally had no ORDER BY, so an
//      unordered SELECT could land on an arbitrary historical calibration run instead
//      of the latest -- verified 35/108 setup_types (32%) got a stale value, some by
//      huge margins. Fixed with DISTINCT ON + ORDER BY run_date DESC.
//
// Result after all 4 fixes (RESEARCH_CLAIM garch_scaled_stop_all_setups_modest_minority_effect):
// a real but MODEST effect -- 28/103 setup_types show a rigor-clean EV improvement,
// only 2/103 show both improved EV and reduced regime-spread. NOT a broad win, NOT
// wired into live sizeMultiplier. If ever promoted, must be per-setup-type, never a
// blanket rule.
//
// Run: node scripts/backtest_garch_scaled_stop_all_setups.mjs
import fs from 'fs';
import { query } from '../server/db.js';
import { computeEvAtStopTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const MIN_N = 20;

async function main() {
  console.log("Loading GARCH scales...");
  const scaleRes = await query(`
    SELECT signal_name::text as date, (notes::jsonb->>'scale')::float as scale 
    FROM performance_audit 
    WHERE signal_type = 'GARCH_VOL_SCALE'
  `);
  const scales = [];
  const scaleMap = {};
  for (const r of scaleRes.rows) {
    const scale = r.scale;
    scales.push(scale);
    scaleMap[r.date] = scale;
  }
  
  scales.sort((a, b) => a - b);
  const p01 = scales[Math.floor(scales.length * 0.01)] || 1;
  const p99 = scales[Math.floor(scales.length * 0.99)] || 1;
  console.log(`Scale percentiles: p01=${p01.toFixed(3)}, p99=${p99.toFixed(3)}`);

  console.log("Loading optimal stops...");
  // DISTINCT ON + ORDER BY run_date DESC is required -- OPTIMAL_STOP has one row per
  // weekly recompute (800 total rows for 108 setup_types), and a plain unordered
  // SELECT lets JS object-key overwriting land on an arbitrary historical run, not
  // necessarily the latest. Verified this was a real bug, not theoretical: 35/108
  // setup_types (32%) got a stale value from the unordered version, some by huge
  // margins (IB_BULLISH: stale=19 vs actual latest=79).
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
  for (const r of regimeRes.rows) {
    regimeMap[r.date] = r.regime;
  }

  const results = [];
  let improvedEvCount = 0;
  let worseEvCount = 0;
  let reducedSpreadCount = 0;
  let worseSpreadCount = 0;
  let bothCount = 0;

  for (const st of setupTypes) {
    const opt = optMap[st];
    const dpp = dppByType[st] || { stopDpp: DEFAULT_DPP, targetDpp: DEFAULT_DPP };
    const trades = rawByType[st] || [];
    
    // Filter to trades that have a scale and regime
    const validTrades = trades.filter(t => scaleMap[t.date] !== undefined && regimeMap[t.date] !== undefined);
    if (validTrades.length < MIN_N) continue;

    // Fixed EV
    const fixedEv = computeEvAtStopTarget(validTrades, opt.stop, opt.target, dpp.stopDpp, dpp.targetDpp);
    
    // Scaled EV
    let scaledEvSum = 0;
    const rigorEvents = [];
    for (const t of validTrades) {
      let scale = scaleMap[t.date];
      scale = Math.min(p99, Math.max(p01, scale)); // Cap to p01-p99 band
      const dynamicStop = opt.stop * scale;
      
      let pnl = 0;
      if (t.mae_points > dynamicStop) pnl = -dynamicStop * dpp.stopDpp;
      else if (t.mfe_points >= opt.target) pnl = opt.target * dpp.targetDpp;
      else pnl = t.actual_pnl;
      
      scaledEvSum += pnl;
      rigorEvents.push({ date: t.date, pnl: pnl });
    }
    const scaledEv = scaledEvSum / validTrades.length;
    
    const fixedEvents = validTrades.map(t => {
      let pnl = 0;
      if (t.mae_points > opt.stop) pnl = -opt.stop * dpp.stopDpp;
      else if (t.mfe_points >= opt.target) pnl = opt.target * dpp.targetDpp;
      else pnl = t.actual_pnl;
      return { date: t.date, pnl: pnl };
    });
    
    const fixedRigor = computeRigor(fixedEvents, { pnlFn: e => e.pnl });
    const scaledRigor = computeRigor(rigorEvents, { pnlFn: e => e.pnl });
    
    // Group by regime
    const byRegime = {};
    for (let i = 0; i < validTrades.length; i++) {
      const t = validTrades[i];
      const r = regimeMap[t.date];
      if (!byRegime[r]) byRegime[r] = { fixed: [], scaled: [] };
      byRegime[r].fixed.push(fixedEvents[i].pnl);
      byRegime[r].scaled.push(rigorEvents[i].pnl);
    }
    
    const regimeEvsFixed = [];
    const regimeEvsScaled = [];
    let validRegimeCount = 0;
    for (const [r, events] of Object.entries(byRegime)) {
      if (events.fixed.length >= MIN_N) {
        validRegimeCount++;
        const evF = events.fixed.reduce((a, b) => a + b, 0) / events.fixed.length;
        const evS = events.scaled.reduce((a, b) => a + b, 0) / events.scaled.length;
        regimeEvsFixed.push(evF);
        regimeEvsScaled.push(evS);
      }
    }
    
    let spreadF = null;
    let spreadS = null;
    let spreadDiff = null;
    if (validRegimeCount >= 2) {
      spreadF = Math.max(...regimeEvsFixed) - Math.min(...regimeEvsFixed);
      spreadS = Math.max(...regimeEvsScaled) - Math.min(...regimeEvsScaled);
      spreadDiff = spreadS - spreadF;
      if (spreadS < spreadF) reducedSpreadCount++;
      else worseSpreadCount++;
    }
    
    const evDiff = scaledEv - fixedEv;
    const isClean = scaledRigor.clean;
    if (evDiff > 0 && isClean) improvedEvCount++;
    else worseEvCount++;
    
    if (evDiff > 0 && isClean && spreadS !== null && spreadS < spreadF) bothCount++;
    
    results.push({
      setup_type: st,
      n: validTrades.length,
      fixedEv,
      scaledEv,
      evDiff,
      isClean,
      validRegimeCount,
      spreadF,
      spreadS,
      spreadDiff
    });
  }

  // Sort by evDiff
  results.sort((a, b) => b.evDiff - a.evDiff);
  
  let md = `# GARCH Volatility-Scaled Stop Backtest Findings

## Summary
1. **EV Improvement**: ${improvedEvCount} setup types showed a rigor-clean all-time EV improvement from GARCH-scaling, while ${worseEvCount} did not or got worse.
2. **Regime Consistency**: ${reducedSpreadCount} setup types showed a reduced regime-to-regime EV spread, while ${worseSpreadCount} showed no change or got worse.
3. **Both**: ${bothCount} setup types showed BOTH improved EV and reduced regime spread (strongest candidates for promotion).

## Top 10 Most Improved Setups (by EV)
`;

  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    md += `- **${r.setup_type}** (N=${r.n}): Fixed EV $${r.fixedEv.toFixed(2)} -> Scaled EV $${r.scaledEv.toFixed(2)} (Diff: +$${r.evDiff.toFixed(2)}). `;
    if (r.spreadF !== null) {
      md += `Regime Spread: $${r.spreadF.toFixed(2)} -> $${r.spreadS.toFixed(2)} (Diff: ${r.spreadDiff > 0 ? '+' : ''}$${r.spreadDiff.toFixed(2)}).\n`;
    } else {
      md += `Regime Spread: N/A (too few regimes with N>=20).\n`;
    }
  }
  
  md += `\n## Setups that got meaningfully WORSE (EV drop > $5)\n`;
  const worse = results.filter(r => r.evDiff < -5).sort((a, b) => a.evDiff - b.evDiff);
  for (const r of worse) {
    md += `- **${r.setup_type}** (N=${r.n}): Fixed EV $${r.fixedEv.toFixed(2)} -> Scaled EV $${r.scaledEv.toFixed(2)} (Diff: $${r.evDiff.toFixed(2)}). `;
    if (r.spreadF !== null) {
      md += `Regime Spread: $${r.spreadF.toFixed(2)} -> $${r.spreadS.toFixed(2)} (Diff: ${r.spreadDiff > 0 ? '+' : ''}$${r.spreadDiff.toFixed(2)}).\n`;
    } else {
      md += `Regime Spread: N/A (too few regimes with N>=20).\n`;
    }
  }

  fs.writeFileSync('scratch/garch_all_setups_findings.md', md);
  console.log("Wrote findings to scratch/garch_all_setups_findings.md");
}

main().catch(console.error);
