// User question, 2026-09-22: instead of a separate gauge (Expand/Vol Watch, both tested in
// research_overnight_orderflow_regime_exit.mjs, both negative for this purpose), use the
// STRENGTH of the same 6pm-9pm bid/ask split that already decides the trade's DIRECTION as a
// conviction/regime read -- e.g. an 80/20 split feels like more conviction than a 52/48 one, so
// maybe it also predicts which nights turn into the big trend days research_overnight_orderflow_
// trail_exit.mjs found the whole edge depends on.
//
// This is a genuinely different candidate than Expand: Expand measures "is a lot of volume
// showing up," skew measures "how one-sided is the volume that IS showing up" -- a session
// could have huge volume split 55/45 (weak skew, strong Expand) or modest volume split 85/15
// (strong skew, weak Expand). Worth testing independently, not assumed to behave like Expand
// just because both come from the same underlying bar data.
//
// Reuses fetchTrades()'s real N=53 population + its own share9pm field (added alongside this
// script) -- no reimplementation of the direction/skew calc, per "export the real function."
import { fetchTrades } from './calibrate_overnight_orderflow_entry.mjs';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const DOLLAR_PER_PT = 2, COMMISSION = 2;
const BASELINE_STOP = 700, BASELINE_EXIT = '13:30';
const TRAIL_ARM = 150, TRAIL_WIDTH = 80; // the best cell from research_overnight_orderflow_trail_exit.mjs

function simBaseline(t) {
  const mae = t.maeAtExitIdx[BASELINE_EXIT];
  if (mae >= BASELINE_STOP) return -BASELINE_STOP;
  return (t.priceAtExit(BASELINE_EXIT) - t.entryPrice) * t.direction;
}

function simTrail(t, bars) {
  const long = t.direction === 1;
  let armed = false, peak = null, stop = long ? t.entryPrice - BASELINE_STOP : t.entryPrice + BASELINE_STOP;
  const exitIdx = t.exitIdxByTime[BASELINE_EXIT];
  for (let i = t.entryIdx; i <= exitIdx; i++) {
    const b = bars[i];
    if (!b) continue;
    if (!armed) {
      const stopHit = long ? b.low <= stop : b.high >= stop;
      if (stopHit) return -BASELINE_STOP;
      const favorableExtreme = long ? b.high - t.entryPrice : t.entryPrice - b.low;
      if (favorableExtreme >= TRAIL_ARM) {
        armed = true; peak = long ? b.high : b.low; stop = t.entryPrice;
        const sameBar = long ? b.low <= stop : b.high >= stop;
        if (sameBar) return 0;
      }
      continue;
    }
    if (long && b.high > peak) peak = b.high;
    if (!long && b.low < peak) peak = b.low;
    const candidateStop = long ? peak - TRAIL_WIDTH : peak + TRAIL_WIDTH;
    if (long && candidateStop > stop) stop = candidateStop;
    if (!long && candidateStop < stop) stop = candidateStop;
    const trailHit = long ? b.low <= stop : b.high >= stop;
    if (trailHit) return (stop - t.entryPrice) * t.direction;
  }
  return (t.priceAtExit(BASELINE_EXIT) - t.entryPrice) * t.direction;
}

function dollarSummary(captures, dates, label) {
  const dollars = captures.map((c) => c * DOLLAR_PER_PT - COMMISSION);
  const mean = dollars.reduce((a, b) => a + b, 0) / dollars.length;
  const ci = dayBlockedBootstrapCI(dates.map((date, i) => ({ date, pnl: captures[i] })), `skew_${label}`, { dateField: 'date' });
  return { label, n: captures.length, meanDollarPerDay: +mean.toFixed(2), ci: { lo: +ci.lo.toFixed(1), hi: +ci.hi.toFixed(1) } };
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  return num / Math.sqrt(dx2 * dy2);
}

