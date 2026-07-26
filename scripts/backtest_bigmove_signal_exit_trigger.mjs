// Direct follow-up: tests BIGMOVE_LIVE_SIGNAL (never tested as an exit trigger at all, unlike
// bar6_checkpoint) the same way just done for the sigma-continuation signal -- does exiting an
// EXISTING open trade when "today is becoming a >=400pt move day" fires beat holding to original
// resolution? Applied to ALL directions (not LONG-only like the sigma test) since the big-move
// signal is about TOTAL RANGE, not a specific direction -- a strongly trending day threatens a
// fade trade regardless of which way the fade itself points.
//
// Built the FRESH-only way from the start this time (lesson from
// sigma_signal_exit_trigger_fresh_fails_test): a trade is only eligible to trigger if the
// big-move condition was NOT already active at entry (excludes trades entered already knowing
// today is a big-move day -- that's baked into the entry, not new information).
//
// Reuses the exact validated Globex-inclusive session-tracking methodology from acd.js's live
// BIGMOVE_LIVE_SIGNAL computation (gap-based session-start detection, 250pt/180min threshold,
// schedule-based minutes-remaining) rather than re-deriving it.

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const RANGE_THRESHOLD = 250, MIN_MINUTES_REMAINING = 180, GAP_CUTOFF_MIN = 45;

function summarize(rows, field) {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: '0.0', total: '0.00', ev: '0.00', avgWin: 'n/a', avgLoss: 'n/a' };
  const wins = rows.filter(r => r[field] > 0);
  const losses = rows.filter(r => r[field] <= 0);
  const total = rows.reduce((s, r) => s + r[field], 0);
  return {
    n, wr: (wins.length / n * 100).toFixed(1), total: total.toFixed(2), ev: (total / n).toFixed(2),
    avgWin: wins.length ? (wins.reduce((s, r) => s + r[field], 0) / wins.length).toFixed(2) : 'n/a',
    avgLoss: losses.length ? (losses.reduce((s, r) => s + r[field], 0) / losses.length).toFixed(2) : 'n/a',
  };
}

