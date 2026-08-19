/**
 * Phase 0a: post-hoc time-of-day conditioning of Phase 0's structural-breakout-retest
 * population (docs/OPEN_THREADS.md 2026-08-03, OPEN_DECISION phase0a_time_windowed_
 * diagnostic_not_built, full DeepSeek brainstorm at scratch/deepseek_phase0_time_
 * windowed_brainstorm.md). Phase 0 itself (scripts/backtest_structural_breakout_
 * phase0.mjs) found 0/8 gated cells pass -- this asks whether that pooled-across-the-
 * whole-session negative hides a time-localized effect DeepSeek's own prior thought
 * plausible (an opening-hour retest edge) but structurally impossible to find in a
 * pooled test.
 *
 * DIAGNOSTIC ONLY, not gating -- reuses Phase 0's EXACT candidate detection/simulation
 * (imported, not reimplemented, per this codebase's export-the-real-function rule) so
 * no new detection logic exists to audit. Tags each already-computed trade by its entry
 * bar's time-of-day window and slices N/EV/WR/rigor per (regime, window, scale, arm).
 * Per DeepSeek's own explicit warning: a single window/scale cell passing the
 * conjunctive bar here is a CANDIDATE for a dedicated Phase 0b held-out re-scan, never
 * itself a trusted finding -- 5 RTH + 5 Globex windows x 4 intraday scales = 40 cells,
 * an 87% chance of a false positive by pure multiple-comparisons if any single cell
 * were trusted on its own. Daily scales excluded entirely (DeepSeek 5d: "don't bother
 * windowing daily bars").
 *
 * Run: node scripts/backtest_phase0a_time_windowed_diagnostic.mjs
 */
import pool from '../server/db.js';
import {
  loadBars, buildDailyBars, rollingAvgRange, detectPivots, generateRandomLevels,
  scanRetests, simulateArm, INTRADAY_SCALES, LOOKFORWARD_INTRADAY, MIN_N_FOR_GATE,
} from './backtest_structural_breakout_phase0.mjs';
import { getLandmark } from './backtest_overnight_pattern_discovery_permtest_20260720.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

// DeepSeek's 5 RTH windows (et_min, minutes since midnight ET) -- see the brainstorm
// doc §3 for the behavioral rationale behind each boundary.
function getRthWindow(et_min) {
  if (et_min < 600) return '1_Opening_Spike';      // 9:30-10:00
  if (et_min < 630) return '2_IB_Establishment';   // 10:00-10:30
  if (et_min < 720) return '3_Mid_Morning';        // 10:30-12:00
  if (et_min < 780) return '4_Lunch_Lull';         // 12:00-1:00
  return '5_Afternoon_Close';                       // 1:00-4:00
}

function etMinOf(tsText) {
  // ts is already ET wall-clock text (naive timestamp-without-timezone columns in this
  // DB store ET digits directly, per the standing convention -- see server/db.js and
  // OPEN_DECISION naive_timestamp_epoch_mixing_systematic_audit_needed). No AT TIME
  // ZONE conversion needed; slice the text directly, same pattern as widerTargetWalker.js.
  return Number(tsText.slice(11, 13)) * 60 + Number(tsText.slice(14, 16));
}

function ev(trades) {
  if (!trades.length) return { n: 0, wr: null, ev: null, rigor: null };
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0).length;
  const meanEv = trades.reduce((s, t) => s + t.pnl, 0) / n;
  const rigor = computeRigor(trades, { dateField: 'date', pnlFn: t => t.pnl });
  return { n, wr: wins / n, ev: meanEv, rigor };
}

