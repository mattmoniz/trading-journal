import { query } from '../server/db.js';
import { inferDirection, CONDITIONAL_VARIANTS } from '../server/config/setupTypes.js';
import fs from 'fs';
import {
  testTrailForPopulation, MIN_N,
} from './lib/breakevenTrailCore.mjs';

async function main() {
  console.log('Loading current live OPTIMAL_STOP...');
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, optimal_stop, optimal_target
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const optMap = {};
  for (const r of optRes.rows) optMap[r.setup_type] = { stop: parseFloat(r.optimal_stop), target: parseFloat(r.optimal_target) };

  console.log('Loading corroborating evidence...');
  const postResSeqRes = await query(`SELECT signal_name, notes FROM performance_audit WHERE signal_type='POST_RES_SEQ'`);
  const postResSeqMap = {};
  for (const r of postResSeqRes.rows) {
    postResSeqMap[r.signal_name] = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes;
  }

  const levelContRes = await query(`SELECT signal_name, notes FROM performance_audit WHERE signal_type='LEVEL_CONTINUATION'`);
  const levelContMap = {};
  for (const r of levelContRes.rows) {
    levelContMap[r.signal_name] = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes;
  }

  function getLevelCont(setupType) {
    if (levelContMap[setupType]) return levelContMap[setupType];
    for (const k of Object.keys(levelContMap)) {
      if (setupType.startsWith(k)) return levelContMap[k];
    }
    return null;
  }

  console.log('Loading eligible trades...');
  const tradesRes = await query(`
    SELECT setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, stop_level::float as stop_level,
      t1_level::float as t1_level, actual_pnl::float as actual_pnl, resolution,
      replay_resolution
    FROM active_setups
    WHERE status IN ('RESOLVED', 'EXPIRED') AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300 AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
      AND origin_status IN ('ACTIVE', 'SHADOW')
    ORDER BY fired_at ASC
  `);
  // preflight_backtest_assertions.mjs check [1], roadmap Phase 0 sweep, 2026-08-10: this
  // population was previously unfiltered by origin_status (84.5% BACKFILL system-wide,
  // confirmed via direct query) -- both the trail-candidate pullback distribution AND the
  // EV baseline it's scored against came from mostly-synthetic data. Now real-only, matching
  // every other calibration pipeline in this codebase. Practical impact today: none of the
  // 6 live-wired _TRAIL variants currently read a fresh row from this script anyway (see
  // breakeven_trail_4_more_variants_lost_calibration_row resolution, 2026-08-10) -- this is
  // a correctness fix for future runs, not a change to anything currently live-consumed.
  const allTrades = tradesRes.rows;

  // Roadmap Phase 3 (I4), 2026-08-10: self-starving-population fix. resolveSetupType()
  // in acd.js (~line 6423) UNCONDITIONALLY diverts every new touch of these 6 base types
  // to their own _TRAIL setup_type the moment this mechanism is wired -- so the base
  // type's own row in active_setups can never accumulate a NEW real trade again after
  // its addedDate. This script grouped purely by raw setup_type, meaning it was reading
  // a population frozen on whatever existed before the diversion, while the real,
  // growing touch history was sitting under the _TRAIL name where this script never
  // looked. Confirmed live: e.g. PD_POC_FADE_LONG (base) has real_n=19 (frozen, all
  // pre-2026-07-21) vs PD_POC_FADE_LONG_TRAIL (real, still accumulating) real_n=11 --
  // pooled, that's 30, already past MIN_N=20; unpooled, neither half alone is enough.
  // This was NOT caught by the 2026-08-04/2026-08-10 breakeven_trail_4_more_variants_
  // lost_calibration_row investigation, which measured only the base type's own real_n
  // and concluded (correctly, as far as it checked) "thin data, wait for growth" without
  // noticing growth was already happening under a name this query never read. Fix: pool
  // trades from a _TRAIL variant into its baseType's bucket for calibration purposes --
  // same entry/stop/target mechanism, only the resolution label differs, and the base
  // type's OWN live calibration (SETUP_STATUS/OPTIMAL_STOP) is untouched by this (still
  // computed elsewhere from the base type's own unpooled rows, unaffected). Generic via
  // the CONDITIONAL_VARIANTS registry, not a hardcoded 6-name list, so a future 7th
  // trail variant is covered automatically.
  // Known remaining edge case, not yet reachable: once a variant's own trail actually
  // starts engaging (a future TRAIL_EXIT/BREAKEVEN_TRAIL_HIT resolution rather than
  // today's universal PRICE_CLEAN fallback), the pullback-distribution filter below
  // (resolution==='TARGET_HIT') will undercount those trades, since a trail-exited trade
  // that DID reach original target resolves as TRAIL_EXIT, not TARGET_HIT. Not an issue
  // today (trailWidth has never been non-null for any of these 6, confirmed via
  // resolution_method census) -- revisit once the first variant clears MIN_N and starts
  // actually trailing.
  const trailPoolMap = {};
  for (const [variantType, cfg] of Object.entries(CONDITIONAL_VARIANTS)) {
    if (cfg.backtestScript === 'scripts/backtest_breakeven_trail.mjs' && cfg.baseType) {
      trailPoolMap[variantType] = cfg.baseType;
    }
  }

  const byType = {};
  for (const t of allTrades) {
    const canonicalType = trailPoolMap[t.setup_type] || t.setup_type;
    (byType[canonicalType] ||= []).push(t);
  }

  console.log('Loading NQ price bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), dateObj: new Date(b.ts), high: b.high, low: b.low, close: b.close }));

  const barRangeRes = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high-low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
  const MIN_TRAIL_WIDTH = parseFloat(barRangeRes.rows[0].median_range);
  const MIN_TIGHT_TRAIL = 2 * MIN_TRAIL_WIDTH;

  const results = { A: {}, B: {} };
  const setupTypes = Object.keys(byType).filter(st => {
    const ts = byType[st].filter(t => t.replay_resolution === 'TARGET_HIT' || t.resolution === 'TARGET_HIT');
    return optMap[st] && ts.length >= MIN_N;
  });

  const funnel = { A: { total: setupTypes.length, noPullbackData: 0, thinTail: 0, noPlateauPass: 0, failedOosOrBaseline: 0, notRigorClean: 0, survived: 0 },
                   B: { total: setupTypes.length, noPullbackData: 0, thinTail: 0, noPlateauPass: 0, failedOosOrBaseline: 0, notRigorClean: 0, survived: 0 } };

  let responseMd = '# Breakeven-Then-Trail Test Results\n\n';

  for (const tier of ['A', 'B']) {
    responseMd += `## Tier ${tier} (${tier === 'A' ? 'Snug Trail / Take-a-little-extra' : 'Real Runner / Continuation Capture'})\n\n`;

    for (const setupType of setupTypes) {
      const trades = byType[setupType];
      const { stop, target: originalTarget } = optMap[setupType];
      const direction = inferDirection(setupType);
      if (!direction) continue;
      const long = direction === 'LONG';

      const outcome = testTrailForPopulation({
        trades, long, stop, originalTarget, allBars, tier,
        minTrailWidth: MIN_TRAIL_WIDTH, minTightTrail: MIN_TIGHT_TRAIL,
      });

      if (outcome.funnelReason === 'tooFewWalked') continue;
      if (outcome.funnelReason !== 'survived') { funnel[tier][outcome.funnelReason]++; continue; }

      const r = outcome.result;
      results[tier][setupType] = r;

      let corroboration = '';
      const postSeq = postResSeqMap[`TARGET_${setupType}`.slice(0, 60)];
      const lvlCont = getLevelCont(setupType);
      corroboration += `\n- **Corroborating Evidence**:`;
      if (postSeq) corroboration += `\n  - POST_RES_SEQ (TARGET_HIT): favFirstPct=${postSeq.favFirstPct}%, avgEfficiency=${postSeq.avgEfficiency}%`;
      else corroboration += `\n  - POST_RES_SEQ (TARGET_HIT): None found`;

      if (lvlCont) corroboration += `\n  - LEVEL_CONTINUATION: bigContinuationPct=${lvlCont.bigContinuationPct}%, avgExtension=${lvlCont.avgExtension}pt`;
      else corroboration += `\n  - LEVEL_CONTINUATION: None found`;

      responseMd += `### ${setupType}\n- **T1 Reach Count**: ${r.t1Reached}\n- **Best Config**: Trail=${r.trail}pt\n- **Baseline EV (100% T1, full)**: $${r.baselineEv.toFixed(2)}\n- **Baseline EV (100% T1, OOS)**: $${r.baselineOosEv.toFixed(2)}\n- **Breakeven-Then-Trail EV (full)**: $${r.fullEv.toFixed(2)}\n- **Breakeven-Then-Trail EV (OOS)**: $${r.oosEv.toFixed(2)}\n- **Breakeven Scratch Rate**: ${(r.scratchRate * 100).toFixed(1)}% (${r.scratches}/${r.t1Wins} T1-reaches scratched)\n- **2D Grid Trail Neighbors**: ${r.trailNeighborsNotes}${corroboration}\n\n`;
      funnel[tier].survived++;
    }
    if (Object.keys(results[tier]).length === 0) {
      responseMd += `No setup types survived Tier ${tier}.\n\n`;
    }
  }

  console.log('Guardrail funnel Tier A:', JSON.stringify(funnel.A));
  console.log('Guardrail funnel Tier B:', JSON.stringify(funnel.B));

  fs.writeFileSync('scratch/breakeven_trail_report.md', responseMd);
  console.log('Done, wrote results to scratch/breakeven_trail_report.md');

  const todayRow = await query(`SELECT CURRENT_DATE::text as d`);
  const today = todayRow.rows[0].d;

  const allSurvivorNames = [];
  for (const tier of ['A', 'B']) {
    for (const [st, r] of Object.entries(results[tier])) {
       const signalName = `${tier}_${st}`;
       allSurvivorNames.push(signalName);
       await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
        VALUES ($1, 0, 'BREAKEVEN_TRAIL_TEST', $2, $3, $4, $5)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
          SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
      `, [today, signalName, r.t1Reached, r.fullEv, JSON.stringify(r)]);
    }
  }

  // Never delete a row that a LIVE CONDITIONAL_VARIANTS entry currently reads
  // (trailVariant.trailSignalName in acd.js's insert-time lookup), even if it doesn't
  // survive this run. Found 2026-08-03 (Gemini+DeepSeek blind cross-check while
  // extending this mechanism to IB): the original unconditional DELETE wiped 5 of the
  // 6 originally-wired TRAIL variants' rows within ~1-2 weekly runs (survivor sets are
  // genuinely volatile run to run, especially right after an OPTIMAL_STOP calibration
  // change like today's optStopQ fix), and the live consumer (acd.js line ~7580) treats
  // a missing row as `runnerTrailWidth = null`, which resolveSetupsByPrice() then
  // silently resolves as an ordinary fixed-target trade — no warning, no distinction
  // from the mechanism actually working. Confirmed live: all 33 real fires across all 6
  // wired _TRAIL setup_types had runner_trail_width IS NULL, i.e. the mechanism has
  // never once actually engaged since going live 2026-07-21 (SHADOW-only, so zero
  // capital risk — but a real, previously-undetected dead mechanism nonetheless).
  // A live-wired trail calibration going one noisy week stale is a much smaller problem
  // than it vanishing outright — trail widths shift gradually, not sign-flip, so
  // graceful degration to a recent-but-not-today value is clearly better than silently
  // reverting to "no trail at all." Non-wired exploratory candidates still get pruned
  // normally the moment they stop surviving. RESEARCH_CLAIM
  // breakeven_trail_calibration_wiped_by_unscoped_cleanup has the full incident.
  const wiredTrailSignalNames = Object.values(CONDITIONAL_VARIANTS)
    .map(v => v.trailSignalName)
    .filter(Boolean);
  const staleRes = await query(`
    DELETE FROM performance_audit
    WHERE signal_type='BREAKEVEN_TRAIL_TEST'
      AND signal_name !~ '_(BALANCE|TREND|TURBULENT)$'
      AND NOT (signal_name = ANY($1))
      AND NOT (signal_name = ANY($2))
    RETURNING signal_name
  `, [allSurvivorNames, wiredTrailSignalNames]);
  if (staleRes.rows.length) console.log(`Cleaned up ${staleRes.rows.length} stale row(s) no longer surviving: ${staleRes.rows.map(r => r.signal_name).join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
