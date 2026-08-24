// The actual candidate RULE, not just a diagnostic correlation: gate the wider-target
// mechanism's extend decision on buying/selling pressure at the T1-touch bar, rather than
// extending every fast-touch trade blindly (the current live 1.5x-always behavior).
//
// Built on 3 prior diagnostics in this same thread (2026-08-24):
//   1. wider_target_speed_participation_sign_check -- speed alone doesn't predict
//      continuation cleanly; directional pressure does.
//   2. wider_target_pressure_confound_check -- pressure's effect survives controlling for
//      day volatility and setup-type/bet_class composition (regression + within-group
//      replication on VALUE_FADE alone).
//   3. wider_target_pressure_oos_check -- the pattern holds on chronologically held-out
//      data, most cleanly at the TOP tier (loss rate 4.5% train vs 5.4% test, nearly
//      identical); the LOW/MID distinction was weaker out-of-sample.
//
// Given (3), the gate uses ONLY the top-tier cutoff (the train-derived boundary between
// MID and HIGH from the OOS script) rather than the full 3-way split -- the part of the
// finding that actually replicated cleanly. Threshold is derived from TRAIN only and
// applied unchanged to TEST, so this comparison is itself out-of-sample, not re-fit to the
// data it's evaluated on.
//
// Three arms compared on the IDENTICAL test population:
//   NEVER  -- always bank T1 immediately (delta=0 by construction, the reference floor)
//   ALWAYS -- current live behavior: every fast-touch trade extends to 1.5x, no gate
//   GATED  -- extend only if dirImbalance >= threshold (train-derived), else bank T1
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const FIRED_AT_BAR_COUNT_CUTOFF = 4;
const MAX_WALK_BARS = 500;
const TARGET_MULT = 1.5;
const TRAIN_FRACTION = 0.6;

