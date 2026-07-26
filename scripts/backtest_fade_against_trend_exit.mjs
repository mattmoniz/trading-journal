// Dedicated test of the standalone hypothesis surfaced by
// bigmove_signal_fade_direction_hypothesis_refuted (OPEN_DECISION
// test_blind_fast_exit_fading_against_trend): does a plain, SIGNAL-FREE rule -- exit early
// at a fixed bar count whenever a trade is fading against the day's already-established
// direction -- improve outcomes broadly, not just on eventual big-move days (which is all
// the surfaced +$14,320/N=258 number actually tested)?
//
// Real control per the OPEN_DECISION's own ask: compare against exiting RIDING-WITH-the-day
// trades at the SAME fixed bar offset. If early exit helps both groups equally, the effect is
// just "exiting early is often good" (structural), not "fading against the trend specifically
// is dangerous." Only a FADING-specific improvement that RIDING doesn't share is a real finding.
//
// Day direction at entry: session open (per the existing Globex-inclusive gap-based session
// tracking convention) vs. close at the entry bar -- same method as
// backtest_bigmove_signal_exit_trigger_fade_direction.mjs, reused for consistency, computed
// at ENTRY this time (not at a later trigger bar) since this rule is blind/signal-free and
// applies from bar 0, not from some later condition becoming true.
//
// Tests multiple fixed-bar offsets (3, 6, 10, 15) since there's no natural "trigger" to derive
// one from -- a blind rule needs its offset chosen by what actually holds up, not assumed.
// Chronological 80/20 train/test split throughout, per this codebase's standing convention.

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const GAP_CUTOFF_MIN = 45;
const CANDIDATE_OFFSETS = [3, 6, 10, 15];

function summarize(rows, field) {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: '0.0', total: '0.00', ev: '0.00' };
  const wins = rows.filter(r => r[field] > 0);
  const total = rows.reduce((s, r) => s + r[field], 0);
  return { n, wr: (wins.length / n * 100).toFixed(1), total: total.toFixed(2), ev: (total / n).toFixed(2) };
}

