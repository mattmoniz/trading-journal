// User question, 2026-09-22: as OVERNIGHT_ORDERFLOW_LONG/SHORT approaches its exit (it has no
// price target -- holds to a calibrated clock time, currently 13:30 ET -- so "approaching the
// target" is read here as "approaching the exit time"), can the system check whether the SAME
// side (ask/bid) that originally predicted the move is STILL winning right now, and use that
// as either an early-exit trigger (bail if it's flipped) or a hold-longer signal (stay in if
// it's still confirming)?
//
// RELEVANT PRIOR, not a direct match: RESEARCH_CLAIM directional_orderflow_ride_no_stop_negative_
// 20260921 tested "does live one-sided Globex order flow predict continuation" for a general
// population and found the opposite -- heavy one-sided volume more often marks exhaustion than
// continuation. That test was about ENTERING fresh off a live imbalance reading, general Globex
// population, no existing position. This is different: a position ALREADY open (this exact,
// already-directionally-validated N=53 population), checking whether order flow SHORTLY BEFORE
// the exit still agrees with the ORIGINAL entry direction -- worth testing on its own rather
// than assuming the prior negative transfers.
//
// Reuses fetchTrades()'s real population + the underlying continuous `bars` array (same symbol/
// data as every other script in this thread) -- no reimplementation.
import { fetchTrades } from './calibrate_overnight_orderflow_entry.mjs';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const DOLLAR_PER_PT = 2, COMMISSION = 2;
const BASELINE_STOP = 700, BASELINE_EXIT = '13:30';
// Must be one of EXIT_TIME_CANDIDATES (calibrate_overnight_orderflow_entry.mjs) since
// exitIdxByTime is only pre-computed for those -- '12:30' is the closest available to "an hour
// before the 13:30 exit."
const CHECK_TIME = '12:30';
const LOOKBACK_MIN = 30; // order-flow read window ending at CHECK_TIME

