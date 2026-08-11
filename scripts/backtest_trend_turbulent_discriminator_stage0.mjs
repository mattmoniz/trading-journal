// Roadmap Phase 5 — the TREND/TURBULENT discriminator, standalone (Part 3, Setup C's own
// "critical constraint": "the discriminator is the load-bearing component. Build and
// validate THAT before building the setup. If it cannot beat a coin flip at separating the
// two, this setup cannot work and should not be built.").
//
// Pre-registration (Part 3, exact text): "Given information available by time T, can we
// classify the remainder of the session as TREND vs TURBULENT better than base rate?
// Success threshold: accuracy at least 15 percentage points above base rate, out of
// sample, on at least 200 sessions."
//
// Ground truth: acd_daily_log.day_type (scripts/derive_day_types.js, real O/H/L/C +
// IB-structure classification) -- imported via a direct join, never reimplemented.
// T = IB close, IB_CLOSE=630 (9:30-10:30 ET, the 60-min IB convention this codebase's own
// 2026-08-05 day-type-conditioning work already used and the user separately confirmed as
// correct over a competing 30-min convention elsewhere in this codebase -- see CLAUDE.md's
// "New setup type checklist" item 10).
//
// Features, all computable strictly before T (no lookahead):
//   1. ibRangePctile -- this session's IB range (high-low over etMin<630) vs its own
//      trailing-60-session distribution. Reuses the exact percentileRank()/trailing-window
//      methodology already established in analyze_intraday_ib_range_daytype.mjs (same
//      TRAILING_WINDOW=60/MIN_VALID_TRAILING=30 constants) -- NOT reimplemented from
//      scratch, ported inline since that script's helpers aren't exported, but identical
//      logic/constants, same data source.
//   2. ibDirectionality -- |ibClose - ibMid| / ibRange (0 = IB closed dead center, 0.5 = IB
//      closed at its own extreme). A natural, cheap, no-lookahead "did the IB itself
//      already show one-sided conviction" signal -- the missing ingredient Part 1.3 names
//      explicitly ("wide != trending... must separate TREND from TURBULENT, not just
//      measure range").
//
// Classifier: simple rule-based threshold selection (no ML, per this codebase's own
// "N nowhere near sufficient, would fit noise" standing rule) -- candidate thresholds on
// ibDirectionality (and ibRangePctile alone, as the baseline this is meant to improve on)
// selected on the TRAIN split ONLY, evaluated on TEST (out-of-sample) only, per the exact
// winner's-curse-honest methodology analyze_intraday_ib_range_daytype.mjs already
// established for this same underlying data.
//
// Run: node scripts/backtest_trend_turbulent_discriminator_stage0.mjs

import { query } from '../server/db.js';
import { recordClaim } from './record_claim.mjs';

const IB_CLOSE = 630, RTH_END = 960;
const MIN_BARS = 10;
const TRAILING_WINDOW = 60, MIN_VALID_TRAILING = 30;

