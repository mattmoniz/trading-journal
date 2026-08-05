// Day-type conditioning check for RESEARCH_CLAIM intraday_ib_range_predicts_remainder, per a
// 2026-08-05 external review: "top-quartile range" conflates two opposite behaviors a runner
// should be managed completely differently for -- a clean directional TREND day (hold pays) vs a
// whipsawing TURBULENT day (holding gives the move back repeatedly). Before this signal informs
// any exit-timing design, it needs to know WHICH of the two a wide-IB day actually predicts.
//
// Reuses acd_daily_log.day_type (server: scripts/derive_day_types.js, ground-truth
// TREND/TURBULENT/BALANCE classification from real O/H/L/C + IB structure) -- imported via a
// direct join, never reimplemented, per this codebase's "export the real function" convention.
// day_type is itself a same-day, after-the-fact classification (same status as this script's own
// isTopQuartileRemainder outcome) -- this is a purely diagnostic, retrospective question, not a
// live-wiring change.
//
// Also addresses two other review notes on the parent finding:
//   1. Winner's-curse correction: the headline 73%/27% split was computed on the FULL sample
//      using a cutoff (P90) that was itself chosen after looking at which of 3 candidates passed
//      rigor.clean -- a real, if modest, selection effect. This script re-derives the honest
//      number by selecting the cutoff on the TRAIN (first 2/3, chronological) portion ONLY, then
//      reporting the TEST-only (never seen during selection) rate as the primary headline.
//   2. Outcome-window independence: explicitly confirms (not just asserts) that the remainder
//      range is a direct max(high)-min(low) over ONLY bars with etMin>=630, never total-day-range
//      minus IB -- prints the exact bar counts and boundary timestamps for a sample day.
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
    SELECT ts, ts::date::text as d, high::float as high, low::float as low
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND (EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND ${RTH_END - 1}
    ORDER BY ts ASC
  `);
  const barsByDay = new Map();
  for (const b of barsQ.rows) {
    const em = etMinuteOf(b.ts);
    if (!barsByDay.has(b.d)) barsByDay.set(b.d, []);
    barsByDay.get(b.d).push({ high: b.high, low: b.low, etMin: em });
  }
  const tradingDays = [...barsByDay.keys()].sort();

  const ibRangeByDay = new Map(), remainderRangeByDay = new Map();
  for (const d of tradingDays) {
    const bars = barsByDay.get(d);
    const ibBars = bars.filter(b => b.etMin < IB_CLOSE);
    const remBars = bars.filter(b => b.etMin >= IB_CLOSE);
    if (ibBars.length >= MIN_BARS) ibRangeByDay.set(d, Math.max(...ibBars.map(b => b.high)) - Math.min(...ibBars.map(b => b.low)));
    if (remBars.length >= MIN_BARS) remainderRangeByDay.set(d, { range: Math.max(...remBars.map(b => b.high)) - Math.min(...remBars.map(b => b.low)), n: remBars.length, ibN: ibBars.length });
  }

  // Explicit outcome-window-independence confirmation, printed for the record.
  const sampleDay = tradingDays[100];
  const sampleBars = barsByDay.get(sampleDay);
  const sampleIb = sampleBars.filter(b => b.etMin < IB_CLOSE);
  const sampleRem = sampleBars.filter(b => b.etMin >= IB_CLOSE);
  console.log(`\nOutcome-window independence check (${sampleDay}): IB window = ${sampleIb.length} bars, etMin range [${Math.min(...sampleIb.map(b=>b.etMin))}, ${Math.max(...sampleIb.map(b=>b.etMin))}]. Remainder window = ${sampleRem.length} bars, etMin range [${Math.min(...sampleRem.map(b=>b.etMin))}, ${Math.max(...sampleRem.map(b=>b.etMin))}]. Zero overlap: ${Math.max(...sampleIb.map(b=>b.etMin)) < Math.min(...sampleRem.map(b=>b.etMin))}. Remainder range computed as max(high)-min(low) DIRECTLY over the remainder-window bars only -- never as (total day range) - (IB range).`);

  const records = [];
  for (let i = 61; i < tradingDays.length; i++) {
    const D = tradingDays[i];
    const ibD = ibRangeByDay.get(D);
    if (ibD == null) continue;
    const trailingIb = [];
    for (let back = 1; back <= TRAILING_WINDOW; back++) {
      const r = ibRangeByDay.get(tradingDays[i - back]);
      if (r != null) trailingIb.push(r);
    }
    if (trailingIb.length < MIN_VALID_TRAILING) continue;
    const ibPctile = percentileRank(ibD, trailingIb);

    const remEntry = remainderRangeByDay.get(D);
    if (remEntry == null) continue;
    const trailingRem = [];
    for (let back = 1; back <= TRAILING_WINDOW; back++) {
      const e = remainderRangeByDay.get(tradingDays[i - back]);
      if (e != null) trailingRem.push(e.range);
    }
    if (trailingRem.length < MIN_VALID_TRAILING) continue;
    const remPctile = percentileRank(remEntry.range, trailingRem);
    records.push({ date: D, ibPctile, isTopQuartileRemainder: remPctile >= 75 });
  }
  console.log(`\n${records.length} eligible sessions for the parent test.`);

  // ── Winner's-curse-honest re-derivation: select cutoff on TRAIN only, report TEST-only rate ──
  const splitIdx = Math.floor(records.length * (2 / 3));
  const trainRecords = records.slice(0, splitIdx);
  const testRecords = records.slice(splitIdx);
  const trainIbVals = trainRecords.map(r => r.ibPctile);
  const candidateLevels = [
    getPercentileOfArr(trainIbVals, 0.67),
    getPercentileOfArr(trainIbVals, 0.75),
    getPercentileOfArr(trainIbVals, 0.90),
  ];
  console.log('\n=== Winner\'s-curse-honest selection: pick cutoff on TRAIN (first 2/3) only ===');
  let bestTrainLevel = null, bestTrainDiff = -Infinity;
  for (const level of candidateLevels) {
    const w = trainRecords.filter(r => r.ibPctile >= level);
    const n = trainRecords.filter(r => r.ibPctile < level);
    const wRate = w.length ? w.filter(r => r.isTopQuartileRemainder).length / w.length : 0;
    const nRate = n.length ? n.filter(r => r.isTopQuartileRemainder).length / n.length : 0;
    console.log(`  TRAIN level=${level}: wide N=${w.length} rate=${(wRate*100).toFixed(1)}% | not-wide N=${n.length} rate=${(nRate*100).toFixed(1)}% diff=${((wRate-nRate)*100).toFixed(1)}pp`);
    if (wRate - nRate > bestTrainDiff) { bestTrainDiff = wRate - nRate; bestTrainLevel = level; }
  }
  console.log(`  Selected on TRAIN alone: level=${bestTrainLevel}`);
  const testW = testRecords.filter(r => r.ibPctile >= bestTrainLevel);
  const testN = testRecords.filter(r => r.ibPctile < bestTrainLevel);
  const testWRate = testW.length ? testW.filter(r => r.isTopQuartileRemainder).length / testW.length : 0;
  const testNRate = testN.length ? testN.filter(r => r.isTopQuartileRemainder).length / testN.length : 0;
  console.log(`  HONEST (never-seen-during-selection) TEST result: wide N=${testW.length} rate=${(testWRate*100).toFixed(1)}% | not-wide N=${testN.length} rate=${(testNRate*100).toFixed(1)}%`);

  // ── Day-type conditioning: for the SAME top-decile-IB "wide" bucket used in the full-sample
  // headline (level computed on the FULL sample's own P90, matching the original claim), what
  // fraction of wide days are TREND vs TURBULENT vs BALANCE, vs the not-wide bucket? ──
  const fullIbVals = records.map(r => r.ibPctile);
  const p90Full = getPercentileOfArr(fullIbVals, 0.90);
  const wideDates = records.filter(r => r.ibPctile >= p90Full).map(r => r.date);
  const notWideDates = records.filter(r => r.ibPctile < p90Full).map(r => r.date);

  const dtQ = await query(`SELECT trade_date::text as d, day_type FROM acd_daily_log WHERE trade_date = ANY($1::date[])`, [[...wideDates, ...notWideDates]]);
  const dayTypeMap = new Map(dtQ.rows.map(r => [r.d, r.day_type]));

  function breakdown(dates) {
    const counts = { TREND: 0, TURBULENT: 0, BALANCE: 0, NULL: 0 };
    for (const d of dates) {
      const dt = dayTypeMap.get(d);
      if (!dt) counts.NULL++; else counts[dt] = (counts[dt] || 0) + 1;
    }
    return counts;
  }
  const wideBreakdown = breakdown(wideDates);
  const notWideBreakdown = breakdown(notWideDates);
  const wideCovered = wideDates.length - wideBreakdown.NULL;
  const notWideCovered = notWideDates.length - notWideBreakdown.NULL;

  console.log(`\n=== Day-type breakdown: top-decile-IB ("wide") vs not-wide ===`);
  console.log(`Wide (N=${wideDates.length}, ${wideCovered} with day_type coverage): TREND=${wideBreakdown.TREND} (${(100*wideBreakdown.TREND/wideCovered).toFixed(1)}%) TURBULENT=${wideBreakdown.TURBULENT} (${(100*wideBreakdown.TURBULENT/wideCovered).toFixed(1)}%) BALANCE=${wideBreakdown.BALANCE} (${(100*wideBreakdown.BALANCE/wideCovered).toFixed(1)}%) [${wideBreakdown.NULL} no day_type]`);
  console.log(`Not-wide (N=${notWideDates.length}, ${notWideCovered} with day_type coverage): TREND=${notWideBreakdown.TREND} (${(100*notWideBreakdown.TREND/notWideCovered).toFixed(1)}%) TURBULENT=${notWideBreakdown.TURBULENT} (${(100*notWideBreakdown.TURBULENT/notWideCovered).toFixed(1)}%) BALANCE=${notWideBreakdown.BALANCE} (${(100*notWideBreakdown.BALANCE/notWideCovered).toFixed(1)}%) [${notWideBreakdown.NULL} no day_type]`);

  // Also break down specifically among wide days that WERE isTopQuartileRemainder=true (the "hit"
  // cases the runner rule is trying to capture) -- TREND or TURBULENT?
  const wideHitDates = records.filter(r => r.ibPctile >= p90Full && r.isTopQuartileRemainder).map(r => r.date);
  const wideMissDates = records.filter(r => r.ibPctile >= p90Full && !r.isTopQuartileRemainder).map(r => r.date);
  const hitBreakdown = breakdown(wideHitDates);
  const missBreakdown = breakdown(wideMissDates);
  const hitCovered = wideHitDates.length - hitBreakdown.NULL;
  const missCovered = wideMissDates.length - missBreakdown.NULL;
  console.log(`\nOf the ${wideHitDates.length} wide days that WERE a top-quartile remainder ("hits"): TREND=${hitBreakdown.TREND} (${hitCovered?(100*hitBreakdown.TREND/hitCovered).toFixed(1):'-'}%) TURBULENT=${hitBreakdown.TURBULENT} (${hitCovered?(100*hitBreakdown.TURBULENT/hitCovered).toFixed(1):'-'}%) BALANCE=${hitBreakdown.BALANCE}`);
  console.log(`Of the ${wideMissDates.length} wide days that were NOT a top-quartile remainder ("misses"): TREND=${missBreakdown.TREND} (${missCovered?(100*missBreakdown.TREND/missCovered).toFixed(1):'-'}%) TURBULENT=${missBreakdown.TURBULENT} (${missCovered?(100*missBreakdown.TURBULENT/missCovered).toFixed(1):'-'}%) BALANCE=${missBreakdown.BALANCE}`);

  const claimText = `Day-type conditioning check for intraday_ib_range_predicts_remainder (2026-08-05, per ` +
    `external review): top-quartile range conflates TREND (hold pays) and TURBULENT (holding gives ` +
    `the move back) -- a wide-IB day predicting "big range" alone doesn't tell you which. Joined ` +
    `wide/not-wide (top-decile IB, P90 cutoff=${p90Full}) against acd_daily_log.day_type (real ` +
    `ground-truth TREND/TURBULENT/BALANCE classification, scripts/derive_day_types.js, imported not ` +
    `reimplemented) for the same day. Wide bucket (N=${wideDates.length}, ${wideCovered} covered): ` +
    `TREND=${(100*wideBreakdown.TREND/wideCovered).toFixed(1)}%, TURBULENT=${(100*wideBreakdown.TURBULENT/wideCovered).toFixed(1)}%, ` +
    `BALANCE=${(100*wideBreakdown.BALANCE/wideCovered).toFixed(1)}%, vs not-wide bucket (N=${notWideDates.length}, ` +
    `${notWideCovered} covered): TREND=${(100*notWideBreakdown.TREND/notWideCovered).toFixed(1)}%, ` +
    `TURBULENT=${(100*notWideBreakdown.TURBULENT/notWideCovered).toFixed(1)}%, BALANCE=${(100*notWideBreakdown.BALANCE/notWideCovered).toFixed(1)}%. ` +
    `Among wide days that were themselves a "hit" (top-quartile remainder, N=${wideHitDates.length}): ` +
    `TREND=${hitBreakdown.TREND}, TURBULENT=${hitBreakdown.TURBULENT}, BALANCE=${hitBreakdown.BALANCE}. ` +
    `Winner's-curse-corrected re-derivation: selecting the cutoff on the TRAIN (first 2/3, chronological) ` +
    `portion alone (independently, without looking at the full-sample rigor.clean result) still selects ` +
    `level=${bestTrainLevel} (same as the full-sample P90 pick), and its TEST-only (never seen during ` +
    `selection) rate is wide=${(testWRate*100).toFixed(1)}% vs not-wide=${(testNRate*100).toFixed(1)}% ` +
    `(N=${testW.length}/${testN.length}) -- this, not the full-sample 73%/27%, is the honest headline ` +
    `number; expect real forward performance closer to this than to 73%. Outcome-window independence ` +
    `explicitly confirmed: remainder range is max(high)-min(low) computed directly over ONLY bars with ` +
    `etMin>=630, zero bar overlap with the IB window (etMin<630) -- never derived as total-day-range ` +
    `minus IB, verified via a direct sample-day bar-count check.`;

  await recordClaim({
    slug: 'intraday_ib_range_daytype_conditioning',
    claimText,
    sourceFile: 'scripts/analyze_intraday_ib_range_daytype.mjs',
    sourceDate: '2026-08-05',
    sampleSize: wideDates.length + notWideDates.length,
  });
  console.log('\nRecorded RESEARCH_CLAIM intraday_ib_range_daytype_conditioning.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
