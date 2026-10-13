// backtest_major_pivot_stop_timeexit_1yr_20261008.mjs -- the real follow-up test from
// major_pivot_target_barely_mattered_real_root_cause_20261008: re-test the REAL mechanism
// (stop=1.5x ATR, 720min mark-to-market time-exit, NO target dependency -- the thing that
// was actually validated on 2026-09-10, now correctly understood) over a ~1-year window,
// matching the original backtest's real scope, instead of the live detector's 120-day
// LOOKBACK_DAYS. Reuses the REAL computeDefendedBreaks() function (now takes an optional
// lookbackDays param, added for this purpose) -- no reimplementation of pivot/break logic.

import { query } from '../server/db.js';
import { computeDefendedBreaks } from '../server/services/majorPivotDefendedBreakDetector.js';
import { dayBlockedBootstrapCI, computeRigor } from '../server/services/rigorDiagnostics.js';

const STOP_MULT_LABEL = '1.5x ATR (unchanged from live config, baked into b.stopPrice already)';
const HOLD_MIN = 720;
const COMMISSION = 2, PT = 2;
const LOOKBACK_DAYS = 365;

console.log(`Running computeDefendedBreaks(1.5, ${LOOKBACK_DAYS}) -- this re-walks every bar in the window, may take a while...`);
const t0 = Date.now();
const breaks = await computeDefendedBreaks(1.5, LOOKBACK_DAYS);
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. ${breaks.length} total defended breaks (RTH+Globex combined).`);

const rthBreaks = [];
const globexBreaks = [];
for (const b of breaks) {
  const [, hms] = b.entryTsStr.split(' ');
  const [h, m] = hms.split(':').map(Number);
  const modOfDay = h * 60 + m;
  const isGlobex = modOfDay >= 1080 || modOfDay < 510;
  (isGlobex ? globexBreaks : rthBreaks).push(b);
}
console.log(`RTH breaks: ${rthBreaks.length}, Globex breaks: ${globexBreaks.length}`);

async function simulate(breakList, label) {
  const trades = [];
  for (const b of breakList) {
    const long = b.direction === 'LONG';
    const stopPts = Math.abs(b.entryPrice - b.stopPrice);
    const endTs = new Date(new Date(b.entryTsStr.replace(' ', 'T') + 'Z').getTime() + HOLD_MIN * 60000).toISOString().slice(0, 19).replace('T', ' ');

    const bars = (await query(`SELECT ts::text ts, high::float h, low::float l, close::float c FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1 AND ts <= $2 ORDER BY ts`, [b.entryTsStr, endTs])).rows;
    if (!bars.length) continue;

    let resolution = 'TIME_EXPIRED', pnl = null;
    for (const bar of bars) {
      const stopHit = long ? bar.l <= b.stopPrice : bar.h >= b.stopPrice;
      if (stopHit) { pnl = -stopPts * PT - COMMISSION; resolution = 'STOP_HIT'; break; }
    }
    if (pnl == null) {
      const lastClose = bars[bars.length - 1].c;
      pnl = (long ? lastClose - b.entryPrice : b.entryPrice - lastClose) * PT - COMMISSION;
    }
    trades.push({ date: b.entryTsStr.slice(0, 10), pnl, resolution, streak: b.streak });
  }

  console.log(`\n=== ${label}: ${trades.length} usable trades ===`);
  if (trades.length < 5) { console.log('Too few to evaluate.'); return; }

  const stopCount = trades.filter(t => t.resolution === 'STOP_HIT').length;
  const timeCount = trades.filter(t => t.resolution === 'TIME_EXPIRED').length;
  const ev = trades.reduce((s, t) => s + t.pnl, 0) / trades.length;
  const wr = trades.filter(t => t.pnl > 0).length / trades.length;
  console.log(`Stop-outs: ${stopCount} (${(100 * stopCount / trades.length).toFixed(1)}%), Time-exits: ${timeCount} (${(100 * timeCount / trades.length).toFixed(1)}%)`);
  console.log(`Mean EV: $${ev.toFixed(2)}/trade, WR(positive pnl): ${(100 * wr).toFixed(1)}%, total=$${trades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);

  const ci = dayBlockedBootstrapCI(trades, 'major_pivot_1yr_recheck_' + label, { dateField: 'date' });
  const excludesZero = ci.lo > 0 || ci.hi < 0;
  console.log(`Day-blocked bootstrap 95% CI: [$${ci.lo.toFixed(2)}, $${ci.hi.toFixed(2)}]${excludesZero ? '  <<< excludes zero' : ''}`);

  const rigor = computeRigor(trades, { pnlFn: t => t.pnl });
  console.log('Rigor:', JSON.stringify(rigor));

  return { trades, ev, ci, rigor, stopCount, timeCount };
}

await simulate(rthBreaks, 'RTH');
await simulate(globexBreaks, 'Globex');

console.log('\nDone.');
process.exit(0);