async function main() {
  const maxDateRow = await query(`SELECT MAX(trade_date)::text as max_date FROM active_setups`);
  const maxDate = maxDateRow.rows[0].max_date;

  console.log('Loading 2yr bar history with ET-minute-of-day...');
  const barsRes = await query(`
    SELECT ts, close::float,
           (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::date - interval '2 years'
    ORDER BY ts ASC
  `, [maxDate]);
  const bars = barsRes.rows.map((r, i, arr) => {
    const gapMin = i === 0 ? Infinity : (new Date(r.ts).getTime() - new Date(arr[i - 1].ts).getTime()) / 60000;
    return { ts: new Date(r.ts).getTime(), close: r.close, etMin: r.et_min, gapMin };
  });

  console.log('Computing per-bar running day-direction (Globex-inclusive session tracking)...');
  const dayDirection = new Array(bars.length).fill(null); // 'UP' | 'DOWN'
  let sessOpen = null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].gapMin > GAP_CUTOFF_MIN) sessOpen = null; // new session starts
    if (sessOpen == null) sessOpen = bars[i].close;
    dayDirection[i] = bars[i].close >= sessOpen ? 'UP' : 'DOWN';
  }
  const tsToIdx = new Map();
  for (let i = 0; i < bars.length; i++) tsToIdx.set(bars[i].ts, i);

  console.log('Loading ALL trades (any direction) in trailing 2 years...');
  const tradesQ = await query(`
    SELECT trade_date::text as trade_date, fired_at, setup_type, origin_status,
           actual_pnl::float as actual_pnl, bars_to_resolution,
           entry_zone_low::float, entry_zone_high::float
    FROM active_setups
    WHERE trade_date >= $1::date - interval '2 years' AND trade_date <= $1::date
      AND actual_pnl IS NOT NULL AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND (mae_points IS NULL OR mae_points::float <= 300) AND (mfe_points IS NULL OR mfe_points::float <= 300)
      AND entry_zone_low IS NOT NULL AND bars_to_resolution IS NOT NULL AND bars_to_resolution > 0
    ORDER BY trade_date ASC, fired_at ASC
  `, [maxDate]);
  const trades = tradesQ.rows;
  console.log(`${trades.length} trades match the population filter.`);

  const results = [];
  let noBarIdx = 0;
  for (const t of trades) {
    const entryIdx = tsToIdx.get(new Date(t.fired_at).getTime());
    if (entryIdx == null) { noBarIdx++; continue; }
    const hi = t.entry_zone_high != null ? t.entry_zone_high : t.entry_zone_low;
    const entry = (t.entry_zone_low + hi) / 2;
    const direction = directionFromType(t.setup_type);
    const dayDir = dayDirection[entryIdx];
    const isFadingAgainst = (dayDir === 'DOWN' && direction === 'LONG') || (dayDir === 'UP' && direction === 'SHORT');
    results.push({ ...t, entryIdx, entry, direction, isFadingAgainst });
  }
  console.log(`${noBarIdx} trades skipped (entry bar not found). ${results.length} eligible.`);

  const fading = results.filter(r => r.isFadingAgainst);
  const riding = results.filter(r => !r.isFadingAgainst);
  console.log(`${fading.length} fading against the day's direction at entry, ${riding.length} riding with it.`);

  for (const off of CANDIDATE_OFFSETS) {
    for (const r of results) {
      if (off < r.bars_to_resolution && r.entryIdx + off < bars.length) {
        const exitBar = bars[r.entryIdx + off];
        const points = r.direction === 'LONG' ? (exitBar.close - r.entry) : (r.entry - exitBar.close);
        r[`pnlExit${off}`] = points * PNL_PER_POINT - COMMISSION;
        r[`affected${off}`] = true;
      } else {
        r[`pnlExit${off}`] = r.actual_pnl; // trade resolved before this offset, exit rule never applies
        r[`affected${off}`] = false;
      }
    }
  }

  function trainTestSplit(rows) {
    const dates = [...new Set(rows.map(r => r.trade_date))].sort();
    const splitIdx = Math.floor(dates.length * 0.8);
    const trainDates = new Set(dates.slice(0, splitIdx));
    return { train: rows.filter(r => trainDates.has(r.trade_date)), test: rows.filter(r => !trainDates.has(r.trade_date)) };
  }

  const md = [];
  md.push('# Blind Fade-Against-Trend Early Exit — Standalone Test\n');
  md.push(`Window: trailing 2 years ending ${maxDate}. Population: all resolved trades (any direction), N=${results.length}.`);
  md.push(`Fading against the day's direction at entry: N=${fading.length}. Riding with it: N=${riding.length}.\n`);

  for (const off of CANDIDATE_OFFSETS) {
    md.push(`## Fixed exit at bar ${off}`);
    for (const [label, groupAll] of [['FADING (hypothesis: early exit should help)', fading], ['RIDING (control: early exit should barely matter)', riding]]) {
      const group = groupAll.filter(r => r[`affected${off}`]); // only trades actually still open at bar `off`
      const base = summarize(group, 'actual_pnl');
      const exit = summarize(group, `pnlExit${off}`);
      const delta = (Number(exit.total) - Number(base.total)).toFixed(2);
      const perTrade = group.length ? (Number(delta) / group.length).toFixed(2) : 'n/a';
      md.push(`- ${label}: AFFECTED-ONLY N=${base.n} (of ${groupAll.length} total, ${(base.n / groupAll.length * 100).toFixed(0)}% still open at bar ${off})`);
      md.push(`  baseline WR=${base.wr}% Total=$${base.total} | exit-at-${off} Total=$${exit.total} | delta=$${delta} | delta/trade=$${perTrade}`);

      const { train, test } = trainTestSplit(group);
      for (const [splitLabel, set] of [['TRAIN', train], ['TEST', test]]) {
        const b = summarize(set, 'actual_pnl');
        const e = summarize(set, `pnlExit${off}`);
        const d = (Number(e.total) - Number(b.total));
        const pt = set.length ? (d / set.length).toFixed(2) : 'n/a';
        md.push(`    ${splitLabel} (N=${set.length}): baseline=$${b.total} exit=$${e.total} delta=$${d.toFixed(2)} delta/trade=$${pt}`);
      }
    }
    md.push('');
  }

  const report = md.join('\n');
  fs.writeFileSync('scratch/fade_against_trend_exit_RESULTS.md', report);
  console.log(report);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
