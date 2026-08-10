// CORRECTED 2026-08-10 (Roadmap Phase 0). The original version of this script had a real,
// confirmed confound (RESEARCH_CLAIM rth_calibration_genuine_holdout_test, OPEN_DECISION
// rth_holdout_test_needs_chronological_evaluation, both 2026-08-05): its per-touch
// evaluation loop checked `if (mae > stop) ... else if (mfe >= target)` against pre-aggregated
// scalar mae/mfe values with no regard for which was actually touched FIRST in real time.
// That mechanically favors whichever compared arm has the WIDER stop (a wide stop is less
// likely to be "exceeded" by a fixed mae value, regardless of real chronological order) --
// confirmed on the original run: the "winning" Calib arm averaged 79.7pt stops vs Live's
// 52.9pt and Flat's 32pt, a gap large enough to explain most of the reported EV gap on its
// own. The calibration/candidate-selection step had the identical defect (it called the
// same order-blind sweepOptimalStopAndTarget()).
//
// Fix: both the candidate sweep AND the held-out evaluation now go through
// precomputeCrossovers()/computeEvAtStopTargetChronological() (scripts/update_optimal_stops.mjs)
// -- the same already-audited, order-aware primitives the live calibration pipeline uses
// elsewhere (computeStopTargetForType(), the IB day-type sweep). Deliberately does NOT reuse
// sweepOptimalStopAndTargetChronological() wholesale: that helper's precomputeCrossovers()
// call always uses the fixed WALK_WINDOW_BARS=390 cross-day default, which would let a touch
// firing late in an RTH session walk into the NEXT day's bars -- wrong for this population,
// since none of TARGET_SETUPS below are _TRAIL/overnight-capable; they're plain RTH fades
// that get force-closed same-session live (CLAUDE.md's sessionEndET hard-cap convention).
// Instead each touch carries its own day-bounded `maxBars` (bars remaining in that trading
// day), passed explicitly to precomputeCrossovers() per touch -- same primitive, correct
// window, no behavior change beyond fixing the order-blindness.
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { LEVEL_FADE_DEFINITIONS } from '../server/config/setupDefinitions.js';
import { computeRunningVwapSeries } from '../server/services/developingValueService.js';
import { DEFAULT_DPP, TARGET_SWEEP, precomputeCrossovers, computeEvAtStopTargetChronological } from './update_optimal_stops.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const TARGET_SETUPS = [
  'OR_LOW_FADE_LONG',
  'OR_HIGH_FADE_SHORT',
  'IB_HIGH_FADE_SHORT',
  'IB_LOW_FADE_LONG',
  'RTH_VWAP_FADE_LONG',
  'RTH_VWAP_FADE_SHORT',
  'ONL_FADE_LONG',
  'ONH_FADE_SHORT',
  'DAILY_OPEN_FADE_SHORT',
  'DAILY_OPEN_FADE_LONG',
  'CAM_S2_FADE_LONG',
  'CAM_S3_FADE_LONG',
  'CAM_S1_FADE_LONG',
  'CAM_R3_FADE_SHORT',
  'CAM_R2_FADE_SHORT'
];

const CUTOFF_DATE = '2025-08-05';
const DPP = DEFAULT_DPP;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const MIN_N = 20;

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const idx = Math.floor(arr.length * p);
  return arr[idx];
}

