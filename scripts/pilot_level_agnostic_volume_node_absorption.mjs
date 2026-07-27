// scripts/pilot_level_agnostic_volume_node_absorption.mjs
// ═══════════════════════════════════════════════════════════════════════
// Resolves (with a real answer, not just a scoping doc) OPEN_DECISION
// level_agnostic_absorption_multisession_research — Opus Audit #4's Q2 highest-ceiling
// idea: is there a real order-flow "this price is being defended by real size" edge
// detectable WITHOUT first classifying price as near one of this app's ~50 named MGI
// levels (PD_POC, CAM_R1, FLOOR_S1, etc)?
//
// Design constraints taken directly from the Opus audit's own flagged risks:
//   1. "Volume node" and "defense" must be defined without a level anchor. Reuses
//      developingValueService.js's computeProfile() (the CLAUDE.md-mandated correct
//      spread-across-bar-range method — never reimplemented) over a TRAILING 5-session
//      window (no lookahead — the window is fully before the day being scanned). A
//      "node" = a local-maximum price bucket at/above that window's own p85 volume
//      percentile (data-derived, not a static cutoff). This never consults level_prices
//      or any named level at all — genuinely level-agnostic by construction.
//   2. Avoid the delta-direction trap (0-for-4 this session, per Opus's own audit).
//      "Defense" is measured by volume MAGNITUDE only (a real high-volume node vs a
//      low-volume gap) — never by delta/CVD sign.
//   3. Confound checklist item 3 (same-selection-minus-signal control): a matched GAP
//      arm (local-MINIMUM price buckets, <=p25) using the identical touch/resolve
//      mechanics isolates whether volume-node presence itself matters, vs "any touch of
//      any price partially fades" being true regardless.
//
// Reuses resolve()/loadData() from backtest_unified.js (never reimplemented) for bar
// loading and outcome simulation, computeProfile() from developingValueService.js for
// the volume profile, and computeRigor() from rigorDiagnostics.js for the stability
// check — same conventions as every other finding this session.
// ═══════════════════════════════════════════════════════════════════════

import { resolve, loadData } from './backtest_unified.js';
import { computeProfile } from '../server/services/developingValueService.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const RTH_START = 570, RTH_END = 960;
const TRAIL_SESSIONS = 5;
const PROXIMITY = 15; // pt — matches the existing detectLevelFades() touch-proximity convention
const STOP = 90, TARGET = 40; // flat, matches backtest_unified.js's own default (Monday excluded from this pilot for simplicity)
const NODE_PCTL = 0.85, GAP_PCTL = 0.25;
const MAX_CANDIDATES_PER_ARM = 3; // per day, per arm — bounds N without cherry-picking (always top-K by rank, not by outcome)

function percentileOf(sortedVals, p) {
  if (!sortedVals.length) return null;
  const idx = Math.min(sortedVals.length - 1, Math.floor(p * sortedVals.length));
  return sortedVals[idx];
}

// Local maxima (nodes) / local minima (gaps) in a sorted-by-price volume profile.
function findLocalExtrema(entries, kind) {
  const out = [];
  for (let i = 1; i < entries.length - 1; i++) {
    const prev = entries[i - 1].volume, cur = entries[i].volume, next = entries[i + 1].volume;
    if (kind === 'max' && cur > prev && cur > next) out.push(entries[i]);
    if (kind === 'min' && cur < prev && cur < next) out.push(entries[i]);
  }
  return out;
}

