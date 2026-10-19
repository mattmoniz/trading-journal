// backtest_major_pivot_two_lot_runner_20261019.mjs -- does trading 2 contracts (lot 1 takes a profit, lot 2 runs with a breakeven stop) beat 1 contract held 24 h?
//
// User 2026-10-19: "should we use a quantity of 2 and leave a runner just in case". This is a PAIRED comparison on the SAME trades (so a split-population day-weighting trap
// does not apply): per-trade results are reported as P&L PER CONTRACT-EQUIVALENT (total / 2) next to the 1-lot result, plus the TOTAL dollars and the worst trade, because
// doubling quantity doubles both the wins and the losses -- what matters is whether the STRUCTURE (bank half early, stop the runner at breakeven) improves the payoff for the risk.
// Population = the real computeDefendedBreaks() (zigzag 1.0, 365 d), entry = completed 5-minute bar close, stop = STOP x the structural distance, runner/hold = 1440 min
// (the best-looking hold from backtest_major_pivot_recalibration_20261019.mjs). Lot 1 target = K x ATR. After lot 1 fills, lot 2's stop moves to breakeven (entry) from the NEXT
// bar (conservative: a bar that hits the target does not also stop the runner). Inside a 1-minute bar the stop is checked before the target. Commission $2 per contract round trip.
// Variants: runner stop = BREAKEVEN after lot 1, or KEEP the original stop.
// Run: node scripts/backtest_major_pivot_two_lot_runner_20261019.mjs
import { query } from '../server/db.js';
import { computeDefendedBreaks } from '../server/services/majorPivotDefendedBreakDetector.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';

const PT = 2, COMM = 2, HOLD = 1440;
const STOPS = [1.0, 1.5], KS = [0.5, 1.0, 1.5], RUNNER = ['BREAKEVEN', 'KEEP'];
const addMin = (ts, n) => new Date(new Date(ts.replace(' ', 'T') + 'Z').getTime() + n * 60000).toISOString().slice(0, 19).replace('T', ' ');
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (x) => (x == null || Number.isNaN(x) ? '   n/a' : (x >= 0 ? '+' : '') + x.toFixed(0)).padStart(6);
const pct = (x) => (x == null || Number.isNaN(x) ? '  n/a' : (100 * x).toFixed(0) + '%').padStart(5);

const breaks = await computeDefendedBreaks(1.0, 365);
const isGlobex = (b) => { const [h, m] = b.entryTsStr.split(' ')[1].split(':').map(Number); const mod = h * 60 + m; return mod >= 1080 || mod < 510; };
const trades = [];
for (const b of breaks) {
  const entryTime = b.closeTsStr;
  const bars = (await query(`SELECT ts::text ts, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 AND ts < $2 ORDER BY ts`, [entryTime, addMin(entryTime, HOLD)])).rows;
  if (bars.length < 5) continue;
  trades.push({ date: entryTime.slice(0, 10), entry: b.entryPrice, atr: b.atr, structDist: Math.abs(b.entryPrice - b.stopPrice), dir: b.direction === 'LONG' ? 1 : -1, bars, session: isGlobex(b) ? 'GLOBEX' : 'RTH' });
}

