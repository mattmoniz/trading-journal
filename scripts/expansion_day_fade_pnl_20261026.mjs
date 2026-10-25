// Do RTH level-fade trades do worse (or better) on "range expansion" days (overnight range/ATR20 in the prior same-type top third; known before 09:30)?
// Events: scratch/rotation_gate_replay_rows_ts_20261020.json (3.5-year RTH roster replay, simulated P&L). Per-trade mean = sum/N; day-blocked delta CI; circular-shift placebo on the day flag.
import fs from 'fs';
import { dayBlockedBootstrapDeltaCI, hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
const R = JSON.parse(fs.readFileSync(new URL('../scratch/overnight_rth_dataset_20261026.json', import.meta.url))).rows;
const ev = JSON.parse(fs.readFileSync(new URL('../scratch/rotation_gate_replay_rows_ts_20261020.json', import.meta.url)));
const typeOf = (r) => (r.dow === 1 ? 'MON' : 'OTH'), onRngAtr = (r) => (r.onH - r.onL) / r.atr, mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const flag = new Map();
R.forEach((r, i) => { const N = typeOf(r) === 'MON' ? 15 : 60, prior = []; for (let j = i - 1; j >= 0 && prior.length < N; j--) if (typeOf(R[j]) === typeOf(r)) prior.push(onRngAtr(R[j])); if (prior.length < 12) return; const s = [...prior].sort((a, b) => a - b); flag.set(r.date, onRngAtr(r) >= s[Math.floor(0.67 * (s.length - 1))]); });
const rows = ev.filter((e) => flag.has(e.d)).map((e) => ({ date: e.d, pnl: e.pnl, group: flag.get(e.d) ? 'EXP' : 'REST', era: e.era, long: e.long }));
const dates = [...new Set(rows.map((r) => r.date))].sort();
const stat = (rs) => { const a = rs.filter((r) => r.group === 'EXP'), b = rs.filter((r) => r.group === 'REST'); return { nE: a.length, nR: b.length, dE: new Set(a.map((r) => r.date)).size, mE: mean(a.map((r) => r.pnl)), mR: mean(b.map((r) => r.pnl)), diff: mean(a.map((r) => r.pnl)) - mean(b.map((r) => r.pnl)) }; };
function report(label, rs) {
  const s = stat(rs), ci = dayBlockedBootstrapDeltaCI(rs, 'exp|' + label, { groupField: 'group', groupA: 'REST', groupB: 'EXP', iters: 3000 });
  // circular-shift placebo: shift the per-date flag sequence against the dates, recompute the pooled per-trade difference
  const fl = dates.map((d) => flag.get(d)), byDate = new Map(); for (const r of rs) (byDate.get(r.date) || byDate.set(r.date, []).get(r.date)).push(r.pnl);
  let ge = 0, tot = 0; const L = dates.length;
  for (let off = 1; off < L; off++) { let sE = 0, nE = 0, sR = 0, nR = 0; for (let i = 0; i < L; i++) { const p = byDate.get(dates[i]); if (!p) continue; const f = fl[(i + off) % L]; for (const v of p) { if (f) { sE += v; nE++; } else { sR += v; nR++; } } } if (nE && nR) { tot++; if (Math.abs(sE / nE - sR / nR) >= Math.abs(s.diff)) ge++; } }
  console.log(`${label.padEnd(14)} EXP n=${s.nE} (${s.dE} days) mean ${s.mE.toFixed(2)} | REST n=${s.nR} mean ${s.mR.toFixed(2)} | diff ${s.diff.toFixed(2)}/trade CI [${ci.lo?.toFixed(2)}, ${ci.hi?.toFixed(2)}] placebo p=${(ge / tot).toFixed(3)}`);
}
report('ALL', rows); report('era PRE', rows.filter((r) => r.era === 'PRE')); report('era POST', rows.filter((r) => r.era !== 'PRE'));
const half = Math.floor(dates.length / 2), d1 = new Set(dates.slice(0, half));
report('first half', rows.filter((r) => d1.has(r.date))); report('second half', rows.filter((r) => !d1.has(r.date)));
report('LONG fades', rows.filter((r) => r.long)); report('SHORT fades', rows.filter((r) => !r.long));
console.log('days with flag:', dates.filter((d) => flag.get(d)).length, 'of', dates.length);
process.exit(0);