async function main() {
  const { barsByDate, dates } = await loadData();
  const nodeTrades = [];
  const gapTrades = [];
  let daysWithNodes = 0, daysWithGaps = 0;

  for (let di = TRAIL_SESSIONS; di < dates.length; di++) {
    const date = dates[di];
    const bars = barsByDate.get(date);
    if (!bars || !bars.length) continue;

    // Trailing window profile — strictly prior sessions, no lookahead.
    // loadData()'s bar shape uses .vol (backtest_unified.js convention); computeProfile()
    // expects .volume (developingValueService.js convention) — map, don't reimplement either.
    const trailBars = [];
    for (let j = di - TRAIL_SESSIONS; j < di; j++) {
      const b = barsByDate.get(dates[j]);
      if (b) for (const bar of b) trailBars.push({ high: bar.high, low: bar.low, volume: bar.vol });
    }
    const profile = computeProfile(trailBars);
    if (!profile || profile.entries.length < 20) continue;

    const volsSorted = [...profile.entries.map(e => e.volume)].sort((a, b) => a - b);
    const nodeCutoff = percentileOf(volsSorted, NODE_PCTL);
    const gapCutoff = percentileOf(volsSorted, GAP_PCTL);

    const nodeCandidates = findLocalExtrema(profile.entries, 'max')
      .filter(e => e.volume >= nodeCutoff)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, MAX_CANDIDATES_PER_ARM);
    const gapCandidates = findLocalExtrema(profile.entries, 'min')
      .filter(e => e.volume <= gapCutoff)
      .sort((a, b) => a.volume - b.volume)
      .slice(0, MAX_CANDIDATES_PER_ARM);

    if (nodeCandidates.length) daysWithNodes++;
    if (gapCandidates.length) daysWithGaps++;

    // Scan today's RTH bars for the first touch of each candidate price (either arm),
    // same fromAbove/fromBelow direction convention as detectLevelFades().
    function scanTouches(candidates, sink) {
      for (const cand of candidates) {
        for (let i = 1; i < bars.length; i++) {
          const b = bars[i], prev = bars[i - 1];
          if (b.tod < RTH_START || b.tod >= RTH_END) continue;
          if (Math.abs(b.close - cand.price) > PROXIMITY) continue;
          const dir = prev.close > cand.price ? 'SHORT' : 'LONG';
          const entry = b.close;
          const stopPx = dir === 'LONG' ? entry - STOP : entry + STOP;
          const targetPx = dir === 'LONG' ? entry + TARGET : entry - TARGET;
          const r = resolve(bars, i, dir, entry, stopPx, targetPx, 240);
          sink.push({ date, dir, entry, nodeVolume: cand.price, pnl: r.pnl, result: r.result });
          break; // first touch of this candidate only
        }
      }
    }
    scanTouches(nodeCandidates, nodeTrades);
    scanTouches(gapCandidates, gapTrades);
  }

  console.log(`Days with >=1 node candidate: ${daysWithNodes}, with >=1 gap candidate: ${daysWithGaps}`);
  console.log(`NODE arm: N=${nodeTrades.length}   GAP arm: N=${gapTrades.length}`);

  function summarize(pop, label) {
    if (!pop.length) { console.log(`${label}: N=0`); return null; }
    const decided = pop.filter(t => t.result !== 'EXPIRED');
    const wr = decided.length ? decided.filter(t => t.pnl > 0).length / decided.length * 100 : null;
    const ev = pop.reduce((s, t) => s + t.pnl, 0) / pop.length;
    console.log(`${label}: N=${pop.length} (decided=${decided.length}) WR=${wr?.toFixed(1)}% EV=$${ev.toFixed(2)}/trade`);
    return { n: pop.length, wr, ev };
  }

  console.log('\n=== Full sample ===');
  const nodeStats = summarize(nodeTrades, 'NODE (high-volume, level-agnostic)');
  const gapStats = summarize(gapTrades, 'GAP  (low-volume control)');
  if (nodeStats && gapStats) console.log(`Delta (node - gap): $${(nodeStats.ev - gapStats.ev).toFixed(2)}/trade`);

  console.log('\n=== Chronological 70/30 train/test (NODE arm) ===');
  const nodeChrono = [...nodeTrades].sort((a, b) => a.date.localeCompare(b.date));
  const splitIdx = Math.floor(nodeChrono.length * 0.7);
  const nodeTrain = nodeChrono.slice(0, splitIdx), nodeTest = nodeChrono.slice(splitIdx);
  summarize(nodeTrain, 'NODE train');
  summarize(nodeTest, 'NODE test');

  console.log('\n=== Chronological 70/30 train/test (GAP arm, same split point in time) ===');
  const gapChrono = [...gapTrades].sort((a, b) => a.date.localeCompare(b.date));
  const gapSplitIdx = Math.floor(gapChrono.length * 0.7);
  summarize(gapChrono.slice(0, gapSplitIdx), 'GAP train');
  summarize(gapChrono.slice(gapSplitIdx), 'GAP test');

  console.log('\n=== Rigor (NODE arm) ===');
  const rigor = computeRigor(nodeTrades, { dateField: 'date', pnlFn: t => t.pnl });
  console.log(`distinctDates=${rigor.distinctDates} top5DayPct=${rigor.top5DayPct}% clustered=${rigor.clustered} stable=${rigor.stable} thirds=${JSON.stringify(rigor.thirds)} clean=${rigor.clean}`);

  console.log('\n=== Rigor (GAP arm) ===');
  const gapRigor = computeRigor(gapTrades, { dateField: 'date', pnlFn: t => t.pnl });
  console.log(`distinctDates=${gapRigor.distinctDates} top5DayPct=${gapRigor.top5DayPct}% clustered=${gapRigor.clustered} stable=${gapRigor.stable} thirds=${JSON.stringify(gapRigor.thirds)} clean=${gapRigor.clean}`);

  const summary = {
    nodeStats, gapStats,
    nodeTrainEv: nodeTrain.length ? nodeTrain.reduce((s, t) => s + t.pnl, 0) / nodeTrain.length : null,
    nodeTestEv: nodeTest.length ? nodeTest.reduce((s, t) => s + t.pnl, 0) / nodeTest.length : null,
    rigor, gapRigor,
  };
  console.log('\n=== JSON summary ===');
  console.log(JSON.stringify(summary));

  return summary;
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
