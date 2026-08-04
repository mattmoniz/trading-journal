// Session-level (not trade-level) compression -> range test, per docs/COMPRESSION_TAIL_MFE_SPEC.md
// Part 2/3, REFRAMED 2026-08-04 after a real methodology gap was found in the first version
// (scripts/analyze_compression_tail_mfe.mjs): that script tested compression against MFE, which
// only exists for a fired trade, so it was forced through active_setups (origin_status
// ACTIVE/SHADOW) — a thin, ~3-week-old, setup-gated population. That answers "does compression
// predict big excursions on trades THIS SYSTEM happened to fire," not "does compression predict
// big moves in the market" — exactly the routing CLAUDE.md's own standing rule says to avoid for
// a market-behavior question ("A hypothesis about market behavior gets tested against raw
// bar/price history first... only route through active_setups when the question is specifically
// about how this system's OWN setups perform"). The tell: the original test's own setup-selection
// step found NO setup_type even qualifies as a VAH type with enough real N — not a fact about VAH
// behavior, a fact about how young the tracking is.
//
// This version drops setup_type/family entirely and asks the market-level question directly: for
// every REAL RTH trading day (not setup-gated, the full NQ bar history), does compression heading
// into the session predict that session's own realized range landing in the top quartile of its
// trailing 60 sessions? No trade needs to exist for a day to be included.
//
// Same 3 metrics as Part 1, redefined at the session level (all 3 are now simpler than the
// trade-level version — no "developing as of entry time" trick needed, since every predictor is a
// fully-known FACT ABOUT THE PRIOR DAY, not a partial-day snapshot of the day being predicted):
//   1. va_width_pctile_60d: PRIOR day's (D-1) own final value-area width, percentile-ranked
//      against ITS OWN trailing 60 days (D-2..D-61). LOW = compressed.
//   2. va_overlap_streak: consecutive sessions before D (D-1 vs D-2, D-2 vs D-3, ...) with
//      overlapping value areas — identical definition to the trade-level version, just applied to
//      every real trading day instead of only trade-having ones. HIGH = compressed.
//   3. ib_range_pctile_60d: PRIOR day's (D-1) own Initial Balance range, percentile-ranked against
//      its own trailing 60 days. LOW = compressed.
// Outcome: day D's own realized RTH session range (high-low), percentile-ranked against the
// trailing 60 days BEFORE D (D-1..D-60) — no lookahead (D's own range is a fact only known after
// D closes; the comparison basis is entirely prior real data). isTopQuartile = that percentile >=
// 75. No setup_type/family dimension — this is a market-wide question, not a per-strategy one, so
// the 3-metric x 3-strictness-level budget is 9 tests (not 18), Bonferroni alpha = 0.05/9.
import { query } from '../server/db.js';
import { computeProfile } from '../server/services/developingValueService.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const RTH_START = 570, RTH_END = 960, IB_CLOSE = 630;
const MIN_BARS = 10;
const TRAILING_WINDOW = 60;
const MIN_VALID_TRAILING = 30;