// One contract, stop only, held to the time limit.
function oneLot(t, stopMult) {
  const stopDist = t.structDist * stopMult, stop = t.entry - t.dir * stopDist;
  let last = null;
  for (const b of t.bars) { last = b; if (t.dir === 1 ? b.l <= stop : b.h >= stop) return -stopDist * PT - COMM; }
  return last ? (last.c - t.entry) * t.dir * PT - COMM : null;
}
// Two contracts. Returns { total, a, b, aFilled } in dollars.
function twoLot(t, stopMult, k, runnerMode) {
  const stopDist = t.structDist * stopMult, stop = t.entry - t.dir * stopDist, target = t.entry + t.dir * k * t.atr;
  let aDone = false, aPnl = 0, bStop = stop, bDone = false, bPnl = 0, last = null;
  for (const bar of t.bars) {
    last = bar;
    const hitStop = (px) => (t.dir === 1 ? bar.l <= px : bar.h >= px);
    if (!aDone) {
      if (hitStop(stop)) { aPnl = -stopDist * PT - COMM; bPnl = -stopDist * PT - COMM; return { total: aPnl + bPnl, a: aPnl, b: bPnl, aFilled: false }; }   // both stopped together
      if (t.dir === 1 ? bar.h >= target : bar.l <= target) { aDone = true; aPnl = k * t.atr * PT - COMM; if (runnerMode === 'BREAKEVEN') bStop = t.entry; }  // runner stop moves from the NEXT bar
      continue;
    }
    if (!bDone && hitStop(bStop)) { bDone = true; bPnl = (bStop - t.entry) * t.dir * PT - COMM; break; }
  }
  if (!aDone) { const lc = last ? (last.c - t.entry) * t.dir * PT - COMM : 0; return { total: 2 * lc, a: lc, b: lc, aFilled: false }; }   // time exit, both lots
  if (!bDone) bPnl = (last.c - t.entry) * t.dir * PT - COMM;
  return { total: aPnl + bPnl, a: aPnl, b: bPnl, aFilled: true };
}

function analyse(pop, label) {
  console.log(`\n==================== ${label}: ${pop.length} breaks, ${new Set(pop.map(t => t.date)).size} distinct days ====================`);
  console.log(' stop  lot1 tgt  runner   | 1-LOT (24h)             | 2-LOT per-contract       | 2-LOT TOTAL $/trade  worst   best  | paired diff (2-lot per contract - 1-lot)  CI lo/hi | lot1 filled | days');
  for (const stopMult of STOPS) {
    const one = pop.map(t => oneLot(t, stopMult)).filter(x => x != null);
    for (const k of KS) for (const mode of RUNNER) {
      const rows = pop.map(t => { const o = oneLot(t, stopMult); const r = twoLot(t, stopMult, k, mode); return o == null ? null : { date: t.date, one: o, total: r.total, per: r.total / 2, filled: r.aFilled }; }).filter(Boolean);
      const diff = rows.map(r => ({ date: r.date, pnl: r.per - r.one }));
      const ci = diff.length >= 8 ? dayBlockedBootstrapCI(diff, `twolot|${label}|${stopMult}|${k}|${mode}`, { dateField: 'date' }) : { lo: NaN, hi: NaN };
      console.log(`${String(stopMult).padStart(5)} ${(k + 'xATR').padStart(9)} ${mode.padStart(10)} | mean ${fmt(mean(rows.map(r => r.one)))} med ${fmt(median(rows.map(r => r.one)))} | mean ${fmt(mean(rows.map(r => r.per)))} med ${fmt(median(rows.map(r => r.per)))} | ${fmt(mean(rows.map(r => r.total)))}  ${fmt(Math.min(...rows.map(r => r.total)))} ${fmt(Math.max(...rows.map(r => r.total)))} | ${fmt(mean(diff.map(d => d.pnl)))}   ${fmt(ci.lo)} ${fmt(ci.hi)} | ${pct(rows.filter(r => r.filled).length / rows.length)} | ${new Set(rows.map(r => r.date)).size}`);
    }
  }
}
analyse(trades.filter(t => t.session === 'RTH'), 'RTH threshold1.0');
analyse(trades.filter(t => t.session === 'GLOBEX'), 'GLOBEX threshold1.0');
console.log('\nHow to read: 2-LOT per-contract is directly comparable to the 1-LOT mean (same trades). TOTAL is the real dollar result of the two-contract trade (about twice the per-contract figure) and "worst" is the worst single two-contract trade. A paired difference near zero means the structure changes the SIZE of the bet, not its quality.');
console.log('Done.');
process.exit(0);
