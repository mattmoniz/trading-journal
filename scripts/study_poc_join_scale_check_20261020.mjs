// study_poc_join_scale_check_20261020.mjs -- user point 2026-10-20: a fixed 65pt rotation is a much bigger move in 2023 (NQ ~12-15k) than now (~30k), so the PRE/POST era gap may be a scale artifact.
// Compares the fixed-65pt construction with a price-proportional one (detectSignalEvents rMode='pct', R = 65 / reference price) and a proportional stop (100pt at the reference price), realistic fills, by year and era. Research only.
import { loadBars, buildEvents, fwd, simE1, mean, f, dayCI } from './lib/pocJoinLoader.mjs';
const FROM = '2023-03-06', TO = '2026-10-16', REF = 29500;   // reference price: the level at which 65pt / 100pt were validated (recent data)
const D = await loadBars(FROM, TO);
const run = async (label, opts, stopFn) => { const ev = await buildEvents(D, FROM, TO, opts); const rows = [];
  for (let i = 0; i < ev.length; i++) { const w = fwd(D, ev, i); if (!w) continue; const e = ev[i], sp = stopFn(e); rows.push({ ...e, stopPts: sp, pnl: simE1(D, e, w[0], w[1], { stopPts: sp }).pnl, year: e.d.slice(0, 4), era: e.d < '2025-06-01' ? 'PRE' : 'POST' }); }
  console.log(`\n=== ${label} === events ${rows.length}, mean ${f(mean(rows.map(r => r.pnl)), 2)}`);
  console.log('year  events  per-session  avg entry px  avg stop pts   mean E1   [CI]');
  for (const y of ['2023', '2024', '2025', '2026']) { const a = rows.filter(r => r.year === y); const [lo, hi] = dayCI(a, r => r.pnl, 800); console.log(y, String(a.length).padStart(7), (a.length / new Set(a.map(r => r.d)).size).toFixed(2).padStart(10), mean(a.map(r => r.entry)).toFixed(0).padStart(13), mean(a.map(r => r.stopPts)).toFixed(0).padStart(11), f(mean(a.map(r => r.pnl)), 1).padStart(9), `[${f(lo, 0)},${f(hi, 0)}]`); }
  for (const era of ['PRE', 'POST']) { const a = rows.filter(r => r.era === era); const [lo, hi] = dayCI(a, r => r.pnl, 800); console.log(era.padEnd(5), String(a.length).padStart(7), ''.padStart(10), mean(a.map(r => r.entry)).toFixed(0).padStart(13), mean(a.map(r => r.stopPts)).toFixed(0).padStart(11), f(mean(a.map(r => r.pnl)), 1).padStart(9), `[${f(lo, 0)},${f(hi, 0)}]`); } return rows; };
const fixed = await run('FIXED 65pt rotation, fixed 100pt stop (the live construction)', { R: 65, rMode: 'fixed' }, () => 100);
const pct = await run(`PROPORTIONAL: rotation 65/${REF} of price (rMode pct), stop 100/${REF} of entry`, { R: 65 / REF, rMode: 'pct' }, (e) => 100 * e.entry / REF);
const pctFixedStop = await run('PROPORTIONAL rotation but fixed 100pt stop (isolates the stop scaling)', { R: 65 / REF, rMode: 'pct' }, () => 100);
process.exit(0);
