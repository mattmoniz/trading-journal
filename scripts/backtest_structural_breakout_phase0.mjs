/**
 * Structural Breakout / Persistent-Level Retest — Phase 0 Test
 *
 * Full spec: docs/STRUCTURAL_BREAKOUT_RETEST_SPEC.md §3,
 * scratch/backtest_structural_breakout_phase0_spec_v3.md (DeepSeek-reviewed, build-ready).
 * Two prior Gemini dispatches on this exact build both failed (attempt 1 fabricated
 * results, attempt 2 honestly ran out of time) -- per the standing 2-corrections rule,
 * built directly by Claude.
 *
 * QUESTION: does trading a RETEST of a data-derived structural pivot beat trading the
 * first touch? Four arms, same stop/target METHOD calibrated SEPARATELY per arm:
 *   Arm 0: first-touch control (enter immediately on pivot confirmation)
 *   Arm 1: retest, amplitude-filtered structural pivots
 *   Arm 2: blind retest control (any local high/low, no amplitude filter)
 *   Arm 3: random-level control (levels drawn from a distribution matching where real
 *          pivots cluster -- near rolling-window extremes, not uniform)
 * Success: Arm 1 beats Arm 0 AND Arm 2 AND Arm 3 (conjunctive), N>=20, computeRigor-clean.
 *
 * RTH and Globex evaluated completely separately, never pooled. Intraday scales
 * k in {5,10,20,30} (1-min bars); daily scales k in {2,3,5} (RTH-session daily bars,
 * RTH-only per this codebase's convention -- daily-scale Globex analysis is out of scope,
 * a documented limitation, not an oversight).
 *
 * No lookahead: a fractal pivot at bar index i is only confirmed (knowable) at bar i+k
 * (needs k bars after it to know it's a local extreme) -- entries only ever use bars at
 * or after a pivot's confirmIdx. swingMin[k] (the amplitude floor) is a ROLLING, CAUSAL
 * percentile over only prior-confirmed candidates, not a global/future-informed cutoff.
 *
 * Reuses real functions, not reimplementations: replayBars() (server/services/
 * maeMfeReplay.js) for the bar-by-bar stop/target simulation, computeRigor()/
 * computeReplication() (server/services/rigorDiagnostics.js) for the stability checks.
 *
 * Run: node scripts/backtest_structural_breakout_phase0.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { replayBars, directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const SIGNAL_TYPE = 'STRUCTURAL_BREAKOUT_PHASE0'; // 26 chars, fits VARCHAR(30)
export const INTRADAY_SCALES = [5, 10, 20, 30];
const DAILY_SCALES = [2, 3, 5];
const RTH_START = 570, RTH_END = 960; // 9:30am-4:00pm ET
const MAINT_START = 1020, MAINT_END = 1080; // 5-6pm ET daily maintenance gap
export const LOOKFORWARD_INTRADAY = 200; // bars, ~3.3hr horizon for MAE/MFE calibration + replay
const LOOKFORWARD_DAILY = 20; // daily bars, ~1 month horizon
export const MIN_N_FOR_GATE = 20;

// ── Data loading ─────────────────────────────────────────────────────────────
export async function loadBars(regime) {
  // FIXED (DeepSeek review, 2026-08-03): RTH_END-1 excluded minute 960 (4:00pm, the RTH
  // closing bar) from RTH AND from the Globex NOT-clause, so it fell through and got
  // misclassified as Globex. BETWEEN is inclusive on both ends -- use RTH_END directly.
  const whereClause = regime === 'RTH'
    ? `(EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN ${RTH_START} AND ${RTH_END}`
    : `NOT ((EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN ${RTH_START} AND ${RTH_END})
       AND NOT ((EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN ${MAINT_START} AND ${MAINT_END - 1})`;
  const r = await query(`
    SELECT ts::text as ts, ts::date::text as trade_date,
      open::float, high::float, low::float, close::float, COALESCE(volume,0)::float as volume
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ${whereClause}
    ORDER BY ts
  `);
  return r.rows;
}

// One row per RTH trading day, built from RTH 1-min bars -- matches this codebase's
// existing "daily/session" convention (PD_HIGH/PD_LOW etc. use RTH range, not full 24h).
export function buildDailyBars(rthBars) {
  const byDate = new Map();
  for (const b of rthBars) {
    if (!byDate.has(b.trade_date)) byDate.set(b.trade_date, []);
    byDate.get(b.trade_date).push(b);
  }
  const days = [...byDate.keys()].sort();
  return days.map(d => {
    const bars = byDate.get(d);
    return {
      ts: bars[bars.length - 1].ts,
      trade_date: d,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    };
  });
}

// ── Causal rolling ATR-like average range (used for nearTolerance/farThreshold) ────
export function rollingAvgRange(bars, window) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  const q = [];
  for (let i = 0; i < bars.length; i++) {
    const range = bars[i].high - bars[i].low;
    q.push(range);
    sum += range;
    if (q.length > window) sum -= q.shift();
    out[i] = q.length >= Math.min(window, 5) ? sum / q.length : null;
  }
  return out;
}

// ── Fractal pivot detection (causal amplitude filter) ───────────────────────────
// amplitudeFilter: true = apply the rolling swingMin[k] 25th-percentile floor (real
// structural pivots, Arm 0/1); false = keep every raw fractal point unfiltered (Arm 2's
// "any local high/low" population).
export function detectPivots(bars, k, amplitudeFilter) {
  const pivots = [];
  const pastAmplitudesHigh = []; // rolling causal population for the percentile floor
  const pastAmplitudesLow = [];
  const PCTILE_WINDOW = 300, PCTILE_MIN_N = 20, TRIM_PCTILE = 0.25;

  const percentileFloor = (arr) => {
    if (arr.length < PCTILE_MIN_N) return 0; // no floor yet during burn-in -- keep everything
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * TRIM_PCTILE);
    return sorted[idx];
  };

  for (let i = k; i < bars.length - k; i++) {
    const left = bars.slice(i - k, i);
    const right = bars.slice(i + 1, i + k + 1);
    const bar = bars[i];

    // Strict inequality on the LEFT side only (Gemini review, 2026-08-03) -- a flat-top
    // plateau of tied-high bars would otherwise have EVERY bar in the run independently
    // qualify as its own swing high (each sees only <= neighbors), spawning duplicate
    // pivots for what's really one level. Requiring the left side to be strictly lower
    // means only the FIRST bar of a tied run can qualify (any later bar in the run has an
    // equal-height left neighbor, failing strict <).
    const isSwingHigh = left.every(b => b.high < bar.high) && right.every(b => b.high <= bar.high);
    const isSwingLow = left.every(b => b.low > bar.low) && right.every(b => b.low >= bar.low);

    if (isSwingHigh) {
      const leftMin = Math.min(...left.map(b => b.low));
      const rightMin = Math.min(...right.map(b => b.low));
      const amplitude = Math.min(bar.high - leftMin, bar.high - rightMin);
      const floor = percentileFloor(pastAmplitudesHigh);
      const keep = !amplitudeFilter || amplitude >= floor;
      pastAmplitudesHigh.push(amplitude);
      if (pastAmplitudesHigh.length > PCTILE_WINDOW) pastAmplitudesHigh.shift();
      if (keep) {
        const formationVolume = [...left, bar, ...right].reduce((s, b) => s + b.volume, 0);
        pivots.push({ idx: i, confirmIdx: i + k, price: bar.high, direction: 'RESISTANCE', amplitude, formationVolume });
      }
    }
    if (isSwingLow) {
      const leftMax = Math.max(...left.map(b => b.high));
      const rightMax = Math.max(...right.map(b => b.high));
      const amplitude = Math.min(rightMax - bar.low, leftMax - bar.low);
      const floor = percentileFloor(pastAmplitudesLow);
      const keep = !amplitudeFilter || amplitude >= floor;
      pastAmplitudesLow.push(amplitude);
      if (pastAmplitudesLow.length > PCTILE_WINDOW) pastAmplitudesLow.shift();
      if (keep) {
        const formationVolume = [...left, bar, ...right].reduce((s, b) => s + b.volume, 0);
        pivots.push({ idx: i, confirmIdx: i + k, price: bar.low, direction: 'SUPPORT', amplitude, formationVolume });
      }
    }
  }
  return pivots;
}

// ── Random-level control (Arm 3) ────────────────────────────────────────────────
// Levels drawn from a distribution matching where REAL pivots cluster: near the
// extremes of a trailing window, not uniform across the range (a uniform draw would
// mostly land in the noisy mid-range and never get touched twice in a meaningful way).
// Beta(0.3, 0.3) is U-shaped -- biased toward 0 and 1 -- mapped onto each window's
// [low, high] range. One synthetic level generated per real pivot's confirmIdx (same
// time distribution as Arm 1, different price), alternating RESISTANCE/SUPPORT to
// mirror the real population's direction mix.
function sampleBetaLike() {
  // Approximate Beta(0.3,0.3) via rejection-free inverse-ish trick: average of a few
  // extreme-biased uniform draws pushed toward 0/1 using a power transform.
  const u = Math.random();
  const x = u < 0.5 ? 0.5 * Math.pow(2 * u, 1 / 0.3) : 1 - 0.5 * Math.pow(2 * (1 - u), 1 / 0.3);
  return Math.min(1, Math.max(0, x));
}

export function generateRandomLevels(bars, k, realPivots) {
  const randomLevels = [];
  for (const p of realPivots) {
    const winStart = Math.max(0, p.idx - k * 3);
    const winEnd = Math.min(bars.length - 1, p.idx + k);
    const windowBars = bars.slice(winStart, winEnd + 1);
    if (!windowBars.length) continue;
    const lo = Math.min(...windowBars.map(b => b.low));
    const hi = Math.max(...windowBars.map(b => b.high));
    if (hi <= lo) continue;
    const frac = sampleBetaLike();
    const price = lo + frac * (hi - lo);
    randomLevels.push({
      idx: p.idx, confirmIdx: p.confirmIdx, price,
      direction: p.direction, // mirror real population's direction mix at the same moment
      amplitude: p.amplitude, formationVolume: p.formationVolume,
    });
  }
  return randomLevels;
}

// ── Single forward-pass retest scan (no persistence table, per spec) ────────────
// For Arm 0: entry = bar immediately after confirmation, direction from pivot type.
// For Arm 1/2/3: entry = first bar re-entering nearTolerance from the correct side,
// after having cleared farThreshold (the "clearly left and came back" logic), within
// a bounded clearWindow bars of confirmation.
export function scanRetests(bars, pivots, avgRangeSeries, k, isDaily) {
  const nearMult = 0.5, farMult = 2.5; // stated defaults, not independently tuned (per spec's own allowance)
  const clearWindow = isDaily ? k : k * 3;
  const arm0 = [], armRetest = [];
  const byConfirmIdx = new Map();
  for (const p of pivots) {
    if (!byConfirmIdx.has(p.confirmIdx)) byConfirmIdx.set(p.confirmIdx, []);
    byConfirmIdx.get(p.confirmIdx).push(p);
  }
  const active = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const avgRange = avgRangeSeries[i] ?? (bar.high - bar.low);
    const nearTol = nearMult * avgRange, farThresh = farMult * avgRange;

    const newPivots = byConfirmIdx.get(i) || [];
    for (const p of newPivots) {
      const entryIdx = i + 1;
      if (entryIdx < bars.length) {
        arm0.push({
          entryIdx, entryTs: bars[entryIdx].ts, tradeDate: bars[entryIdx].trade_date,
          entryPrice: bars[entryIdx].open,
          direction: p.direction === 'RESISTANCE' ? 'SHORT' : 'LONG',
          scale: k, formationVolume: p.formationVolume, pivotPrice: p.price,
        });
      }
      active.push({
        price: p.price, direction: p.direction, formationVolume: p.formationVolume,
        farCleared: false, maxDistanceAway: 0, expireAtIdx: i + clearWindow,
      });
    }

    for (let j = active.length - 1; j >= 0; j--) {
      const ap = active[j];
      if (i > ap.expireAtIdx) { active.splice(j, 1); continue; }
      const distAway = ap.direction === 'RESISTANCE'
        ? Math.max(0, ap.price - bar.low)
        : Math.max(0, bar.high - ap.price);
      ap.maxDistanceAway = Math.max(ap.maxDistanceAway, distAway);
      if (!ap.farCleared && ap.maxDistanceAway >= farThresh) ap.farCleared = true;
      if (ap.farCleared) {
        // Range-overlap test (Gemini review, 2026-08-03), not a one-sided unbounded
        // threshold -- the old `bar.high >= price - nearTol` alone was trivially true for
        // ANY bar with a high above that point, including a bar that gapped straight
        // through the near-zone entirely (e.g. price jumps from far below resistance
        // directly to far above it in one bar) without the bar's actual [low,high] range
        // ever intersecting the near-zone. Direction (which side price approaches from)
        // is already enforced by distAway/farCleared above -- this check only needs to
        // confirm genuine proximity, so it's the same overlap test for both directions.
        const touches = bar.high >= ap.price - nearTol && bar.low <= ap.price + nearTol;
        if (touches) {
          const entryIdx = i + 1;
          if (entryIdx < bars.length) {
            armRetest.push({
              entryIdx, entryTs: bars[entryIdx].ts, tradeDate: bars[entryIdx].trade_date,
              entryPrice: bars[entryIdx].open,
              direction: ap.direction === 'RESISTANCE' ? 'SHORT' : 'LONG',
              scale: k, formationVolume: ap.formationVolume, pivotPrice: ap.price,
            });
          }
          active.splice(j, 1);
        }
      }
    }
  }
  return { arm0, armRetest };
}

// ── Raw MAE/MFE (no stop/target yet -- used to derive the arm's own calibration) ──
// Includes the entry bar itself in the walk (Gemini review, 2026-08-03) -- matches this
// codebase's own live convention (maeMfeReplay.js's computeMaeMfe() queries bars with
// `ts >= fired_at`, i.e. inclusive of the entry bar). Entry is that bar's OPEN; the same
// bar's own high/low relative to that open is real, live-relevant intrabar movement, not
// something to skip.
function rawExcursion(bars, entryIdx, direction, lookforward) {
  const end = Math.min(bars.length, entryIdx + lookforward);
  let mae = 0, mfe = 0;
  const entry = bars[entryIdx].entryPriceOverride ?? bars[entryIdx].open;
  for (let i = entryIdx; i < end; i++) {
    const b = bars[i];
    const favorable = direction === 'LONG' ? b.high - entry : entry - b.low;
    const adverse = direction === 'LONG' ? entry - b.low : b.high - entry;
    mfe = Math.max(mfe, favorable);
    mae = Math.max(mae, adverse);
  }
  return { mae, mfe };
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── Simulate an arm: derive stop/target from ITS OWN candidates, then replay ────
export function simulateArm(bars, candidates, lookforward) {
  if (!candidates.length) return { n: 0, trades: [] };
  const raw = candidates.map(c => rawExcursion(bars, c.entryIdx, c.direction, lookforward));
  const stopDist = median(raw.map(r => r.mae));
  const targetDist = median(raw.map(r => r.mfe));
  if (!stopDist || !targetDist || stopDist <= 0 || targetDist <= 0) return { n: 0, trades: [], stopDist, targetDist };

  const trades = [];
  for (const c of candidates) {
    const entry = c.entryPrice;
    const stop = c.direction === 'LONG' ? entry - stopDist : entry + stopDist;
    const t1 = c.direction === 'LONG' ? entry + targetDist : entry - targetDist;
    // Walk starts AT entryIdx (inclusive), not entryIdx+1 -- matches maeMfeReplay.js's
    // own live convention (computeMaeMfe queries `ts >= fired_at`) and rawExcursion's
    // matching fix above (Gemini review, 2026-08-03): the entry bar's own high/low
    // relative to the entry price is real, live-relevant intrabar movement.
    const walkBars = bars.slice(c.entryIdx, Math.min(bars.length, c.entryIdx + lookforward))
      .map(b => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close }));
    const result = replayBars(walkBars, entry, stop, t1, c.direction);
    if (!result) continue;
    // FIXED (DeepSeek review, 2026-08-03, CRITICAL): replayBars() returns the resolution
    // under the key `replayResolution`, not `resolution` -- `result.resolution` was always
    // undefined, so every single trade silently fell through to the mark-to-market EXPIRED
    // fallback regardless of whether it actually hit stop or target. Verified directly
    // against server/services/maeMfeReplay.js's return statement before trusting this fix.
    const pnl = result.replayResolution === 'TARGET_HIT' ? targetDist
      : result.replayResolution === 'STOP_HIT' ? -stopDist
      : (c.direction === 'LONG' ? walkBars[walkBars.length - 1]?.close - entry : entry - walkBars[walkBars.length - 1]?.close) || 0;
    trades.push({ ...c, resolution: result.replayResolution, pnl, date: c.tradeDate });
  }
  return { n: trades.length, trades, stopDist, targetDist };
}

function summarize(trades) {
  if (!trades.length) return { n: 0, wr: null, ev: null };
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0).length;
  const ev = trades.reduce((s, t) => s + t.pnl, 0) / n;
  const rigor = computeRigor(trades, { dateField: 'date', pnlFn: t => t.pnl });
  return { n, wr: wins / n, ev, rigor };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log('[phase0] Loading bars...');
  const rthBars = await loadBars('RTH');
  const globexBars = await loadBars('GLOBEX');
  const dailyBars = buildDailyBars(rthBars);
  console.log(`[phase0] RTH bars=${rthBars.length} Globex bars=${globexBars.length} Daily bars=${dailyBars.length}`);

  const rthAvgRange = rollingAvgRange(rthBars, 20);
  const globexAvgRange = rollingAvgRange(globexBars, 20);
  const dailyAvgRange = rollingAvgRange(dailyBars, 14);

  const allResults = []; // { regime, scale, arm, n, wr, ev, rigor, stopDist, targetDist }

  async function runOneCell(regime, bars, avgRangeSeries, k, isDaily) {
    const lookforward = isDaily ? LOOKFORWARD_DAILY : LOOKFORWARD_INTRADAY;
    const realPivots = detectPivots(bars, k, true);
    const unfilteredPivots = detectPivots(bars, k, false);
    const randomLevels = generateRandomLevels(bars, k, realPivots);

    const { arm0, armRetest: arm1 } = scanRetests(bars, realPivots, avgRangeSeries, k, isDaily);
    const { armRetest: arm2 } = scanRetests(bars, unfilteredPivots, avgRangeSeries, k, isDaily);
    const { armRetest: arm3 } = scanRetests(bars, randomLevels, avgRangeSeries, k, isDaily);

    const arms = { ARM0_FIRST_TOUCH: arm0, ARM1_RETEST_STRUCT: arm1, ARM2_BLIND_RETEST: arm2, ARM3_RANDOM_LEVEL: arm3 };
    for (const [armName, candidates] of Object.entries(arms)) {
      const sim = simulateArm(bars, candidates, lookforward);
      const summary = summarize(sim.trades);
      allResults.push({ regime, scale: k, isDaily, arm: armName, ...summary, stopDist: sim.stopDist, targetDist: sim.targetDist });
      console.log(`[phase0] ${regime} k=${k}${isDaily ? 'd' : ''} ${armName}: N=${summary.n} WR=${summary.wr != null ? (summary.wr * 100).toFixed(1) + '%' : 'n/a'} EV=${summary.ev != null ? '$' + summary.ev.toFixed(2) : 'n/a'} stop=${sim.stopDist?.toFixed(1)} target=${sim.targetDist?.toFixed(1)}`);
    }
  }

  for (const k of INTRADAY_SCALES) {
    await runOneCell('RTH', rthBars, rthAvgRange, k, false);
    await runOneCell('GLOBEX', globexBars, globexAvgRange, k, false);
  }
  for (const k of DAILY_SCALES) {
    await runOneCell('RTH', dailyBars, dailyAvgRange, k, true);
  }

  // ── Success criteria: Arm1 beats Arm0 AND Arm2 AND Arm3 (conjunctive), N>=20, rigor-clean ──
  console.log('\n=== SUCCESS CRITERIA EVALUATION (per regime/scale) ===');
  const cellKeys = new Set(allResults.map(r => `${r.regime}|${r.scale}|${r.isDaily}`));
  const verdicts = [];
  for (const key of cellKeys) {
    const [regime, scaleStr, isDailyStr] = key.split('|');
    const scale = Number(scaleStr), isDaily = isDailyStr === 'true';
    const byArm = Object.fromEntries(allResults.filter(r => r.regime === regime && r.scale === scale && r.isDaily === isDaily).map(r => [r.arm, r]));
    const a0 = byArm.ARM0_FIRST_TOUCH, a1 = byArm.ARM1_RETEST_STRUCT, a2 = byArm.ARM2_BLIND_RETEST, a3 = byArm.ARM3_RANDOM_LEVEL;
    const label = `${regime} k=${scale}${isDaily ? ' (daily)' : ''}`;
    if (!a1 || a1.n < MIN_N_FOR_GATE) {
      console.log(`  ${label}: Arm1 N=${a1?.n ?? 0} < ${MIN_N_FOR_GATE} -- ${isDaily ? 'descriptive only, non-gating (expected per spec)' : 'too thin to evaluate'}`);
      verdicts.push({ regime, scale, isDaily, verdict: 'TOO_THIN', a0, a1, a2, a3 });
      continue;
    }
    const beatsA0 = a1.ev != null && a0?.ev != null && a1.ev > a0.ev;
    const beatsA2 = a1.ev != null && a2?.ev != null && a1.ev > a2.ev;
    const beatsA3 = a1.ev != null && a3?.ev != null && a1.ev > a3.ev;
    const conjunctive = beatsA0 && beatsA2 && beatsA3;
    const rigorClean = a1.rigor?.clean === true;
    const verdict = conjunctive && rigorClean ? 'PASS' : 'FAIL';
    console.log(`  ${label}: Arm1 EV=$${a1.ev.toFixed(2)} vs Arm0=$${a0?.ev?.toFixed(2)} Arm2=$${a2?.ev?.toFixed(2)} Arm3=$${a3?.ev?.toFixed(2)} | beatsAll3=${conjunctive} rigorClean=${rigorClean} => ${verdict}`);
    verdicts.push({ regime, scale, isDaily, verdict, a0, a1, a2, a3 });
  }

  const passCount = verdicts.filter(v => v.verdict === 'PASS').length;
  const gatedCells = verdicts.filter(v => v.verdict !== 'TOO_THIN').length;
  const overallVerdict = gatedCells === 0 ? 'ALL_TOO_THIN' : passCount > 0 ? 'PARTIAL_OR_FULL_PASS' : 'FAIL';
  console.log(`\n=== OVERALL: ${passCount}/${gatedCells} gated cells PASS -- ${overallVerdict} ===`);
  console.log(overallVerdict === 'FAIL'
    ? 'Per spec: Phase 0 negative overall -- the retest-based/structure-based premise does not clear its own bar. Close the thread; the persistence engine is not justified.'
    : 'At least one cell passed all 3 conjunctive controls -- worth a closer look before deciding on Phase 1.');

  // ── Documented methodological caveats (both DeepSeek and Gemini review, 2026-08-03) --
  // real limitations of this Phase 0 methodology, not code bugs, that any PASS verdict
  // must be read alongside, not a clean standalone causal finding.
  const CAVEATS = [
    'Arm2 is a fractal-pivot SUPERSET of Arm1 (every Arm1 pivot also qualifies for Arm2) -- an Arm1>Arm2 win could reflect the amplitude filter selecting structurally "better" pivots rather than the retest mechanic itself adding value independent of pivot quality.',
    'Arm2 uses fractal (k-bar-confirmed) local highs/lows, not literally "any" local high/low as the spec\'s plain-English description says -- a conservative deviation (fractal filtering already removes 1-2 bar noise spikes Arm2 was meant to include), documented not silently changed.',
    'Trades that reach the lookforward window\'s end without hitting stop or target are marked-to-market at the window\'s last close. Since stop and target distances are independently calibrated per arm and are rarely equal, this population is not symmetric around zero by construction -- a real, inherent bias in any fixed-horizon barrier simulation with asymmetric bounds, not unique to this script. Its magnitude scales with how often trades actually expire vs. resolve; check the resolution-type breakdown per arm before trusting a close PASS/FAIL margin.',
  ];
  console.log('\n=== METHODOLOGICAL CAVEATS (read before trusting any PASS verdict) ===');
  for (const c of CAVEATS) console.log(`  - ${c}`);

  // ── Persist ──────────────────────────────────────────────────────────────
  const { rows: dateRows } = await query(`SELECT CURRENT_DATE::text as today`);
  const today = dateRows[0].today;
  for (const r of allResults) {
    const signalName = `${r.regime}_K${r.scale}${r.isDaily ? 'D' : ''}_${r.arm}`.slice(0, 60);
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation, notes)
      VALUES ($1, 9999, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
            recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
    `, [
      today, SIGNAL_TYPE, signalName, r.n, r.wr, r.ev,
      r.n < MIN_N_FOR_GATE ? 'THIN_N' : (r.rigor?.clean ? 'STABLE' : 'UNSTABLE'),
      JSON.stringify({ stop_dist: r.stopDist, target_dist: r.targetDist, rigor: r.rigor }),
    ]);
  }

  await recordClaim({
    slug: 'structural_breakout_phase0_retest_test',
    claimText: `Phase 0 test of whether a data-derived structural pivot RETEST beats trading the first touch. Fractal pivots at intraday k in {5,10,20,30} (1-min bars, RTH+Globex separate) and daily k in {2,3,5} (RTH-session daily bars only). 4 arms per (regime,scale): Arm0 first-touch control, Arm1 retest+amplitude-filtered structure, Arm2 blind retest (any local high/low), Arm3 random-level control (drawn from a distribution matching where real pivots cluster). Stop/target calibrated SEPARATELY per arm (median MAE/MFE of that arm's own candidates). Success requires Arm1 EV to beat Arm0 AND Arm2 AND Arm3 (conjunctive) with N>=${MIN_N_FOR_GATE} and computeRigor()-clean. RESULT: ${passCount}/${gatedCells} gated (regime,scale) cells passed all 3 conjunctive controls. Overall verdict: ${overallVerdict}. ${overallVerdict === 'FAIL' ? 'Retest-based structural premise does NOT clear its own bar -- the persistence-table engine (Phase 1/2/3) is not justified by this data.' : 'At least one cell shows a real, conjunctively-validated effect -- worth deeper investigation before deciding on Phase 1.'} Full per-cell breakdown in performance_audit signal_type=STRUCTURAL_BREAKOUT_PHASE0. CAVEATS (both DeepSeek and Gemini review, audited, not code bugs): ${CAVEATS.join(' ')}`,
    sourceFile: 'scripts/backtest_structural_breakout_phase0.mjs',
    sourceDate: today,
    sampleSize: allResults.reduce((s, r) => s + r.n, 0),
    winRate: null,
    evPerTrade: null,
    rigorStatus: overallVerdict === 'FAIL' ? 'clean_negative' : 'mixed',
    status: 'PROVISIONAL',
  });

  console.log(`\n[phase0] Persisted ${allResults.length} performance_audit rows + RESEARCH_CLAIM structural_breakout_phase0_retest_test`);
  await pool.end();
}

// Import-safety guard (2026-08-19, found live: exporting loadBars/detectPivots/etc for
// backtest_phase0a_time_windowed_diagnostic.mjs to import triggered this ENTIRE script's
// real execution -- a full duplicate Phase 0 backtest run plus a `pool.end()` that then
// crashed the importing script's own persistence step -- as an import side effect. Same
// bug class already fixed once in this codebase (backtest_setup_status.mjs/
// update_optimal_stops.mjs, same guard) and found again the same session in
// backtest_overnight_pattern_discovery_permtest_20260720.mjs. `node
// scripts/backtest_structural_breakout_phase0.mjs` still runs normally; importing its
// exported functions no longer does.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(e => { console.error('[phase0] ERROR:', e.message, e.stack); process.exit(1); });
}