async function main() {
  const maxDateRow = await query(`SELECT MAX(trade_date)::text as max_date FROM active_setups`);
  const maxDate = maxDateRow.rows[0].max_date;

  console.log('Loading 2yr bar history with ET-minute-of-day...');
  const barsRes = await query(`
    SELECT ts, high::float, low::float, close::float,
           (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::date - interval '2 years'
    ORDER BY ts ASC
  `, [maxDate]);
  const bars = barsRes.rows.map((r, i, arr) => {
    const gapMin = i === 0 ? Infinity : (new Date(r.ts).getTime() - new Date(arr[i - 1].ts).getTime()) / 60000;
    return { ts: new Date(r.ts).getTime(), high: r.high, low: r.low, close: r.close, etMin: r.et_min, gapMin };
  });

  console.log('Computing per-bar big-move-day state (Globex-inclusive session tracking)...');
  const bigMoveActive = new Array(bars.length).fill(false);
  let sessHigh = -Infinity, sessLow = Infinity;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].gapMin > GAP_CUTOFF_MIN) { sessHigh = -Infinity; sessLow = Infinity; } // new session starts
    if (bars[i].high > sessHigh) sessHigh = bars[i].high;
    if (bars[i].low < sessLow) sessLow = bars[i].low;
    const rangeSoFar = sessHigh - sessLow;
    const nowEtMin = bars[i].etMin;
    const minutesRemaining = nowEtMin < 1020 ? (1020 - nowEtMin) : (1440 - nowEtMin + 1020);
    bigMoveActive[i] = rangeSoFar >= RANGE_THRESHOLD && minutesRemaining >= MIN_MINUTES_REMAINING;
  }
  const tsToIdx = new Map();
  for (let i = 0; i < bars.length; i++) tsToIdx.set(bars[i].ts, i);
  console.log(`Big-move-day condition active on ${bigMoveActive.filter(Boolean).length} of ${bars.length} bars (${(bigMoveActive.filter(Boolean).length / bars.length * 100).toFixed(1)}%).`);

  console.log('Loading ALL trades (any direction) in trailing 365 days...');
  const tradesQ = await query(`
    SELECT trade_date::text as trade_date, fired_at, setup_type, origin_status,
           actual_pnl::float as actual_pnl, bars_to_resolution,
           entry_zone_low::float, entry_zone_high::float
    FROM active_setups
    WHERE trade_date >= $1::date - interval '365 days' AND trade_date <= $1::date
      AND actual_pnl IS NOT NULL AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND (mae_points IS NULL OR mae_points::float <= 300) AND (mfe_points IS NULL OR mfe_points::float <= 300)
      AND entry_zone_low IS NOT NULL AND bars_to_resolution IS NOT NULL AND bars_to_resolution > 0
    ORDER BY trade_date ASC, fired_at ASC
  `, [maxDate]);
  const trades = tradesQ.rows;
  console.log(`${trades.length} trades match the population filter.`);

  const results = [];
  let noBarIdx = 0, alreadyActiveAtEntry = 0;
  for (const t of trades) {
    const entryIdx = tsToIdx.get(new Date(t.fired_at).getTime());
    if (entryIdx == null) { noBarIdx++; continue; }
    const hi = t.entry_zone_high != null ? t.entry_zone_high : t.entry_zone_low;
    const entry = (t.entry_zone_low + hi) / 2;

    const alreadyActive = bigMoveActive[entryIdx];
    if (alreadyActive) alreadyActiveAtEntry++;

    let triggerOffset = null;
    if (!alreadyActive) {
      for (let off = 1; off < t.bars_to_resolution && entryIdx + off < bars.length; off++) {
        if (bigMoveActive[entryIdx + off]) { triggerOffset = off; break; }
      }
    }
    results.push({ ...t, entryIdx, entry, triggerOffset, alreadyActive });
  }
  console.log(`${noBarIdx} trades skipped (entry bar not found).`);
  console.log(`${alreadyActiveAtEntry} of ${results.length} trades (${(alreadyActiveAtEntry / results.length * 100).toFixed(1)}%) entered with the big-move condition already active -- excluded from fresh-trigger eligibility.`);

  const eligible = results.filter(r => !r.alreadyActive);
  const triggered = eligible.filter(r => r.triggerOffset != null);
  console.log(`Of ${eligible.length} clean trades, the fresh big-move signal fired on ${triggered.length} (${(triggered.length / eligible.length * 100).toFixed(1)}%).`);
  const offsets = triggered.map(r => r.triggerOffset).sort((a, b) => a - b);
  const medianOffset = offsets.length ? offsets[Math.floor(offsets.length / 2)] : null;
  console.log(`Median fresh-trigger offset: ${medianOffset} bars.`);

  for (const r of eligible) {
    const direction = directionFromType(r.setup_type);
    r.pnlBaseline = r.actual_pnl;
    r.pnlSignalGated = r.actual_pnl;
    if (r.triggerOffset != null) {
      const exitBar = bars[r.entryIdx + r.triggerOffset];
      const points = direction === 'LONG' ? (exitBar.close - r.entry) : (r.entry - exitBar.close);
      r.pnlSignalGated = points * PNL_PER_POINT - COMMISSION;
    }
    r.pnlBlindGated = r.actual_pnl;
    if (medianOffset != null && medianOffset < r.bars_to_resolution && r.entryIdx + medianOffset < bars.length) {
      const exitBar = bars[r.entryIdx + medianOffset];
      const points = direction === 'LONG' ? (exitBar.close - r.entry) : (r.entry - exitBar.close);
      r.pnlBlindGated = points * PNL_PER_POINT - COMMISSION;
    }
  }

  const dates = [...new Set(eligible.map(r => r.trade_date))].sort();
  const splitIdx = Math.floor(dates.length * 0.8);
  const trainDates = new Set(dates.slice(0, splitIdx));
  const trainSet = eligible.filter(r => trainDates.has(r.trade_date));
  const testSet = eligible.filter(r => !trainDates.has(r.trade_date));

  const md = [];
  md.push('# Big-Move-Day Signal as an Exit Trigger — Fresh-Only, All Directions\n');
  md.push(`Window: trailing 365 days ending ${maxDate}. All directions (big-move-day is about total range, not a specific direction).\n`);
  md.push(`Confound check: ${alreadyActiveAtEntry} of ${results.length} trades (${(alreadyActiveAtEntry / results.length * 100).toFixed(1)}%) entered with the condition already active -- excluded.\n`);
  md.push(`Clean population: N=${eligible.length}. Fresh signal fired on ${triggered.length} (${(triggered.length / eligible.length * 100).toFixed(1)}%). Median fresh-trigger offset: ${medianOffset} bars.\n`);

  const base = summarize(eligible, 'pnlBaseline');
  const gated = summarize(eligible, 'pnlSignalGated');
  const blind = summarize(eligible, 'pnlBlindGated');
  md.push('## Clean population, POOLED');
  md.push(`- Baseline: N=${base.n}, WR=${base.wr}%, Total=$${base.total}, EV/trade=$${base.ev}`);
  md.push(`- Signal-gated: WR=${gated.wr}%, Total=$${gated.total}, EV/trade=$${gated.ev}`);
  md.push(`- Blind control (fixed bar ${medianOffset}): WR=${blind.wr}%, Total=$${blind.total}, EV/trade=$${blind.ev}`);
  md.push(`- Signal-gated vs baseline: $${(Number(gated.total) - Number(base.total)).toFixed(2)} | Blind vs baseline: $${(Number(blind.total) - Number(base.total)).toFixed(2)}\n`);

  md.push('## Clean population, TRAIN vs TEST');
  for (const [label, set] of [['TRAIN', trainSet], ['TEST', testSet]]) {
    const b = summarize(set, 'pnlBaseline');
    const g = summarize(set, 'pnlSignalGated');
    const bl = summarize(set, 'pnlBlindGated');
    md.push(`### ${label} (N=${set.length})`);
    md.push(`- Baseline: WR=${b.wr}%, Total=$${b.total}, EV/trade=$${b.ev}`);
    md.push(`- Signal-gated: WR=${g.wr}%, Total=$${g.total}, EV/trade=$${g.ev}`);
    md.push(`- Blind control: WR=${bl.wr}%, Total=$${bl.total}, EV/trade=$${bl.ev}`);
    md.push(`- Signal-gated vs baseline: $${(Number(g.total) - Number(b.total)).toFixed(2)} | Blind vs baseline: $${(Number(bl.total) - Number(b.total)).toFixed(2)}`);
  }

  const report = md.join('\n');
  fs.writeFileSync('scratch/bigmove_signal_exit_trigger_RESULTS.md', report);
  console.log(report);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