function pnlAt(entry, price, long) {
  const points = long ? price - entry : entry - price;
  return points * PNL_PER_POINT - COMMISSION;
}

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, trade_date::text as trade_date, fired_at,
      extract(epoch from fired_at)*1000 as fired_at_ms,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level, bars_to_resolution
    FROM active_setups
    WHERE resolution = 'TARGET_HIT' AND origin_status IN ('ACTIVE','SHADOW')
      AND entry_zone_low IS NOT NULL AND entry_zone_high IS NOT NULL
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND fired_at IS NOT NULL
      AND bars_to_resolution <= ${FIRED_AT_BAR_COUNT_CUTOFF}
    ORDER BY fired_at ASC
  `);
  const trades = tradesRes.rows.filter(t => inferDirection(t.setup_type) !== null);

  const barsRes = await query(`
    SELECT ts, high::float as high, low::float as low, close::float as close,
      COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map(b => ({
    ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close,
    bid_volume: b.bid_volume, ask_volume: b.ask_volume,
  }));

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function walkOne(trade) {
    const direction = inferDirection(trade.setup_type);
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const stop = trade.stop_level;
    const t1 = trade.t1_level;

    const startIdx = firstIndexAfter(new Date(trade.fired_at).getTime());
    let barCount = 0, t1TouchIdx = null;
    for (let i = startIdx; i < Math.min(allBars.length, startIdx + MAX_WALK_BARS); i++) {
      barCount++;
      const bar = allBars[i];
      const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (t1Hit && stopHit) return null;
      if (t1Hit) { t1TouchIdx = i; break; }
      if (stopHit) return null;
    }
    if (t1TouchIdx === null || barCount > FIRED_AT_BAR_COUNT_CUTOFF) return null;

    const baselinePnl = pnlAt(entry, t1, long); // NEVER arm's outcome
    const origDistance = Math.abs(t1 - entry);
    const widerTarget = long ? entry + origDistance * TARGET_MULT : entry - origDistance * TARGET_MULT;
    let extendPnl = null;
    for (let i = t1TouchIdx + 1; i < Math.min(allBars.length, t1TouchIdx + 1 + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const widerHit = long ? bar.high >= widerTarget : bar.low <= widerTarget;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (widerHit && stopHit) { extendPnl = pnlAt(entry, stop, long); break; }
      if (widerHit) { extendPnl = pnlAt(entry, widerTarget, long); break; }
      if (stopHit) { extendPnl = pnlAt(entry, stop, long); break; }
    }
    if (extendPnl === null) {
      const lastBar = allBars[Math.min(allBars.length - 1, t1TouchIdx + MAX_WALK_BARS)];
      extendPnl = pnlAt(entry, lastBar.close, long);
    }

    const touchBar = allBars[t1TouchIdx];
    const totalVol = touchBar.bid_volume + touchBar.ask_volume;
    let dirImbalance = null;
    if (totalVol > 0) {
      const favorable = long ? touchBar.ask_volume : touchBar.bid_volume;
      const adverse = long ? touchBar.bid_volume : touchBar.ask_volume;
      dirImbalance = (favorable - adverse) / totalVol;
    }

    return { date: trade.trade_date, fired_at_ms: trade.fired_at_ms, baselinePnl, extendPnl, dirImbalance };
  }

  const results = trades.map(walkOne).filter(r => r && r.dirImbalance !== null);
  const sorted = [...results].sort((a, b) => a.fired_at_ms - b.fired_at_ms);
  const cut = Math.floor(sorted.length * TRAIN_FRACTION);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);

  // Threshold: the train-derived MID/HIGH boundary (top tercile cutoff) -- the part of the
  // pressure finding that actually replicated cleanly out-of-sample.
  const trainSortedByImb = [...train].sort((a, b) => a.dirImbalance - b.dirImbalance);
  const threshold = trainSortedByImb[Math.floor(trainSortedByImb.length * 2 / 3)].dirImbalance;
  console.log(`Train N=${train.length}, Test N=${test.length}, gate threshold (train top-tercile cutoff) = ${threshold.toFixed(3)}`);

  function summarize(deltas) {
    const n = deltas.length;
    const mean = deltas.reduce((a, b) => a + b, 0) / n;
    const neg = deltas.filter(d => d < 0).length;
    return { n, mean, neg };
  }

  // Evaluate all 3 arms on TEST only.
  const neverDeltas = test.map(() => 0); // reference floor, delta vs itself = 0 by definition
  const alwaysDeltas = test.map(r => r.extendPnl - r.baselinePnl);
  const gatedDeltas = test.map(r => r.dirImbalance >= threshold ? (r.extendPnl - r.baselinePnl) : 0);
  const gatedExtendCount = test.filter(r => r.dirImbalance >= threshold).length;

  console.log(`\n=== TEST set comparison (N=${test.length}, held-out) ===`);
  console.log('All deltas are vs the NEVER-extend floor (banking T1 immediately, current pre-mechanism baseline).');

  const sAlways = summarize(alwaysDeltas);
  console.log(`\nALWAYS extend (current live behavior): mean delta=$${sAlways.mean.toFixed(2)}, neg=${sAlways.neg}/${sAlways.n} (${(sAlways.neg/sAlways.n*100).toFixed(1)}%)`);

  const sGated = summarize(gatedDeltas);
  console.log(`GATED (extend only if pressure>=${threshold.toFixed(3)}): mean delta=$${sGated.mean.toFixed(2)}, neg=${sGated.neg}/${sGated.n} (${(sGated.neg/sGated.n*100).toFixed(1)}%)`);
  console.log(`  -- ${gatedExtendCount}/${test.length} (${(gatedExtendCount/test.length*100).toFixed(1)}%) of test trades actually extended under the gate; the rest banked T1 immediately (delta=0, same as NEVER).`);

  // Rigor on the GATED arm's non-zero (actually-extended) subset, since that's the part
  // doing any real work -- the zero-delta bank trades contribute no variance either way.
  const gatedExtended = test.filter(r => r.dirImbalance >= threshold);
  const rigorGated = computeRigor(
    gatedExtended.map(r => ({ t: r.date, pnl: r.extendPnl - r.baselinePnl })),
    { dateField: 't', pnlFn: r => r.pnl }
  );
  console.log(`  Rigor on the actually-extended subset: stable=${rigorGated.stable} clustered=${rigorGated.clustered} clean=${rigorGated.clean}`);

  console.log(`\nGATED beats ALWAYS by $${(sGated.mean - sAlways.mean).toFixed(2)}/trade on held-out data, with ${sAlways.neg}->${sGated.neg} real losses out of ${test.length}.`);

  const claimText = `Candidate rule test (not just diagnostic): gate the wider-target mechanism's extend decision on buying/selling pressure at the T1-touch bar (dirImbalance >= train-derived top-tercile threshold=${threshold.toFixed(3)}) vs the current live ALWAYS-extend-at-1.5x behavior vs a NEVER-extend floor. Threshold derived from chronological TRAIN only (N=${train.length}), evaluated on held-out TEST (N=${test.length}).
ALWAYS (current live): mean delta=$${sAlways.mean.toFixed(2)} neg=${sAlways.neg}/${sAlways.n} (${(sAlways.neg/sAlways.n*100).toFixed(1)}%).
GATED (new candidate): mean delta=$${sGated.mean.toFixed(2)} neg=${sGated.neg}/${sGated.n} (${(sGated.neg/sGated.n*100).toFixed(1)}%); ${gatedExtendCount}/${test.length} (${(gatedExtendCount/test.length*100).toFixed(1)}%) of trades actually extend under the gate.
Rigor on the actually-extended subset: stable=${rigorGated.stable} clustered=${rigorGated.clustered} clean=${rigorGated.clean}.
GATED vs ALWAYS delta: $${(sGated.mean - sAlways.mean).toFixed(2)}/trade improvement, loss count ${sAlways.neg}->${sGated.neg}.
Descriptive/comparative only -- not yet wired live. Next step per this codebase's SHADOW-first convention: wire as a SHADOW-only variant of stepWiderTarget() to accumulate real forward N before any live-capital consequence.`;

  await recordClaim({
    slug: 'wider_target_pressure_gate_vs_always_extend',
    claimText,
    sourceFile: 'scripts/backtest_wider_target_pressure_gate.mjs',
    sampleSize: test.length,
    winRate: (sGated.n - sGated.neg) / sGated.n,
    evPerTrade: sGated.mean,
    rigorStatus: `stable=${rigorGated.stable} clustered=${rigorGated.clustered} clean=${rigorGated.clean}`,
    status: 'PROVISIONAL',
  });

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
