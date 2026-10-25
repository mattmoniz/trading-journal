// Control for the SHOWN A2_RANGE_EXPANSION / A4_HIVOL_RANGE cells: both state (ON range/ATR20) and outcome (RTH range/ATR20) share the ATR20 denominator.
// Here: state = ON range in POINTS >= 67th pct of prior same-type ON ranges (points); outcome = percentile rank of the RTH range (points) among the prior 60 RTH ranges.
import fs from 'fs';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
const R = JSON.parse(fs.readFileSync(new URL('../scratch/overnight_rth_dataset_20261026.json', import.meta.url))).rows;
const typeOf = (r) => (r.dow === 1 ? 'MON' : 'OTH'), mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const onRng = (r) => r.onH - r.onL, rthRng = (r) => r.rthRangeAtr * r.atr;
const rows = R.map((r, i) => {
  const N = typeOf(r) === 'MON' ? 15 : 60, prior = []; for (let j = i - 1; j >= 0 && prior.length < N; j--) if (typeOf(R[j]) === typeOf(r)) prior.push(onRng(R[j]));
  const pr = R.slice(Math.max(0, i - 60), i).map(rthRng);
  if (prior.length < 12 || pr.length < 30) return null;
  const s = [...prior].sort((a, b) => a - b), cut = s[Math.floor(0.67 * (s.length - 1))];
  return { date: r.date, state: onRng(r) >= cut, y: pr.filter((v) => v < rthRng(r)).length / pr.length };
}).filter(Boolean);
const cut = Math.floor(R.length * 0.6);
for (const [label, blk] of [['explore', rows.filter((x) => x.date <= R[cut - 1].date)], ['hold-out', rows.filter((x) => x.date > R[cut - 1].date)], ['all', rows]]) {
  const mu = mean(blk.map((x) => x.y)), st = blk.filter((x) => x.state), vals = st.map((x) => ({ date: x.date, pnl: x.y - mu })), ci = dayBlockedBootstrapCI(vals, 'ctl|' + label, { iters: 3000 });
  console.log(`${label}: days ${blk.length}, state days ${st.length}, mean RTH-range rank|state ${mean(st.map((x) => x.y)).toFixed(3)} vs all ${mu.toFixed(3)}, excess ${mean(vals.map((v) => v.pnl)).toFixed(3)} [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] (rank units; 0.5 = median day)`);
}
process.exit(0);
