// Follow-up to OPEN_DECISION wider_target_pressure_gate_own_clustering_unchecked (2026-09-08):
// the already-LIVE wider-target pressure gate was validated once at ship time
// (scripts/backtest_wider_target_pressure_gate.mjs, +$2.55/trade on held-out TEST) but that
// validation never ran a top-5-day-exclusion control -- a later companion script
// (scripts/backtest_pressure_gate_six_angles_20260908.mjs) found the SAME baseline GATED arm
// is clustered=true (top5DayPct>50 per computeRigor). This script asks the direct question:
// does the baseline's validated edge survive excluding its own 5 best days?
//
// Reuses the EXACT same trade population, bar-walk, and chronological 60/40 train/test split
// as both scripts above (independently re-verified against a direct SQL count before trusting
// it, per this codebase's own audit convention) -- no lookahead, same T1-touch-bar dirImbalance
// signal, same TRAIN-derived top-tercile threshold applied blind to TEST.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

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

function getImbalance(bar, long) {
  const totalVol = (bar.bid_volume || 0) + (bar.ask_volume || 0);
  if (totalVol === 0) return null;
  const favorable = long ? (bar.ask_volume || 0) : (bar.bid_volume || 0);
  const adverse = long ? (bar.bid_volume || 0) : (bar.ask_volume || 0);
  return (favorable - adverse) / totalVol;
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
    ts_ms: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close,
    bid_volume: b.bid_volume, ask_volume: b.ask_volume,
  }));

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts_ms <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const processed = [];
  for (const trade of trades) {
    const direction = inferDirection(trade.setup_type);
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const stop = trade.stop_level;
    const t1 = trade.t1_level;

    const startIdx = firstIndexAfter(trade.fired_at_ms);
    let barCount = 0, t1TouchIdx = null;
    for (let i = startIdx; i < Math.min(allBars.length, startIdx + MAX_WALK_BARS); i++) {
      barCount++;
      const bar = allBars[i];
      const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (t1Hit && stopHit) break;
      if (t1Hit) { t1TouchIdx = i; break; }
      if (stopHit) break;
    }
    if (t1TouchIdx === null || barCount > FIRED_AT_BAR_COUNT_CUTOFF) continue;

    const baselinePnl = pnlAt(entry, t1, long);
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
    const dirImbalance = getImbalance(touchBar, long);
    if (dirImbalance === null) continue;

    processed.push({ date: trade.trade_date, fired_at_ms: trade.fired_at_ms, baselinePnl, extendPnl, dirImbalance });
  }

  const sorted = [...processed].sort((a, b) => a.fired_at_ms - b.fired_at_ms);
  const cut = Math.floor(sorted.length * TRAIN_FRACTION);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);

  const trainSortedByImb = [...train].sort((a, b) => a.dirImbalance - b.dirImbalance);
  const threshold = trainSortedByImb[Math.floor(trainSortedByImb.length * 2 / 3)].dirImbalance;

  const extended = test.filter(r => r.dirImbalance >= threshold);
  const withDelta = extended.map(r => ({ ...r, delta: r.extendPnl - r.baselinePnl }));

  const byDay = new Map();
  for (const r of withDelta) {
    if (!byDay.has(r.date)) byDay.set(r.date, { n: 0, d: 0 });
    byDay.get(r.date).n++;
    byDay.get(r.date).d += r.delta;
  }
  const days = [...byDay.entries()].map(([date, st]) => ({ date, ...st })).sort((a, b) => b.d - a.d);
  const totalN = withDelta.length;
  const totalD = withDelta.reduce((a, b) => a + b.delta, 0);
  const top5 = days.slice(0, 5);
  const top5DateSet = new Set(top5.map(d => d.date));
  const top5N = top5.reduce((a, b) => a + b.n, 0);
  const top5D = top5.reduce((a, b) => a + b.d, 0);

  console.log(`Baseline GATED arm, TEST set, N=${totalN}, total delta=$${totalD.toFixed(2)} (mean $${(totalD/totalN).toFixed(2)}/trade)`);
  console.log(`Top 5 days: ${top5.map(d => `${d.date}: $${d.d.toFixed(2)} (N=${d.n})`).join(', ')}`);
  console.log(`Top 5 days carried $${top5D.toFixed(2)} (${(top5D/totalD*100).toFixed(1)}%) of total, with N=${top5N} (${(top5N/totalN*100).toFixed(1)}%) of trades.\n`);

  const remainder = withDelta.filter(r => !top5DateSet.has(r.date));
  const remN = remainder.length;
  const remD = remainder.reduce((a, b) => a + b.delta, 0);
  const remMean = remN > 0 ? remD / remN : 0;
  const remNeg = remainder.filter(r => r.delta < 0).length;
  console.log(`=== EXCLUDING top-5 days ===`);
  console.log(`Remaining N=${remN}, total delta=$${remD.toFixed(2)}, mean=$${remMean.toFixed(2)}/trade, neg=${remNeg}/${remN} (${remN>0?(remNeg/remN*100).toFixed(1):'0.0'}%)`);

  if (remN > 0) {
    const rigorRem = computeRigor(remainder.map(r => ({ t: r.date, pnl: r.delta })), { dateField: 't', pnlFn: r => r.pnl });
    console.log(`Rigor on remainder: stable=${rigorRem.stable} clustered=${rigorRem.clustered} clean=${rigorRem.clean}`);
  }

  // Second cut: even-vs-odd day split (a different, less arbitrary exclusion than "top 5 by
  // definition will always look bad when removed" -- chronological alternation instead).
  const chronoDays = [...byDay.keys()].sort();
  const firstHalfDays = new Set(chronoDays.slice(0, Math.ceil(chronoDays.length / 2)));
  const firstHalf = withDelta.filter(r => firstHalfDays.has(r.date));
  const secondHalf = withDelta.filter(r => !firstHalfDays.has(r.date));
  const summarizeHalf = (arr) => {
    const n = arr.length, d = arr.reduce((a,b)=>a+b.delta,0);
    return { n, d, mean: n>0?d/n:0, neg: arr.filter(r=>r.delta<0).length };
  };
  const h1 = summarizeHalf(firstHalf), h2 = summarizeHalf(secondHalf);
  console.log(`\n=== Chronological half-split (robustness check, not top-day-based) ===`);
  console.log(`First half of days:  N=${h1.n}, mean=$${h1.mean.toFixed(2)}/trade, neg=${h1.neg}/${h1.n}`);
  console.log(`Second half of days: N=${h2.n}, mean=$${h2.mean.toFixed(2)}/trade, neg=${h2.neg}/${h2.n}`);

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