async function main() {
  console.log('[phase0a] Loading bars (reusing Phase 0\'s own loader, not re-querying independently)...');
  const rthBars = await loadBars('RTH');
  const globexBars = await loadBars('GLOBEX');
  console.log(`[phase0a] RTH bars=${rthBars.length} Globex bars=${globexBars.length}`);

  const rthAvgRange = rollingAvgRange(rthBars, 20);
  const globexAvgRange = rollingAvgRange(globexBars, 20);

  // ── Recompute the exact same candidate population Phase 0 evaluates, per scale ──
  // (Arm3's random-level draw is independently re-sampled here, not bit-identical to
  // any specific historical Phase 0 run -- expected and immaterial, see the decision's
  // own build-scope note: this is a fresh diagnostic pass, not a replay of stored data.)
  const allTrades = []; // { regime, scale, arm, ...trade, window }
  for (const k of INTRADAY_SCALES) {
    for (const [regime, bars, avgRange] of [['RTH', rthBars, rthAvgRange], ['GLOBEX', globexBars, globexAvgRange]]) {
      const realPivots = detectPivots(bars, k, true);
      const unfilteredPivots = detectPivots(bars, k, false);
      const randomLevels = generateRandomLevels(bars, k, realPivots);
      const { arm0, armRetest: arm1 } = scanRetests(bars, realPivots, avgRange, k, false);
      const { armRetest: arm2 } = scanRetests(bars, unfilteredPivots, avgRange, k, false);
      const { armRetest: arm3 } = scanRetests(bars, randomLevels, avgRange, k, false);
      const arms = { ARM0_FIRST_TOUCH: arm0, ARM1_RETEST_STRUCT: arm1, ARM2_BLIND_RETEST: arm2, ARM3_RANDOM_LEVEL: arm3 };
      for (const [armName, candidates] of Object.entries(arms)) {
        const sim = simulateArm(bars, candidates, LOOKFORWARD_INTRADAY);
        for (const t of sim.trades) {
          const et_min = etMinOf(t.entryTs);
          const window = regime === 'RTH' ? getRthWindow(et_min) : getLandmark(et_min);
          allTrades.push({ ...t, regime, scale: k, arm: armName, window });
        }
      }
      console.log(`[phase0a] ${regime} k=${k}: tagged ${arms.ARM0_FIRST_TOUCH.length + arm1.length + arm2.length + arm3.length} candidate trades across 4 arms`);
    }
  }
  console.log(`[phase0a] Total tagged trades: ${allTrades.length}`);

  // ── Step 1: per (regime, window, scale) table, all 4 arms ──
  const cellKey = t => `${t.regime}|${t.window}|${t.scale}`;
  const cells = new Map();
  for (const t of allTrades) {
    const k = cellKey(t);
    if (!cells.has(k)) cells.set(k, { ARM0_FIRST_TOUCH: [], ARM1_RETEST_STRUCT: [], ARM2_BLIND_RETEST: [], ARM3_RANDOM_LEVEL: [] });
    cells.get(k)[t.arm].push(t);
  }

  let md = '# Phase 0a: Time-Windowed Diagnostic\n\n';
  md += 'DIAGNOSTIC ONLY -- not gating. See docs/OPEN_THREADS.md / OPEN_DECISION phase0a_time_windowed_diagnostic_not_built.\n\n';
  md += '## Per-window results (all 4 arms)\n\n';
  md += '| Regime | Window | Scale | Arm0 N/EV | Arm1 N/EV | Arm2 N/EV | Arm3 N/EV | Arm1 beats all 3? | Arm1 rigor.clean | Verdict |\n';
  md += '|---|---|---|---|---|---|---|---|---|---|\n';

  const candidateCells = [];
  const sortedKeys = [...cells.keys()].sort();
  for (const key of sortedKeys) {
    const [regime, window, scaleStr] = key.split('|');
    const scale = Number(scaleStr);
    const c = cells.get(key);
    const a0 = ev(c.ARM0_FIRST_TOUCH), a1 = ev(c.ARM1_RETEST_STRUCT), a2 = ev(c.ARM2_BLIND_RETEST), a3 = ev(c.ARM3_RANDOM_LEVEL);
    const allN20 = a0.n >= MIN_N_FOR_GATE && a1.n >= MIN_N_FOR_GATE && a2.n >= MIN_N_FOR_GATE && a3.n >= MIN_N_FOR_GATE;
    const beatsAll3 = allN20 && a1.ev != null && a0.ev != null && a2.ev != null && a3.ev != null
      && a1.ev > a0.ev && a1.ev > a2.ev && a1.ev > a3.ev;
    const rigorClean = a1.rigor?.clean === true;
    const verdict = !allN20 ? 'TOO_THIN' : (beatsAll3 && rigorClean ? 'CANDIDATE_FOR_0B' : 'FAIL');
    if (verdict === 'CANDIDATE_FOR_0B') candidateCells.push({ regime, window, scale, a0, a1, a2, a3 });
    const fmt = s => s.n < MIN_N_FOR_GATE ? `${s.n}/thin` : `${s.n}/$${s.ev.toFixed(2)}`;
    md += `| ${regime} | ${window} | ${scale} | ${fmt(a0)} | ${fmt(a1)} | ${fmt(a2)} | ${fmt(a3)} | ${beatsAll3} | ${rigorClean} | ${verdict} |\n`;
  }

  // ── Step 1a: RTH sliding 30-min heatmap (Arm1-Arm0 delta), 5-min increments ──
  md += '\n## RTH sliding-window heatmap (Arm1-Arm0 EV delta, 30-min bins, 5-min stride)\n\n';
  md += '| Bin start (ET) | ' + INTRADAY_SCALES.map(k => `k=${k}`).join(' | ') + ' |\n';
  md += '|---|' + INTRADAY_SCALES.map(() => '---').join('|') + '|\n';
  const rthArm0 = allTrades.filter(t => t.regime === 'RTH' && t.arm === 'ARM0_FIRST_TOUCH');
  const rthArm1 = allTrades.filter(t => t.regime === 'RTH' && t.arm === 'ARM1_RETEST_STRUCT');
  for (let binStart = 570; binStart <= 930; binStart += 5) {
    const binEnd = binStart + 30;
    const row = [];
    for (const k of INTRADAY_SCALES) {
      const inBin = t => t.scale === k && etMinOf(t.entryTs) >= binStart && etMinOf(t.entryTs) < binEnd;
      const a0 = rthArm0.filter(inBin), a1 = rthArm1.filter(inBin);
      if (a0.length < 5 || a1.length < 5) { row.push('thin'); continue; }
      const a0Ev = a0.reduce((s, t) => s + t.pnl, 0) / a0.length;
      const a1Ev = a1.reduce((s, t) => s + t.pnl, 0) / a1.length;
      row.push(`${(a1Ev - a0Ev).toFixed(2)} (n${a1.length})`);
    }
    const hh = String(Math.floor(binStart / 60)).padStart(2, '0');
    const mm = String(binStart % 60).padStart(2, '0');
    md += `| ${hh}:${mm} | ${row.join(' | ')} |\n`;
  }

  // ── Decision rule (DeepSeek's own, verbatim) ──
  md += '\n## Decision rule (per the DeepSeek brainstorm this build follows)\n\n';
  if (candidateCells.length === 0) {
    md += 'NO window/scale cell shows the conjunctive pattern (Arm1 beats Arm0 AND Arm2 AND Arm3, N>=20 all arms, rigor.clean) -- ';
    md += 'the time-localization hypothesis is NOT supported by the data. Close this follow-up. The Phase 0 pooled negative result stands; ';
    md += 'the time-window refinement does not rescue it.\n';
  } else {
    md += `${candidateCells.length} window/scale cell(s) show the conjunctive pattern -- flagged as CANDIDATES for a dedicated Phase 0b `;
    md += 'held-out re-scan (window-native calibration, chronological train/test split, computeReplication() against other windows). ';
    md += 'NONE of these are trusted findings on their own -- 40 cells were screened here, an ~87% false-positive rate is expected by chance alone. Candidates:\n\n';
    for (const c of candidateCells) {
      md += `- ${c.regime} / ${c.window} / k=${c.scale}: Arm1 EV=$${c.a1.ev.toFixed(2)} (N=${c.a1.n}) vs Arm0=$${c.a0.ev.toFixed(2)} Arm2=$${c.a2.ev.toFixed(2)} Arm3=$${c.a3.ev.toFixed(2)}\n`;
    }
  }

  fs.writeFileSync('scratch/deepseek_phase0a_time_windowed_diagnostic.md', md);
  console.log('[phase0a] Results written to scratch/deepseek_phase0a_time_windowed_diagnostic.md');
  console.log(`[phase0a] ${candidateCells.length} candidate cell(s) for Phase 0b out of ${sortedKeys.length} evaluated.`);

  // ── Persist (diagnostic, never gating) ──
  const { rows: todayRows } = await pool.query(`SELECT CURRENT_DATE::text as today`);
  await recordClaim({
    slug: 'phase0a_time_windowed_diagnostic',
    claimText: `Post-hoc time-of-day conditioning of Phase 0's structural-breakout-retest population (5 RTH + 5 Globex windows x 4 intraday scales = 40 cells, diagnostic only). ${candidateCells.length === 0 ? 'NO cell shows the conjunctive Arm1-beats-all-3-controls pattern with N>=20 and rigor.clean -- time-localization hypothesis not supported. Phase 0\'s pooled negative stands.' : `${candidateCells.length} candidate cell(s) found: ${candidateCells.map(c => `${c.regime}/${c.window}/k${c.scale}`).join(', ')} -- NOT trusted findings, ~87% false-positive rate expected from the 40-cell search surface. Each needs its own Phase 0b held-out re-scan before being treated as real.`} Full table + RTH sliding-window heatmap at scratch/deepseek_phase0a_time_windowed_diagnostic.md.`,
    sourceFile: 'scripts/backtest_phase0a_time_windowed_diagnostic.mjs',
    sourceDate: todayRows[0].today,
    sampleSize: allTrades.length,
    rigorStatus: candidateCells.length === 0 ? 'clean_negative_diagnostic' : 'candidates_need_phase0b',
    status: 'PROVISIONAL',
    extra: { cells_evaluated: sortedKeys.length, candidate_cells: candidateCells.map(c => ({ regime: c.regime, window: c.window, scale: c.scale, arm1Ev: +c.a1.ev.toFixed(2), arm1N: c.a1.n })) },
  });
  console.log('[phase0a] Recorded RESEARCH_CLAIM phase0a_time_windowed_diagnostic.');
  await pool.end();
}

main().catch(e => { console.error('[phase0a] ERROR:', e.message, e.stack); process.exit(1); });
