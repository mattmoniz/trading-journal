// Confound-controlled follow-up to pretest_wider_target_speed_and_participation.mjs's
// directional-imbalance ("pressure") finding (2026-08-24). User's direct challenge: a raw
// tercile split doesn't tell us whether "pressure predicts continuation" is a real,
// independent effect, or just a proxy for (a) which setup_type/bet_class the trade belongs
// to (already known to have very different continuation behavior -- VALUE_FADE vs
// VWAP_MAGNET diverged sharply in backtest_wider_target_mfe_percentile.mjs), (b) how
// volatile that trading day was, or (c) speed (already checked, weakly correlated).
//
// Two complementary checks, not one:
// 1. A simple multiple regression (delta ~ dirImbalance + dayVolatility + barsToT1) --
//    tells us whether pressure has an independent relationship with outcome once the other
//    two are accounted for, without needing to split N=326 into tiny buckets.
// 2. A within-group replication on the single largest bet_class (VALUE_FADE, the only group
//    with enough N to support its own tercile split) -- a direct, interpretable check of
//    whether the pooled pattern survives when setup-type composition is held fixed.
//
// Day volatility here is a same-day realized RTH range (self-computed from the same bars
// already loaded, always available) rather than the canonical GARCH_VOL_SCALE table, which
// only has coverage through 2026-07-17 and would leave ~5 weeks of this dataset uncontrolled
// -- a cruder but complete proxy beats a precise one with real gaps for this purpose.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { getVolumeBaseline } from '../server/services/touchQuality.js';
import { recordClaim } from './record_claim.mjs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const FIRED_AT_BAR_COUNT_CUTOFF = 4;
const MAX_WALK_BARS = 500;
const TARGET_MULT = 1.5;

function pnlAt(entry, price, long) {
  const points = long ? price - entry : entry - price;
  return points * PNL_PER_POINT - COMMISSION;
}

