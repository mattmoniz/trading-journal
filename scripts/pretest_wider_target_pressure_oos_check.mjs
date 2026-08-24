// Genuine out-of-sample check for the directional-imbalance ("pressure") finding
// (wider_target_pressure_confound_check, 2026-08-24), per direct user request: does the
// pattern found on the whole dataset still hold on data it never saw?
//
// Chronological 60/40 split: tercile CUTOFFS for dirImbalance are computed ONLY from the
// earlier 60% of armed trades (TRAIN), then those same fixed cutoffs are applied to the
// later 40% (TEST) -- no recomputation on the held-out data, so this genuinely tests
// whether the pattern predicts forward rather than just describing the data it was found in.
//
// Reuses the identical walk methodology (armed-trade population, wider-target walk,
// dirImbalance via touchQuality.js's real getVolumeBaseline()) as the two sibling scripts
// this follows -- copied rather than imported since each of these pretest scripts is a
// self-contained one-off diagnostic, matching this thread's own established pattern.
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

    const baselinePnl = pnlAt(entry, t1, long);
    const origDistance = Math.abs(t1 - entry);
    const widerTarget = long ? entry + origDistance * TARGET_MULT : entry - origDistance * TARGET_MULT;
    let simPnl = null;
    for (let i = t1TouchIdx + 1; i < Math.min(allBars.length, t1TouchIdx + 1 + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const widerHit = long ? bar.high >= widerTarget : bar.low <= widerTarget;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (widerHit && stopHit) { simPnl = pnlAt(entry, stop, long); break; }
      if (widerHit) { simPnl = pnlAt(entry, widerTarget, long); break; }
      if (stopHit) { simPnl = pnlAt(entry, stop, long); break; }
    }
    if (simPnl === null) {
      const lastBar = allBars[Math.min(allBars.length - 1, t1TouchIdx + MAX_WALK_BARS)];
      simPnl = pnlAt(entry, lastBar.close, long);
    }

    const touchBar = allBars[t1TouchIdx];
    const totalVol = touchBar.bid_volume + touchBar.ask_volume;
    let dirImbalance = null;
    if (totalVol > 0) {
      const favorable = long ? touchBar.ask_volume : touchBar.bid_volume;
      const adverse = long ? touchBar.bid_volume : touchBar.ask_volume;
      dirImbalance = (favorable - adverse) / totalVol;
    }

    return {
      date: trade.trade_date, fired_at_ms: trade.fired_at_ms,
      delta: simPnl - baselinePnl, dirImbalance,
    };
  }

  const results = trades.map(walkOne).filter(r => r && r.dirImbalance !== null);
  console.log(`Usable armed trades with pressure reading: N=${results.length}`);

  const sorted = [...results].sort((a, b) => a.fired_at_ms - b.fired_at_ms);
  const cut = Math.floor(sorted.length * TRAIN_FRACTION);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  console.log(`Train N=${train.length} (chronologically first ${TRAIN_FRACTION * 100}%), Test N=${test.length} (held out, later in time)`);

  // Tercile cutoffs from TRAIN only.
  const trainSortedByImb = [...train].sort((a, b) => a.dirImbalance - b.dirImbalance);
  const c1 = trainSortedByImb[Math.floor(trainSortedByImb.length / 3)].dirImbalance;
  const c2 = trainSortedByImb[Math.floor(trainSortedByImb.length * 2 / 3)].dirImbalance;
  console.log(`\nTrain-derived cutoffs: LOW < ${c1.toFixed(3)} <= MID < ${c2.toFixed(3)} <= HIGH`);

  function summarize(bucket) {
    const n = bucket.length;
    if (n === 0) return null;
    const mean = bucket.reduce((s, r) => s + r.delta, 0) / n;
    const neg = bucket.filter(r => r.delta < 0).length;
    return { n, mean, neg };
  }

  console.log('\n=== TRAIN (in-sample, for reference) ===');
  for (const [label, bucket] of Object.entries({
    LOW: train.filter(r => r.dirImbalance < c1),
    MID: train.filter(r => r.dirImbalance >= c1 && r.dirImbalance < c2),
    HIGH: train.filter(r => r.dirImbalance >= c2),
  })) {
    const s = summarize(bucket);
    console.log(`  ${label}: N=${s?.n ?? 0} mean=$${s ? s.mean.toFixed(2) : 'n/a'} neg=${s ? `${s.neg}/${s.n}` : 'n/a'}`);
  }

  console.log('\n=== TEST (held-out, never seen when cutoffs were derived) ===');
  const testBuckets = {
    LOW: test.filter(r => r.dirImbalance < c1),
    MID: test.filter(r => r.dirImbalance >= c1 && r.dirImbalance < c2),
    HIGH: test.filter(r => r.dirImbalance >= c2),
  };
  const testSummaries = {};
  for (const [label, bucket] of Object.entries(testBuckets)) {
    const s = summarize(bucket);
    testSummaries[label] = s;
    if (!s) { console.log(`  ${label}: N=0`); continue; }
    const distinctDates = new Set(bucket.map(r => r.date)).size;
    console.log(`  ${label}: N=${s.n} mean=$${s.mean.toFixed(2)} neg=${s.neg}/${s.n} distinctDates=${distinctDates}`);
  }

  const monotonic = testSummaries.LOW && testSummaries.MID && testSummaries.HIGH
    && testSummaries.HIGH.mean > testSummaries.MID.mean && testSummaries.MID.mean > testSummaries.LOW.mean;
  console.log(`\nHolds up on held-out data (still climbs LOW -> MID -> HIGH)? ${monotonic ? 'YES' : 'NO -- pattern did not fully replicate out of sample'}`);

  const rigor = computeRigor(test.map(r => ({ t: r.date, pnl: r.delta })), { dateField: 't', pnlFn: r => r.pnl });

  const claimText = `Out-of-sample check for wider_target_pressure_confound_check's directional-imbalance finding, per direct user request (2026-08-24): tercile cutoffs for pressure (buying/selling imbalance at the T1-touch bar) derived ONLY from the chronologically first ${TRAIN_FRACTION * 100}% of armed trades (train N=${train.length}), applied unchanged to the held-out later ${(1 - TRAIN_FRACTION) * 100}% (test N=${test.length}).
TEST results: LOW N=${testSummaries.LOW?.n ?? 0} mean=$${testSummaries.LOW?.mean.toFixed(2) ?? 'n/a'}; MID N=${testSummaries.MID?.n ?? 0} mean=$${testSummaries.MID?.mean.toFixed(2) ?? 'n/a'}; HIGH N=${testSummaries.HIGH?.n ?? 0} mean=$${testSummaries.HIGH?.mean.toFixed(2) ?? 'n/a'}.
Monotonic replication on held-out data: ${monotonic ? 'YES' : 'NO'}.
Test-set rigor: stable=${rigor.stable} clustered=${rigor.clustered} clean=${rigor.clean}.
This directly answers whether the pooled/within-group findings (wider_target_pressure_confound_check) generalize forward in time, not just describe the data they were found in.`;

  await recordClaim({
    slug: 'wider_target_pressure_oos_check',
    claimText,
    sourceFile: 'scripts/pretest_wider_target_pressure_oos_check.mjs',
    sampleSize: test.length,
    winRate: testSummaries.HIGH ? (testSummaries.HIGH.n - testSummaries.HIGH.neg) / testSummaries.HIGH.n : null,
    evPerTrade: testSummaries.HIGH?.mean ?? null,
    rigorStatus: `stable=${rigor.stable} clustered=${rigor.clustered} clean=${rigor.clean} monotonic=${monotonic}`,
    status: monotonic ? 'PROVISIONAL' : 'PROVISIONAL',
  });

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