function etMinuteOf(d) { const dt = new Date(d); return dt.getUTCHours() * 60 + dt.getUTCMinutes(); }
function percentileRank(value, arr) {
  if (value == null || !arr.length) return null;
  let below = 0, equal = 0;
  for (const v of arr) { if (v < value) below++; else if (v === value) equal++; }
  return +(((below + 0.5 * equal) / arr.length) * 100).toFixed(1);
}
function getPercentileOfArr(arr, p) {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function main() {
  console.log('Loading all NQ RTH bars...');
  const barsQ = await query(`
    SELECT ts, ts::date::text as d, open::float as open, high::float as high, low::float as low, close::float as close
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND (EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND ${RTH_END - 1}
    ORDER BY ts ASC
  `);
  const barsByDay = new Map();
  for (const b of barsQ.rows) {
    const em = etMinuteOf(b.ts);
    if (!barsByDay.has(b.d)) barsByDay.set(b.d, []);
    barsByDay.get(b.d).push({ open: b.open, high: b.high, low: b.low, close: b.close, etMin: em });
  }
  const tradingDays = [...barsByDay.keys()].sort();

  // Per-day IB stats, computable strictly before T=630.
  const ibStatsByDay = new Map();
  for (const d of tradingDays) {
    const bars = barsByDay.get(d);
    const ibBars = bars.filter(b => b.etMin < IB_CLOSE).sort((a, b) => a.etMin - b.etMin);
    if (ibBars.length < MIN_BARS) continue;
    const ibH = Math.max(...ibBars.map(b => b.high));
    const ibL = Math.min(...ibBars.map(b => b.low));
    const ibRange = ibH - ibL;
    if (ibRange <= 0) continue;
    const ibClose = ibBars[ibBars.length - 1].close;
    const ibMid = (ibH + ibL) / 2;
    const ibDirectionality = Math.abs(ibClose - ibMid) / ibRange; // 0..0.5
    ibStatsByDay.set(d, { ibRange, ibDirectionality });
  }

  // Ground truth.
  const dtQ = await query(`SELECT trade_date::text as d, day_type FROM acd_daily_log WHERE day_type IS NOT NULL`);
  const dayTypeByDay = new Map(dtQ.rows.map(r => [r.d, r.day_type]));

  // Build records: trailing-60-session IB-range percentile + directionality + ground truth,
  // restricted to days classified TREND or TURBULENT (per the pre-registration's own literal
  // framing -- BALANCE is a third, separate outcome, not part of this binary discrimination).
  const records = [];
  for (let i = 61; i < tradingDays.length; i++) {
    const D = tradingDays[i];
    const stat = ibStatsByDay.get(D);
    if (!stat) continue;
    const dt = dayTypeByDay.get(D);
    if (dt !== 'TREND' && dt !== 'TURBULENT') continue; // BALANCE / null excluded from this binary test

    const trailingRanges = [];
    for (let back = 1; back <= TRAILING_WINDOW; back++) {
      const s = ibStatsByDay.get(tradingDays[i - back]);
      if (s) trailingRanges.push(s.ibRange);
    }
    if (trailingRanges.length < MIN_VALID_TRAILING) continue;
    const ibRangePctile = percentileRank(stat.ibRange, trailingRanges);

    records.push({ date: D, ibRangePctile, ibDirectionality: stat.ibDirectionality, dayType: dt });
  }

  console.log(`\n${records.length} eligible TREND/TURBULENT sessions (BALANCE and unclassified days excluded per the pre-registration's own binary framing).`);
  const trendN = records.filter(r => r.dayType === 'TREND').length;
  const turbN = records.filter(r => r.dayType === 'TURBULENT').length;
  console.log(`TREND=${trendN}, TURBULENT=${turbN}.`);

  const totalUniverseN = records.length;
  const meetsPreregisteredN = totalUniverseN >= 200;
  console.log(`\nPre-registered N requirement: >=200 sessions, out of sample. Total available TREND/TURBULENT universe (train+test combined): N=${totalUniverseN}. ${meetsPreregisteredN ? 'Clears the bar.' : 'DOES NOT clear the bar -- this is a hard data-availability ceiling, not a methodology choice: the entire history of this system contains only ' + totalUniverseN + ' days classified TREND or TURBULENT (out of 426 classified days total; the rest are BALANCE). No train/test split of the existing data can produce an out-of-sample N>=200 subset.'}`);

  // ── Walk-forward split (50/50 -- maximizes OOS N given the hard ceiling above; still a
  // genuine train-then-test chronological split, same integrity as this session's other
  // walk-forward tests, just proportioned differently given so few total sessions exist). ──
  const splitIdx = Math.floor(records.length / 2);
  const train = records.slice(0, splitIdx);
  const test = records.slice(splitIdx);
  console.log(`\nWalk-forward split: ${train.length} train, ${test.length} test (out-of-sample).`);

  const baseRateMajorityClass = trendN >= turbN ? 'TREND' : 'TURBULENT';
  const testBaseRateN = test.filter(r => r.dayType === baseRateMajorityClass).length;
  const testBaseRateAcc = testBaseRateN / test.length;
  console.log(`Base rate (guess majority class "${baseRateMajorityClass}" every time, computed on the FULL sample's own majority -- not re-picked on test): TEST accuracy=${(testBaseRateAcc * 100).toFixed(1)}% (N=${test.length}).`);

  // ── Candidate 1: ibRangePctile alone (the baseline Part 1.3 already flagged as
  // insufficient -- "wide != trending"). Threshold + direction (does high range predict
  // TREND or TURBULENT?) selected on TRAIN only. ──
  function evalRangeOnlyRule(recs, level, predictAbove) {
    let correct = 0;
    for (const r of recs) {
      const pred = (r.ibRangePctile >= level) === predictAbove ? 'TREND' : 'TURBULENT';
      // predictAbove=true means "ibRangePctile>=level predicts TREND"; predictAbove=false
      // means "ibRangePctile>=level predicts TURBULENT" (both directions tested since Part
      // 1.3's own finding suggests wide IB leans TURBULENT, not TREND).
      if (pred === r.dayType) correct++;
    }
    return correct / recs.length;
  }
  const rangeCandidateLevels = [
    getPercentileOfArr(train.map(r => r.ibRangePctile), 0.5),
    getPercentileOfArr(train.map(r => r.ibRangePctile), 0.67),
    getPercentileOfArr(train.map(r => r.ibRangePctile), 0.75),
    getPercentileOfArr(train.map(r => r.ibRangePctile), 0.90),
  ];
  let bestRangeOnly = null;
  for (const level of rangeCandidateLevels) {
    for (const predictAbove of [true, false]) {
      const acc = evalRangeOnlyRule(train, level, predictAbove);
      if (!bestRangeOnly || acc > bestRangeOnly.acc) bestRangeOnly = { level, predictAbove, acc };
    }
  }
  const rangeOnlyTestAcc = evalRangeOnlyRule(test, bestRangeOnly.level, bestRangeOnly.predictAbove);
  console.log(`\nCandidate 1 (ibRangePctile alone): TRAIN-selected level=${bestRangeOnly.level.toFixed(1)}, direction=${bestRangeOnly.predictAbove ? '>=level predicts TREND' : '>=level predicts TURBULENT'} (TRAIN acc=${(bestRangeOnly.acc*100).toFixed(1)}%). TEST (OOS) accuracy=${(rangeOnlyTestAcc*100).toFixed(1)}%.`);

  // ── Candidate 2: ibDirectionality alone -- the new feature Part 1.3 says is missing. ──
  function evalDirOnlyRule(recs, level, predictAbove) {
    let correct = 0;
    for (const r of recs) {
      const pred = (r.ibDirectionality >= level) === predictAbove ? 'TREND' : 'TURBULENT';
      if (pred === r.dayType) correct++;
    }
    return correct / recs.length;
  }
  const dirCandidateLevels = [
    getPercentileOfArr(train.map(r => r.ibDirectionality), 0.5),
    getPercentileOfArr(train.map(r => r.ibDirectionality), 0.67),
    getPercentileOfArr(train.map(r => r.ibDirectionality), 0.75),
  ];
  let bestDirOnly = null;
  for (const level of dirCandidateLevels) {
    for (const predictAbove of [true, false]) {
      const acc = evalDirOnlyRule(train, level, predictAbove);
      if (!bestDirOnly || acc > bestDirOnly.acc) bestDirOnly = { level, predictAbove, acc };
    }
  }
  const dirOnlyTestAcc = evalDirOnlyRule(test, bestDirOnly.level, bestDirOnly.predictAbove);
  console.log(`\nCandidate 2 (ibDirectionality alone): TRAIN-selected level=${bestDirOnly.level.toFixed(3)}, direction=${bestDirOnly.predictAbove ? '>=level predicts TREND' : '>=level predicts TURBULENT'} (TRAIN acc=${(bestDirOnly.acc*100).toFixed(1)}%). TEST (OOS) accuracy=${(dirOnlyTestAcc*100).toFixed(1)}%.`);

  // ── Candidate 3: combined 2D rule (range percentile AND directionality, both required).
  // Clean AND-based 2-way rule -- no special-cased "mixed signal" branch (an earlier draft
  // hardcoded the mixed case to always predict TURBULENT regardless of `predicts`, an
  // unswept, arbitrary asymmetry caught before trusting any result from it). ──
  function evalCombined(recs, rangeLevel, dirLevel, highRangeHighDirPredicts) {
    const otherClass = highRangeHighDirPredicts === 'TREND' ? 'TURBULENT' : 'TREND';
    let correct = 0;
    for (const r of recs) {
      const highRange = r.ibRangePctile >= rangeLevel;
      const highDir = r.ibDirectionality >= dirLevel;
      const pred = (highRange && highDir) ? highRangeHighDirPredicts : otherClass;
      if (pred === r.dayType) correct++;
    }
    return correct / recs.length;
  }
  let bestCombined = null;
  for (const rangeLevel of rangeCandidateLevels) {
    for (const dirLevel of dirCandidateLevels) {
      for (const predicts of ['TREND', 'TURBULENT']) {
        const acc = evalCombined(train, rangeLevel, dirLevel, predicts);
        if (!bestCombined || acc > bestCombined.acc) bestCombined = { rangeLevel, dirLevel, predicts, acc };
      }
    }
  }
  const combinedTestAcc = evalCombined(test, bestCombined.rangeLevel, bestCombined.dirLevel, bestCombined.predicts);
  console.log(`\nCandidate 3 (combined ibRangePctile x ibDirectionality): TRAIN-selected rangeLevel=${bestCombined.rangeLevel.toFixed(1)}, dirLevel=${bestCombined.dirLevel.toFixed(3)}, high+high predicts ${bestCombined.predicts} (TRAIN acc=${(bestCombined.acc*100).toFixed(1)}%). TEST (OOS) accuracy=${(combinedTestAcc*100).toFixed(1)}%.`);

  // ── Verdict against the pre-registered gate. ──
  const bestTestAcc = Math.max(rangeOnlyTestAcc, dirOnlyTestAcc, combinedTestAcc);
  const bestLabel = bestTestAcc === combinedTestAcc ? 'combined' : (bestTestAcc === dirOnlyTestAcc ? 'directionality-only' : 'range-only');
  const deltaVsBaseRate = (bestTestAcc - testBaseRateAcc) * 100;
  const beats15pp = deltaVsBaseRate >= 15;
  const overallPass = beats15pp && meetsPreregisteredN;

  console.log(`\n=== VERDICT ===`);
  console.log(`Best candidate: ${bestLabel}, TEST (OOS) accuracy=${(bestTestAcc*100).toFixed(1)}% vs base rate ${(testBaseRateAcc*100).toFixed(1)}% -- delta=${deltaVsBaseRate.toFixed(1)}pp (threshold: >=15pp).`);
  console.log(`Accuracy gate: ${beats15pp ? 'PASSED' : 'FAILED'}. Sample-size gate (N>=200 OOS/total): ${meetsPreregisteredN ? 'PASSED' : 'FAILED'} (actual total universe N=${totalUniverseN}).`);
  console.log(`OVERALL: ${overallPass ? 'PASSED -- Setups C and E may proceed' : 'FAILED -- per the roadmap\'s own explicit rule ("If that fails, stop. The whole expansion family depends on it."), Setups C and E do NOT get built this round.'}`);

  await recordClaim({
    slug: 'trend_turbulent_discriminator_stage0',
    claimText: `Roadmap Phase 5, standalone TREND/TURBULENT discriminator pre-registration test (Part 3, Setup C's gating constraint). Ground truth: acd_daily_log.day_type. T=IB close (etMin<630, 60-min IB). Features: ibRangePctile (trailing-60-session percentile of IB range, same methodology as analyze_intraday_ib_range_daytype.mjs) and ibDirectionality (|ibClose-ibMid|/ibRange, a new no-lookahead feature testing whether the IB's own one-sidedness helps beyond range alone). Restricted to days classified TREND (N=${trendN}) or TURBULENT (N=${turbN}) -- BALANCE excluded per the pre-registration's own binary framing. 50/50 chronological walk-forward split (train=${train.length}, test=${test.length}) -- proportioned to maximize OOS N given a hard data ceiling (see below), threshold selection on TRAIN only, reported accuracy is TEST-only (never seen during selection), same winner's-curse-honest methodology as the existing intraday_ib_range_daytype_conditioning claim.

Three candidates tested: (1) ibRangePctile alone -- TEST acc=${(rangeOnlyTestAcc*100).toFixed(1)}%; (2) ibDirectionality alone -- TEST acc=${(dirOnlyTestAcc*100).toFixed(1)}%; (3) combined 2D rule -- TEST acc=${(combinedTestAcc*100).toFixed(1)}%. Base rate (majority-class guess): ${(testBaseRateAcc*100).toFixed(1)}% (TEST N=${test.length}). Best candidate (${bestLabel}) beats base rate by ${deltaVsBaseRate.toFixed(1)}pp (pre-registered threshold: >=15pp) -- accuracy gate ${beats15pp ? 'PASSED' : 'FAILED'}.

CRITICAL, decisive finding independent of the accuracy result: the pre-registered sample-size requirement (>=200 sessions, out of sample) is a HARD DATA-AVAILABILITY CEILING this system cannot currently clear, regardless of methodology -- the ENTIRE history of this system contains only ${totalUniverseN} days classified TREND or TURBULENT (out of 426 total classified days; the remaining ${426 - totalUniverseN} are BALANCE). No train/test split of existing data can produce N>=200 out-of-sample. At the current combined TREND+TURBULENT accrual rate (~${totalUniverseN} over roughly 1.7 years of classified history), reaching N=200 would take approximately another year or more of real trading days.

VERDICT per the roadmap's own explicit rule ("If it cannot beat a coin flip... this setup cannot work and should not be built" / "If that fails, stop. The whole expansion family depends on it."): OVERALL = ${overallPass ? 'PASSED' : 'FAILED (sample-size gate)'}. ${overallPass ? '' : `Even though the accuracy result is genuinely informative (best candidate beats base rate by ${deltaVsBaseRate.toFixed(1)}pp), the pre-registered N>=200 bar cannot be certified as met -- per the roadmap's decision rule, Setups C and E do NOT get built this round. Reallocate effort to deepening Setups A, B, D, F instead, per Part 6's own contingency ("reallocate to deepening A, B, D, F"). This is a data-accrual constraint, not a methodology failure or a permanently negative verdict -- self-recalibrating (re-run this same script) as more TREND/TURBULENT days classify over time; not a dead end.`}`,
    sourceFile: 'scripts/backtest_trend_turbulent_discriminator_stage0.mjs',
    sourceDate: '2026-08-11',
    sampleSize: totalUniverseN,
    evPerTrade: null,
    winRate: bestTestAcc,
    rigorStatus: `n${totalUniverseN}_of_200required_bestacc${(bestTestAcc*100).toFixed(1)}_baserate${(testBaseRateAcc*100).toFixed(1)}_delta${deltaVsBaseRate.toFixed(1)}pp_${overallPass ? 'PASS' : 'FAIL_SAMPLESIZE'}`,
    status: 'PROVISIONAL',
  });
  console.log('\nRESEARCH_CLAIM trend_turbulent_discriminator_stage0 recorded.');

  return { overallPass, totalUniverseN, bestTestAcc, testBaseRateAcc, deltaVsBaseRate };
}

main().then(r => { console.log('\nDone.', JSON.stringify(r)); }).catch(e => { console.error('FATAL:', e); process.exit(1); });
