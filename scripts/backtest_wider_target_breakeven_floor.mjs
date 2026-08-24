// Third arm for the wider-target-mechanism risk-shape question, alongside the existing
// origStop (current live shape, stop never moves) and T1-floor (stop snaps to T1 the
// instant T1 touches -- already proven tautological, 0/326 negative deltas, but a LOWER
// mean than origStop because it also kills some legitimate late-recovering winners).
//
// Breakeven-floor is a genuinely different, non-tautological shape: once T1 is touched
// and the mechanism arms for the wider target, the stop snaps to ENTRY (not T1) --
// protects the raw trade from ever going net-negative, but does NOT guarantee beating
// the T1 baseline (a trade that gives back the whole T1 gain down to exactly breakeven
// still shows a real NEGATIVE delta vs the T1 baseline, even though its own P&L is $0,
// not negative). User's own question, 2026-08-24: "what if we move the stop to BE once
// it hits t1 as a safety?"
//
// Same population/methodology as scratch/velocity_wider_target_t1floor_vs_origstop.mjs
// (fast bucket, bars_to_resolution<=4, ACTIVE+SHADOW, TARGET_HIT, direction-resolvable) --
// reused verbatim, all 3 arms computed in the same pass for a fair comparison.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const TARGET_MULT = 1.5;
const FIRED_AT_BAR_COUNT_CUTOFF = 4;
const MAX_WALK_BARS = 500;

