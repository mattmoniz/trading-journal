// scripts/pilot_level_agnostic_touch_battle_quality.mjs
// ═══════════════════════════════════════════════════════════════════════
// Direct follow-up to pilot_level_agnostic_volume_node_absorption.mjs, per the user's
// sharp critique: that first pass only detected a TOUCH (bar.close within 15pt of a
// historically-busy price) and measured the eventual bar-walk outcome — it never asked
// whether the touch itself showed a real BATTLE between buyers and sellers, just whether
// it happened near a price that was busy days ago. Delta=$0.32/trade (no edge) answered
// "does touching a historically busy price differ from touching a historically empty
// one" — it did NOT test "does REAL interaction at the touch (volume climax + who won
// the fight) predict outcome," which is the actual order-flow question Opus's audit
// raised and the reason touchQuality.js exists in the first place (its own header
// comment: "heavy volume at a touch does NOT automatically mean absorbed — it can mean a
// fight the adverse side won").
//
// This script reuses getVolumeBaseline()/classifyTouch() from touchQuality.js UNMODIFIED
// (the real, already-live, already-validated battle classifier — same module
// resolveSetupsByPrice() reads for named levels) and applies it to the exact same
// level-agnostic NODE/GAP touches from the prior pilot. Classification:
//   - maxVolZ = peak (bid+ask) volume z-score in the reaction window vs a 90-day
//     trailing per-minute-of-day baseline (real function, not reimplemented)
//   - gaveFurtherGround = did MAE keep growing past bar 1 of the window (the adverse
//     side kept pushing) vs plateau immediately (the level held)
//   - HIGH_VOL_ABSORBED = high volume AND held (buyers/sellers fought and the fade side won)
//   - HIGH_VOL_OVERRUN  = high volume AND gave more ground (the fade side lost the fight)
//   - QUIET             = no real battle happened at all
// Tests whether ABSORBED touches outperform OVERRUN/QUIET ones, cross-tabbed against
// NODE (historically busy) vs GAP (historically empty) location — isolating whether the
// INTERACTION itself carries signal independent of, or on top of, the location.
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import { resolve, loadData } from './backtest_unified.js';
import { computeProfile } from '../server/services/developingValueService.js';
import { getVolumeBaseline, classifyTouch } from '../server/services/touchQuality.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const RTH_START = 570, RTH_END = 960;
const TRAIL_SESSIONS = 5;
const PROXIMITY = 15;
const STOP = 90, TARGET = 40;
const NODE_PCTL = 0.85, GAP_PCTL = 0.25;
const MAX_CANDIDATES_PER_ARM = 3;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function findLocalExtrema(entries, kind) {
  const out = [];
  for (let i = 1; i < entries.length - 1; i++) {
    const prev = entries[i - 1].volume, cur = entries[i].volume, next = entries[i + 1].volume;
    if (kind === 'max' && cur > prev && cur > next) out.push(entries[i]);
    if (kind === 'min' && cur < prev && cur < next) out.push(entries[i]);
  }
  return out;
}

// Local MAE-trace replay (same convention as calibrate_touch_quality.mjs's replayFull()
// — a small, self-contained helper every touch-quality-adjacent script keeps locally;
// the SHARED, reused pieces are getVolumeBaseline/classifyTouch, imported above).
function replayWithTrace(bars, entryIdx, direction, entry, stop, target, maxBars = 240) {
  let mae = 0;
  const maeTrace = [];
  let resolution = 'EXPIRED', pnl = 0, barsHeld = 0;
  const isLong = direction === 'LONG';
  for (let i = entryIdx + 1; i < bars.length && i <= entryIdx + maxBars; i++) {
    const b = bars[i];
    const adverse = isLong ? entry - b.low : b.high - entry;
    mae = Math.max(mae, adverse);
    maeTrace.push(mae);
    const stopHit = isLong ? b.low <= stop : b.high >= stop;
    const targetHit = isLong ? b.high >= target : b.low <= target;
    barsHeld = i - entryIdx;
    if (stopHit) { resolution = 'STOP_HIT'; pnl = -Math.abs(entry - stop) * DPP - COMM; break; }
    if (targetHit) { resolution = 'TARGET_HIT'; pnl = Math.abs(target - entry) * DPP - COMM; break; }
  }
  return { resolution, pnl, maeTrace, barsHeld };
}

