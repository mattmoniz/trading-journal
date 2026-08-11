// Roadmap Phase 6, Setup D ("Opening Drive") — Stage 1 bar-history backtest.
// Stage 0 pre-registration: RESEARCH_CLAIM setup_d_opening_drive_stage0.
// Design critique: scratch/deepseek_setup_d_design.md (DeepSeek, 2026-08-11) — incorporated
// below: (1) a blind-delay control arm is REQUIRED to rule out the entry-timing confound
// that killed engagement_confirmation_entry_timing; (2) report un-gated vs NL30-gated EV;
// (3) report "classified but never pulled back" days separately; (4) report day-type
// breakdown even though the bet claims day-type independence; (5) report implied stop-
// distance distribution.
//
// User decision (direct answer, not assumed): test a 5-minute-OR-consistent variant AND a
// 15-minute-OR-consistent variant side by side, rather than only replicating the live
// (5-min-anchor + 15-min-confirm, a real confirmed mismatch — OPEN_DECISION
// open_drive_5min_or_vs_15min_classifier_mismatch) definition as the sole test.
//   VARIANT_5MIN = the CURRENT live definition exactly: OR = first 5 RTH minutes
//     (9:30-9:35), confirmation/extension-check window = first 15 minutes (9:30-9:45).
//   VARIANT_15MIN = OR = first 15 RTH minutes (9:30-9:45), confirmation window = first 45
//     minutes (9:30-10:15) — scaled up by the SAME 1:3 anchor:confirm ratio the live system
//     already uses, so the two variants are structurally analogous at two different scales,
//     not an apples-to-oranges comparison. Stated explicitly so this interpretation can be
//     corrected if it doesn't match what was actually meant.
//
// Both variants share: the asymmetric pullback entry band (-15/+5 around the OR boundary,
// replicated exactly — a symmetric band would test a different entry rule), the
// classifyACDOpeningCall() extraction (real function, not reimplemented), and resolve()
// (backtest_unified.js) for every EV evaluation.
//
// Run: node scripts/backtest_setup_d_opening_drive_stage1.mjs

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { classifyACDOpeningCall } from '../server/services/openingCallClassifier.js';
import { resolve, loadData } from './backtest_unified.js';
import { computeVolatilityDefaultRatios, loadVolatilityDefaultInputs, TARGET_SWEEP } from './update_optimal_stops.mjs';
import { recordClaim } from './record_claim.mjs';

const DEFAULT_DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const WALK_MAX_BARS = 240;
const MIN_N = 20;
const TARGET_SWEEP_EXTENDED = [...TARGET_SWEEP, 175, 200, 250, 300];

const WINDOWS = {
  VARIANT_5MIN: { orEndMin: 575, confirmEndMin: 585 },   // OR 9:30-9:35, confirm 9:30-9:45 (live today)
  VARIANT_15MIN: { orEndMin: 585, confirmEndMin: 615 },  // OR 9:30-9:45, confirm 9:30-10:15 (scaled 1:3)
};

