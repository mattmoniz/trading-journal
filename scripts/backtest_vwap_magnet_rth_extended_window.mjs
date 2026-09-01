// Resolves OPEN_DECISION globex_vs_rth_vwap_magnet_divergence_unexplained's named confound:
// the original RTH-vs-Globex VWAP_MAGNET comparison (2026-08-04) used getTrailingVwapStd(),
// which reads session_analysis.close_vs_vwap — a table that only goes back to 2026-03-25
// (~109 real days, confirmed 2026-09-01), vs. the Globex sibling's ~3.5yr price_bars_primary-
// derived reconstruction. This script re-runs the exact same RTH VWAP_MAGNET bar-history
// reconstruction (backfill_vwap_magnet_rth_bar_history_mae.mjs's own trigger logic:
// computeRunningVwapSeries + a rolling-std-derived sigma threshold, fresh-trigger only, walk
// to RTH session close) with getTrailingRthVwapStdFullHistory() (server/services/queries.js,
// new 2026-09-01, verified byte-identical to session_analysis.close_vs_vwap on 5 overlapping
// dates) instead — a genuinely longer, non-session_analysis-limited RTH reconstruction — and
// compares the S=100/T=60 result (the exact cell the original decision flagged) against the
// SAME comparison re-run with the OLD short-window function, so both sides are computed by
// the identical methodology in the same pass (per this codebase's own baseline-must-be-
// computed-the-same-way convention).
//
// Verifies which hypothesis holds: (a) RTH VWAP_MAGNET is a real, structural loser regardless
// of reconstruction window length, or (b) the original RTH-loser reading was itself a
// short-history artifact.

import { query } from '../server/db.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { getTrailingVwapStd, getTrailingRthVwapStdFullHistory } from '../server/services/queries.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const STOP = 100, TARGET = 60;
const PT_VALUE = 2; // MNQ $/pt
const COMMISSION_RT = 2; // MNQ round-trip commission

async function reconstruct(stdFn, label, minCandidateDays) {
  console.log(`\n=== Reconstructing with ${label} ===`);
  const daysRes = await query(`SELECT DISTINCT trade_date::text as d FROM session_analysis WHERE close_vs_vwap IS NOT NULL ORDER BY d`);
  let candidateDays;
  if (label === 'FULL_HISTORY') {
    // Full price_bars_primary trading-day list, not session_analysis-limited.
    const allDaysRes = await query(`SELECT DISTINCT ts::date::text as d FROM price_bars_primary WHERE symbol='NQ' ORDER BY d`);
    candidateDays = allDaysRes.rows.map(r => r.d).slice(minCandidateDays);
  } else {
    candidateDays = daysRes.rows.map(r => r.d).slice(30);
  }
  console.log(`${candidateDays.length} candidate RTH trading days (${candidateDays[0]} through ${candidateDays[candidateDays.length - 1]})`);

  const barsRes = await query(`
    SELECT ts::date::text as d, high::float, low::float, close::float,
           COALESCE(bid_volume,0)::int + COALESCE(ask_volume,0)::int as volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY ts
  `);
  const barsByDay = new Map();
  for (const b of barsRes.rows) { if (!barsByDay.has(b.d)) barsByDay.set(b.d, []); barsByDay.get(b.d).push(b); }

  const instances = [];
  let dayCount = 0;
  for (const d of candidateDays) {
    dayCount++;
    if (dayCount % 200 === 0) console.log(`  ...${dayCount}/${candidateDays.length} days, ${instances.length} instances so far`);
    const bars = barsByDay.get(d) || [];
    if (bars.length < 30) continue;
    const vwapSeries = computeRunningVwapSeries(bars);
    const std = await stdFn(d, 30);
    if (std.n < 20) continue;

    let wasBeyond = false;
    for (let i = 0; i < bars.length; i++) {
      const vwapNow = vwapSeries[i];
      if (vwapNow == null) continue;
      const dist = bars[i].close - vwapNow;
      const isBeyond = Math.abs(dist) >= std.threshold;
      if (isBeyond && !wasBeyond) {
        const isLong = dist < 0;
        const entry = bars[i].close;
        const endIdx = bars.length;
        let outcome = null; // 'STOP' | 'TARGET' | null (never resolved by session close)
        for (let j = i + 1; j < endIdx; j++) {
          const adverse = isLong ? entry - bars[j].low : bars[j].high - entry;
          const favorable = isLong ? bars[j].high - entry : entry - bars[j].low;
          const stopHit = adverse >= STOP;
          const targetHit = favorable >= TARGET;
          if (stopHit) { outcome = 'STOP'; break; }
          if (targetHit) { outcome = 'TARGET'; break; }
        }
        if (outcome) {
          const pnl = outcome === 'TARGET' ? (TARGET * PT_VALUE - COMMISSION_RT) : (-STOP * PT_VALUE - COMMISSION_RT);
          instances.push({ date: d, direction: isLong ? 'LONG' : 'SHORT', outcome, pnl });
        }
      }
      wasBeyond = isBeyond;
    }
  }
  console.log(`Total resolved S=${STOP}/T=${TARGET} instances: ${instances.length}`);
  return instances;
}