// Small OLS solver: y = X*b via normal equations (X'X)b = X'y, Gaussian elimination.
function ols(rows, yKey, xKeys) {
  const n = rows.length;
  const k = xKeys.length + 1; // +1 for intercept
  const X = rows.map(r => [1, ...xKeys.map(xk => r[xk])]);
  const y = rows.map(r => r[yKey]);
  const XtX = Array.from({ length: k }, () => Array(k).fill(0));
  const Xty = Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  // Gaussian elimination on augmented [XtX | Xty]
  const A = XtX.map((row, i) => [...row, Xty[i]]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    if (Math.abs(A[col][col]) < 1e-12) continue; // singular-ish, leave as 0
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const factor = A[r][col] / A[col][col];
      for (let c = col; c <= k; c++) A[r][c] -= factor * A[col][c];
    }
  }
  const coeffs = A.map((row, i) => Math.abs(row[i]) > 1e-12 ? row[k] / row[i] : 0);
  // R^2
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  const yHat = X.map(xr => xr.reduce((s, xv, i) => s + xv * coeffs[i], 0));
  const ssRes = y.reduce((s, yv, i) => s + (yv - yHat[i]) ** 2, 0);
  const ssTot = y.reduce((s, yv) => s + (yv - yMean) ** 2, 0);
  const r2 = 1 - ssRes / ssTot;
  return { intercept: coeffs[0], coeffs: xKeys.reduce((o, xk, i) => ({ ...o, [xk]: coeffs[i + 1] }), {}), r2, n };
}

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, bet_class, trade_date::text as trade_date, fired_at,
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
  const barsEtRes = await query(`
    SELECT (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 + EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York'))::int as mod,
           (ts AT TIME ZONE 'America/New_York')::date::text as et_date
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map((b, i) => ({
    ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close,
    bid_volume: b.bid_volume, ask_volume: b.ask_volume,
    mod: barsEtRes.rows[i].mod, et_date: barsEtRes.rows[i].et_date,
  }));

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // Day-level realized range (RTH-ish, just "all bars stamped with that ET date") --
  // self-computed control, always available, no external-table coverage gap.
  const dayRange = new Map(); // et_date -> { high, low }
  for (const b of allBars) {
    const cur = dayRange.get(b.et_date);
    if (!cur) dayRange.set(b.et_date, { high: b.high, low: b.low });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); }
  }

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

    const baseline = await getBaseline(trade.trade_date);
    const touchBar = allBars[t1TouchIdx];
    const totalVol = touchBar.bid_volume + touchBar.ask_volume;
    let dirImbalance = null;
    if (totalVol > 0) {
      const favorable = long ? touchBar.ask_volume : touchBar.bid_volume;
      const adverse = long ? touchBar.bid_volume : touchBar.ask_volume;
      dirImbalance = (favorable - adverse) / totalVol;
    }
    const dr = dayRange.get(touchBar.et_date);
    const dayRangePts = dr ? dr.high - dr.low : null;

    return {
      date: trade.trade_date,
      setup_type: trade.setup_type,
      bet_class: trade.bet_class,
      barsToT1: barCount,
      delta: simPnl - baselinePnl,
      dirImbalance,
      dayRangePts,
    };
  }

  const results = [];
  for (const t of trades) {
    const r = await walkOne(t);
    if (r && r.dirImbalance !== null && r.dayRangePts !== null) results.push(r);
  }
  console.log(`Usable (T1 touched within ${FIRED_AT_BAR_COUNT_CUTOFF} bars, has both features): N=${results.length}`);

  // === Check 1: multiple regression, controlling for day volatility and speed at once ===
  const reg = ols(results, 'delta', ['dirImbalance', 'dayRangePts', 'barsToT1']);
  console.log('\n=== Multiple regression: delta ~ dirImbalance + dayRangePts + barsToT1 ===');
  console.log(`N=${reg.n}, R²=${reg.r2.toFixed(4)}`);
  console.log(`  intercept        = ${reg.intercept.toFixed(2)}`);
  console.log(`  dirImbalance     = ${reg.coeffs.dirImbalance.toFixed(2)}  (per 1.0 of imbalance, e.g. -1 to +1 range)`);
  console.log(`  dayRangePts      = ${reg.coeffs.dayRangePts.toFixed(3)}  (per point of day range)`);
  console.log(`  barsToT1         = ${reg.coeffs.barsToT1.toFixed(2)}  (per bar)`);
  console.log(`  --> a full move from most-against (-1) to most-with (+1) pressure predicts a ${(reg.coeffs.dirImbalance * 2).toFixed(2)} dollar swing, AFTER accounting for day volatility and speed.`);

  // === Check 2: within-group replication on the single largest bet_class ===
  const byBetClass = {};
  for (const r of results) (byBetClass[r.bet_class || 'UNKNOWN'] ??= []).push(r);
  const largest = Object.entries(byBetClass).sort((a, b) => b[1].length - a[1].length)[0];
  console.log(`\n=== Within-group replication: largest bet_class = ${largest[0]} (N=${largest[1].length}) ===`);
  const groupTrades = [...largest[1]].sort((a, b) => a.dirImbalance - b.dirImbalance);
  const gc1 = Math.floor(groupTrades.length / 3), gc2 = Math.floor(groupTrades.length * 2 / 3);
  const groupBuckets = { LOW: groupTrades.slice(0, gc1), MID: groupTrades.slice(gc1, gc2), HIGH: groupTrades.slice(gc2) };
  for (const [label, bucket] of Object.entries(groupBuckets)) {
    if (bucket.length < 5) { console.log(`  ${label}: N=${bucket.length} (too thin)`); continue; }
    const mean = bucket.reduce((s, r) => s + r.delta, 0) / bucket.length;
    const neg = bucket.filter(r => r.delta < 0).length;
    const distinctDates = new Set(bucket.map(r => r.date)).size;
    console.log(`  ${label} (imbalance ${bucket[0].dirImbalance.toFixed(2)} to ${bucket[bucket.length - 1].dirImbalance.toFixed(2)}): N=${bucket.length} mean=$${mean.toFixed(2)} neg=${neg}/${bucket.length} distinctDates=${distinctDates}`);
  }

  // Bet_class composition of the pooled HIGH-imbalance tercile (is it just one setup type?)
  const sortedAll = [...results].sort((a, b) => a.dirImbalance - b.dirImbalance);
  const ac2 = Math.floor(sortedAll.length * 2 / 3);
  const highTercile = sortedAll.slice(ac2);
  const composition = {};
  for (const r of highTercile) composition[r.bet_class || 'UNKNOWN'] = (composition[r.bet_class || 'UNKNOWN'] || 0) + 1;
  console.log(`\n=== bet_class composition of the pooled HIGH-imbalance tercile (N=${highTercile.length}) ===`);
  for (const [bc, n] of Object.entries(composition).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${bc}: ${n} (${(n / highTercile.length * 100).toFixed(1)}%)`);
  }
  const distinctDatesHigh = new Set(highTercile.map(r => r.date)).size;
  console.log(`  distinct trading days in this tercile: ${distinctDatesHigh} (of ${highTercile.length} trades)`);

  const claimText = `Confound-controlled follow-up to wider_target_speed_participation_sign_check's directional-imbalance ("pressure") finding, per direct user challenge (2026-08-24): does it survive controlling for day volatility and setup-type/bet_class composition, not just a raw pooled tercile split?
Multiple regression (delta ~ dirImbalance + dayRangePts + barsToT1, N=${reg.n}, R²=${reg.r2.toFixed(4)}): dirImbalance coefficient=${reg.coeffs.dirImbalance.toFixed(2)} (full -1 to +1 swing implies ~$${(reg.coeffs.dirImbalance * 2).toFixed(2)}), controlling for same-day realized range and bars-to-T1 simultaneously.
Within-group replication (largest bet_class=${largest[0]}, N=${largest[1].length}): see per-tercile breakdown in console output.
Pooled HIGH-imbalance tercile composition: ${Object.entries(composition).map(([bc, n]) => `${bc}=${n}`).join(', ')}; distinct trading days=${distinctDatesHigh}/${highTercile.length}.
Descriptive/diagnostic only -- not a final claim on the mechanism, feeds the design of wider_target_dynamic_checkpoint_reevaluation.`;

  await recordClaim({
    slug: 'wider_target_pressure_confound_check',
    claimText,
    sourceFile: 'scripts/pretest_wider_target_pressure_confound_check.mjs',
    sampleSize: reg.n,
    winRate: null,
    evPerTrade: reg.coeffs.dirImbalance,
    rigorStatus: `R2=${reg.r2.toFixed(4)} distinctDatesInHighTercile=${distinctDatesHigh}`,
    status: 'PROVISIONAL',
  });

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
