// summarize_major_pivot_year_pnl_20261019.mjs -- what would one year of MAJOR_PIVOT_DEFENDED_BREAK have looked like in total dollars, for one contract?
// User 2026-10-19: "on aggregate, how would the total P&L look in that whole timeframe after the year". Reports, for each config: total $, trades, win rate, median, worst/best, top-3 share,
// total WITHOUT the 3 best trades, max drawdown on a resolved-time-ordered curve, monthly P&L, max simultaneous open positions, and the total under a strict ONE-POSITION-AT-A-TIME queue
// (a break is skipped while an earlier position is still open -- the repo's standing lesson that a sum of independent trades overstates what one contract can do).
// Entry = completed 5-minute bar close; stop checked each 1-minute bar; time exit at the hold limit; $2/pt, $2 round-trip commission; NO slippage in the headline, a flat friction sensitivity below it.
// Configs: LIVE (stop 1.5x, 720 min) and TRIAL (stop 1.0x, 1440 min), RTH only, plus RTH+Globex for the trial.
// Run: node scripts/summarize_major_pivot_year_pnl_20261019.mjs
import { query } from '../server/db.js';
import { computeDefendedBreaks } from '../server/services/majorPivotDefendedBreakDetector.js';

const PT = 2, COMM = 2, FRICTION = 25;       // FRICTION: flat all-in slippage sensitivity per trade (entry + stop fill), dollars; measured stop fills in 2026-10 averaged ~12 pts from the stop level
const addMin = (ts, n) => new Date(new Date(ts.replace(' ', 'T') + 'Z').getTime() + n * 60000).toISOString().slice(0, 19).replace('T', ' ');
const toMin = (s) => Math.floor(new Date(s.replace(' ', 'T') + 'Z').getTime() / 60000);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const money = (x) => (x >= 0 ? '+$' : '-$') + Math.abs(Math.round(x)).toLocaleString();

const breaks = await computeDefendedBreaks(1.0, 365);
const isGlobex = (b) => { const [h, m] = b.entryTsStr.split(' ')[1].split(':').map(Number); const mod = h * 60 + m; return mod >= 1080 || mod < 510; };
const raw = [];
for (const b of breaks) {
  const bars = (await query(`SELECT ts::text ts, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 AND ts < $2 ORDER BY ts`, [b.closeTsStr, addMin(b.closeTsStr, 1440)])).rows;
  if (bars.length < 5) continue;
  raw.push({ entryTs: b.closeTsStr, entryMin: toMin(b.closeTsStr), entry: b.entryPrice, structDist: Math.abs(b.entryPrice - b.stopPrice), dir: b.direction === 'LONG' ? 1 : -1, bars, globex: isGlobex(b), live15: null });
}
function run(t, stopMult, holdMin) {
  const stopDist = t.structDist * stopMult, stop = t.entry - t.dir * stopDist, limit = t.entryMin + holdMin;
  let last = null;
  for (const b of t.bars) {
    if (toMin(b.ts) >= limit) break;
    last = b;
    if (t.dir === 1 ? b.l <= stop : b.h >= stop) return { pnl: -stopDist * PT - COMM, exitMin: toMin(b.ts), how: 'STOP' };
  }
  return last ? { pnl: (last.c - t.entry) * t.dir * PT - COMM, exitMin: toMin(last.ts), how: 'TIME' } : null;
}
function maxDrawdown(trs) {                                    // peak-to-trough on the cumulative curve ordered by EXIT time
  let run = 0, peak = 0, dd = 0;
  for (const t of [...trs].sort((a, b) => a.exitMin - b.exitMin)) { run += t.pnl; peak = Math.max(peak, run); dd = Math.max(dd, peak - run); }
  return dd;
}
function maxOverlap(trs) {
  const ev = []; for (const t of trs) { ev.push([t.entryMin, 1], [t.exitMin, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); let cur = 0, mx = 0; for (const [, d] of ev) { cur += d; mx = Math.max(mx, cur); } return mx;
}
function report(label, pop, stopMult, holdMin) {
  const all = pop.map(t => { const r = run(t, stopMult, holdMin); return r ? { ...r, entryMin: t.entryMin, entryTs: t.entryTs } : null; }).filter(Boolean).sort((a, b) => a.entryMin - b.entryMin);
  // strict one-position-at-a-time: take a break only if no earlier taken position is still open at its entry
  const queue = []; let freeAt = -Infinity; for (const t of all) { if (t.entryMin >= freeAt) { queue.push(t); freeAt = t.exitMin; } }
  const stat = (trs, tag) => {
    const p = trs.map(t => t.pnl), sorted = [...p].sort((a, b) => b - a), tot = sum(p), top3 = sum(sorted.slice(0, 3));
    return `${tag.padEnd(22)} trades ${String(trs.length).padStart(3)} | TOTAL ${money(tot).padStart(8)} | per trade ${money(tot / (trs.length || 1)).padStart(6)} | win rate ${(100 * p.filter(x => x > 0).length / (trs.length || 1)).toFixed(0)}% | median ${money(median(p))} | best ${money(sorted[0])} worst ${money(sorted[sorted.length - 1])} | without the 3 best ${money(tot - top3)} | max drawdown ${money(-maxDrawdown(trs))} | with $${FRICTION}/trade friction ${money(tot - FRICTION * trs.length)}`;
  };
  console.log(`\n--- ${label} ---`);
  console.log('  ' + stat(all, 'every break (overlaps ok)') + ` | max open at once ${maxOverlap(all)}`);
  console.log('  ' + stat(queue, 'one position at a time'));
  const byM = {}; for (const t of all) { const k = t.entryTs.slice(0, 7); byM[k] = (byM[k] || 0) + t.pnl; }
  console.log('  monthly (every break): ' + Object.entries(byM).map(([k, v]) => `${k} ${money(v)}`).join('  '));
  const half = all.length >> 1; console.log(`  first half of trades ${money(sum(all.slice(0, half).map(t => t.pnl)))} (${all[0].entryTs.slice(0, 10)}..${all[half - 1].entryTs.slice(0, 10)})   second half ${money(sum(all.slice(half).map(t => t.pnl)))} (${all[half].entryTs.slice(0, 10)}..${all[all.length - 1].entryTs.slice(0, 10)})`);
}
const rth = raw.filter(t => !t.globex), both = raw;
console.log(`Period: ${raw[0].entryTs.slice(0, 10)} to ${raw[raw.length - 1].entryTs.slice(0, 10)}; ${rth.length} RTH breaks, ${raw.length - rth.length} Globex breaks (zigzag 1.0). One MNQ contract, commission included, slippage excluded unless stated.`);
report('RTH only -- LIVE config (stop 1.5x, hold 12h)', rth, 1.5, 720);
report('RTH only -- TRIAL config (stop 1.0x, hold 24h)', rth, 1.0, 1440);
report('RTH + Globex -- TRIAL config (stop 1.0x, hold 24h)', both, 1.0, 1440);
console.log('\nDone.');
process.exit(0);