async function main() {
  const oldInstances = await reconstruct(getTrailingVwapStd, 'SHORT_WINDOW_session_analysis');
  const newInstances = await reconstruct(getTrailingRthVwapStdFullHistory, 'FULL_HISTORY', 30);

  for (const [label, instances] of [['SHORT_WINDOW (session_analysis, ~109d)', oldInstances], ['FULL_HISTORY (price_bars_primary, ~3.9yr)', newInstances]]) {
    console.log(`\n=== ${label} ===`);
    const n = instances.length;
    const wr = instances.filter(i => i.outcome === 'TARGET').length / n;
    const meanPnl = instances.reduce((s, i) => s + i.pnl, 0) / n;
    const rigor = computeRigor(instances, { dateField: 'date', pnlFn: i => i.pnl });
    console.log(`N=${n} WR=${(wr * 100).toFixed(1)}% meanPnl=$${meanPnl.toFixed(2)}`);
    console.log(`rigor: stable=${rigor.stable} clustered=${rigor.clustered} clean=${rigor.clean} zTrend=${rigor.zTrend} zScores=${JSON.stringify(rigor.zScores)} thirds=${JSON.stringify(rigor.thirds)}`);

    for (const dir of ['LONG', 'SHORT']) {
      const dirInst = instances.filter(i => i.direction === dir);
      if (!dirInst.length) continue;
      const dwr = dirInst.filter(i => i.outcome === 'TARGET').length / dirInst.length;
      const dmean = dirInst.reduce((s, i) => s + i.pnl, 0) / dirInst.length;
      const drigor = computeRigor(dirInst, { dateField: 'date', pnlFn: i => i.pnl });
      console.log(`  ${dir}: N=${dirInst.length} WR=${(dwr * 100).toFixed(1)}% meanPnl=$${dmean.toFixed(2)} zTrend=${drigor.zTrend} zScores=${JSON.stringify(drigor.zScores)}`);
    }
  }

  const oldRigor = computeRigor(oldInstances, { dateField: 'date', pnlFn: i => i.pnl });
  const newRigor = computeRigor(newInstances, { dateField: 'date', pnlFn: i => i.pnl });
  const oldMean = oldInstances.reduce((s, i) => s + i.pnl, 0) / oldInstances.length;
  const newMean = newInstances.reduce((s, i) => s + i.pnl, 0) / newInstances.length;
  const conclusionSame = (oldMean < 0) === (newMean < 0);

  const claimText = `RTH VWAP_MAGNET at S=${STOP}/T=${TARGET}, reconstructed with a genuinely longer, non-session_analysis-limited history (docs to resolve OPEN_DECISION globex_vs_rth_vwap_magnet_divergence_unexplained's named confound). SHORT_WINDOW (original method, session_analysis.close_vs_vwap, ~109 real days back to 2026-03-25): N=${oldInstances.length}, meanPnl=$${oldMean.toFixed(2)}, zTrend=${oldRigor.zTrend}. FULL_HISTORY (new getTrailingRthVwapStdFullHistory, price_bars_primary back to 2022-12-14, verified byte-identical to session_analysis on 5 overlapping dates before use): N=${newInstances.length}, meanPnl=$${newMean.toFixed(2)}, zTrend=${newRigor.zTrend}. CONCLUSION: the RTH-loser sign ${conclusionSame ? 'HOLDS UP' : 'DOES NOT HOLD UP'} under the longer reconstruction (${conclusionSame ? 'supports hypothesis (a): a real session-structure difference, not a short-history artifact' : 'supports hypothesis (b): the short-window RTH reconstruction was itself the artifact, not a real session-mechanism difference — the original RTH-vs-Globex divergence read may be an unfair comparison of a well-powered long-history calibration against a thin short-history one, not a real Globex-only edge'}). Does not by itself explain the Globex side's strengthening z-trend (a separate question) — isolates whether the RTH side of the divergence is real.`;

  await recordClaim({
    slug: 'vwap_magnet_rth_extended_window_reconstruction',
    claimText,
    sourceFile: 'scripts/backtest_vwap_magnet_rth_extended_window.mjs',
    sampleSize: newInstances.length,
    evPerTrade: newMean,
    rigorStatus: `stable=${newRigor.stable} clustered=${newRigor.clustered} clean=${newRigor.clean} zTrend=${newRigor.zTrend}`,
    status: 'PROVISIONAL',
  });

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