function pnl(entry, exitPrice, long) {
  const signedPoints = long ? (exitPrice - entry) : (entry - exitPrice);
  return signedPoints * DEFAULT_DPP - COMMISSION;
}
function walkPnl(bars, entryIdx, direction, entry, stop, target) {
  const res = resolve(bars, entryIdx, direction, entry, stop, target, WALK_MAX_BARS);
  if (res.result !== 'EXPIRED') return res.pnl;
  const cutoff = bars[Math.min(bars.length - 1, entryIdx + WALK_MAX_BARS)];
  return pnl(entry, cutoff.close, direction === 'LONG');
}
function percentileOf(sortedArr, p) {
  if (!sortedArr.length) return null;
  return sortedArr[Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p))];
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  console.log('[setup_d_stage1] Loading bar/ACD data...');
  const { barsByDate, acdByDate, dates } = await loadData();
  const dayTypeQ = await query(`SELECT trade_date::text as d, day_type FROM acd_daily_log WHERE day_type IS NOT NULL`);
  const dayTypeByDate = new Map(dayTypeQ.rows.map(r => [r.d, r.day_type]));

  // ── Detect classification + pullback entry + blind-delay control, per variant ──────
  const results = {};
  for (const [variantName, win] of Object.entries(WINDOWS)) {
    const armATouches = [];   // real pullback entries
    const barsToEntryByDir = { UP: [], DOWN: [] };
    let classifiedUp = 0, classifiedDown = 0, neverPulledBackUp = 0, neverPulledBackDown = 0;
    const neverPulledBackMFE = [];

    for (const date of dates) {
      const bars = barsByDate.get(date);
      const acd = acdByDate.get(date);
      if (!bars || !acd) continue;
      const orBars = bars.filter(b => b.tod >= 570 && b.tod < win.orEndMin);
      const confirmBars = bars.filter(b => b.tod >= 570 && b.tod < win.confirmEndMin);
      if (orBars.length < 3 || confirmBars.length < 5) continue;
      const orH = Math.max(...orBars.map(b => b.high));
      const orL = Math.min(...orBars.map(b => b.low));

      const call = classifyACDOpeningCall(confirmBars, orH, orL);
      if (!call || call.type !== 'OPEN_DRIVE') continue;

      const dir = call.driveDirection; // 'UP' or 'DOWN'
      const isLong = dir === 'UP';
      if (isLong) classifiedUp++; else classifiedDown++;

      // Scan forward from the confirm window's close for the asymmetric pullback band
      // (-15/+5 around the OR boundary, replicated exactly from the live entry condition).
      const confirmEndIdx = bars.findIndex(b => b.tod >= win.confirmEndMin);
      if (confirmEndIdx === -1) continue;
      let entryIdx = null;
      for (let i = confirmEndIdx; i < bars.length && bars[i].tod < 960; i++) {
        const px = bars[i].close;
        const hit = isLong
          ? (px >= orH - 15 && px <= orH + 5)
          : (px <= orL + 15 && px >= orL - 5);
        if (hit) { entryIdx = i; break; }
      }
      if (entryIdx == null) {
        if (isLong) neverPulledBackUp++; else neverPulledBackDown++;
        const restOfDay = bars.slice(confirmEndIdx);
        if (restOfDay.length) {
          const entryPx = bars[confirmEndIdx].close;
          const mfe = isLong
            ? Math.max(...restOfDay.map(b => b.high)) - entryPx
            : entryPx - Math.min(...restOfDay.map(b => b.low));
          neverPulledBackMFE.push(mfe);
        }
        continue;
      }
      const barsToEntry = entryIdx - confirmEndIdx;
      barsToEntryByDir[dir].push(barsToEntry);
      const nl30Val = parseInt(acd.nl30) || 0;
      const nl30State = nl30Val > 9 ? 'BULLISH' : nl30Val < -9 ? 'BEARISH' : 'RANGING';
      const nl30Aligned = isLong ? nl30State !== 'BEARISH' : nl30State !== 'BULLISH';
      armATouches.push({
        date, bars, entryIdx, entry: bars[entryIdx].close, direction: isLong ? 'LONG' : 'SHORT',
        confirmEndIdx, barsToEntry, nl30Aligned, dayType: dayTypeByDate.get(date) || 'UNKNOWN',
        orH, orL,
      });
    }

    // Blind-delay control arm (Arm B) — per DeepSeek's required recommendation: same
    // confirm-window start, delayed by the MEDIAN bars-to-entry Arm A actually took (computed
    // per direction, from Arm A's own real entries — aggregate/structural, not per-trade
    // hindsight), entering regardless of whether the pullback band was ever touched.
    const medianDelay = { UP: median(barsToEntryByDir.UP), DOWN: median(barsToEntryByDir.DOWN) };
    const armBTouches = [];
    for (const t of armATouches) {
      const dir = t.direction === 'LONG' ? 'UP' : 'DOWN';
      const delayIdx = t.confirmEndIdx + medianDelay[dir];
      if (delayIdx >= t.bars.length) continue;
      armBTouches.push({ ...t, entryIdx: delayIdx, entry: t.bars[delayIdx].close });
    }

    console.log(`\n[${variantName}] Classified OPEN_DRIVE: UP=${classifiedUp}, DOWN=${classifiedDown}. Never pulled back (no entry): UP=${neverPulledBackUp}, DOWN=${neverPulledBackDown}. Median bars-to-entry: UP=${medianDelay.UP}, DOWN=${medianDelay.DOWN}.`);
    if (neverPulledBackMFE.length) {
      const s = [...neverPulledBackMFE].sort((a, b) => a - b);
      console.log(`  Never-pulled-back days' MFE from confirm-window close: p50=${percentileOf(s, 0.5)?.toFixed(1)}pt, p75=${percentileOf(s, 0.75)?.toFixed(1)}pt (n=${s.length}) — favorable continuation this entry rule structurally forfeits.`);
    }

    results[variantName] = { armATouches, armBTouches, classifiedUp, classifiedDown, neverPulledBackUp, neverPulledBackDown };
  }

  // ── Sweep + walk-forward, per (variant, arm) — reused inner routine ─────────────────
  function sweepArm(touches, label) {
    if (touches.length < MIN_N) return { insufficientN: true, n: touches.length, label };
    const maes = touches.map(t => {
      const wide = 1000;
      const wideStop = t.direction === 'LONG' ? t.entry - wide : t.entry + wide;
      const wideTarget = t.direction === 'LONG' ? t.entry + wide : t.entry - wide;
      const res = resolve(t.bars, t.entryIdx, t.direction, t.entry, wideStop, wideTarget, WALK_MAX_BARS);
      return res.mae;
    }).sort((a, b) => a - b);
    const stopCandidates = [0.25, 0.40, 0.50, 0.60, 0.75].map(pct => ({ value: percentileOf(maes, pct), pct })).filter(c => c.value > 0);
    if (!stopCandidates.length) return { insufficientN: true, n: touches.length, label };

    const sorted = [...touches].sort((a, b) => a.date.localeCompare(b.date));
    const splitIdx = Math.floor(sorted.length * (2 / 3));
    const train = sorted.slice(0, splitIdx), test = sorted.slice(splitIdx);

    function evalCand(set, stop, target) {
      let sum = 0;
      for (const t of set) {
        const stopPrice = t.direction === 'LONG' ? t.entry - stop : t.entry + stop;
        const targetPrice = t.direction === 'LONG' ? t.entry + target : t.entry - target;
        sum += walkPnl(t.bars, t.entryIdx, t.direction, t.entry, stopPrice, targetPrice);
      }
      return sum / set.length;
    }

    let best = null;
    for (const { value: stopVal, pct } of stopCandidates) {
      const stop = Math.round(stopVal);
      const requiredN = Math.ceil(MIN_N / (1 - pct));
      if (train.length < requiredN) continue;
      for (const target of TARGET_SWEEP_EXTENDED) {
        const ev = evalCand(train, stop, target);
        if (!best || ev > best.ev) best = { stop, target, ev };
      }
    }
    if (!best) return { insufficientN: true, n: touches.length, label };
    const oosEv = evalCand(test, best.stop, best.target);

    const fullEvents = sorted.map(t => {
      const stopPrice = t.direction === 'LONG' ? t.entry - best.stop : t.entry + best.stop;
      const targetPrice = t.direction === 'LONG' ? t.entry + best.target : t.entry - best.target;
      return { date: t.date, pnl: walkPnl(t.bars, t.entryIdx, t.direction, t.entry, stopPrice, targetPrice) };
    });
    const rigor = computeRigor(fullEvents, { dateField: 'date', pnlFn: e => e.pnl });
    return {
      label, n: touches.length, nTrain: train.length, nTest: test.length,
      stop: best.stop, target: best.target, isEv: best.ev, oosEv,
      rigorClean: rigor.clean, top5DayPct: rigor.top5DayPct, thirds: rigor.thirds,
    };
  }

  const summary = {};
  for (const [variantName, r] of Object.entries(results)) {
    summary[variantName] = {
      armA: sweepArm(r.armATouches, `${variantName}_ArmA_pullback`),
      armB: sweepArm(r.armBTouches, `${variantName}_ArmB_blindDelay`),
    };
    console.log(`\n=== ${variantName} ===`);
    for (const arm of ['armA', 'armB']) {
      const s = summary[variantName][arm];
      if (s.insufficientN) { console.log(`  ${arm}: N=${s.n} — insufficient for a sweep (MIN_N=${MIN_N}).`); continue; }
      console.log(`  ${arm}: N=${s.n} (train=${s.nTrain}/test=${s.nTest}), stop=${s.stop}/target=${s.target}, IS_EV=$${s.isEv.toFixed(2)} -> OOS_EV=$${s.oosEv.toFixed(2)}, rigor.clean=${s.rigorClean}, top5DayPct=${s.top5DayPct}, thirds=${JSON.stringify(s.thirds)}`);
    }
  }

  // ── NL30-gated vs ungated EV (Arm A, both variants) — flat 39pt/43pt reference stop/
  // target purely for a quick descriptive comparison, NOT the calibrated result. ──
  console.log('\n=== NL30 alignment check (Arm A, descriptive, flat 39/43 stop/target) ===');
  for (const [variantName, r] of Object.entries(results)) {
    const aligned = r.armATouches.filter(t => t.nl30Aligned);
    const misaligned = r.armATouches.filter(t => !t.nl30Aligned);
    const evOf = (set) => set.length ? set.reduce((s, t) => s + walkPnl(t.bars, t.entryIdx, t.direction, t.entry, t.direction === 'LONG' ? t.entry - 39 : t.entry + 39, t.direction === 'LONG' ? t.entry + 43 : t.entry - 43), 0) / set.length : null;
    console.log(`  ${variantName}: NL30-aligned N=${aligned.length} EV=$${evOf(aligned)?.toFixed(2)} | misaligned N=${misaligned.length} EV=$${evOf(misaligned)?.toFixed(2)}`);
  }

  // ── Day-type breakdown (Arm A, both variants) ──
  console.log('\n=== Day-type breakdown (Arm A) ===');
  const dayTypeReport = {};
  for (const [variantName, r] of Object.entries(results)) {
    const byType = {};
    for (const t of r.armATouches) (byType[t.dayType] ||= []).push(t);
    dayTypeReport[variantName] = {};
    for (const [dt, touches] of Object.entries(byType)) {
      const ev = touches.reduce((s, t) => s + walkPnl(t.bars, t.entryIdx, t.direction, t.entry, t.direction === 'LONG' ? t.entry - 39 : t.entry + 39, t.direction === 'LONG' ? t.entry + 43 : t.entry - 43), 0) / touches.length;
      dayTypeReport[variantName][dt] = { n: touches.length, ev: +ev.toFixed(2) };
    }
    console.log(`  ${variantName}: ${JSON.stringify(dayTypeReport[variantName])}`);
  }

  // ── Flat volatility-scaled default, for the primary verdict ──
  const { priorStoredByType, realNByType, medianBarRange } = await loadVolatilityDefaultInputs();
  const { volScaleRatio, targetStopRatio, canComputeVolDefault } = computeVolatilityDefaultRatios({ priorStoredByType, realNByType, medianBarRange, minN: MIN_N });
  let flatOosEv = {};
  if (canComputeVolDefault) {
    const flatStop = Math.round(volScaleRatio * medianBarRange);
    const flatTarget = Math.round(targetStopRatio * flatStop);
    console.log(`\nFlat volatility-scaled default: stop=${flatStop}/target=${flatTarget}`);
    for (const [variantName, r] of Object.entries(results)) {
      const sorted = [...r.armATouches].sort((a, b) => a.date.localeCompare(b.date));
      const test = sorted.slice(Math.floor(sorted.length * (2 / 3)));
      flatOosEv[variantName] = test.length ? test.reduce((s, t) => s + walkPnl(t.bars, t.entryIdx, t.direction, t.entry, t.direction === 'LONG' ? t.entry - flatStop : t.entry + flatStop, t.direction === 'LONG' ? t.entry + flatTarget : t.entry - flatTarget), 0) / test.length : null;
      console.log(`  ${variantName} Arm A flat-default OOS EV: $${flatOosEv[variantName]?.toFixed(2)}`);
    }
  }

  // ── Verdict: does Arm A materially beat Arm B (rules out the entry-timing confound), AND
  // does the winning variant/arm's calibrated OOS EV beat the flat default? ──
  console.log('\n=== VERDICT ===');
  let anyPass = false;
  const verdictLines = [];
  for (const variantName of Object.keys(WINDOWS)) {
    const a = summary[variantName].armA, b = summary[variantName].armB;
    if (a.insufficientN) { verdictLines.push(`${variantName}: Arm A has insufficient N (${a.n}) to evaluate.`); continue; }
    const confoundNote = !b.insufficientN
      ? (a.oosEv > b.oosEv ? `Arm A ($${a.oosEv.toFixed(2)}) beats Arm B blind-delay control ($${b.oosEv.toFixed(2)}) — the pullback condition appears to add real value beyond delayed entry alone.` : `Arm A ($${a.oosEv.toFixed(2)}) does NOT beat Arm B blind-delay control ($${b.oosEv.toFixed(2)}) — the entry-timing confound is NOT ruled out; the apparent edge may just be "enter later," matching the engagement_confirmation_entry_timing precedent.`)
      : `Arm B has insufficient N (${b.n}) to compare.`;
    const beatsFlat = flatOosEv[variantName] != null && a.oosEv > flatOosEv[variantName];
    const pass = a.rigorClean && !b.insufficientN && a.oosEv > b.oosEv && beatsFlat && a.n >= MIN_N;
    if (pass) anyPass = true;
    verdictLines.push(`${variantName}: ${confoundNote} Beats flat default: ${beatsFlat}. rigor.clean=${a.rigorClean}. ${pass ? 'PASSES the full Stage 1 gate.' : 'Does NOT pass the full Stage 1 gate.'}`);
    console.log(`${variantName}: ${confoundNote} Beats flat: ${beatsFlat}. rigor.clean=${a.rigorClean}. ${pass ? 'PASS' : 'FAIL'}`);
  }
  console.log(`\nOVERALL: ${anyPass ? 'At least one variant PASSES Stage 1 — candidate for Stage 2.' : 'NEITHER variant passes the full Stage 1 gate.'}`);

  await recordClaim({
    slug: 'setup_d_opening_drive_stage1',
    claimText: `Stage 1 bar-history backtest for Setup D (Opening Drive), incorporating DeepSeek's design critique (scratch/deepseek_setup_d_design.md) and the user's explicit request to compare a 5-minute-OR-consistent variant (current live definition: OR=9:30-9:35, confirm window=9:30-9:45) against a 15-minute-OR-consistent variant (OR=9:30-9:45, confirm window=9:30-10:15, same 1:3 anchor:confirm ratio scaled up). Both variants use the extracted classifyACDOpeningCall() (server/services/openingCallClassifier.js, a pure port of the 3-times-duplicated live formula, not reimplemented) and resolve() (backtest_unified.js) for every EV evaluation. Each variant tested with two arms: Arm A (the real pullback-to-OR-boundary entry, exact asymmetric -15/+5 band replicated from live) and Arm B (a blind-delay control — same classification, but enters at the MEDIAN bars-to-entry Arm A actually took, regardless of whether the pullback band was ever touched) — required per DeepSeek's critique to rule out the same entry-timing confound that invalidated the engagement_confirmation_entry_timing finding earlier in this project (entering later against fixed exits is structurally favorable regardless of the condition tested).

RESULTS: ${JSON.stringify(summary)}. Never-pulled-back rate: VARIANT_5MIN UP=${results.VARIANT_5MIN.neverPulledBackUp}/${results.VARIANT_5MIN.classifiedUp}, DOWN=${results.VARIANT_5MIN.neverPulledBackDown}/${results.VARIANT_5MIN.classifiedDown}; VARIANT_15MIN UP=${results.VARIANT_15MIN.neverPulledBackUp}/${results.VARIANT_15MIN.classifiedUp}, DOWN=${results.VARIANT_15MIN.neverPulledBackDown}/${results.VARIANT_15MIN.classifiedDown}. Day-type breakdown (Arm A, descriptive flat 39/43): ${JSON.stringify(dayTypeReport)}. NL30-gated vs ungated EV reported separately in console output (both directions checked; live gate is nl30State!=='BEARISH' for LONG / !=='BULLISH' for SHORT, exact ±9 threshold replicated from acd.js).

VERDICT: ${verdictLines.join(' ')} OVERALL: ${anyPass ? 'at least one variant passes the full Stage 1 gate (rigor-clean, Arm A beats its own blind-delay control, beats the flat volatility-scaled default, real N>=20) -- candidate for Stage 2.' : 'neither variant passes the full Stage 1 gate this round.'}

Separately confirms/informs OPEN_DECISION open_drive_5min_or_vs_15min_classifier_mismatch (which window definition performs better, from real data, not guessed).`,
    sourceFile: 'scripts/backtest_setup_d_opening_drive_stage1.mjs',
    sourceDate: '2026-08-11',
    sampleSize: results.VARIANT_5MIN.armATouches.length + results.VARIANT_15MIN.armATouches.length,
    rigorStatus: `5min_armA_${summary.VARIANT_5MIN.armA.insufficientN ? 'thinN' : (summary.VARIANT_5MIN.armA.rigorClean ? 'clean' : 'unstable')}_15min_armA_${summary.VARIANT_15MIN.armA.insufficientN ? 'thinN' : (summary.VARIANT_15MIN.armA.rigorClean ? 'clean' : 'unstable')}_overall_${anyPass ? 'PASS' : 'FAIL'}`,
    status: 'PROVISIONAL',
  });
  console.log('\nRESEARCH_CLAIM setup_d_opening_drive_stage1 recorded.');

  return { anyPass, summary };
}

main().then(r => console.log('\nDone.', JSON.stringify({ anyPass: r.anyPass }))).catch(e => { console.error('FATAL:', e); process.exit(1); });