function pnlAt(entry, price, long) {
  const points = long ? price - entry : entry - price;
  return points * PNL_PER_POINT - COMMISSION;
}

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, trade_date::text as trade_date, fired_at,
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
  console.log(`Fast bucket (bars_to_resolution<=4, ACTIVE+SHADOW, direction-resolvable): N=${trades.length}`);

  const barsRes = await query(`SELECT ts, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close }));
  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function walkAllArms(trade) {
    const direction = inferDirection(trade.setup_type);
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const stop = trade.stop_level;
    const t1 = trade.t1_level;
    const t1Distance = Math.abs(t1 - entry);
    const widerTarget = long ? entry + t1Distance * TARGET_MULT : entry - t1Distance * TARGET_MULT;

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

    function walkArm(armStop) {
      for (let i = t1TouchIdx + 1; i < Math.min(allBars.length, t1TouchIdx + 1 + MAX_WALK_BARS); i++) {
        const bar = allBars[i];
        const widerHit = long ? bar.high >= widerTarget : bar.low <= widerTarget;
        const armStopHit = long ? bar.low <= armStop : bar.high >= armStop;
        if (widerHit && armStopHit) return pnlAt(entry, armStop, long);
        if (widerHit) return pnlAt(entry, widerTarget, long);
        if (armStopHit) return pnlAt(entry, armStop, long);
      }
      const lastBar = allBars[Math.min(allBars.length - 1, t1TouchIdx + MAX_WALK_BARS)];
      return pnlAt(entry, lastBar.close, long);
    }

    return {
      date: trade.trade_date,
      setupType: trade.setup_type,
      origStopPnl: walkArm(stop),
      t1FloorPnl: walkArm(t1),
      beFloorPnl: walkArm(entry), // NEW: breakeven-floor arm
      baselinePnl,
    };
  }

  const results = trades.map(walkAllArms).filter(Boolean);
  console.log(`Usable (T1 touched within ${FIRED_AT_BAR_COUNT_CUTOFF} bars, no same-bar conflict): N=${results.length}`);

  function summarize(label, deltas) {
    const n = deltas.length;
    const mean = deltas.reduce((a, b) => a + b, 0) / n;
    const sorted = [...deltas].sort((a, b) => a - b);
    const median = sorted[Math.floor(n / 2)];
    const negCount = deltas.filter(d => d < 0).length;
    const posCount = deltas.filter(d => d > 0).length;
    const zeroCount = deltas.filter(d => d === 0).length;
    console.log(`${label}: N=${n}, mean=$${mean.toFixed(2)}, median=$${median.toFixed(2)}, negative=${negCount} (${(negCount / n * 100).toFixed(1)}%), positive=${posCount}, zero=${zeroCount}`);
    return { n, mean, median, negCount, posCount, zeroCount };
  }

  const origStopDeltas = results.map(r => r.origStopPnl - r.baselinePnl);
  const t1FloorDeltas = results.map(r => r.t1FloorPnl - r.baselinePnl);
  const beFloorDeltas = results.map(r => r.beFloorPnl - r.baselinePnl);

  console.log('\n=== Arm A: original-stop (current live shape) ===');
  const sA = summarize('origStop delta vs baseline', origStopDeltas);

  console.log('\n=== Arm B: T1-floor (already known tautological, for reference) ===');
  const sB = summarize('t1Floor delta vs baseline', t1FloorDeltas);

  console.log('\n=== Arm C: breakeven-floor (NEW -- stop snaps to ENTRY, not T1, once armed) ===');
  const sC = summarize('beFloor delta vs baseline', beFloorDeltas);
  // Separately report raw trade P&L (not delta-vs-baseline) for the BE arm, since the
  // interesting safety property is "does the raw trade ever go net-negative," not just
  // "does it beat the T1 baseline."
  const beRawPnls = results.map(r => r.beFloorPnl);
  const beRawNeg = beRawPnls.filter(p => p < 0).length;
  console.log(`  Raw P&L negative count (true losses, not just underperforming T1): ${beRawNeg}/${results.length} (${(beRawNeg / results.length * 100).toFixed(1)}%)`);

  const rigorC = computeRigor(results.map(r => ({ t: r.date, pnl: r.beFloorPnl - r.baselinePnl })), { dateField: 't', pnlFn: r => r.pnl });
  console.log(`  Rigor: stable=${rigorC.stable} clustered=${rigorC.clustered} clean=${rigorC.clean}`);

  const claimText = `Breakeven-floor arm for the wider-target mechanism (stop snaps to ENTRY, not T1, once armed at fast T1-touch) -- 3-way comparison, same population as the existing T1-floor analysis (fast bucket bars_to_resolution<=4, ACTIVE+SHADOW, TARGET_HIT, N=${results.length}).
Arm A (current live, no floor): mean=$${sA.mean.toFixed(2)} median=$${sA.median.toFixed(2)} negative=${sA.negCount}/${sA.n} (${(sA.negCount/sA.n*100).toFixed(1)}%)
Arm B (T1-floor, reference): mean=$${sB.mean.toFixed(2)} median=$${sB.median.toFixed(2)} negative=${sB.negCount}/${sB.n} (tautological vs baseline by construction)
Arm C (breakeven-floor, NEW): mean=$${sC.mean.toFixed(2)} median=$${sC.median.toFixed(2)} negative-vs-T1-baseline=${sC.negCount}/${sC.n} (${(sC.negCount/sC.n*100).toFixed(1)}%), raw-trade-P&L-negative=${beRawNeg}/${results.length} (${(beRawNeg/results.length*100).toFixed(1)}%)
Rigor (Arm C, delta vs baseline): stable=${rigorC.stable} clustered=${rigorC.clustered} clean=${rigorC.clean}
Key distinction: breakeven-floor is NOT tautological like T1-floor -- it can still show a negative delta vs the T1 baseline (giving back the whole T1 gain to land at exactly breakeven), even though the raw trade P&L itself never goes net-negative. Not wired live, descriptive only.`;

  await recordClaim({
    slug: 'wider_target_breakeven_floor_vs_origstop_vs_t1floor',
    claimText,
    sourceFile: 'scripts/backtest_wider_target_breakeven_floor.mjs',
    sampleSize: results.length,
    winRate: sC.posCount / sC.n,
    evPerTrade: sC.mean,
    rigorStatus: `stable=${rigorC.stable} clustered=${rigorC.clustered} clean=${rigorC.clean}`,
    status: 'PROVISIONAL',
  });

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
