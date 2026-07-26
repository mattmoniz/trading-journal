// Redesign of scripts/backtest_sigma_signal_as_exit_trigger.mjs (RESEARCH_CLAIM
// sigma_signal_as_exit_trigger_confounded, OPEN_DECISION redesign_sigma_signal_exit_trigger_fresh_only).
// The first version checked every bar of an open LONG trade for a down-move sigma crossing --
// median trigger offset was 1 bar, because FADE-LONG setups often enter WHILE already inside an
// ongoing decline (structural to what fading weakness means), so the check mostly re-detected
// the entry condition itself, not new post-entry deterioration.
//
// Fix: require the down-move to be FRESH. A trade is only eligible to trigger if its sigma
// magnitude at entry was BELOW threshold (i.e., it did NOT enter already inside a qualifying
// decline) -- then search forward for the first bar where it crosses to/above threshold. This
// isolates genuinely new deterioration from the population that was already confounded.
//
// Same population, methodology, and blind-control confound check as the first version --
// only the trigger-eligibility gate changes.

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const SIG_WIN = 100, H = 60, GAP_CUTOFF = 45, SIGMA_THRESHOLD = 2.0;

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

  console.log('Loading 2yr bar history for sigma precomputation...');
  const barsRes = await query(`
    SELECT ts, close::float FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::date - interval '2 years'
    ORDER BY ts ASC
  `, [maxDate]);
  const bars = barsRes.rows.map((r, i, arr) => {
    const gapMin = i === 0 ? Infinity : (new Date(r.ts).getTime() - new Date(arr[i - 1].ts).getTime()) / 60000;
    return { ts: new Date(r.ts).getTime(), close: r.close, gapMin };
  });

  console.log('Computing down-move sigma magnitude at every bar (gap-guarded)...');
  const sigmaMag = new Array(bars.length).fill(null);
  let volWindow = [], sumLogRet = 0, sumSqLogRet = 0;
  for (let i = 1; i < bars.length; i++) {
    const gapMin = bars[i].gapMin;
    const logRet = Math.log(bars[i].close / bars[i - 1].close);
    if (gapMin > GAP_CUTOFF) { volWindow = []; sumLogRet = 0; sumSqLogRet = 0; }
    else {
      volWindow.push(logRet);
      sumLogRet += logRet; sumSqLogRet += logRet * logRet;
      if (volWindow.length > SIG_WIN) { const rm = volWindow.shift(); sumLogRet -= rm; sumSqLogRet -= rm * rm; }
    }
    if (volWindow.length === SIG_WIN && i >= H) {
      let lookbackHasGap = false;
      for (let j = i - H + 1; j <= i; j++) { if (bars[j].gapMin > GAP_CUTOFF) { lookbackHasGap = true; break; } }
      if (!lookbackHasGap) {
        const mean = sumLogRet / SIG_WIN;
        const variance = Math.max(0, sumSqLogRet / SIG_WIN - mean * mean);
        const stdDevLogRet = Math.sqrt(variance);
        if (stdDevLogRet > 0) {
          const moveInPoints = bars[i].close - bars[i - H].close;
          const expectedMove = bars[i].close * stdDevLogRet * Math.sqrt(H);
          if (moveInPoints < 0) sigmaMag[i] = Math.abs(moveInPoints) / expectedMove;
        }
      }
    }
  }
  const tsToIdx = new Map();
  for (let i = 0; i < bars.length; i++) tsToIdx.set(bars[i].ts, i);

  console.log('Loading LONG trades in trailing 365 days...');
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
  const longTrades = tradesQ.rows.filter(t => directionFromType(t.setup_type) === 'LONG');
  console.log(`${longTrades.length} LONG trades match the population filter.`);

  const results = [];
  let noBarIdx = 0, alreadyElevatedAtEntry = 0;
  for (const t of longTrades) {
    const entryIdx = tsToIdx.get(new Date(t.fired_at).getTime());
    if (entryIdx == null) { noBarIdx++; continue; }
    const hi = t.entry_zone_high != null ? t.entry_zone_high : t.entry_zone_low;
    const entry = (t.entry_zone_low + hi) / 2;

    // FRESH gate: exclude trades whose sigma was already at/above threshold at entry --
    // these are the confounded population (entering during an already-active decline).
    const entryMag = sigmaMag[entryIdx];
    const alreadyElevated = entryMag != null && entryMag >= SIGMA_THRESHOLD;
    if (alreadyElevated) alreadyElevatedAtEntry++;

    let triggerOffset = null;
    if (!alreadyElevated) {
      for (let off = 1; off < t.bars_to_resolution && entryIdx + off < bars.length; off++) {
        const mag = sigmaMag[entryIdx + off];
        if (mag != null && mag >= SIGMA_THRESHOLD) { triggerOffset = off; break; }
      }
    }
    results.push({ ...t, entryIdx, entry, triggerOffset, alreadyElevated });
  }
  console.log(`${noBarIdx} trades skipped (entry bar not found in bar history).`);
  console.log(`${alreadyElevatedAtEntry} of ${results.length} trades (${(alreadyElevatedAtEntry / results.length * 100).toFixed(1)}%) were already sigma-elevated AT ENTRY -- excluded from fresh-trigger eligibility, this is the confound quantified directly.`);

  const eligible = results.filter(r => !r.alreadyElevated);
  const triggered = eligible.filter(r => r.triggerOffset != null);
  console.log(`Of the ${eligible.length} "clean" (not-already-elevated) trades, the fresh signal fired on ${triggered.length} (${(triggered.length / eligible.length * 100).toFixed(1)}%).`);

  const offsets = triggered.map(r => r.triggerOffset).sort((a, b) => a - b);
  const medianOffset = offsets.length ? offsets[Math.floor(offsets.length / 2)] : null;
  console.log(`Median fresh-trigger offset: ${medianOffset} bars (compare to 1 bar in the confounded first version).`);

  // Chronological 80/20 train/test split -- this session has repeatedly found pooled numbers
  // overstate what holds on genuinely held-out data. Split by trade_date, not by row order.
  const dates = [...new Set(eligible.map(r => r.trade_date))].sort();
  const splitIdx = Math.floor(dates.length * 0.8);
  const trainDates = new Set(dates.slice(0, splitIdx));
  const trainSet = eligible.filter(r => trainDates.has(r.trade_date));
  const testSet = eligible.filter(r => !trainDates.has(r.trade_date));

  for (const r of eligible) {
    r.pnlBaseline = r.actual_pnl;
    r.pnlSignalGated = r.actual_pnl;
    if (r.triggerOffset != null) {
      const exitBar = bars[r.entryIdx + r.triggerOffset];
      r.pnlSignalGated = (exitBar.close - r.entry) * PNL_PER_POINT - COMMISSION;
    }
    r.pnlBlindGated = r.actual_pnl;
    if (medianOffset != null && medianOffset < r.bars_to_resolution && r.entryIdx + medianOffset < bars.length) {
      const exitBar = bars[r.entryIdx + medianOffset];
      r.pnlBlindGated = (exitBar.close - r.entry) * PNL_PER_POINT - COMMISSION;
    }
  }

  const md = [];
  md.push('# Sigma-Continuation Signal as an Exit Trigger — FRESH-ONLY Redesign\n');
  md.push(`Window: trailing 365 days ending ${maxDate}. LONG trades only. Threshold: ${SIGMA_THRESHOLD} sigma.\n`);
  md.push(`Confound quantified directly: ${alreadyElevatedAtEntry} of ${results.length} trades (${(alreadyElevatedAtEntry / results.length * 100).toFixed(1)}%) entered already sigma-elevated -- excluded from this analysis entirely (not just from triggering).\n`);
  md.push(`Clean population: N=${eligible.length}. Fresh signal fired on ${triggered.length} (${(triggered.length / eligible.length * 100).toFixed(1)}%). Median fresh-trigger offset: ${medianOffset} bars.\n`);

  const base = summarize(eligible, 'pnlBaseline');
  const gated = summarize(eligible, 'pnlSignalGated');
  const blind = summarize(eligible, 'pnlBlindGated');
  md.push('## Clean population, POOLED (baseline vs signal-gated vs blind-control)');
  md.push(`- Baseline (hold): N=${base.n}, WR=${base.wr}%, Total=$${base.total}, EV/trade=$${base.ev}, avgWin=$${base.avgWin}, avgLoss=$${base.avgLoss}`);
  md.push(`- Signal-gated (exit on fresh crossing): WR=${gated.wr}%, Total=$${gated.total}, EV/trade=$${gated.ev}, avgWin=$${gated.avgWin}, avgLoss=$${gated.avgLoss}`);
  md.push(`- Blind control (exit at fixed bar ${medianOffset}, no signal): WR=${blind.wr}%, Total=$${blind.total}, EV/trade=$${blind.ev}`);
  md.push(`- **Signal-gated vs baseline: $${(Number(gated.total) - Number(base.total)).toFixed(2)}**`);
  md.push(`- **Blind control vs baseline: $${(Number(blind.total) - Number(base.total)).toFixed(2)}**\n`);

  md.push('## Clean population, TRAIN vs TEST (chronological 80/20 split, does the pooled result survive?)');
  for (const [label, set] of [['TRAIN', trainSet], ['TEST', testSet]]) {
    const b = summarize(set, 'pnlBaseline');
    const g = summarize(set, 'pnlSignalGated');
    const bl = summarize(set, 'pnlBlindGated');
    md.push(`### ${label} (N=${set.length}, dates ${set.length ? set[0].trade_date : 'n/a'} to ${set.length ? set[set.length - 1].trade_date : 'n/a'})`);
    md.push(`- Baseline: WR=${b.wr}%, Total=$${b.total}, EV/trade=$${b.ev}`);
    md.push(`- Signal-gated: WR=${g.wr}%, Total=$${g.total}, EV/trade=$${g.ev}`);
    md.push(`- Blind control: WR=${bl.wr}%, Total=$${bl.total}, EV/trade=$${bl.ev}`);
    md.push(`- Signal-gated vs baseline: $${(Number(g.total) - Number(b.total)).toFixed(2)} | Blind vs baseline: $${(Number(bl.total) - Number(b.total)).toFixed(2)}`);
  }
  md.push('');

  const trigBase = summarize(triggered, 'pnlBaseline');
  const trigGated = summarize(triggered, 'pnlSignalGated');
  const trigBlind = summarize(triggered, 'pnlBlindGated');
  md.push('## Only trades where the fresh signal actually fired');
  md.push(`- Baseline: N=${trigBase.n}, WR=${trigBase.wr}%, Total=$${trigBase.total}, EV/trade=$${trigBase.ev}`);
  md.push(`- Signal-gated: WR=${trigGated.wr}%, Total=$${trigGated.total}, EV/trade=$${trigGated.ev}`);
  md.push(`- Blind control (same trades, fixed-bar exit): WR=${trigBlind.wr}%, Total=$${trigBlind.total}, EV/trade=$${trigBlind.ev}`);
  md.push(`- **Signal-gated vs baseline: $${(Number(trigGated.total) - Number(trigBase.total)).toFixed(2)}**`);
  md.push(`- **Blind control vs baseline: $${(Number(trigBlind.total) - Number(trigBase.total)).toFixed(2)}**`);

  const report = md.join('\n');
  fs.writeFileSync('scratch/sigma_signal_exit_trigger_fresh_RESULTS.md', report);
  console.log(report);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