function simBaseline(t) {
  const mae = t.maeAtExitIdx[BASELINE_EXIT];
  if (mae >= BASELINE_STOP) return -BASELINE_STOP;
  return (t.priceAtExit(BASELINE_EXIT) - t.entryPrice) * t.direction;
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

  const rows = [];
  for (const t of trades) {
    const stopHitByCheck = t.maeAtExitIdx[CHECK_TIME] >= BASELINE_STOP;
    if (stopHitByCheck) continue; // already stopped out before the checkpoint -- N/A for this question

    const checkIdx = t.exitIdxByTime[CHECK_TIME];
    let ask = 0, bid = 0;
    for (let i = checkIdx - LOOKBACK_MIN; i <= checkIdx; i++) {
      const b = bars[i];
      if (b) { ask += b.ask_volume; bid += b.bid_volume; }
    }
    const shareAtCheck = (ask + bid) > 0 ? ask / (ask + bid) : 0.5;
    // "Still agrees" means the SAME side that predicted the ORIGINAL direction is still winning.
    const stillAgrees = t.direction === 1 ? shareAtCheck > 0.5 : shareAtCheck < 0.5;
    const skewAtCheck = t.direction === 1 ? (shareAtCheck - 0.5) : (0.5 - shareAtCheck); // positive = confirming, negative = flipped

    const priceAtCheck = bars[checkIdx].close;
    const pnlAtCheck = (priceAtCheck - t.entryPrice) * t.direction;
    const finalPnl = simBaseline(t);
    const remainingCapture = finalPnl - pnlAtCheck; // what happened from checkpoint to exit

    rows.push({ tDay: t.tDay, stillAgrees, skewAtCheck, pnlAtCheck, finalPnl, remainingCapture });
  }
  console.log(`${rows.length}/${n} trades still open (not stopped out) at ${CHECK_TIME}\n`);

  const corr = pearson(rows.map((r) => r.skewAtCheck), rows.map((r) => r.remainingCapture));
  console.log(`Pearson corr(order-flow skew AT ${CHECK_TIME} in the trade's favor, remaining capture ${CHECK_TIME}->${BASELINE_EXIT}) = ${corr.toFixed(3)} (N=${rows.length})`);

  const agree = rows.filter((r) => r.stillAgrees), flip = rows.filter((r) => !r.stillAgrees);
  const meanRemAgree = agree.reduce((s, r) => s + r.remainingCapture, 0) / agree.length;
  const meanRemFlip = flip.length ? flip.reduce((s, r) => s + r.remainingCapture, 0) / flip.length : null;
  console.log(`\nSTILL AGREES (n=${agree.length}): mean remaining capture ${CHECK_TIME}->exit = ${meanRemAgree.toFixed(1)}pt`);
  console.log(`FLIPPED (n=${flip.length}): mean remaining capture ${CHECK_TIME}->exit = ${meanRemFlip != null ? meanRemFlip.toFixed(1) : 'N/A'}pt`);

  // Test as an actual rule: exit early at CHECK_TIME price if flipped, otherwise hold to the
  // normal exit -- compare against holding everyone to the normal exit regardless.
  const dates = rows.map((r) => r.tDay);
  const holdAllCaptures = rows.map((r) => r.finalPnl);
  const earlyExitCaptures = rows.map((r) => (r.stillAgrees ? r.finalPnl : r.pnlAtCheck));

  function summarize(captures, label) {
    const dollars = captures.map((c) => c * DOLLAR_PER_PT - COMMISSION);
    const mean = dollars.reduce((a, b) => a + b, 0) / dollars.length;
    const ci = dayBlockedBootstrapCI(dates.map((date, i) => ({ date, pnl: captures[i] })), `exitconf_${label}`, { dateField: 'date' });
    return { label, n: captures.length, meanDollarPerDay: +mean.toFixed(2), ci: { lo: +ci.lo.toFixed(1), hi: +ci.hi.toFixed(1) } };
  }
  const holdAll = summarize(holdAllCaptures, 'hold_all_to_exit');
  const earlyExit = summarize(earlyExitCaptures, 'bail_if_flipped');
  console.log('\nHold-all-to-exit (on this open-at-checkpoint subset):', holdAll);
  console.log('Bail-early-if-flipped-at-checkpoint:', earlyExit);
  const verdict = earlyExit.meanDollarPerDay > holdAll.meanDollarPerDay ? 'IMPROVES' : 'DOES_NOT_IMPROVE';
  console.log(`\nVerdict: bailing early on a flip ${verdict} on holding through (delta $${(earlyExit.meanDollarPerDay - holdAll.meanDollarPerDay).toFixed(2)}/day)`);

  await recordClaim({
    slug: 'overnight_orderflow_exit_confirmation_check_20260922',
    claimText: `User question (2026-09-22): near OVERNIGHT_ORDERFLOW_LONG/SHORT's exit (no price target -- calibrated clock exit, ${BASELINE_EXIT}), does checking whether the order flow that originally predicted the move is STILL winning (${LOOKBACK_MIN}min window ending ${CHECK_TIME}, 30min before exit) predict the remaining outcome, and would bailing early on a flip beat holding through? Distinct from the already-negative RESEARCH_CLAIM directional_orderflow_ride_no_stop_negative_20260921 (fresh-entry, general Globex population) -- this tests an existing, already-directionally-validated position instead. Real N=${rows.length} (of ${n} total, ${n - rows.length} already stopped out by ${CHECK_TIME} and excluded as N/A). Pearson corr(order-flow skew at checkpoint, remaining capture to exit) = ${corr.toFixed(3)}. STILL-AGREES (n=${agree.length}) mean remaining capture=${meanRemAgree.toFixed(1)}pt vs FLIPPED (n=${flip.length}) mean remaining capture=${meanRemFlip != null ? meanRemFlip.toFixed(1) : 'N/A'}pt. Bail-early-if-flipped vs hold-all-to-exit: $${earlyExit.meanDollarPerDay}/day vs $${holdAll.meanDollarPerDay}/day (delta $${(earlyExit.meanDollarPerDay - holdAll.meanDollarPerDay).toFixed(2)}/day). Verdict: ${verdict}. N thin (${rows.length}) -- single checkpoint/window tested, not swept -- treat as a first look, not a promotion-ready result.`,
    sourceFile: 'scripts/research_overnight_orderflow_exit_confirmation.mjs',
    sourceDate: '2026-09-22',
    sampleSize: rows.length,
    winRate: null,
    evPerTrade: earlyExit.meanDollarPerDay - holdAll.meanDollarPerDay,
    rigorStatus: `n=${rows.length}_thin_single_checkpoint_no_sweep`,
    status: 'PROVISIONAL',
  });
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
