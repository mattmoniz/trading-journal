import fs from 'fs';
import { query } from '../server/db.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
const R = JSON.parse(fs.readFileSync(new URL('../scratch/overnight_rth_dataset_20261026.json', import.meta.url))).rows;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const typeOf = (r) => (r.dow === 1 ? 'MON' : 'OTH'), onRngAtr = (r) => (r.onH - r.onL) / r.atr;
const flag = (valFn, p) => R.map((r, i) => { const N = typeOf(r) === 'MON' ? 15 : 60, prior = []; for (let j = i - 1; j >= 0 && prior.length < N; j--) if (typeOf(R[j]) === typeOf(r)) prior.push(valFn(R[j])); if (prior.length < 12) return null; const s = [...prior].sort((a, b) => a - b); return valFn(r) >= s[Math.floor(p * (s.length - 1))]; });
const hiOn = flag(onRngAtr, 0.67), atrVal = (r) => r.atr;
// bottom third of ATR20 vs prior same-type: flag top third of (-atr)
const lowAtr = flag((r) => -r.atr, 0.67);
const cut = Math.floor(R.length * 0.6);
const blocks = { explore: [0, cut], 'hold-out': [cut, R.length] };
for (const [name, [a, b]] of Object.entries(blocks)) {
  const idx = [...Array(b - a).keys()].map((k) => a + k).filter((i) => hiOn[i] !== null && lowAtr[i] !== null);
  const mu = mean(idx.map((i) => R[i].rthRangeAtr));
  const ex = (flagArr) => { const v = idx.filter((i) => flagArr[i]).map((i) => ({ date: R[i].date, pnl: R[i].rthRangeAtr - mu })); const ci = dayBlockedBootstrapCI(v, 'atrctl|' + name, { iters: 3000 }); return `n=${v.length} excess ${mean(v.map((x) => x.pnl)).toFixed(3)} [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`; };
  console.log(`${name}: HIGH ON range/ATR state: ${ex(hiOn)} | PLACEBO low-ATR20 state: ${ex(lowAtr)}`);
  // ATR as a third matching variable for the range-expansion state
  const st = idx.filter((i) => hiOn[i]), ctl = idx.filter((i) => !hiOn[i]);
  const sd = (fn) => { const arr = idx.map((i) => fn(R[i])), m = mean(arr); return Math.sqrt(mean(arr.map((v) => (v - m) ** 2))) || 1; };
  const sg = sd((r) => r.gapAtr ? Math.abs(r.gapAtr) : 0), sp = sd((r) => r.pdRangeAtr), sa = sd((r) => Math.log(r.atr));
  const mv = st.map((i) => { const d = ctl.map((j) => ({ j, d: Math.hypot((Math.abs(R[j].gapAtr) - Math.abs(R[i].gapAtr)) / sg, (R[j].pdRangeAtr - R[i].pdRangeAtr) / sp, (Math.log(R[j].atr) - Math.log(R[i].atr)) / sa) })).sort((x, y) => x.d - y.d).slice(0, 5); return { date: R[i].date, pnl: R[i].rthRangeAtr - mean(d.map((e) => R[e.j].rthRangeAtr)) }; });
  const ci = dayBlockedBootstrapCI(mv, 'atrmatch|' + name, { iters: 3000 });
  console.log(`   matched on gap, prior-day range AND log ATR20: excess ${mean(mv.map((v) => v.pnl)).toFixed(3)} [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`);
}
const q = await query(`SELECT to_char(trade_date,'YYYY-MM') m, round(avg(rth_range)::numeric) avg_rng, min(n_bars) min_bars FROM daily_rth_stats WHERE trade_date BETWEEN '2025-08-01' AND '2026-01-31' GROUP BY 1 ORDER BY 1`);
console.table(q.rows);
process.exit(0);