async function main() {
  const { trades, bars } = await fetchTrades();
  const n = trades.length;
  console.log(`Population: N=${n}\n`);

  const skewMag = trades.map((t) => Math.abs(t.share9pm - 0.5)); // 0 = dead even, 0.5 = fully one-sided
  const mfe = trades.map((t) => t.mfeAtExitIdx[BASELINE_EXIT]);
  console.log('skewMag range:', Math.min(...skewMag).toFixed(3), 'to', Math.max(...skewMag).toFixed(3), '| median:', [...skewMag].sort((a, b) => a - b)[Math.floor(n / 2)].toFixed(3));

  const corrMfe = pearson(skewMag, mfe);
  console.log(`\nPearson corr(6pm-9pm skew magnitude, eventual MFE by ${BASELINE_EXIT}) = ${corrMfe.toFixed(3)} (N=${n})`);

  // Also check the more direct question: does a STRONGER skew predict a higher HIT RATE (the
  // direction call itself being more reliable), separate from move SIZE.
  const captures = trades.map(simBaseline);
  const corrHit = pearson(skewMag, captures.map((c) => (c > 0 ? 1 : 0)));
  console.log(`Pearson corr(skew magnitude, trade won [0/1]) = ${corrHit.toFixed(3)}`);

  const sorted = trades.map((t, i) => ({ ...t, skewMag: skewMag[i] })).sort((a, b) => a.skewMag - b.skewMag);
  const half = Math.floor(n / 2);
  const weakGroup = sorted.slice(0, half), strongGroup = sorted.slice(n - half);
  const meanMfeWeak = weakGroup.reduce((s, t) => s + t.mfeAtExitIdx[BASELINE_EXIT], 0) / weakGroup.length;
  const meanMfeStrong = strongGroup.reduce((s, t) => s + t.mfeAtExitIdx[BASELINE_EXIT], 0) / strongGroup.length;
  console.log(`\nWEAK-skew half (n=${weakGroup.length}, skewMag<median): mean MFE = ${meanMfeWeak.toFixed(1)}pt`);
  console.log(`STRONG-skew half (n=${strongGroup.length}, skewMag>=median): mean MFE = ${meanMfeStrong.toFixed(1)}pt`);
  const weakHitRate = 100 * weakGroup.filter((t) => simBaseline(t) > 0).length / weakGroup.length;
  const strongHitRate = 100 * strongGroup.filter((t) => simBaseline(t) > 0).length / strongGroup.length;
  console.log(`WEAK-skew hit rate: ${weakHitRate.toFixed(1)}% | STRONG-skew hit rate: ${strongHitRate.toFixed(1)}%`);

  console.log('\nRegime-conditioned exit: trail on WEAK-skew (low-conviction) nights, hold flat on STRONG-skew nights.');
  console.log(`  NOTE: real skewMag never exceeds ${Math.max(...skewMag).toFixed(3)} in this population -- an arbitrary absolute cutoff (e.g. 0.15) would silently put every trade in one bucket. Using the median split (already computed above) as the actual regime boundary instead.`);
  const flatAll = dollarSummary(captures, trades.map((t) => t.tDay), 'flat_all');
  console.log('  Flat-always baseline:', flatAll);
  const medianSkew = [...skewMag].sort((a, b) => a - b)[Math.floor(n / 2)];
  const regimeCaptures = trades.map((t, i) => (skewMag[i] < medianSkew ? simTrail(t, bars) : simBaseline(t)));
  const regime = dollarSummary(regimeCaptures, trades.map((t) => t.tDay), 'skew_regime_conditioned');
  console.log(`  Regime-conditioned (trail if skewMag < median ${medianSkew.toFixed(3)} else flat):`, regime);

  const verdict = regime.meanDollarPerDay > flatAll.meanDollarPerDay ? 'IMPROVES' : 'DOES_NOT_IMPROVE';
  console.log(`\nVerdict: skew-conditioned exit ${verdict} on flat-always (delta $${(regime.meanDollarPerDay - flatAll.meanDollarPerDay).toFixed(2)}/day)`);

  await recordClaim({
    slug: 'overnight_orderflow_skew_magnitude_regime_20260922',
    claimText: `User question (2026-09-22): does the STRENGTH (not just direction) of the same 6pm-9pm bid/ask volume split already used to pick direction ALSO predict which nights become the big trend days (a conviction read, distinct from the already-tested-and-negative Expand/Vol Watch gauges in overnight_orderflow_expand_regime_exit_20260922)? Tested against the real N=${n} population: Pearson corr(skew magnitude |share9pm-0.5|, eventual MFE by ${BASELINE_EXIT}) = ${corrMfe.toFixed(3)}; corr(skew magnitude, trade won) = ${corrHit.toFixed(3)}. WEAK-skew half (n=${weakGroup.length}) mean MFE=${meanMfeWeak.toFixed(1)}pt/hitRate=${weakHitRate.toFixed(1)}% vs STRONG-skew half (n=${strongGroup.length}) mean MFE=${meanMfeStrong.toFixed(1)}pt/hitRate=${strongHitRate.toFixed(1)}%. Real skewMag never exceeds ${Math.max(...skewMag).toFixed(3)} in this population -- direction is decided by a very thin margin most nights, despite the signal's real 64-68% overall hit rate. Regime-conditioned exit (trail only when skewMag below the median ${medianSkew.toFixed(3)}, flat otherwise) vs flat-always: $${regime.meanDollarPerDay}/day vs $${flatAll.meanDollarPerDay}/day (delta $${(regime.meanDollarPerDay - flatAll.meanDollarPerDay).toFixed(2)}/day). Verdict: ${verdict}. N=53 is thin for a within-population split like this -- treat as a first look.`,
    sourceFile: 'scripts/research_overnight_orderflow_skew_regime.mjs',
    sourceDate: '2026-09-22',
    sampleSize: n,
    winRate: null,
    evPerTrade: regime.meanDollarPerDay - flatAll.meanDollarPerDay,
    rigorStatus: `n=${n}_thin_single_split_no_holdout`,
    status: 'PROVISIONAL',
  });
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