async function main() {
  const { barsByDate, dates } = await loadData();
  const baselineCache = new Map();
  async function getBaselineCached(date) {
    if (!baselineCache.has(date)) baselineCache.set(date, await getVolumeBaseline(query, date));
    return baselineCache.get(date);
  }

  const rawTouches = []; // { date, location: NODE|GAP, dir, entry, bars, entryIdx, resolution, pnl, maeTrace }

  for (let di = TRAIL_SESSIONS; di < dates.length; di++) {
    const date = dates[di];
    const bars = barsByDate.get(date);
    if (!bars || !bars.length) continue;

    const trailBars = [];
    for (let j = di - TRAIL_SESSIONS; j < di; j++) {
      const b = barsByDate.get(dates[j]);
      if (b) for (const bar of b) trailBars.push({ high: bar.high, low: bar.low, volume: bar.vol });
    }
    const profile = computeProfile(trailBars);
    if (!profile || profile.entries.length < 20) continue;

    const volsSorted = [...profile.entries.map(e => e.volume)].sort((a, b) => a - b);
    const nodeCutoff = percentile(volsSorted, NODE_PCTL);
    const gapCutoff = percentile(volsSorted, GAP_PCTL);

    const nodeCandidates = findLocalExtrema(profile.entries, 'max').filter(e => e.volume >= nodeCutoff).sort((a, b) => b.volume - a.volume).slice(0, MAX_CANDIDATES_PER_ARM);
    const gapCandidates = findLocalExtrema(profile.entries, 'min').filter(e => e.volume <= gapCutoff).sort((a, b) => a.volume - b.volume).slice(0, MAX_CANDIDATES_PER_ARM);

    function scan(candidates, location) {
      for (const cand of candidates) {
        for (let i = 1; i < bars.length; i++) {
          const b = bars[i], prev = bars[i - 1];
          if (b.tod < RTH_START || b.tod >= RTH_END) continue;
          if (Math.abs(b.close - cand.price) > PROXIMITY) continue;
          const dir = prev.close > cand.price ? 'SHORT' : 'LONG';
          const entry = b.close;
          const stopPx = dir === 'LONG' ? entry - STOP : entry + STOP;
          const targetPx = dir === 'LONG' ? entry + TARGET : entry - TARGET;
          const r = replayWithTrace(bars, i, dir, entry, stopPx, targetPx, 240);
          rawTouches.push({ date, location, dir, entryIdx: i, entry, resolution: r.resolution, pnl: r.pnl, maeTrace: r.maeTrace, bars });
          break;
        }
      }
    }
    scan(nodeCandidates, 'NODE');
    scan(gapCandidates, 'GAP');
  }

  console.log(`Raw touches: NODE=${rawTouches.filter(t=>t.location==='NODE').length}, GAP=${rawTouches.filter(t=>t.location==='GAP').length}`);

  // Reaction window size — data-derived (p25 of bars-to-resolution across ALL touches,
  // same methodology as calibrate_touch_quality.mjs), not a hardcoded number.
  const barsToRes = rawTouches.map(t => t.maeTrace.length).filter(n => n > 0).sort((a, b) => a - b);
  const windowSize = Math.max(2, Math.ceil(percentile(barsToRes, 0.25)));
  console.log(`Reaction window size (p25 bars-to-resolution): ${windowSize}`);

  // Pass 1: classify maxVolZ + gaveFurtherGround for every touch with enough bars.
  const classified = [];
  for (const t of rawTouches) {
    if (t.maeTrace.length < windowSize) continue; // resolved before the window completed
    const baseline = await getBaselineCached(t.date);
    const windowBars = t.bars.slice(t.entryIdx + 1, t.entryIdx + 1 + windowSize)
      .map(b => ({ mod: Number(b.tod), bid_volume: b.bid_vol, ask_volume: b.ask_vol }));
    if (windowBars.length < windowSize) continue;
    const maeAtBar1 = t.maeTrace[0];
    const maeAtWindowEnd = t.maeTrace[windowSize - 1];
    const gaveFurtherGround = maeAtWindowEnd > maeAtBar1 + 0.01;
    const probe = classifyTouch({ windowBars, direction: t.dir, baseline, highVolZCutoff: Infinity, gaveFurtherGround });
    if (!probe) continue; // no baseline coverage
    classified.push({ ...t, maxVolZ: probe.maxVolZ, gaveFurtherGround, netAdverseDelta: probe.netAdverseDelta });
  }
  console.log(`Classified (baseline coverage available): N=${classified.length}`);
  if (classified.length < 20) { console.log('N<20, cannot proceed.'); process.exit(0); }

  // Shared high-vol cutoff (top tercile of maxVolZ), computed ONCE across NODE+GAP
  // combined so both locations are judged against the same standard.
  const zSorted = classified.map(t => t.maxVolZ).sort((a, b) => a - b);
  const highVolZCutoff = percentile(zSorted, 2 / 3);
  console.log(`Shared highVolZCutoff (top-tercile): ${highVolZCutoff.toFixed(2)}`);

  for (const t of classified) {
    t.bucket = t.maxVolZ > highVolZCutoff ? (t.gaveFurtherGround ? 'HIGH_VOL_OVERRUN' : 'HIGH_VOL_ABSORBED') : 'QUIET';
  }

  function summarize(pop, label) {
    if (!pop.length) { console.log(`  ${label}: N=0`); return null; }
    const decided = pop.filter(t => t.resolution !== 'EXPIRED');
    const wr = decided.length ? decided.filter(t => t.pnl > 0).length / decided.length * 100 : null;
    const ev = pop.reduce((s, t) => s + t.pnl, 0) / pop.length;
    console.log(`  ${label}: N=${pop.length} WR=${wr?.toFixed(1)}% EV=$${ev.toFixed(2)}/trade`);
    return { n: pop.length, wr, ev };
  }

  console.log('\n=== Bucket x Location breakdown ===');
  for (const loc of ['NODE', 'GAP']) {
    console.log(`-- ${loc} --`);
    for (const bucket of ['HIGH_VOL_ABSORBED', 'HIGH_VOL_OVERRUN', 'QUIET']) {
      summarize(classified.filter(t => t.location === loc && t.bucket === bucket), bucket);
    }
  }

  console.log('\n=== Core hypothesis: ABSORBED vs OVERRUN, pooled across both locations ===');
  const absorbed = classified.filter(t => t.bucket === 'HIGH_VOL_ABSORBED');
  const overrun = classified.filter(t => t.bucket === 'HIGH_VOL_OVERRUN');
  const quiet = classified.filter(t => t.bucket === 'QUIET');
  const absorbedStats = summarize(absorbed, 'ABSORBED (real defense — high vol, held ground)');
  const overrunStats = summarize(overrun, 'OVERRUN  (lost the fight — high vol, gave ground)');
  summarize(quiet, 'QUIET    (no real battle)');
  if (absorbedStats && overrunStats) console.log(`Delta (absorbed - overrun): $${(absorbedStats.ev - overrunStats.ev).toFixed(2)}/trade`);

  console.log('\n=== Chronological 70/30 train/test (ABSORBED arm) ===');
  const absorbedChrono = [...absorbed].sort((a, b) => a.date.localeCompare(b.date));
  const splitIdx = Math.floor(absorbedChrono.length * 0.7);
  summarize(absorbedChrono.slice(0, splitIdx), 'ABSORBED train');
  summarize(absorbedChrono.slice(splitIdx), 'ABSORBED test');

  console.log('\n=== Chronological 70/30 train/test (OVERRUN arm) ===');
  const overrunChrono = [...overrun].sort((a, b) => a.date.localeCompare(b.date));
  const oSplitIdx = Math.floor(overrunChrono.length * 0.7);
  summarize(overrunChrono.slice(0, oSplitIdx), 'OVERRUN train');
  summarize(overrunChrono.slice(oSplitIdx), 'OVERRUN test');

  console.log('\n=== Rigor (ABSORBED) ===');
  const rigorA = computeRigor(absorbed, { dateField: 'date', pnlFn: t => t.pnl });
  console.log(`distinctDates=${rigorA.distinctDates} top5DayPct=${rigorA.top5DayPct}% clustered=${rigorA.clustered} stable=${rigorA.stable} thirds=${JSON.stringify(rigorA.thirds)} clean=${rigorA.clean}`);

  console.log('\n=== Rigor (OVERRUN) ===');
  const rigorO = computeRigor(overrun, { dateField: 'date', pnlFn: t => t.pnl });
  console.log(`distinctDates=${rigorO.distinctDates} top5DayPct=${rigorO.top5DayPct}% clustered=${rigorO.clustered} stable=${rigorO.stable} thirds=${JSON.stringify(rigorO.thirds)} clean=${rigorO.clean}`);

  // ── Confound check: is this a real order-flow/volume effect, or just a repackaging
  // of the already-validated bar6_checkpoint "worst point passed early" MAE-trajectory
  // signal? gaveFurtherGround (MAE still growing through the window) is conceptually
  // close to that existing finding. Decompose as a full 2x2 (heldGround x highVol),
  // not just the volume-gated 3-bucket scheme above — if heldGround alone (regardless
  // of volume) explains just as much, the "battle"/volume angle isn't adding anything.
  console.log('\n=== Confound check: 2x2 (held ground x high volume), independent of the bucket scheme ===');
  const heldHighVol = classified.filter(t => !t.gaveFurtherGround && t.maxVolZ > highVolZCutoff);   // = ABSORBED
  const heldLowVol  = classified.filter(t => !t.gaveFurtherGround && t.maxVolZ <= highVolZCutoff);  // held ground, but NOT high volume
  const gaveHighVol = classified.filter(t => t.gaveFurtherGround && t.maxVolZ > highVolZCutoff);    // = OVERRUN
  const gaveLowVol  = classified.filter(t => t.gaveFurtherGround && t.maxVolZ <= highVolZCutoff);   // gave ground, but NOT high volume
  const heldHighVolStats = summarize(heldHighVol, 'HELD ground + HIGH vol (= ABSORBED)');
  const heldLowVolStats = summarize(heldLowVol, 'HELD ground + low vol  (held-ground-only control)');
  const gaveHighVolStats = summarize(gaveHighVol, 'GAVE ground + HIGH vol (= OVERRUN)');
  const gaveLowVolStats = summarize(gaveLowVol, 'GAVE ground + low vol  (gave-ground-only control)');
  console.log(`\nWithin HELD ground: high-vol vs low-vol delta = $${(heldHighVolStats?.ev - heldLowVolStats?.ev).toFixed(2)}/trade (volume's marginal contribution when ground was already held)`);
  console.log(`Within GAVE ground: high-vol vs low-vol delta = $${(gaveHighVolStats?.ev - gaveLowVolStats?.ev).toFixed(2)}/trade (volume's marginal contribution when ground was already given)`);
  console.log(`Within HIGH vol: held vs gave delta = $${(heldHighVolStats?.ev - gaveHighVolStats?.ev).toFixed(2)}/trade (matches the ABSORBED-OVERRUN delta above by construction)`);
  console.log(`Within low vol: held vs gave delta = $${(heldLowVolStats?.ev - gaveLowVolStats?.ev).toFixed(2)}/trade (does held-ground ALONE, without the volume requirement, already explain the effect?)`);

  // ── The real headline, once the confound check above shows volume isn't the driver:
  // held-ground vs gave-ground, POOLED across both volume tiers — this is the pure
  // MAE-trajectory generalization test (does bar6_checkpoint's "worst point passed
  // early" effect hold for level-agnostic touches too, not just named levels).
  console.log('\n=== Pure held-ground vs gave-ground (pooled across volume tiers, all classified touches) ===');
  const held = classified.filter(t => !t.gaveFurtherGround);
  const gave = classified.filter(t => t.gaveFurtherGround);
  const heldStats = summarize(held, 'HELD ground (regardless of volume)');
  const gaveStats = summarize(gave, 'GAVE ground (regardless of volume)');
  if (heldStats && gaveStats) console.log(`Delta (held - gave): $${(heldStats.ev - gaveStats.ev).toFixed(2)}/trade`);

  console.log('\n=== Chronological 70/30 train/test (HELD ground, pooled) ===');
  const heldChrono = [...held].sort((a, b) => a.date.localeCompare(b.date));
  const hSplit = Math.floor(heldChrono.length * 0.7);
  summarize(heldChrono.slice(0, hSplit), 'HELD train');
  summarize(heldChrono.slice(hSplit), 'HELD test');

  console.log('\n=== Chronological 70/30 train/test (GAVE ground, pooled) ===');
  const gaveChrono = [...gave].sort((a, b) => a.date.localeCompare(b.date));
  const gSplit = Math.floor(gaveChrono.length * 0.7);
  summarize(gaveChrono.slice(0, gSplit), 'GAVE train');
  summarize(gaveChrono.slice(gSplit), 'GAVE test');

  console.log('\n=== Rigor (HELD, pooled) ===');
  const rigorHeld = computeRigor(held, { dateField: 'date', pnlFn: t => t.pnl });
  console.log(`distinctDates=${rigorHeld.distinctDates} top5DayPct=${rigorHeld.top5DayPct}% clustered=${rigorHeld.clustered} stable=${rigorHeld.stable} thirds=${JSON.stringify(rigorHeld.thirds)} clean=${rigorHeld.clean}`);

  console.log('\n=== Rigor (GAVE, pooled) ===');
  const rigorGave = computeRigor(gave, { dateField: 'date', pnlFn: t => t.pnl });
  console.log(`distinctDates=${rigorGave.distinctDates} top5DayPct=${rigorGave.top5DayPct}% clustered=${rigorGave.clustered} stable=${rigorGave.stable} thirds=${JSON.stringify(rigorGave.thirds)} clean=${rigorGave.clean}`);

  // Location breakdown for the pooled held/gave split — does this generalize across
  // BOTH the historically-busy (NODE) and historically-empty (GAP) locations too?
  console.log('\n=== HELD vs GAVE, split by location (does it generalize across both?) ===');
  for (const loc of ['NODE', 'GAP']) {
    summarize(held.filter(t => t.location === loc), `HELD @ ${loc}`);
    summarize(gave.filter(t => t.location === loc), `GAVE @ ${loc}`);
  }

  console.log('\n=== JSON summary ===');
  console.log(JSON.stringify({ absorbedStats, overrunStats, rigorA, rigorO, windowSize, highVolZCutoff, heldHighVolStats, heldLowVolStats, gaveHighVolStats, gaveLowVolStats, heldStats, gaveStats, rigorHeld, rigorGave }));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
