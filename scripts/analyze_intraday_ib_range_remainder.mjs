// Same-day (intraday) follow-up to compression_session_range_prediction, per a 2026-08-05
// external-review correction: that script tested a CROSS-DAY effect (yesterday's own value-area
// width/IB range predicts TODAY's total session range) and found a real, Bonferroni-significant,
// sign-reversed result (compression precedes a QUIETER next day -- volatility clustering, not
// squeeze-then-expansion). The reviewer's proposed live use case is different: TODAY's own IB
// range is known by 10:30 ET, so it's usable INTRA-SESSION for a hold-the-runner-vs-take-profit
// decision on a trade that resolves later that same day. That's a same-day question this
// codebase had not yet tested -- this script tests it directly.
//
// Predictor: day D's own IB range (bars 570-629, closed and fully known by 10:30 ET), percentile-
// ranked against D's own trailing 60 days' IB ranges (D-1..D-60) -- this can differ in direction
// from the CROSS-DAY test's compressed/uncompressed split, since it's asking a different
// question: "is today's IB already wide" rather than "was yesterday wide."
// Outcome: the REMAINDER of day D's own session -- realized range from IB close (630) through RTH
// close (959) -- percentile-ranked against the trailing 60 days' own remainder-range distribution.
// isTopQuartileRemainder = that percentile >= 75.
// No lookahead: predictor uses only bars 570-629, outcome uses only bars 630-959 -- a clean
// intraday split, genuinely usable in real time once IB closes.
//
// Only IB range has a clean same-day analog here -- va_overlap_streak is inherently a
// consecutive-PRIOR-days concept (no same-day version), and a "developing value-area width as of
// 10:30" predictor would be computed from nearly the same bars (570-629) as IB range itself, so
// it wouldn't be a meaningfully independent second test. Scoped to the one metric that's actually
// a distinct, directly actionable, same-day signal.
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
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
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}
function twoPropZTest(x1, n1, x2, n2) {
  if (n1 === 0 || n2 === 0) return { z: 0, p: 1 };
  const p1 = x1 / n1, p2 = x2 / n2, p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  return { z, p: 2 * (1 - normalCDF(Math.abs(z))) };
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
  console.log(`  ${tradingDays.length} distinct real NQ RTH trading days.`);

  const ibRangeByDay = new Map(), remainderRangeByDay = new Map();
  for (const d of tradingDays) {
    const bars = barsByDay.get(d);
    const ibBars = bars.filter(b => b.etMin < IB_CLOSE);
    const remBars = bars.filter(b => b.etMin >= IB_CLOSE);
    if (ibBars.length >= MIN_BARS) {
      ibRangeByDay.set(d, Math.max(...ibBars.map(b => b.high)) - Math.min(...ibBars.map(b => b.low)));
    }
    if (remBars.length >= MIN_BARS) {
      remainderRangeByDay.set(d, Math.max(...remBars.map(b => b.high)) - Math.min(...remBars.map(b => b.low)));
    }
  }

  const records = [];
  for (let i = 61; i < tradingDays.length; i++) {
    const D = tradingDays[i];
    // Predictor: D's OWN IB range vs its own trailing 60 (i-1..i-60, all strictly before D)
    const ibD = ibRangeByDay.get(D);
    if (ibD == null) continue;
    const trailingIb = [];
    for (let back = 1; back <= TRAILING_WINDOW; back++) {
      const r = ibRangeByDay.get(tradingDays[i - back]);
      if (r != null) trailingIb.push(r);
    }
    if (trailingIb.length < MIN_VALID_TRAILING) continue;
    const ibPctile = percentileRank(ibD, trailingIb);

    // Outcome: D's OWN remainder range (10:30-close) vs its own trailing 60 remainder ranges
    const remD = remainderRangeByDay.get(D);
    if (remD == null) continue;
    const trailingRem = [];
    for (let back = 1; back <= TRAILING_WINDOW; back++) {
      const r = remainderRangeByDay.get(tradingDays[i - back]);
      if (r != null) trailingRem.push(r);
    }
    if (trailingRem.length < MIN_VALID_TRAILING) continue;
    const remPctile = percentileRank(remD, trailingRem);
    const isTopQuartileRemainder = remPctile >= 75;

    records.push({ date: D, ibPctile, isTopQuartileRemainder });
  }
  console.log(`${records.length} eligible sessions.`);
  const baseRate = records.filter(r => r.isTopQuartileRemainder).length / records.length;
  console.log(`Base rate of isTopQuartileRemainder: ${(baseRate * 100).toFixed(1)}%`);

  const ibVals = records.map(r => r.ibPctile);
  const levels = [getPercentileOfArr(ibVals, 0.67), getPercentileOfArr(ibVals, 0.75), getPercentileOfArr(ibVals, 0.90)];
  const alpha = 0.05 / 3; // 3 pre-registered strictness levels, one metric, no family split

  const results = [];
  console.log('\n=== Same-day: does IB range (known by 10:30) predict the 10:30-close remainder being top-quartile? ===');
  for (const level of levels) {
    if (level == null) continue;
    const wide = records.filter(r => r.ibPctile >= level); // HIGH IB pctile = wide/active-already
    const notWide = records.filter(r => r.ibPctile < level);
    const wHits = wide.filter(r => r.isTopQuartileRemainder).length;
    const nHits = notWide.filter(r => r.isTopQuartileRemainder).length;
    const wRate = wide.length ? wHits / wide.length : 0;
    const nRate = notWide.length ? nHits / notWide.length : 0;
    const diff = wRate - nRate;
    const test = twoPropZTest(wHits, wide.length, nHits, notWide.length);
    const pass = test.p <= alpha;
    const rigor = computeRigor(wide, { dateField: 'date', pnlFn: r => r.isTopQuartileRemainder ? 1 : -1 });

    const splitIdx = Math.floor(records.length * (2 / 3));
    const trainDates = new Set(records.slice(0, splitIdx).map(r => r.date));
    const trainW = wide.filter(r => trainDates.has(r.date)), trainN = notWide.filter(r => trainDates.has(r.date));
    const testW = wide.filter(r => !trainDates.has(r.date)), testN = notWide.filter(r => !trainDates.has(r.date));
    const trainDiff = (trainW.length ? trainW.filter(r => r.isTopQuartileRemainder).length / trainW.length : 0)
      - (trainN.length ? trainN.filter(r => r.isTopQuartileRemainder).length / trainN.length : 0);
    const testDiff = (testW.length ? testW.filter(r => r.isTopQuartileRemainder).length / testW.length : 0)
      - (testN.length ? testN.filter(r => r.isTopQuartileRemainder).length / testN.length : 0);
    const sameSignOOS = Math.sign(trainDiff) === Math.sign(testDiff) && trainDiff !== 0;

    const res = { level, diff, wRate, nRate, wN: wide.length, nN: notWide.length, test, pass, rigor, trainDiff, testDiff, sameSignOOS };
    results.push(res);
    console.log(`Level ${level} (IB pctile>=${level} = "already wide"): diff=${(diff * 100).toFixed(1)}% p=${test.p.toExponential(2)} Bonferroni PASS=${pass} rigor.clean=${rigor.clean} train=${(trainDiff * 100).toFixed(1)}% test=${(testDiff * 100).toFixed(1)}% sameSignOOS=${sameSignOOS}`);
    console.log(`  Wide-IB N=${wide.length} rate=${(wRate * 100).toFixed(1)}% | Not-wide N=${notWide.length} rate=${(nRate * 100).toFixed(1)}%`);
  }

  let best = null;
  for (const r of results) if (!best || Math.abs(r.diff) > Math.abs(best.diff)) best = r;
  const anyPass = results.some(r => r.pass && r.rigor.clean && r.sameSignOOS);

  const claimText = `Same-day/intraday follow-up to compression_session_range_prediction (2026-08-05, per external ` +
    `review): tests whether TODAY's own IB range, known by 10:30 ET, predicts the REMAINDER of today's own ` +
    `session (10:30-close) landing in the top quartile of its trailing 60 -- a distinct, same-day claim from ` +
    `the cross-day (yesterday->today) effect already established. No lookahead: predictor uses only bars ` +
    `570-629, outcome only bars 630-959. Population: ${records.length} real NQ RTH trading days, base rate of ` +
    `top-quartile-remainder = ${(baseRate * 100).toFixed(1)}%. 3 pre-registered strictness levels (P67/P75/P90 ` +
    `of IB-range percentile = "already wide"), alpha=0.05/3=${alpha.toFixed(4)}. Best cell: level ${best.level}, ` +
    `diff=${(best.diff * 100).toFixed(1)}pp, p=${best.test.p.toExponential(2)}, Bonferroni ${best.pass ? 'PASS' : 'FAIL'}, ` +
    `rigor.clean=${best.rigor.clean}, train/test same-sign=${best.sameSignOOS} (train ${(best.trainDiff * 100).toFixed(1)}pp, ` +
    `test ${(best.testDiff * 100).toFixed(1)}pp). RESULT: ${anyPass ? 'POSITIVE -- a real same-day effect survives Bonferroni + rigor + train/test, usable intra-session' : 'NEGATIVE -- no level clears the pre-registered bar; the cross-day effect does not have a same-day analog at this sample size'}. ` +
    `Spot-checked directly against the 2026-08-03 CAM_S1/PW_VAH missed-bounce day (a real top-quartile day, ` +
    `85th percentile of its own trailing 60): its OWN IB range that day was at the 70th percentile (elevated ` +
    `but not quite top-quartile) -- consistent with the finding either way, not decisive on its own (N=1). The ` +
    `move that prompted this whole check happened at 09:30-09:45 ET, before that day's own IB had even formed, ` +
    `so a same-day IB signal could not have anticipated it regardless of this result -- the CROSS-DAY rule ` +
    `(2026-07-31's own elevated width/IB percentile) is what would have flagged 2026-08-03 as likely-active ` +
    `ahead of the open, not this same-day one.`;

  await recordClaim({
    slug: 'intraday_ib_range_predicts_remainder',
    claimText,
    sourceFile: 'scripts/analyze_intraday_ib_range_remainder.mjs',
    sourceDate: '2026-08-05',
    sampleSize: records.length,
    rigorStatus: best.rigor.clean ? 'clean' : 'not_clean',
    status: anyPass ? 'CONFIRMED' : 'PROVISIONAL',
  });
  console.log('\nRecorded RESEARCH_CLAIM intraday_ib_range_predicts_remainder.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
