// Direct follow-up to bigmove_signal_as_exit_trigger_promising_not_clean
// (OPEN_DECISION bigmove_signal_exit_trigger_fade_direction_followup): that test pooled every
// direction together and found a real-but-not-clean effect (beats baseline on both train/test,
// but loses to a blind control on test). The untested, sharper version of the intuition: a
// trending big-move day should threaten a trade FADING AGAINST that day's own direction more
// than one riding WITH it. Splits the same fresh-trigger population by that alignment.
//
// Day direction at the trigger bar: current close vs. the CURRENT session's own opening price
// (tracked alongside the existing session-range gap-detection, no new session logic needed).
// isFadingAgainst = (day trending DOWN and trade is LONG) or (day trending UP and trade is SHORT).
//
// Same population, fresh-only design, and train/test/blind-control rigor as the pooled version.

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

  console.log('Computing per-bar big-move-day state + running day-direction...');
  const bigMoveActive = new Array(bars.length).fill(false);
  const dayDirection = new Array(bars.length).fill(null); // 'UP' | 'DOWN'
  let sessHigh = -Infinity, sessLow = Infinity, sessOpen = null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].gapMin > GAP_CUTOFF_MIN) { sessHigh = -Infinity; sessLow = Infinity; sessOpen = null; }
    if (sessOpen == null) sessOpen = bars[i].close;
    if (bars[i].high > sessHigh) sessHigh = bars[i].high;
    if (bars[i].low < sessLow) sessLow = bars[i].low;
    const rangeSoFar = sessHigh - sessLow;
    const nowEtMin = bars[i].etMin;
    const minutesRemaining = nowEtMin < 1020 ? (1020 - nowEtMin) : (1440 - nowEtMin + 1020);
    bigMoveActive[i] = rangeSoFar >= RANGE_THRESHOLD && minutesRemaining >= MIN_MINUTES_REMAINING;
    dayDirection[i] = bars[i].close >= sessOpen ? 'UP' : 'DOWN';
  }
  const tsToIdx = new Map();
  for (let i = 0; i < bars.length; i++) tsToIdx.set(bars[i].ts, i);

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

  const results = [];
  let noBarIdx = 0, alreadyActiveAtEntry = 0;
  for (const t of trades) {
    const entryIdx = tsToIdx.get(new Date(t.fired_at).getTime());
    if (entryIdx == null) { noBarIdx++; continue; }
    const hi = t.entry_zone_high != null ? t.entry_zone_high : t.entry_zone_low;
    const entry = (t.entry_zone_low + hi) / 2;
    const direction = directionFromType(t.setup_type);

    const alreadyActive = bigMoveActive[entryIdx];
    if (alreadyActive) alreadyActiveAtEntry++;

    let triggerOffset = null;
    if (!alreadyActive) {
      for (let off = 1; off < t.bars_to_resolution && entryIdx + off < bars.length; off++) {
        if (bigMoveActive[entryIdx + off]) { triggerOffset = off; break; }
      }
    }
    let isFadingAgainst = null;
    if (triggerOffset != null) {
      const dayDir = dayDirection[entryIdx + triggerOffset];
      isFadingAgainst = (dayDir === 'DOWN' && direction === 'LONG') || (dayDir === 'UP' && direction === 'SHORT');
    }
    results.push({ ...t, entryIdx, entry, direction, triggerOffset, alreadyActive, isFadingAgainst });
  }
  console.log(`${noBarIdx} trades skipped. ${alreadyActiveAtEntry} already-active-at-entry excluded.`);

  const eligible = results.filter(r => !r.alreadyActive);
  const triggered = eligible.filter(r => r.triggerOffset != null);
  const fadingAgainst = triggered.filter(r => r.isFadingAgainst);
  const ridingWith = triggered.filter(r => !r.isFadingAgainst);
  console.log(`Triggered: ${triggered.length} total -- ${fadingAgainst.length} fading against the day's direction, ${ridingWith.length} riding with it.`);

  const offsets = triggered.map(r => r.triggerOffset).sort((a, b) => a - b);
  const medianOffset = offsets.length ? offsets[Math.floor(offsets.length / 2)] : null;

  for (const r of eligible) {
    r.pnlBaseline = r.actual_pnl;
    r.pnlSignalGated = r.actual_pnl;
    if (r.triggerOffset != null) {
      const exitBar = bars[r.entryIdx + r.triggerOffset];
      const points = r.direction === 'LONG' ? (exitBar.close - r.entry) : (r.entry - exitBar.close);
      r.pnlSignalGated = points * PNL_PER_POINT - COMMISSION;
    }
    r.pnlBlindGated = r.actual_pnl;
    if (medianOffset != null && medianOffset < r.bars_to_resolution && r.entryIdx + medianOffset < bars.length) {
      const exitBar = bars[r.entryIdx + medianOffset];
      const points = r.direction === 'LONG' ? (exitBar.close - r.entry) : (r.entry - exitBar.close);
      r.pnlBlindGated = points * PNL_PER_POINT - COMMISSION;
    }
  }

  function trainTestSplit(rows) {
    const dates = [...new Set(rows.map(r => r.trade_date))].sort();
    const splitIdx = Math.floor(dates.length * 0.8);
    const trainDates = new Set(dates.slice(0, splitIdx));
    return { train: rows.filter(r => trainDates.has(r.trade_date)), test: rows.filter(r => !trainDates.has(r.trade_date)) };
  }

  const md = [];
  md.push('# Big-Move-Day Signal as Exit Trigger — Split by Fade-Direction Alignment\n');
  md.push(`Window: trailing 365 days ending ${maxDate}. Median fresh-trigger offset: ${medianOffset} bars.\n`);
  md.push(`Triggered population: ${triggered.length} total -- ${fadingAgainst.length} fading AGAINST the day's established direction, ${ridingWith.length} riding WITH it.\n`);

  for (const [label, group] of [['FADING AGAINST the day (hypothesis: signal should help most here)', fadingAgainst], ['RIDING WITH the day (hypothesis: signal should barely matter here)', ridingWith]]) {
    md.push(`## ${label}`);
    const base = summarize(group, 'pnlBaseline');
    const gated = summarize(group, 'pnlSignalGated');
    const blind = summarize(group, 'pnlBlindGated');
    md.push(`- POOLED: Baseline N=${base.n} WR=${base.wr}% Total=$${base.total} | Signal-gated Total=$${gated.total} | Blind Total=$${blind.total}`);
    md.push(`- Signal-gated vs baseline: $${(Number(gated.total) - Number(base.total)).toFixed(2)} | Blind vs baseline: $${(Number(blind.total) - Number(base.total)).toFixed(2)} | Signal vs blind: $${(Number(gated.total) - Number(blind.total)).toFixed(2)}`);

    const { train, test } = trainTestSplit(group);
    for (const [splitLabel, set] of [['TRAIN', train], ['TEST', test]]) {
      const b = summarize(set, 'pnlBaseline'), g = summarize(set, 'pnlSignalGated'), bl = summarize(set, 'pnlBlindGated');
      md.push(`  - ${splitLabel} (N=${set.length}): baseline=$${b.total}, signal=$${g.total}, blind=$${bl.total} | signal-vs-base=$${(Number(g.total) - Number(b.total)).toFixed(2)}, blind-vs-base=$${(Number(bl.total) - Number(b.total)).toFixed(2)}`);
    }
    md.push('');
  }

  const report = md.join('\n');
  fs.writeFileSync('scratch/bigmove_signal_fade_direction_RESULTS.md', report);
  console.log(report);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