// Distributional/tail-risk stats (added 2026-08-10, DeepSeek review item 6, HIGH severity):
// a mean EV alone can't distinguish "wins consistently" from "wins often, loses catastrophically
// rarely" -- exactly the concern for setup_types whose calibrated candidate picked a wide
// stop/small target (e.g. 151pt/15pt). sorted must already be ascending.
function distStats(vals) {
  if (!vals.length) return null;
  const sorted = [...vals].sort((a,b)=>a-b);
  return {
    min: sorted[0],
    p5: percentile(sorted, 0.05),
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.50),
    p75: percentile(sorted, 0.75),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

async function main() {
  console.log('Loading all NQ bars into memory...');
  const res = await query(`
    SELECT
      ts::date::text as trade_date,
      ts::text as ts_text,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod,
      close::float, high::float, low::float,
      volume::float as volume
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `);

  // Flat, globally-indexed bar array -- precomputeCrossovers() expects ONE continuous
  // array plus an absolute barIdx into it, not a per-day array. Annotate each row with its
  // global index so a touch constructed while iterating a single day's slice can still be
  // passed straight to precomputeCrossovers() against this shared array.
  const allBars = res.rows;
  allBars.forEach((b, idx) => { b.globalIdx = idx; });

  const barsByDay = new Map();
  for (const b of allBars) {
    if (!barsByDay.has(b.trade_date)) barsByDay.set(b.trade_date, []);
    barsByDay.get(b.trade_date).push(b);
  }

  // Exclusive end index (one past the day's last bar) in `allBars`, per trade_date -- bounds
  // each touch's chronological walk to "resolves within today's RTH session, marks to
  // today's close otherwise." See header comment for why this is day-bounded rather than the
  // generic cross-day WALK_WINDOW_BARS=390 convention.
  const dayEndIdx = new Map();
  for (const [date, bars] of barsByDay.entries()) {
    dayEndIdx.set(date, bars[bars.length - 1].globalIdx + 1);
  }

  console.log('Loading level_prices...');
  const levelsRes = await query(`
    SELECT trade_date::text, level_name, price::float
    FROM level_prices
  `);
  const levelsByDay = new Map();
  for (const r of levelsRes.rows) {
    if (!levelsByDay.has(r.trade_date)) levelsByDay.set(r.trade_date, new Map());
    levelsByDay.get(r.trade_date).set(r.level_name, r.price);
  }

  console.log('Loading current LIVE optimal stops for comparison...');
  // FIXED 2026-08-10: was `run_date = (SELECT MAX(run_date) ...)` -- a GLOBAL max across every
  // signal_name, not a per-signal_name latest. Since OPTIMAL_STOP rows update on different
  // days per setup_type, that returned only whichever signal_names happened to be refreshed
  // on the single most-recent run (3 of 133 in a live check) and silently dropped the rest --
  // the exact DISTINCT ON (signal_name) defect class CLAUDE.md documents elsewhere
  // ("A signal_name lagging even one run behind its signal_type's global max ... was
  // completely absent from the result set"). All 15 TARGET_SETUPS below actually have a real
  // row as of the last calibration run; the old query silently fell back to the hardcoded
  // 65/35 default for 12 of them.
  const liveStopsRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, optimal_stop::float as stop, optimal_target::float as target
    FROM performance_audit
    WHERE signal_type = 'OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const liveValues = new Map();
  const allStops = [];
  const allTargets = [];
  // FIXED 2026-08-10, flagged by DeepSeek's review: the flat baseline used to be the median
  // stop/target across ALL ~133 live calibrated setup_types (prior-period levels, trailing
  // variants, etc.), not just the 15 tested here -- a "market-average" baseline, not a fair
  // one-size-fits-all-for-THIS-population baseline. Scoped to TARGET_SETUPS only. (This makes
  // Flat a WEAKER baseline than before, i.e. easier for Calib to beat -- so this fix, if
  // anything, makes a Calib win less impressive, not more; it does not manufacture the result.)
  for (const r of liveStopsRes.rows) {
    liveValues.set(r.setup_type, { stop: r.stop, target: r.target });
    if (!TARGET_SETUPS.includes(r.setup_type)) continue;
    if (r.stop) allStops.push(r.stop);
    if (r.target) allTargets.push(r.target);
  }

  allStops.sort((a,b)=>a-b);
  allTargets.sort((a,b)=>a-b);
  const flatStop = percentile(allStops, 0.5) || 65;
  const flatTarget = percentile(allTargets, 0.5) || 35;
  console.log(`Flat baseline chosen: Stop=${flatStop}pt, Target=${flatTarget}pt (median of the ${TARGET_SETUPS.length} TESTED types' live calibrated values, not the full ~133-type roster)`);

  const allTouches = [];

  console.log('Reconstructing touches...');
  for (const [date, bars] of barsByDay.entries()) {
    const dayLevels = levelsByDay.get(date) || new Map();
    const runningVwap = computeRunningVwapSeries(bars);
    const firedToday = new Set();
    const dayEnd = dayEndIdx.get(date);

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const vwapNow = runningVwap[i];

      for (const setupType of TARGET_SETUPS) {
        if (firedToday.has(setupType)) continue;

        const isLong = setupType.includes('_LONG');
        const baseLevelName = setupType.replace(/_FADE_(LONG|SHORT)$/, '');

        let levelPrice = null;
        let formationGate = null;

        if (baseLevelName === 'RTH_VWAP') {
          levelPrice = vwapNow;
          formationGate = 570;
        } else {
          levelPrice = dayLevels.get(baseLevelName);
          const def = LEVEL_FADE_DEFINITIONS[baseLevelName];
          formationGate = def ? (def.formationGate || 570) : 570;
        }

        if (levelPrice == null) continue;
        if (bar.mod < formationGate) continue;

        if (Math.abs(bar.close - levelPrice) <= 15) {
          firedToday.add(setupType);

          const entry = bar.close;
          const endClose = bars[bars.length - 1].close;
          const expirePnlPoints = isLong ? (endClose - entry) : (entry - endClose);
          const actualPnl = expirePnlPoints * DPP - COMM; // reporting only -- NOT used for win/loss

          // True (uncensored) worst/best excursion over the rest of TODAY's session. This is
          // NOT where the order-blindness confound lived -- it's independent of any stop/
          // target choice, safe to use for building candidate-grid percentiles.
          let mae = 0, mfe = 0;
          for (let j = i + 1; j < bars.length; j++) {
            const adverse = isLong ? entry - bars[j].low : bars[j].high - entry;
            const favorable = isLong ? bars[j].high - entry : entry - bars[j].low;
            if (adverse > mae) mae = adverse;
            if (favorable > mfe) mfe = favorable;
          }

          // FIXED 2026-08-10, found by DeepSeek's independent review of this script:
          // precomputeCrossovers() walks INCLUDING trade.barIdx itself (matches its one
          // other live caller, update_optimal_stops.mjs's computeStopTargetForType(), which
          // passes barIdx as the bar AFTER fired_at via makeBarIndex() -- that bar hasn't
          // been "seen" yet relative to the entry decision, so including its own high/low is
          // correct there). This script's `entry` is bar `i`'s own CLOSE -- passing
          // barIdx=i (the same bar) made the walk score that bar's high/low as post-entry
          // risk, when a 1-min bar's high/low occur DURING the bar's formation, i.e. AT OR
          // BEFORE the close that defines entry. That's a small look-ahead that mechanically
          // favors wider-stop candidates (an entry-bar excursion of ~10-25pt is a large
          // fraction of a 32pt stop, negligible against a 151pt one). Fixed by walking from
          // i+1 (the first bar genuinely after entry) -- same convention the MAE/MFE scalar
          // computation above already uses (`for (let j = i + 1; ...)`), now consistent with
          // the chronological evaluation path too.
          allTouches.push({
            date,
            setupType,
            entry,
            mae,
            mfe,
            isLong,
            actualPnl,
            barIdx: bar.globalIdx + 1,
            maxBars: dayEnd - (bar.globalIdx + 1),
          });
        }
      }
    }
  }

  console.log(`Found ${allTouches.length} total touches.`);

  const trainTouches = allTouches.filter(t => t.date < CUTOFF_DATE);
  const testTouches = allTouches.filter(t => t.date >= CUTOFF_DATE);

  console.log(`Train (before ${CUTOFF_DATE}): ${trainTouches.length}`);
  console.log(`Test (on/after ${CUTOFF_DATE}): ${testTouches.length}`);

  let aggCalibPnl = 0, aggFlatPnl = 0, aggLivePnl = 0;
  let aggCalibWin = 0, aggFlatWin = 0, aggLiveWin = 0;
  let totalTestN = 0;

  const typeResults = [];

  for (const setupType of TARGET_SETUPS) {
    const trainGroup = trainTouches.filter(t => t.setupType === setupType);
    if (trainGroup.length < MIN_N) {
      console.log(`Skipping ${setupType} - insufficient train N (${trainGroup.length})`);
      continue;
    }

    const maes = trainGroup.map(t => t.mae).sort((a,b)=>a-b);
    const mfes = trainGroup.map(t => t.mfe).sort((a,b)=>a-b);

    const maeCandidates = [
      { value: Math.round(percentile(maes, 0.25)), pct: 0.25 },
      { value: Math.round(percentile(maes, 0.40)), pct: 0.40 },
      { value: Math.round(percentile(maes, 0.50)), pct: 0.50 },
      { value: Math.round(percentile(maes, 0.60)), pct: 0.60 },
      { value: Math.round(percentile(maes, 0.75)), pct: 0.75 }
    ];
    const maxT = percentile(mfes, 0.75);
    const targetGrid = TARGET_SWEEP.filter(T => T <= maxT);
    if (!targetGrid.length) {
      console.log(`Skipping ${setupType} - no usable target grid (maxT=${maxT.toFixed(1)})`);
      continue;
    }
    const stopCandidateValues = [...new Set(maeCandidates.map(c => c.value))];

    // Chronological (order-aware) candidate sweep. Precompute crossovers ONCE per train
    // touch (not once per stop x target pair), matching the live pipeline's own
    // sweepOptimalStopAndTargetChronological() approach in update_optimal_stops.mjs -- just
    // with each touch's own day-bounded maxBars instead of that function's fixed cross-day
    // default (see header comment).
    const trainCrossovers = trainGroup
      .map(t => ({ t, cx: precomputeCrossovers({ barIdx: t.barIdx, direction: t.isLong ? 'LONG' : 'SHORT', entry: t.entry }, allBars, stopCandidateValues, targetGrid, t.maxBars) }))
      .filter(r => r.cx != null);

    if (trainCrossovers.length < MIN_N) {
      console.log(`Skipping ${setupType} - insufficient walkable train N (${trainCrossovers.length})`);
      continue;
    }

    let best = null;
    for (const { value: S, pct } of maeCandidates) {
      const requiredN = Math.ceil(MIN_N / (1 - pct));
      if (trainCrossovers.length < requiredN) continue; // tail too thin to trust this percentile's boundary
      for (const T of targetGrid) {
        let evSum = 0, n = 0;
        for (const { cx } of trainCrossovers) {
          const ev = computeEvAtStopTargetChronological(cx, S, T, DPP, DPP, COMM);
          if (ev == null) continue;
          evSum += ev; n++;
        }
        if (n < MIN_N) continue;
        const ev = evSum / n;
        if (!best || ev > best.ev) best = { stop: S, target: T, ev, n };
      }
    }
    if (!best) {
      console.log(`Skipping ${setupType} - no candidate cleared the N floor.`);
      continue;
    }
    const { stop: calibStop, target: calibTarget } = best;

    const liveStopData = liveValues.get(setupType);
    const liveStop = liveStopData?.stop || 65;
    const liveTarget = liveStopData?.target || 35;

    const testGroup = testTouches.filter(t => t.setupType === setupType);
    totalTestN += testGroup.length;

    // Genuinely chronological evaluation. For EACH held-out touch, precompute crossovers
    // against all 3 candidate (stop,target) pairs at once, then read off which was actually
    // touched FIRST in real time -- this is the fix: the original version compared each
    // arm's single scalar mae/mfe with no notion of order, which mechanically favored
    // whichever arm had the wider stop.
    let cPnl = 0, cWin = 0;
    let fPnl = 0, fWin = 0;
    let lPnl = 0, lWin = 0;
    const cPnls = []; // per-touch Calib $ pnl -- for tail-risk distribution stats below

    for (const t of testGroup) {
      const stopSet = [...new Set([calibStop, flatStop, liveStop])];
      const targetSet = [...new Set([calibTarget, flatTarget, liveTarget])];
      const cx = precomputeCrossovers({ barIdx: t.barIdx, direction: t.isLong ? 'LONG' : 'SHORT', entry: t.entry }, allBars, stopSet, targetSet, t.maxBars);
      if (!cx) continue;

      const cEvT = computeEvAtStopTargetChronological(cx, calibStop, calibTarget, DPP, DPP, COMM);
      cPnl += cEvT; if (cEvT > 0) cWin++;
      t._calibPnl = cEvT;
      cPnls.push(cEvT);

      const fEvT = computeEvAtStopTargetChronological(cx, flatStop, flatTarget, DPP, DPP, COMM);
      fPnl += fEvT; if (fEvT > 0) fWin++;
      t._flatPnl = fEvT;

      const lEvT = computeEvAtStopTargetChronological(cx, liveStop, liveTarget, DPP, DPP, COMM);
      lPnl += lEvT; if (lEvT > 0) lWin++;
    }

    aggCalibPnl += cPnl; aggCalibWin += cWin;
    aggFlatPnl += fPnl; aggFlatWin += fWin;
    aggLivePnl += lPnl; aggLiveWin += lWin;

    const calibDist = distStats(cPnls);

    typeResults.push({
      setupType,
      n: testGroup.length,
      calib: { stop: calibStop, target: calibTarget, pnl: cPnl, winRate: testGroup.length ? cWin/testGroup.length : 0, ev: testGroup.length ? cPnl/testGroup.length : 0, dist: calibDist },
      flat: { pnl: fPnl, winRate: testGroup.length ? fWin/testGroup.length : 0, ev: testGroup.length ? fPnl/testGroup.length : 0 },
      live: { stop: liveStop, target: liveTarget, pnl: lPnl, winRate: testGroup.length ? lWin/testGroup.length : 0, ev: testGroup.length ? lPnl/testGroup.length : 0 },
      testGroup
    });

    console.log(`[${setupType}] Test N=${testGroup.length}`);
    console.log(`  Calib (${calibStop}/${calibTarget}): EV=$${(testGroup.length ? cPnl/testGroup.length : 0).toFixed(2)} WR=${(testGroup.length ? cWin/testGroup.length*100 : 0).toFixed(1)}%`);
    if (calibDist) {
      console.log(`    Calib $ distribution: min=$${calibDist.min.toFixed(0)} p5=$${calibDist.p5.toFixed(0)} p25=$${calibDist.p25.toFixed(0)} p50=$${calibDist.p50.toFixed(0)} p75=$${calibDist.p75.toFixed(0)} p95=$${calibDist.p95.toFixed(0)} max=$${calibDist.max.toFixed(0)}`);
    }
    console.log(`  Flat  (${flatStop}/${flatTarget}): EV=$${(testGroup.length ? fPnl/testGroup.length : 0).toFixed(2)} WR=${(testGroup.length ? fWin/testGroup.length*100 : 0).toFixed(1)}%`);
    console.log(`  Live  (${liveStop}/${liveTarget}): EV=$${(testGroup.length ? lPnl/testGroup.length : 0).toFixed(2)} WR=${(testGroup.length ? lWin/testGroup.length*100 : 0).toFixed(1)}%`);
  }

  console.log(`\n=== AGGREGATE RESULTS (Holdout >= ${CUTOFF_DATE}, N=${totalTestN}) ===`);
  const cEv = totalTestN ? aggCalibPnl / totalTestN : 0;
  const fEv = totalTestN ? aggFlatPnl / totalTestN : 0;
  const lEv = totalTestN ? aggLivePnl / totalTestN : 0;

  console.log(`Calib (Honest Train): PnL=$${aggCalibPnl.toFixed(2)}, EV=$${cEv.toFixed(2)}, WR=${(totalTestN ? aggCalibWin/totalTestN*100 : 0).toFixed(1)}%`);
  console.log(`Flat Baseline       : PnL=$${aggFlatPnl.toFixed(2)}, EV=$${fEv.toFixed(2)}, WR=${(totalTestN ? aggFlatWin/totalTestN*100 : 0).toFixed(1)}%`);
  console.log(`Live (Contaminated) : PnL=$${aggLivePnl.toFixed(2)}, EV=$${lEv.toFixed(2)}, WR=${(totalTestN ? aggLiveWin/totalTestN*100 : 0).toFixed(1)}%`);

  const winner = (cEv > fEv) ? 'Calib' : 'Flat';

  // bestEvents reuses the chronological pnl already computed per touch above (t._calibPnl /
  // t._flatPnl) -- no third bar-walk needed.
  let bestEvents = [];
  for (const r of typeResults) {
    for (const t of r.testGroup) {
      const pnl = winner === 'Calib' ? t._calibPnl : t._flatPnl;
      if (pnl == null) continue;
      bestEvents.push({ date: t.date, pnl });
    }
  }

  bestEvents.sort((a,b) => a.date.localeCompare(b.date));

  console.log(`\nComputing rigor for best arm (${winner})...`);
  const rigor = computeRigor(bestEvents, { dateField: 'date', pnlFn: e => e.pnl });
  console.log(`Rigor: DistinctDates=${rigor.distinctDates}, Top5DayPct=${rigor.top5DayPct}%, Stable=${rigor.stable}, Clean=${rigor.clean}`);
  if (rigor.thirds) console.log(`  Thirds: EV1=$${rigor.thirds.ev1}, EV2=$${rigor.thirds.ev2}, EV3=$${rigor.thirds.ev3}`);

  // Pooled tail-risk distribution for the winning arm (DeepSeek review item 6) -- a mean EV
  // can't distinguish "wins consistently" from "wins often, loses catastrophically rarely."
  const pooledDist = distStats(bestEvents.map(e => e.pnl));
  if (pooledDist) {
    console.log(`\n${winner} pooled $ distribution (N=${bestEvents.length}): min=$${pooledDist.min.toFixed(0)} p5=$${pooledDist.p5.toFixed(0)} p25=$${pooledDist.p25.toFixed(0)} p50=$${pooledDist.p50.toFixed(0)} p75=$${pooledDist.p75.toFixed(0)} p95=$${pooledDist.p95.toFixed(0)} max=$${pooledDist.max.toFixed(0)}`);
  }

  const text = (cEv > fEv)
    ? `CORRECTED 2026-08-10 (genuinely chronological evaluation via precomputeCrossovers()/computeEvAtStopTargetChronological() for both calibration and evaluation, fixing the 2026-08-05 order-blind confound). RTH calibration pipeline beats the flat baseline on honest, order-aware, held-out data (EV $${cEv.toFixed(2)} vs $${fEv.toFixed(2)}) over ${totalTestN} held-out touches.`
    : `CORRECTED 2026-08-10 (genuinely chronological evaluation via precomputeCrossovers()/computeEvAtStopTargetChronological() for both calibration and evaluation, fixing the 2026-08-05 order-blind confound). A flat uniform baseline beats honest per-setup calibration on order-aware, held-out data (EV $${fEv.toFixed(2)} vs $${cEv.toFixed(2)}) over ${totalTestN} held-out touches.`;

  // A JS Date-derived UTC string is not the same as the DB server's America/New_York trading
  // day -- the two disagree once past 8PM ET. CURRENT_DATE::text is the established fix per
  // CLAUDE.md's "no static thresholds"/trading-day-date hard rule.
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  await recordClaim({
    slug: 'rth_calibration_genuine_holdout_test',
    claimText: text,
    sourceFile: 'scripts/backtest_rth_calibration_genuine_holdout.mjs',
    sourceDate: today,
    sampleSize: totalTestN,
    winRate: winner === 'Calib' ? (totalTestN ? aggCalibWin/totalTestN : 0) : (totalTestN ? aggFlatWin/totalTestN : 0),
    evPerTrade: winner === 'Calib' ? cEv : fEv,
    rigorStatus: rigor.clean ? 'clean' : 'failed'
  });
  console.log('Claim recorded.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