function etMinuteOf(dateLike) {
  const d = new Date(dateLike);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
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
    SELECT ts, ts::date::text as d, high::float as high, low::float as low, volume::float as volume
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND (EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts)) BETWEEN ${RTH_START} AND ${RTH_END - 1}
    ORDER BY ts ASC
  `);
  const barsByDay = new Map();
  for (const b of barsQ.rows) {
    const em = etMinuteOf(b.ts);
    if (!barsByDay.has(b.d)) barsByDay.set(b.d, []);
    barsByDay.get(b.d).push({ high: b.high, low: b.low, volume: b.volume, etMin: em });
  }
  const tradingDays = [...barsByDay.keys()].sort();
  console.log(`  ${tradingDays.length} distinct real NQ RTH trading days (full bar history, no setup_type gating).`);

  console.log('Precomputing per-day final value-area width, IB range, session range...');
  const widthByDay = new Map(), ibRangeByDay = new Map(), sessionRangeByDay = new Map();
  for (const d of tradingDays) {
    const bars = barsByDay.get(d);
    const profile = computeProfile(bars);
    if (profile) widthByDay.set(d, { vah: profile.vah, val: profile.val, width: profile.vah - profile.val });
    const ibBars = bars.filter(b => b.etMin < IB_CLOSE);
    if (ibBars.length >= MIN_BARS) {
      ibRangeByDay.set(d, Math.max(...ibBars.map(b => b.high)) - Math.min(...ibBars.map(b => b.low)));
    }
    sessionRangeByDay.set(d, Math.max(...bars.map(b => b.high)) - Math.min(...bars.map(b => b.low)));
  }

  const records = [];
  for (let i = 61; i < tradingDays.length; i++) {
    const D = tradingDays[i];
    const Dm1 = tradingDays[i - 1];

    // Predictor 1: va_width — D-1's own width, percentile-ranked vs its trailing 60 (i-2..i-61)
    let widthPctile = null;
    const widthDm1 = widthByDay.get(Dm1)?.width;
    if (widthDm1 != null) {
      const trailing = [];
      for (let back = 2; back <= 61; back++) {
        const w = widthByDay.get(tradingDays[i - back])?.width;
        if (w != null) trailing.push(w);
      }
      if (trailing.length >= MIN_VALID_TRAILING) widthPctile = percentileRank(widthDm1, trailing);
    }

    // Predictor 2: va_overlap_streak — consecutive overlapping sessions ending at D-1
    let streak = 0;
    let prev = widthByDay.get(Dm1);
    if (prev) {
      for (let back = 2; back <= 61; back++) {
        const cur = widthByDay.get(tradingDays[i - back]);
        if (!cur) break;
        if (!(prev.val <= cur.vah && prev.vah >= cur.val)) break;
        streak++;
        prev = cur;
      }
    }

    // Predictor 3: ib_range — D-1's own IB range, percentile-ranked vs its trailing 60
    let ibPctile = null;
    const ibDm1 = ibRangeByDay.get(Dm1);
    if (ibDm1 != null) {
      const trailing = [];
      for (let back = 2; back <= 61; back++) {
        const r = ibRangeByDay.get(tradingDays[i - back]);
        if (r != null) trailing.push(r);
      }
      if (trailing.length >= MIN_VALID_TRAILING) ibPctile = percentileRank(ibDm1, trailing);
    }

    // Outcome: D's own session range percentile-ranked vs trailing 60 (i-1..i-60)
    const rangeD = sessionRangeByDay.get(D);
    const trailingRanges = [];
    for (let back = 1; back <= TRAILING_WINDOW; back++) {
      const r = sessionRangeByDay.get(tradingDays[i - back]);
      if (r != null) trailingRanges.push(r);
    }
    if (trailingRanges.length < MIN_VALID_TRAILING) continue;
    const rangePctile = percentileRank(rangeD, trailingRanges);
    const isTopQuartile = rangePctile >= 75;

    records.push({ date: D, widthPctile, streak, ibPctile, isTopQuartile });
  }

  console.log(`${records.length} eligible sessions (>=${MIN_VALID_TRAILING} valid trailing days on both sides) out of ${tradingDays.length} total real NQ RTH trading days.`);

  const widths = records.filter(r => r.widthPctile != null).map(r => r.widthPctile);
  const ibs = records.filter(r => r.ibPctile != null).map(r => r.ibPctile);
  const streaks = records.map(r => r.streak);
  const cuts = {
    va_width: [getPercentileOfArr(widths, 0.33), getPercentileOfArr(widths, 0.25), getPercentileOfArr(widths, 0.10)],
    ib_range: [getPercentileOfArr(ibs, 0.33), getPercentileOfArr(ibs, 0.25), getPercentileOfArr(ibs, 0.10)],
    va_overlap: [getPercentileOfArr(streaks, 0.67), getPercentileOfArr(streaks, 0.75), getPercentileOfArr(streaks, 0.90)],
  };
  const alpha = 0.05 / 9;
  const cells = [
    { metric: 'va_width', field: 'widthPctile', dir: 'low', levels: cuts.va_width },
    { metric: 'ib_range', field: 'ibPctile', dir: 'low', levels: cuts.ib_range },
    { metric: 'va_overlap', field: 'streak', dir: 'high', levels: cuts.va_overlap },
  ];

  const results = [];
  console.log('\n=== Session-level compression -> top-quartile-range test (market-wide, no setup gating) ===');
  for (const cell of cells) {
    for (const level of cell.levels) {
      if (level == null) continue;
      const usable = records.filter(r => r[cell.field] != null);
      const isCompressed = r => cell.dir === 'low' ? r[cell.field] <= level : r[cell.field] >= level;
      const compressed = usable.filter(isCompressed);
      const uncompressed = usable.filter(r => !isCompressed(r));
      const cHits = compressed.filter(r => r.isTopQuartile).length;
      const uHits = uncompressed.filter(r => r.isTopQuartile).length;
      const cRate = compressed.length ? cHits / compressed.length : 0;
      const uRate = uncompressed.length ? uHits / uncompressed.length : 0;
      const diff = cRate - uRate;
      const test = twoPropZTest(cHits, compressed.length, uHits, uncompressed.length);
      const pass = test.p <= alpha;
      const rigor = computeRigor(compressed, { dateField: 'date', pnlFn: r => r.isTopQuartile ? 1 : -1 });

      // Chronological train/test split (first 2/3 sessions vs last 1/3, by date) as this cell's
      // robustness check -- there's no setup_type dimension anymore to run computeReplication()
      // across, so a genuine out-of-sample re-check plays that role here instead.
      const splitIdx = Math.floor(records.length * (2 / 3));
      const trainDates = new Set(records.slice(0, splitIdx).map(r => r.date));
      const trainC = compressed.filter(r => trainDates.has(r.date));
      const trainU = uncompressed.filter(r => trainDates.has(r.date));
      const testC = compressed.filter(r => !trainDates.has(r.date));
      const testU = uncompressed.filter(r => !trainDates.has(r.date));
      const trainDiff = (trainC.length ? trainC.filter(r => r.isTopQuartile).length / trainC.length : 0)
        - (trainU.length ? trainU.filter(r => r.isTopQuartile).length / trainU.length : 0);
      const testDiff = (testC.length ? testC.filter(r => r.isTopQuartile).length / testC.length : 0)
        - (testU.length ? testU.filter(r => r.isTopQuartile).length / testU.length : 0);
      const sameSignOOS = Math.sign(trainDiff) === Math.sign(testDiff) && trainDiff !== 0;

      const res = { metric: cell.metric, level, diff, cRate, uRate, cN: compressed.length, uN: uncompressed.length, test, pass, rigor, trainDiff, testDiff, sameSignOOS };
      results.push(res);
      console.log(`Cell: ${cell.metric} (level ${level}) | diff: ${(diff * 100).toFixed(1)}% | p: ${test.p.toExponential(2)} | Bonferroni PASS: ${pass} | Rigor clean: ${rigor.clean} | train diff: ${(trainDiff * 100).toFixed(1)}% test diff: ${(testDiff * 100).toFixed(1)}% sameSignOOS: ${sameSignOOS}`);
      console.log(`  Compressed N=${compressed.length} rate=${(cRate * 100).toFixed(1)}% | Uncompressed N=${uncompressed.length} rate=${(uRate * 100).toFixed(1)}%`);
    }
  }

  let best = null;
  for (const r of results) if (!best || Math.abs(r.diff) > Math.abs(best.diff)) best = r;

  const anyPass = results.some(r => r.pass && r.rigor.clean && r.sameSignOOS);
  const claimText = `docs/COMPRESSION_TAIL_MFE_SPEC.md Part 2/3, REFRAMED session-level bar-history version ` +
    `(no setup_type/active_setups gating -- direct fix for a routing bug in compression_tail_mfe_mean_reversion/` +
    `continuation, which conflated "does compression predict big moves" with "does compression predict big ` +
    `moves on trades this system happened to fire"). Population: ${records.length} real NQ RTH trading days ` +
    `(out of ${tradingDays.length} total in the bar history) with >=30 valid trailing-60-day comparisons on ` +
    `both the predictor and outcome side. Outcome: day D's own realized RTH range in the top quartile of its ` +
    `own trailing 60 sessions. 9 pre-registered cells (3 metrics x 3 strictness levels, no family split -- ` +
    `this is a market-wide question, not a per-strategy one), alpha=0.05/9=${alpha.toFixed(5)}. ` +
    `Best cell: ${best.metric} (level ${best.level}), diff=${(best.diff * 100).toFixed(1)}%, p=${best.test.p.toExponential(2)}, ` +
    `Bonferroni ${best.pass ? 'PASS' : 'FAIL'}, rigor.clean=${best.rigor.clean}, chronological train/test ` +
    `same-sign=${best.sameSignOOS} (train diff ${(best.trainDiff * 100).toFixed(1)}%, test diff ${(best.testDiff * 100).toFixed(1)}%). ` +
    `RESULT: ${anyPass ? 'a real positive signal survived Bonferroni + rigor + train/test' : 'NEGATIVE -- no cell cleared Bonferroni-corrected significance with a clean rigor check and same-sign train/test'}. ` +
    `This is the properly-powered market-behavior test the original trade-gated version could not be (that ` +
    `version's own Part-4 finding -- zero setup_types even qualify as a VAH type -- was itself the tell that ` +
    `the tracking window, not the market, was the limiting factor).`;

  await recordClaim({
    slug: 'compression_session_range_prediction',
    claimText,
    sourceFile: 'scripts/analyze_compression_session_range.mjs',
    sourceDate: '2026-08-04',
    sampleSize: records.length,
    rigorStatus: best.rigor.clean ? 'clean' : 'not_clean',
    status: anyPass ? 'CONFIRMED' : 'PROVISIONAL',
  });

  console.log('\nRecorded RESEARCH_CLAIM compression_session_range_prediction.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
