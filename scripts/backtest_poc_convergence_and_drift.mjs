// scripts/backtest_poc_convergence_and_drift.mjs
// Signal-level pre-tests for scratch/poc_convergence_and_drift_spec_v1.md, Parts A+B.
// No stop, no target, no trade machinery -- raw NQ point forward returns only.
//
// Rewritten from scratch by Claude 2026-08-21 after a Gemini dispatch produced a broken,
// partially-fabricated result: the saved script crashed on a nonexistent computeRigor()
// field (`tercilePnl` -- the real field is `thirds`), Part B never ran through the real
// spec'd path at all, and the two recordClaim() rows that got persisted anyway included a
// hand-typed literal for Part A's claimText that was never actually computed by the saved
// script. Both rows were deleted from performance_audit before this rewrite. See
// docs/OPEN_THREADS.md's 2026-08-20/21 entry for the full incident writeup.

import { query } from '../server/db.js';
import { computeProfile, getRollingDrift } from '../server/services/developingValueService.js';
import { getGlobex24hrBars } from '../server/services/queries.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const TICK = 0.25;
const RTH_START = 570, RTH_END = 959; // ET minute-of-day, matches developingValueService.js

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function stddev(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function percentile(sorted, p) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
function statStr(a) { const m = mean(a), s = stddev(a); return `mean=${m?.toFixed(2) ?? 'n/a'} sd=${s?.toFixed(2) ?? 'n/a'} N=${a.length}`; }
// r.ts is a JS Date from node-pg's naive-timestamp OID-1114 parser (db.js) -- the naive ET
// wall-clock value is encoded as if it were UTC, so reading UTC fields back out gives the
// original ET hour/minute directly. Matches this codebase's standing convention.
function etMinuteOfDay(ts) { const d = new Date(ts); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

async function main() {
  const dvl = (await query(`SELECT trade_date::text as t, poc::float, migration_dir_vs_prior FROM developing_value_log ORDER BY trade_date ASC`)).rows;
  const dates = dvl.map(r => r.t);
  const dateIdx = new Map(dates.map((d, i) => [d, i]));

  const rthRows = (await query(`
    SELECT ts::date::text as d,
      (array_agg(open::float ORDER BY ts ASC))[1] as rth_open,
      (array_agg(close::float ORDER BY ts DESC))[1] as rth_close
    FROM price_bars_primary
    WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN ${RTH_START} AND ${RTH_END}
    GROUP BY 1
  `)).rows;
  const rthByDate = new Map(rthRows.map(r => [r.d, { open: r.rth_open, close: r.rth_close }]));

  function fwdReturn(anchorOpenDate, closeAtIdx) {
    if (closeAtIdx >= dates.length) return null;
    const openPx = rthByDate.get(anchorOpenDate)?.open;
    const closePx = rthByDate.get(dates[closeAtIdx])?.close;
    return (openPx != null && closePx != null) ? closePx - openPx : null;
  }

  // ================= PART A: 24hr-vs-RTH POC convergence =================
  console.log('\n=== PART A: 24hr-vs-RTH POC convergence ===');
  const partA = [];
  let skippedProfileNull = 0, skippedThinBars = 0;
  for (const row of dvl) {
    const raw = await getGlobex24hrBars(row.t);
    if (raw.length < 50) { skippedThinBars++; continue; }
    const bars = raw.map(r => ({ high: r.high, low: r.low, volume: Number(r.volume) }));
    const profile = computeProfile(bars);
    if (!profile) { skippedProfileNull++; continue; }
    if (row.poc == null) continue;
    let rthVol = 0, totalVol = 0;
    for (const r of raw) { const v = Number(r.volume); totalVol += v; if (etMinuteOfDay(r.ts) >= RTH_START && etMinuteOfDay(r.ts) <= RTH_END) rthVol += v; }
    partA.push({ t: row.t, poc24: profile.poc, pocRTH: row.poc, d_t: Math.abs(profile.poc - row.poc), globexShare: totalVol > 0 ? 1 - rthVol / totalVol : null });
  }
  console.log(`Part A valid rows: ${partA.length} (skipped: ${skippedThinBars} thin-bars, ${skippedProfileNull} profile-null)`);

  const splitA = Math.floor(partA.length * 0.7);
  const trainA = partA.slice(0, splitA), testA = partA.slice(splitA);
  const thresholdA = Math.max(TICK, percentile(trainA.map(x => x.d_t).sort((a, b) => a - b), 0.25));
  console.log(`Threshold (train p25, floor=${TICK}): ${thresholdA.toFixed(2)}`);

  for (const row of testA) {
    const i = dateIdx.get(row.t);
    row.ret1 = fwdReturn(dates[i + 1], i + 1);
    row.ret5 = fwdReturn(dates[i + 1], i + 5);
    row.converged = row.d_t <= thresholdA;
  }
  const evalA = testA.filter(r => r.ret1 != null);
  const dSortedTest = evalA.map(r => r.d_t).sort((a, b) => a - b);
  const farDivergedCut = percentile(dSortedTest, 0.75);

  const uncond1 = evalA.map(r => r.ret1), uncond1Mag = uncond1.map(Math.abs);
  const conv1 = evalA.filter(r => r.converged).map(r => r.ret1), conv1Mag = conv1.map(Math.abs);
  const far1 = evalA.filter(r => r.d_t >= farDivergedCut).map(r => r.ret1);
  console.log(`\nHorizon 1 (close_t+1 - open_t+1):`);
  console.log(`  Unconditional: ${statStr(uncond1)} | Magnitude: ${statStr(uncond1Mag)}`);
  console.log(`  Converged:     ${statStr(conv1)} | Magnitude: ${statStr(conv1Mag)}`);
  console.log(`  Far-diverged:  ${statStr(far1)}`);

  const evalA5 = testA.filter(r => r.ret5 != null);
  const uncond5 = evalA5.map(r => r.ret5), conv5 = evalA5.filter(r => r.converged).map(r => r.ret5);
  console.log(`\nHorizon 5 (close_t+5 - open_t+1):`);
  console.log(`  Unconditional: ${statStr(uncond5)}`);
  console.log(`  Converged:     ${statStr(conv5)}`);

  const gShares = evalA.filter(r => r.converged && r.globexShare != null).map(r => r.globexShare).sort((a, b) => a - b);
  const gT1 = percentile(gShares, 1 / 3), gT2 = percentile(gShares, 2 / 3);
  const convByTercile = { low: [], mid: [], high: [] };
  for (const r of evalA) { if (!r.converged || r.globexShare == null) continue; const b = r.globexShare <= gT1 ? 'low' : r.globexShare <= gT2 ? 'mid' : 'high'; convByTercile[b].push(r.ret1); }
  console.log(`\nGlobex-share terciles (converged bucket, horizon 1):`);
  for (const k of ['low', 'mid', 'high']) console.log(`  ${k}: ${statStr(convByTercile[k])}`);

  const uncondMean1 = mean(uncond1), uncondSd1 = stddev(uncond1);
  const deltaRowsA = evalA.filter(r => r.converged).map(r => ({ t: r.t, delta: r.ret1 - uncondMean1 }));
  const rigorA = computeRigor(deltaRowsA, { dateField: 't', pnlFn: r => r.delta });
  console.log(`\nRigor (converged-minus-unconditional delta, H1): clean=${rigorA.clean} stable=${rigorA.stable} thirds=${JSON.stringify(rigorA.thirds)}`);

  // Kill criteria A
  const convMean1 = mean(conv1);
  const kA1_noSignal = uncondSd1 == null || Math.abs(convMean1 - uncondMean1) <= uncondSd1;
  const kA2_rigorFail = rigorA.stable === false;
  const kA3_globexOnly = convByTercile.low.length > 0 && mean(convByTercile.low) != null &&
    Math.sign(mean(convByTercile.low)) === Math.sign(convMean1 - uncondMean1) &&
    (mean(convByTercile.mid) == null || Math.sign(mean(convByTercile.mid)) !== Math.sign(convMean1 - uncondMean1)) &&
    (mean(convByTercile.high) == null || Math.sign(mean(convByTercile.high)) !== Math.sign(convMean1 - uncondMean1));
  const kA4_thin = conv1.length < 30;
  const magSeparates = !kA1_noSignal ? false : Math.abs(mean(conv1Mag) - mean(uncond1Mag)) > (stddev(uncond1Mag) ?? Infinity);
  console.log(`\nKill criteria A: K1(noSignal)=${kA1_noSignal} K2(rigorFail)=${kA2_rigorFail} K3(globexOnly, informational)=${kA3_globexOnly} K4(thin,N=${conv1.length})=${kA4_thin} magnitudeOnly=${magSeparates}`);

  // ================= PART B: rolling drift as predictive signal =================
  console.log('\n=== PART B: rolling 5/10/20-day POC drift ===');
  const partB = [];
  for (let i = 0; i < dvl.length; i++) {
    const t = dvl[i].t;
    const drifts = await getRollingDrift(t, [5, 10, 20]);
    // Explicit prior-session count = array index i (dvl is the full chronological
    // developing_value_log, so i IS the exact count of persisted rows before t -- equivalent
    // to a real COUNT(*) query, per F5's requirement not to trust getRollingDrift's own
    // available/n fields, which use a fixed Math.min(w,5) floor regardless of w).
    const priorCount = i;
    const streak = i >= 2 ? [dvl[i - 1].migration_dir_vs_prior, dvl[i - 2].migration_dir_vs_prior] : [];
    const rets = {};
    for (const h of [1, 5, 10, 20]) rets[h] = fwdReturn(t, i + h);
    partB.push({ t, priorCount, drifts, streak, rets });
  }
  const splitB = Math.floor(partB.length * 0.7);
  const trainB = partB.slice(0, splitB), testB = partB.slice(splitB);

  // getRollingDrift's return shape (developingValueService.js): { available, drift, ... } --
  // `drift` is the BUILDING HIGHER/LOWER/BALANCING label, only meaningful when available=true.
  function labelOf(row, w) { const d = row.drifts?.[w]; return d?.available ? d.drift : null; }

  for (const h of [1, 5, 10, 20]) {
    const rows = testB.filter(r => r.rets[h] != null && r.priorCount >= 6);
    const uncond = rows.map(r => r.rets[h]);
    const hi = rows.filter(r => labelOf(r, 5) === 'BUILDING HIGHER').map(r => r.rets[h]);
    const lo = rows.filter(r => labelOf(r, 5) === 'BUILDING LOWER').map(r => r.rets[h]);
    const bal = rows.filter(r => labelOf(r, 5) === 'BALANCING').map(r => r.rets[h]);
    console.log(`\nHorizon ${h} (w=5 label, close_t+${h} - open_t):`);
    console.log(`  Unconditional:   ${statStr(uncond)}`);
    console.log(`  BUILDING HIGHER: ${statStr(hi)}`);
    console.log(`  BUILDING LOWER:  ${statStr(lo)}`);
    console.log(`  BALANCING:       ${statStr(bal)}`);
  }

  // computeReplication across w=5/10/20 -- units must be pre-grouped (one unit per window),
  // metricFn is called once per unit, not per raw row (the bug in the discarded version).
  const windowUnits = [5, 10, 20].map(w => {
    const rows = trainB.filter(r => r.rets[1] != null && r.priorCount >= w + 1);
    const hi = rows.filter(r => labelOf(r, w) === 'BUILDING HIGHER').map(r => r.rets[1]);
    const lo = rows.filter(r => labelOf(r, w) === 'BUILDING LOWER').map(r => r.rets[1]);
    return { w, n: hi.length + lo.length, value: (mean(hi) ?? 0) - (mean(lo) ?? 0) };
  });
  const bestW = windowUnits.reduce((best, u) => Math.abs(u.value) > Math.abs(best.value) ? u : best, windowUnits[0]).w;
  const testWindowUnits = [5, 10, 20].map(w => {
    const rows = testB.filter(r => r.rets[1] != null && r.priorCount >= w + 1);
    const hi = rows.filter(r => labelOf(r, w) === 'BUILDING HIGHER').map(r => r.rets[1]);
    const lo = rows.filter(r => labelOf(r, w) === 'BUILDING LOWER').map(r => r.rets[1]);
    return { w, n: hi.length + lo.length, value: (mean(hi) ?? 0) - (mean(lo) ?? 0) };
  });
  const repB = computeReplication(testWindowUnits, { idFn: u => u.w, metricFn: u => ({ n: u.n, value: u.value }), selectedIds: [bestW] });
  console.log(`\nReplication across windows (best-on-train=w${bestW}): replicates=${repB.replicates} selected=${JSON.stringify(repB.selectedPooled)} heldOut=${JSON.stringify(repB.heldOutPooled)} heldOutFavorableFrac=${repB.heldOutFavorableFrac}`);

  const w5Rows = testB.filter(r => r.rets[1] != null && r.priorCount >= 6 && ['BUILDING HIGHER', 'BUILDING LOWER'].includes(labelOf(r, 5)));
  const rigorEventsB = w5Rows.map(r => ({ t: r.t, val: labelOf(r, 5) === 'BUILDING HIGHER' ? r.rets[1] : -r.rets[1] }));
  const rigorB = computeRigor(rigorEventsB, { dateField: 't', pnlFn: r => r.val });
  console.log(`Rigor (w=5, sign-adjusted H1): clean=${rigorB.clean} stable=${rigorB.stable} thirds=${JSON.stringify(rigorB.thirds)}`);

  const hiTest5 = testB.filter(r => r.rets[1] != null && labelOf(r, 5) === 'BUILDING HIGHER').map(r => r.rets[1]);
  const loTest5 = testB.filter(r => r.rets[1] != null && labelOf(r, 5) === 'BUILDING LOWER').map(r => r.rets[1]);
  const uncondTest1 = testB.filter(r => r.rets[1] != null).map(r => r.rets[1]);
  const uncondMeanB = mean(uncondTest1), uncondSdB = stddev(uncondTest1);
  const kB1_noSeparation = uncondSdB == null || (Math.abs(mean(hiTest5) - uncondMeanB) <= uncondSdB && Math.abs(mean(loTest5) - uncondMeanB) <= uncondSdB);
  const kB2_rigorFail = rigorB.stable === false;
  const kB3_noReplicate = !repB.replicates;
  console.log(`\nKill criteria B: K1(noSeparation)=${kB1_noSeparation} K2(rigorFail)=${kB2_rigorFail} K3(noReplicate)=${kB3_noReplicate}`);

  console.log('\n=== Secondary: 2-day migration_dir_vs_prior streak (live gate mechanism) ===');
  const streakRows = testB.filter(r => r.rets[1] != null && r.streak.length === 2 && r.streak[0] && r.streak[1]);
  const hh = streakRows.filter(r => r.streak[0] === 'HIGHER' && r.streak[1] === 'HIGHER').map(r => r.rets[1]);
  const ll = streakRows.filter(r => r.streak[0] === 'LOWER' && r.streak[1] === 'LOWER').map(r => r.rets[1]);
  const mixed = streakRows.filter(r => !(r.streak[0] === 'HIGHER' && r.streak[1] === 'HIGHER') && !(r.streak[0] === 'LOWER' && r.streak[1] === 'LOWER')).map(r => r.rets[1]);
  console.log(`HIGHER/HIGHER streak: ${statStr(hh)}`);
  console.log(`LOWER/LOWER streak:   ${statStr(ll)}`);
  console.log(`Mixed/HOLDING:        ${statStr(mixed)}`);

  // ================= Persist =================
  const statusA = (!kA1_noSignal && !kA2_rigorFail && !kA4_thin) ? 'CONFIRMED' : 'REJECTED';
  const statusB = (!kB1_noSeparation && !kB2_rigorFail && !kB3_noReplicate) ? 'CONFIRMED' : 'REJECTED';

  await recordClaim({
    slug: 'poc_24hr_rth_convergence_forward_return',
    claimText: `N=${partA.length} (train ${trainA.length}/test ${testA.length}; skipped ${skippedThinBars} thin-bars, ${skippedProfileNull} profile-null). Threshold (train p25, floor ${TICK}pt): ${thresholdA.toFixed(2)}pt. Test converged N=${conv1.length}. H1 signed: unconditional ${uncondMean1?.toFixed(2)} (sd ${uncondSd1?.toFixed(2)}), converged ${convMean1?.toFixed(2)}. H5 signed: unconditional ${mean(uncond5)?.toFixed(2)}, converged ${mean(conv5)?.toFixed(2)}. Rigor stable=${rigorA.stable}. Kill criteria: K1(no directional signal)=${kA1_noSignal}, K2(rigor fail)=${kA2_rigorFail}, K4(thin, N=${conv1.length})=${kA4_thin}. Globex-tercile check (K3, informational): low=${mean(convByTercile.low)?.toFixed(2) ?? 'n/a'} mid=${mean(convByTercile.mid)?.toFixed(2) ?? 'n/a'} high=${mean(convByTercile.high)?.toFixed(2) ?? 'n/a'}. Magnitude-only separation=${magSeparates}. Verdict: ${statusA === 'CONFIRMED' ? 'converged sessions show a real, rigor-stable forward-return separation from unconditional' : 'no robust directional edge -- clean negative'}.`,
    sourceFile: 'scripts/backtest_poc_convergence_and_drift.mjs',
    sampleSize: partA.length,
    winRate: null,
    evPerTrade: null,
    rigorStatus: `stable=${rigorA.stable} clustered=${rigorA.clustered}`,
    status: statusA,
  });

  await recordClaim({
    slug: 'poc_rolling_drift_predictive_signal',
    claimText: `N=${partB.length} (train ${trainB.length}/test ${testB.length}). Primary w=5, H1 signed: unconditional ${uncondMeanB?.toFixed(2)} (sd ${uncondSdB?.toFixed(2)}), BUILDING HIGHER ${mean(hiTest5)?.toFixed(2)} (N=${hiTest5.length}), BUILDING LOWER ${mean(loTest5)?.toFixed(2)} (N=${loTest5.length}). Replication across w=5/10/20 (best-on-train=w${bestW}): replicates=${repB.replicates}, heldOutFavorableFrac=${repB.heldOutFavorableFrac}. Rigor stable=${rigorB.stable}. Kill criteria: K1(no separation)=${kB1_noSeparation}, K2(rigor fail)=${kB2_rigorFail}, K3(no replication)=${kB3_noReplicate}. Secondary 2-day migration_dir_vs_prior streak (the live C_STANDALONE_POC_COUNTER gate's actual mechanism): HIGHER/HIGHER ${mean(hh)?.toFixed(2) ?? 'n/a'} (N=${hh.length}), LOWER/LOWER ${mean(ll)?.toFixed(2) ?? 'n/a'} (N=${ll.length}), mixed ${mean(mixed)?.toFixed(2) ?? 'n/a'} (N=${mixed.length}). Verdict: ${statusB === 'CONFIRMED' ? 'rolling POC drift shows a real, replicating forward-return signal' : 'no robust predictive edge -- clean negative; the live gate\'s 54.2%/41.5% comment remains unvalidated by this test'}.`,
    sourceFile: 'scripts/backtest_poc_convergence_and_drift.mjs',
    sampleSize: partB.length,
    winRate: null,
    evPerTrade: null,
    rigorStatus: `stable=${rigorB.stable} replicates=${repB.replicates}`,
    status: statusB,
  });

  console.log(`\nPersisted: Part A status=${statusA}, Part B status=${statusB}`);
  console.log('DONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
