// study_poc_join_with_volume_exits_20261020.mjs -- on the LIVE detector construction (bar volume passed in, as pocRotationJoinDetector.js:131): E0 old exit (20pt stop, mark to market at bar 60), E2 fixed 100pt stop + 60-minute exit, E1 live breakeven-hold, all with realistic fills.
import { loadBars, buildEvents, fwd, simE1, mean, sum, f, dayCI } from './lib/pocJoinLoader.mjs';
const FROM = '2023-03-06', TO = '2026-10-16', D = await loadBars(FROM, TO);
function simFixed(e, fi, last, stopPts, timeBars) { const { O, H, L, C } = D, long = e.long, stop = long ? e.entry - stopPts : e.entry + stopPts, end = Math.min(last, fi + timeBars);
  for (let k = fi; k <= end; k++) if (long ? L[k] <= stop : H[k] >= stop) { const fill = long ? Math.min(stop, O[k]) : Math.max(stop, O[k]); return (long ? fill - e.entry : e.entry - fill) * 2 - 2; }
  return (long ? C[end] - e.entry : e.entry - C[end]) * 2 - 2; }
for (const withVolume of [true, false]) { const ev = await buildEvents(D, FROM, TO, { withVolume }); const rows = [];
  for (let i = 0; i < ev.length; i++) { const w = fwd(D, ev, i); if (!w) continue; const e = ev[i]; rows.push({ d: e.d, era: e.d < '2025-06-01' ? 'PRE' : 'POST', E0: simFixed(e, w[0], w[1], 20, 60), E2: simFixed(e, w[0], w[1], 100, 60), E1: simE1(D, e, w[0], w[1]).pnl }); }
  console.log(`\n=== ${withVolume ? 'WITH volume (live construction)' : 'WITHOUT volume (old research population)'}: ${rows.length} events ===`); console.log('exit'.padEnd(22), 'ALL mean [CI]'.padEnd(24), 'PRE', '      POST');
  for (const [k, lab] of [['E0', 'E0 old 20pt/60min'], ['E2', 'E2 100pt/60min'], ['E1', 'E1 live BE-hold']]) { const [lo, hi] = dayCI(rows, r => r[k], 1000); const pre = rows.filter(r => r.era === 'PRE'), post = rows.filter(r => r.era === 'POST'); console.log(lab.padEnd(22), `${f(mean(rows.map(r => r[k])), 2)} [${f(lo, 1)},${f(hi, 1)}]`.padEnd(24), f(mean(pre.map(r => r[k])), 1).padStart(6), f(mean(post.map(r => r[k])), 1).padStart(8)); } }
process.exit(0);
