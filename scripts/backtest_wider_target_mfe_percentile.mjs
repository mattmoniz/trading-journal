// Tests OPEN_DECISION wider_target_mfe_percentile_targets_vs_multiplier (2026-08-24):
// does a data-derived MFE-percentile target (mfe25/50/75/90, points-from-entry, the same
// approach used throughout this session's rotation-VBP research) beat the live wider-target
// mechanism's fixed 1.5x-of-T1-distance multiplier -- and does the answer hold per-setup_type
// or only pooled globally (the user's own flagged scale-transfer concern: a single absolute
// MFE number may not transfer across setup_types with very different typical move sizes the
// way a multiplier-of-T1 already does by construction, since T1 itself is per-type calibrated)?
//
// Reuses the real live walker (stepWiderTarget/MAX_BARS_TO_T1_FOR_WIDER from
// widerTargetWalker.js) rather than reimplementing the arm/resolve logic, matching this
// codebase's own "export the real function" convention -- same as
// scripts/backtest_calibrated_wider_target.mjs (the 1.5x/2.5x multiplier sweep this
// compares against) and scripts/backtest_wider_target_breakeven_floor.mjs.
//
// No-lookahead discipline: percentiles are derived from a chronological TRAIN split only
// and applied to a held-out chronological TEST split -- never computed on the same trades
// they're evaluated against. Same 60/40 split convention already used elsewhere in this
// codebase's OOS work (e.g. corrected-resim target selection).
//
// Grouping: setup_type if that type alone has >=20 armed trades in the full population,
// else pooled by the STORED active_setups.bet_class column (falls back to the name-only
// getBetClass(setup_type) only for legacy rows where the column is null -- CLAUDE.md
// documents the stored column as the fix for getBetClass()'s own name-only ambiguity, so a
// fresh script should prefer it, not re-introduce the ambiguity it exists to close).
import { query } from '../server/db.js';
import { resolveDirection, getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { stepWiderTarget, MAX_BARS_TO_T1_FOR_WIDER } from '../server/services/widerTargetWalker.js';
import { firedAtToMod } from '../server/services/sessionBoundary.js';
import { recordClaim } from './record_claim.mjs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const MAX_WALK_BARS = 500;
const TRAIN_FRACTION = 0.6;
const MIN_GROUP_TRAIN = 10;
const MIN_GROUP_TEST = 10;
const PERCENTILES = [25, 50, 75, 90];
const REFERENCE_MULTS = [1.5, 2.5]; // live-wired, and the leading-but-undeployed candidate

function pnlAtPrice(entry, price, long) {
  const points = long ? price - entry : entry - price;
  return Math.round((points * PNL_PER_POINT - COMMISSION) * 100) / 100;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

async function main() {
  console.log('Loading real resolved trades (same population as backtest_calibrated_wider_target.mjs)...');
  const tradesRes = await query(`
    SELECT id, setup_type, bet_class, origin_status, status,
      fired_at::text as fired_at,
      extract(epoch from (fired_at AT TIME ZONE 'America/New_York'))*1000 as fired_at_ms,
      trade_date::text as trade_date,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level
    FROM active_setups
    WHERE origin_status IN ('ACTIVE', 'SHADOW')
      AND status IN ('RESOLVED', 'EXPIRED')
      AND t1_level IS NOT NULL AND stop_level IS NOT NULL AND entry_zone_low IS NOT NULL
    ORDER BY fired_at ASC
  `);
  console.log(`Loaded ${tradesRes.rows.length} candidate real trades.`);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`
    SELECT to_char(ts AT TIME ZONE 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS') as ts_et,
           extract(epoch from (ts AT TIME ZONE 'America/New_York'))*1000 as ts_ms,
           high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;
  console.log(`Loaded ${allBars.length} price bars.`);

  function firstIndexAfter(tsMs) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts_ms <= tsMs) lo = mid + 1; else hi = mid; }
    return lo;
  }
  const isSessionEnd = (tsEt) => tsEt.slice(11, 13) >= '16';

  // Pass 1: determine which trades ARM (T1 touched within MAX_BARS_TO_T1_FOR_WIDER bars,
  // no same-bar stop conflict) and find the T1-touch bar index + baseline (bank-T1) pnl.
  // Arming is independent of the wider-target VALUE -- stepWiderTarget's pre-arm branch
  // never reads widerTarget -- so a single pass covers every candidate downstream.
  const armed = [];
  let noDirection = 0, notArmed = 0;
  for (const trade of tradesRes.rows) {
    const direction = resolveDirection(trade);
    if (!direction) { noDirection++; continue; }
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const stop = trade.stop_level;
    const t1 = trade.t1_level;
    const startIdx = firstIndexAfter(trade.fired_at_ms);

    let t1TouchIdx = null, aborted = false;
    for (let i = startIdx; i < Math.min(allBars.length, startIdx + MAX_BARS_TO_T1_FOR_WIDER); i++) {
      const b = allBars[i];
      const t1Hit = long ? b.high >= t1 : b.low <= t1;
      const stopHit = long ? b.low <= stop : b.high >= stop;
      if (t1Hit && stopHit) { aborted = true; break; }
      if (t1Hit) { t1TouchIdx = i; break; }
      if (stopHit) { aborted = true; break; }
    }
    if (aborted || t1TouchIdx === null) { notArmed++; continue; }
    if (isSessionEnd(allBars[t1TouchIdx].ts_et)) { notArmed++; continue; } // matches live B2 fix: no session time left to benefit

    const origDistance = Math.abs(t1 - entry);
    const baselinePnl = pnlAtPrice(entry, t1, long);

    // Walk forward from the T1-touch bar under the ORIGINAL-stop risk shape (matches the
    // live-wired arm, and is the natural reference walk for "how far did price actually
    // go before the trade would have been stopped out or the session ended") --
    // tracking running peak favorable excursion in points-from-entry as we go.
    let mfePoints = 0;
    let stopHitIdx = null, sessionEndIdx = null;
    for (let i = t1TouchIdx + 1; i < Math.min(allBars.length, t1TouchIdx + 1 + MAX_WALK_BARS); i++) {
      const b = allBars[i];
      const excursion = long ? b.high - entry : entry - b.low;
      if (excursion > mfePoints) mfePoints = excursion;
      const stopHit = long ? b.low <= stop : b.high >= stop;
      if (stopHit) { stopHitIdx = i; break; }
      if (isSessionEnd(b.ts_et)) { sessionEndIdx = i; break; }
    }
    if (stopHitIdx === null && sessionEndIdx === null) continue; // walk ran out of bars entirely, ambiguous -- drop

    const group = trade.setup_type; // group refined to bet_class below once N is known
    armed.push({
      trade, direction, long, entry, stop, t1, origDistance, t1TouchIdx, baselinePnl, mfePoints,
      trade_date: trade.trade_date, fired_at_ms: trade.fired_at_ms, setup_type: trade.setup_type,
      bet_class: trade.bet_class || getBetClass(trade.setup_type),
      // FIXED 2026-08-30 (DeepSeek code review round 2, finding R1): walkWiderTarget() below
      // calls the REAL stepWiderTarget() walker, which now needs firedMod/bar.mod to detect
      // session-end for a Globex-origin trade -- without it, isPastMechanismSessionEnd()
      // silently returns false forever (undefined>=960 is false), so the walker's own
      // session-end trigger became a permanent no-op for this script post-fix. This script's
      // OWN local isSessionEnd() (string-based, line ~84) is untouched and still gates arming/
      // the standalone MFE walk correctly-for-RTH same as before -- only the walker's INTERNAL
      // check needed this.
      firedMod: firedAtToMod(trade.fired_at),
    });
  }
  console.log(`Armed (eligible) trades: ${armed.length} (no dir: ${noDirection}, not armed/aborted: ${notArmed})`);

  // Grouping: same convention as backtest_calibrated_wider_target.mjs -- per-setup_type
  // if that type alone clears N>=20 among armed trades, else pool by bet_class.
  const bySetupType = {};
  for (const t of armed) (bySetupType[t.setup_type] ??= []).push(t);
  const finalGroups = {};
  for (const [st, trades] of Object.entries(bySetupType)) {
    if (trades.length >= 20) {
      finalGroups[st] = trades;
    } else {
      const bc = trades[0].bet_class;
      (finalGroups[bc] ??= []).push(...trades);
    }
  }

  // Walk the wider-target continuation for one candidate target price, reusing the real
  // live step function (never reimplemented).
  function walkWiderTarget(t, widerTarget) {
    let state = { widening: true }; // already armed as of t1TouchIdx -- start the walker post-arm
    for (let i = t.t1TouchIdx + 1; i < Math.min(allBars.length, t.t1TouchIdx + 1 + MAX_WALK_BARS); i++) {
      const barCount = i - t.t1TouchIdx; // irrelevant post-arm, stepWiderTarget ignores it in the widening branch
      const b = allBars[i];
      const bar = { ts: b.ts_et, mod: firedAtToMod(b.ts_et), high: b.high, low: b.low, close: b.close };
      const stepRes = stepWiderTarget(state, bar, {
        entry: t.entry, stop: t.stop, t1: t.t1, widerTarget, long: t.long, barCount,
        maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER, firedMod: t.firedMod,
      });
      state = stepRes.state;
      if (stepRes.resolution) {
        return pnlAtPrice(t.entry, stepRes.resolution.priceAtRes, t.long);
      }
    }
    const lastBar = allBars[Math.min(allBars.length - 1, t.t1TouchIdx + MAX_WALK_BARS)];
    return pnlAtPrice(t.entry, lastBar.close, t.long);
  }

  function splitChrono(trades) {
    const sorted = [...trades].sort((a, b) => a.fired_at_ms - b.fired_at_ms);
    const cut = Math.floor(sorted.length * TRAIN_FRACTION);
    return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
  }

  function summarize(deltas) {
    const n = deltas.length;
    const mean = deltas.reduce((a, b) => a + b, 0) / n;
    const sorted = [...deltas].sort((a, b) => a - b);
    const median = sorted[Math.floor(n / 2)];
    const negCount = deltas.filter(d => d < 0).length;
    const posCount = deltas.filter(d => d > 0).length;
    return { n, mean, median, negCount, posCount };
  }

  // === Arm 1: per-GROUP MFE percentile targets (train-derived, test-evaluated) ===
  const groupResults = {};
  for (const [groupName, trades] of Object.entries(finalGroups)) {
    const { train, test } = splitChrono(trades);
    if (train.length < MIN_GROUP_TRAIN || test.length < MIN_GROUP_TEST) {
      groupResults[groupName] = { thin: true, trainN: train.length, testN: test.length };
      continue;
    }
    const trainMfeSorted = train.map(t => t.mfePoints).sort((a, b) => a - b);
    const percTargets = {};
    for (const p of PERCENTILES) percTargets[p] = percentile(trainMfeSorted, p);

    const byPercentile = {};
    for (const p of PERCENTILES) {
      const mfeDist = percTargets[p];
      const events = test.map(t => {
        const widerTarget = t.long ? t.entry + mfeDist : t.entry - mfeDist;
        const simPnl = walkWiderTarget(t, widerTarget);
        return { date: t.trade_date, delta: simPnl - t.baselinePnl };
      });
      const s = summarize(events.map(e => e.delta));
      const rigor = computeRigor(events, { dateField: 'date', pnlFn: e => e.delta });
      byPercentile[p] = { ...s, mfeDistPoints: mfeDist, rigor };
    }
    // Reference multipliers, evaluated on the IDENTICAL test set for a true apples-to-apples.
    const byMult = {};
    for (const mult of REFERENCE_MULTS) {
      const events = test.map(t => {
        const widerTarget = t.long ? t.entry + t.origDistance * mult : t.entry - t.origDistance * mult;
        const simPnl = walkWiderTarget(t, widerTarget);
        return { date: t.trade_date, delta: simPnl - t.baselinePnl };
      });
      const s = summarize(events.map(e => e.delta));
      byMult[mult] = s;
    }
    groupResults[groupName] = { thin: false, trainN: train.length, testN: test.length, byPercentile, byMult };
  }

  // === Arm 2: single GLOBAL MFE percentile (pooled train, applied to every test trade
  // regardless of group) -- directly operationalizes the user's own flagged concern about
  // whether one absolute number transfers across setup_types with different move scales. ===
  const { train: globalTrain, test: globalTest } = splitChrono(armed);
  const globalMfeSorted = globalTrain.map(t => t.mfePoints).sort((a, b) => a - b);
  const globalByPercentile = {};
  for (const p of PERCENTILES) {
    const mfeDist = percentile(globalMfeSorted, p);
    const events = globalTest.map(t => {
      const widerTarget = t.long ? t.entry + mfeDist : t.entry - mfeDist;
      const simPnl = walkWiderTarget(t, widerTarget);
      return { date: t.trade_date, delta: simPnl - t.baselinePnl };
    });
    const s = summarize(events.map(e => e.delta));
    const rigor = computeRigor(events, { dateField: 'date', pnlFn: e => e.delta });
    globalByPercentile[p] = { ...s, mfeDistPoints: mfeDist, rigor };
  }
  const globalByMult = {};
  for (const mult of REFERENCE_MULTS) {
    const events = globalTest.map(t => {
      const widerTarget = t.long ? t.entry + t.origDistance * mult : t.entry - t.origDistance * mult;
      const simPnl = walkWiderTarget(t, widerTarget);
      return { date: t.trade_date, delta: simPnl - t.baselinePnl };
    });
    globalByMult[mult] = summarize(events.map(e => e.delta));
  }

  // === Report ===
  console.log('\n=== GLOBAL POOLED (single percentile/mult applied to every test trade) ===');
  console.log(`Train N=${globalTrain.length}, Test N=${globalTest.length}`);
  for (const p of PERCENTILES) {
    const r = globalByPercentile[p];
    console.log(`  MFE p${p} (${r.mfeDistPoints.toFixed(1)}pt target dist): N=${r.n} mean=$${r.mean.toFixed(2)} median=$${r.median.toFixed(2)} neg=${r.negCount}/${r.n} rigor.clean=${r.rigor.clean} rigor.stable=${r.rigor.stable}`);
  }
  for (const mult of REFERENCE_MULTS) {
    const r = globalByMult[mult];
    console.log(`  ${mult}x mult (reference): N=${r.n} mean=$${r.mean.toFixed(2)} median=$${r.median.toFixed(2)} neg=${r.negCount}/${r.n}`);
  }

  console.log('\n=== PER-GROUP (setup_type if N>=20, else bet_class) ===');
  for (const [groupName, r] of Object.entries(groupResults)) {
    if (r.thin) {
      console.log(`  ${groupName}: THIN (train=${r.trainN}, test=${r.testN}, need >=${MIN_GROUP_TRAIN}/${MIN_GROUP_TEST})`);
      continue;
    }
    console.log(`  ${groupName} (train=${r.trainN}, test=${r.testN}):`);
    for (const p of PERCENTILES) {
      const pr = r.byPercentile[p];
      console.log(`    MFE p${p} (${pr.mfeDistPoints.toFixed(1)}pt): mean=$${pr.mean.toFixed(2)} neg=${pr.negCount}/${pr.n} rigor.clean=${pr.rigor.clean}`);
    }
    for (const mult of REFERENCE_MULTS) {
      const mr = r.byMult[mult];
      console.log(`    ${mult}x mult: mean=$${mr.mean.toFixed(2)} neg=${mr.negCount}/${mr.n}`);
    }
  }

  // === Record the claim ===
  const groupLines = Object.entries(groupResults).map(([g, r]) => {
    if (r.thin) return `${g}: THIN (train=${r.trainN},test=${r.testN})`;
    const best = PERCENTILES.map(p => ({ p, ...r.byPercentile[p] })).sort((a, b) => b.mean - a.mean)[0];
    const bestMult = REFERENCE_MULTS.map(m => ({ m, ...r.byMult[m] })).sort((a, b) => b.mean - a.mean)[0];
    return `${g} (test N=${r.testN}): best percentile=p${best.p} mean=$${best.mean.toFixed(2)} (clean=${best.rigor.clean}) vs best mult=${bestMult.m}x mean=$${bestMult.mean.toFixed(2)}`;
  }).join('; ');

  const globalBest = PERCENTILES.map(p => ({ p, ...globalByPercentile[p] })).sort((a, b) => b.mean - a.mean)[0];
  const globalBestMult = REFERENCE_MULTS.map(m => ({ m, ...globalByMult[m] })).sort((a, b) => b.mean - a.mean)[0];

  const claimText = `MFE-percentile wider-target (p25/50/75/90, points-from-entry, train-derived/test-evaluated 60/40 chronological split) vs the live 1.5x-of-T1-distance multiplier and the leading-but-undeployed 2.5x candidate from wider_target_multiplier_calibration, same armed-trade population (T1 touched within ${MAX_BARS_TO_T1_FOR_WIDER} bars, N=${armed.length} total).
GLOBAL POOLED (single number applied across all setup_types, test N=${globalTest.length}): best percentile=p${globalBest.p} (${globalBest.mfeDistPoints.toFixed(1)}pt) mean=$${globalBest.mean.toFixed(2)} neg=${globalBest.negCount}/${globalBest.n} rigor.clean=${globalBest.rigor.clean} vs best mult=${globalBestMult.m}x mean=$${globalBestMult.mean.toFixed(2)} neg=${globalBestMult.negCount}/${globalBestMult.n}.
PER-GROUP (setup_type N>=20 else bet_class pooled): ${groupLines}.
Methodology: percentiles computed on TRAIN only (chronological, first ${TRAIN_FRACTION * 100}%), evaluated on held-out TEST; MFE measured as peak favorable excursion in points-from-entry walking forward from the T1-touch bar under the original (never-moved) stop, matching the live-wired arm's own risk shape. Reused the real stepWiderTarget() walker for every candidate, not reimplemented.
NOT wired live, descriptive/comparative only. Directly answers the user's own flagged concern (2026-08-24): whether a single global MFE number transfers across setup_types with different move scales vs a multiplier that auto-scales via each type's own T1 distance -- see per-group vs global comparison above.`;

  await recordClaim({
    slug: 'wider_target_mfe_percentile_vs_multiplier',
    claimText,
    sourceFile: 'scripts/backtest_wider_target_mfe_percentile.mjs',
    sampleSize: armed.length,
    winRate: globalBest.posCount / globalBest.n,
    evPerTrade: globalBest.mean,
    rigorStatus: `stable=${globalBest.rigor.stable} clustered=${globalBest.rigor.clustered} clean=${globalBest.rigor.clean}`,
    status: 'PROVISIONAL',
  });

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
