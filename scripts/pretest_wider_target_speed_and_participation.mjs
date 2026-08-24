// Cheap sign-check pre-test, requested before designing the checkpoint-reevaluation
// mechanism further (OPEN_DECISION wider_target_dynamic_checkpoint_reevaluation).
// DeepSeek's cut-off design critique (scratch/deepseek_response.md, 2026-08-24) found a
// LIVE, opposite-signed precedent at the same checkpoint (acd.js's bank-vs-extend branch
// for STACK_VOL_BREAK_LIVE: fast T1 arrival is treated as a climax spike and banked
// immediately -- extending on fast arrivals lost a median $135/trade there). Its explicit
// recommendation: measure the sign for THIS mechanism's own population before assuming
// "fast = let it run." This script does exactly that, plus tests whether buying/selling
// participation at the T1-touch moment (the user's own follow-up idea, 2026-08-24) adds
// anything beyond raw speed.
//
// Population: same armed trades as scripts/backtest_wider_target_breakeven_floor.mjs
// (TARGET_HIT, ACTIVE+SHADOW, bars_to_resolution<=4). Reuses that script's exact walk
// methodology (walk forward from the T1-touch bar under the ORIGINAL, never-moved stop;
// delta = origStopPnl - baselinePnl) rather than reimplementing it.
//
// Participation metric reuses the REAL, already-shared getVolumeBaseline() from
// touchQuality.js (90-day trailing per-minute-of-day avg/std z-score of bid+ask volume) --
// per CLAUDE.md's "export the real function" rule, not a new ad-hoc RVOL calculation.
// Directional imbalance (favorable-minus-adverse volume as a fraction of total, at the
// touch bar) is the same formula already tested as a PRE-TRADE filter this session
// (poc_rotation_delta_intensity_filter_*, weak/negative there) -- here it's measured at a
// different point (the T1-touch/checkpoint moment, not entry), which is a genuinely
// different question, but the prior result is a reason for real skepticism, not optimism.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { getVolumeBaseline } from '../server/services/touchQuality.js';
import { recordClaim } from './record_claim.mjs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const FIRED_AT_BAR_COUNT_CUTOFF = 4;
const MAX_WALK_BARS = 500;
const TARGET_MULT = 1.5; // live-wired wider-target multiplier -- must match Arm A exactly

function pnlAt(entry, price, long) {
  const points = long ? price - entry : entry - price;
  return points * PNL_PER_POINT - COMMISSION;
}

function summarize(deltas) {
  const n = deltas.length;
  const mean = deltas.reduce((a, b) => a + b, 0) / n;
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const negCount = deltas.filter(d => d < 0).length;
  return { n, mean, median, negCount };
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

  const barsRes = await query(`
    SELECT ts, high::float as high, low::float as low, close::float as close,
      COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  // Minute-of-day in ET (touchQuality.js's getVolumeBaseline() keys its baseline map on this).
  const barsEtRes = await query(`
    SELECT (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 + EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York'))::int as mod
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map((b, i) => ({
    ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close,
    bid_volume: b.bid_volume, ask_volume: b.ask_volume,
    mod: barsEtRes.rows[i].mod,
  }));

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // Memoize per-trade-date volume baselines (one query per distinct date, not per trade).
  const baselineCache = new Map();
  async function getBaseline(date) {
    if (!baselineCache.has(date)) baselineCache.set(date, await getVolumeBaseline(query, date));
    return baselineCache.get(date);
  }

  async function walkOne(trade) {
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

    // Original-stop continuation walk toward the live 1.5x wider target (exact same shape as
    // backtest_wider_target_breakeven_floor.mjs's walkArm(stop) -- BUG FIX: an earlier version
    // of this script forgot to check for hitting the wider target at all, which meant every
    // trade just got marked-to-market ~500 bars later instead of banking on a real win. Fixed
    // to match Arm A exactly.).
    const origDistance = Math.abs(t1 - entry);
    const widerTarget = long ? entry + origDistance * TARGET_MULT : entry - origDistance * TARGET_MULT;
    let simPnl = null;
    for (let i = t1TouchIdx + 1; i < Math.min(allBars.length, t1TouchIdx + 1 + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const widerHit = long ? bar.high >= widerTarget : bar.low <= widerTarget;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (widerHit && stopHit) { simPnl = pnlAt(entry, stop, long); break; } // stop-first on same-bar conflict
      if (widerHit) { simPnl = pnlAt(entry, widerTarget, long); break; }
      if (stopHit) { simPnl = pnlAt(entry, stop, long); break; }
    }
    if (simPnl === null) {
      const lastBar = allBars[Math.min(allBars.length - 1, t1TouchIdx + MAX_WALK_BARS)];
      simPnl = pnlAt(entry, lastBar.close, long);
    }

    // Participation at the touch bar: volZ (raw RVOL-style) + directional imbalance.
    const baseline = await getBaseline(trade.trade_date);
    const touchBar = allBars[t1TouchIdx];
    const bl = baseline.get(touchBar.mod);
    const totalVol = touchBar.bid_volume + touchBar.ask_volume;
    let volZ = null, dirImbalance = null;
    if (bl && bl.std_vol > 0) volZ = (totalVol - bl.avg_vol) / bl.std_vol;
    if (totalVol > 0) {
      const favorable = long ? touchBar.ask_volume : touchBar.bid_volume;
      const adverse = long ? touchBar.bid_volume : touchBar.ask_volume;
      dirImbalance = (favorable - adverse) / totalVol;
    }

    return {
      date: trade.trade_date,
      barsToT1: barCount,
      delta: simPnl - baselinePnl,
      volZ, dirImbalance,
    };
  }

  const results = [];
  for (const t of trades) {
    const r = await walkOne(t);
    if (r) results.push(r);
  }
  console.log(`Usable (T1 touched within ${FIRED_AT_BAR_COUNT_CUTOFF} bars): N=${results.length}`);

  // === Dimension 1: speed (barsToT1) -- does fast help or hurt, for THIS mechanism? ===
  console.log('\n=== By speed (bars from fire to T1 touch) ===');
  for (let b = 1; b <= FIRED_AT_BAR_COUNT_CUTOFF; b++) {
    const bucket = results.filter(r => r.barsToT1 === b);
    if (bucket.length < 5) { console.log(`  ${b} bar(s): N=${bucket.length} (too thin)`); continue; }
    const s = summarize(bucket.map(r => r.delta));
    const rigor = computeRigor(bucket.map(r => ({ t: r.date, pnl: r.delta })), { dateField: 't', pnlFn: r => r.pnl });
    console.log(`  ${b} bar(s): N=${s.n} mean=$${s.mean.toFixed(2)} median=$${s.median.toFixed(2)} neg=${s.negCount}/${s.n} rigor.clean=${rigor.clean} rigor.stable=${rigor.stable}`);
  }

  // === Dimension 2: participation (volZ terciles at the touch bar) ===
  const withVolZ = results.filter(r => r.volZ !== null);
  console.log(`\n=== By participation (volZ at touch bar, N with baseline coverage=${withVolZ.length}) ===`);
  const sortedByVolZ = [...withVolZ].sort((a, b) => a.volZ - b.volZ);
  const t1c = Math.floor(sortedByVolZ.length / 3), t2c = Math.floor(sortedByVolZ.length * 2 / 3);
  const volZBuckets = {
    LOW: sortedByVolZ.slice(0, t1c),
    MID: sortedByVolZ.slice(t1c, t2c),
    HIGH: sortedByVolZ.slice(t2c),
  };
  for (const [label, bucket] of Object.entries(volZBuckets)) {
    if (bucket.length < 5) { console.log(`  ${label}: N=${bucket.length} (too thin)`); continue; }
    const s = summarize(bucket.map(r => r.delta));
    const zRange = `${bucket[0].volZ.toFixed(2)} to ${bucket[bucket.length - 1].volZ.toFixed(2)}`;
    console.log(`  ${label} volZ (${zRange}): N=${s.n} mean=$${s.mean.toFixed(2)} median=$${s.median.toFixed(2)} neg=${s.negCount}/${s.n}`);
  }

  // === Dimension 3: directional imbalance (buying/selling skew at the touch bar) ===
  const withImb = results.filter(r => r.dirImbalance !== null);
  console.log(`\n=== By directional imbalance (favorable-minus-adverse volume fraction, N=${withImb.length}) ===`);
  const sortedByImb = [...withImb].sort((a, b) => a.dirImbalance - b.dirImbalance);
  const it1c = Math.floor(sortedByImb.length / 3), it2c = Math.floor(sortedByImb.length * 2 / 3);
  const imbBuckets = {
    LOW_favorable_skew: sortedByImb.slice(0, it1c),
    MID: sortedByImb.slice(it1c, it2c),
    HIGH_favorable_skew: sortedByImb.slice(it2c),
  };
  for (const [label, bucket] of Object.entries(imbBuckets)) {
    if (bucket.length < 5) { console.log(`  ${label}: N=${bucket.length} (too thin)`); continue; }
    const s = summarize(bucket.map(r => r.delta));
    const range = `${bucket[0].dirImbalance.toFixed(2)} to ${bucket[bucket.length - 1].dirImbalance.toFixed(2)}`;
    console.log(`  ${label} (${range}): N=${s.n} mean=$${s.mean.toFixed(2)} median=$${s.median.toFixed(2)} neg=${s.negCount}/${s.n}`);
  }

  // === Simple correlation check: is volZ/dirImbalance just re-measuring speed? ===
  function corr(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
    return num / Math.sqrt(dx2 * dy2);
  }
  const withBoth = results.filter(r => r.volZ !== null);
  const rSpeedVolZ = corr(withBoth.map(r => r.barsToT1), withBoth.map(r => r.volZ));
  console.log(`\nCorrelation(barsToT1, volZ) = ${rSpeedVolZ.toFixed(3)} (N=${withBoth.length}) -- if near 1 or -1, volZ isn't adding independent information beyond speed.`);

  const claimText = `Pre-test for wider_target_dynamic_checkpoint_reevaluation: does speed-to-T1 or buying/selling participation at the touch bar predict whether extending past T1 (under the original, never-moved stop) helps or hurts, on this mechanism's own armed population (N=${results.length}, same population as wider_target_breakeven_floor_vs_origstop_vs_t1floor)?
By speed (bars 1-4): see console output -- reports mean delta per bar-count bucket, honest N-gated (bucket<5 skipped).
By participation (volZ terciles, reusing touchQuality.js's real getVolumeBaseline(), N=${withVolZ.length}): LOW/MID/HIGH mean delta reported.
By directional imbalance (favorable-minus-adverse volume fraction at touch bar, N=${withImb.length}): same tercile breakdown. This is the same formula already tested as a PRE-TRADE filter this session (poc_rotation_delta_intensity_filter_*, weak/negative there) -- here measured at the T1-touch/checkpoint moment instead of entry, a different question.
Correlation(barsToT1, volZ)=${rSpeedVolZ.toFixed(3)} -- checked whether participation is just re-measuring speed.
Purpose: sign-check only, per DeepSeek's design critique (scratch/deepseek_response.md) finding a live, opposite-signed precedent (acd.js STACK_VOL_BREAK_LIVE bank-vs-extend: fast T1 arrival banked as climax, extending fast arrivals cost median -$135/trade there) -- this codebase should not assume "fast = let it run" without measuring it for this specific mechanism first. Descriptive only, not a final design.`;

  await recordClaim({
    slug: 'wider_target_speed_participation_sign_check',
    claimText,
    sourceFile: 'scripts/pretest_wider_target_speed_and_participation.mjs',
    sampleSize: results.length,
    winRate: null,
    evPerTrade: null,
    rigorStatus: 'PRE_TEST_SIGN_CHECK_SEE_CONSOLE',
    status: 'PROVISIONAL',
  });

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
