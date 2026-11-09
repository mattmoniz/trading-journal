// Do setups perform better at certain times? EVERY setup type, FOUR time dimensions, TWO populations, each setup's own result (user 2026-11-08: 'Did you look at every setup or no?', 'Stop cutting corners').
// Dimensions: TIME_BLOCK (RTH open 09:35-10:30 / RTH mid 10:30-14:00 / RTH late 14:00-16:00 / Globex evening 18:30-24:00 / Globex night 00:00-09:30), SESSION (RTH vs Globex), DOW (calendar weekday of fired_at), MONTH (calendar month; only with >12 months of history).
// Populations: LIVE = ACTIVE + SHADOW since 2026-07-09 (real detections); HISTORY = LIVE + BACKFILL (synthetic, backtested, hr-006) + UNKNOWN (older live rows), 2023-11 onward. Kept separate: BACKFILL is not realized performance.
// Per (setup, dimension): cells (one label value) with >= MIN_OBS cluster-collapsed trades; spread = best cell mean - worst cell mean; permutation p = share of label shuffles (within the setup's own trades; DOW / MONTH shuffled at DAY level so days stay intact) with a spread >= the real one.
// Multiplicity: Benjamini-Hochberg FDR 0.10 across every analyzable (setup, dimension) test of a population. Overall test: the average spread across setups against the same shuffles. Exploratory (ledger look, 0 counted tests); a lead feeds a pre-registered forward test, never a gate.
import fs from 'fs';
import { query } from '../server/db.js';
import { logLook } from './lib/look_ledger.mjs';
import { bucketOfMinute, minuteOfText } from '../server/services/bucketRoster.js';
const MIN_OBS = 8, NP = 2000, NP_REFINE = 20000, REFINE_BELOW = 0.05, FDR = 0.10;
let seed = 20261108;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
await logLook({ family: 'setup_time_dependence_full_20261108', dataWindow: 'explore_2023-11_to_2026-11', kind: 'EXPLORE', tests: 0, ref: 'setup_time_dependence_full_' + new Date().toISOString().slice(0, 10), label: 'Exploratory: every setup type x (time block, session, day of week, month) own permutation p with BH FDR 0.10, LIVE and HISTORY populations kept apart', script: 'scripts/setup_time_dependence_full.mjs' });
const dowOf = (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay()];
const rows = (await query(`SELECT setup_type t, origin_status o, fired_at::text fa, cluster_touch_id cl, actual_pnl::float p FROM active_setups
  WHERE origin_status IN ('ACTIVE','SHADOW','BACKFILL','UNKNOWN') AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED'
    AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND stale_levels_basis IS NOT TRUE
    AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%'`)).rows
  .map((r) => { const min = minuteOfText(r.fa), date = r.fa.slice(0, 10); return { t: r.t, o: r.o, date, cl: r.cl, p: r.p, block: bucketOfMinute(min), dow: dowOf(date), month: date.slice(5, 7) }; });
const live = (r) => r.o === 'ACTIVE' || r.o === 'SHADOW';
const POPS = { LIVE: rows.filter(live), HISTORY: rows };
const DIMS = [['TIME_BLOCK', (o) => o.block, false], ['SESSION', (o) => (o.block == null ? null : o.block.startsWith('RTH') ? 'RTH' : 'GLOBEX'), false], ['DOW', (o) => o.dow, true], ['MONTH', (o) => o.month, true]];
const out = []; const summary = [];
for (const [pop, prs] of Object.entries(POPS)) {
  const by = new Map(); for (const r of prs) { if (!by.has(r.t)) by.set(r.t, []); by.get(r.t).push(r); }
  const nDays = new Set(prs.map((r) => r.date)).size, months = new Set(prs.map((r) => r.date.slice(0, 7))).size;
  for (const [dim, labelOf, dayLevel] of DIMS) {
    if (dim === 'MONTH' && months < 13) { summary.push(`${pop} ${dim}: skipped (only ${months} calendar months of data)`); continue; }
    const tests = []; const perm = new Float64Array(NP); let nSingle = 0, nThin = 0;
    for (const [t, rs] of by) {
      const g = new Map();
      for (const r of rs) { const lab = labelOf(r); if (lab == null) continue; const k = r.cl == null ? 'S' + g.size : String(r.cl); if (!g.has(k)) g.set(k, { lab, date: r.date, ys: [] }); g.get(k).ys.push(r.p); }
      const obs = [...g.values()].map((x) => ({ lab: x.lab, date: x.date, y: mean(x.ys) }));
      const distinct = new Set(obs.map((o) => o.lab)); const cnt = new Map(); for (const o of obs) cnt.set(o.lab, (cnt.get(o.lab) || 0) + 1);
      const ok = [...cnt].filter(([, n]) => n >= MIN_OBS).map(([l]) => l);
      if (ok.length < 2) { if (distinct.size <= 1) nSingle++; else nThin++; out.push({ pop, dim, t, status: distinct.size <= 1 ? 'one_cell_only' : 'too_thin', n: obs.length }); continue; }
      const days = [...new Set(obs.map((o) => o.date))], di = new Map(days.map((d, i) => [d, i])), od = obs.map((o) => di.get(o.date)), y = obs.map((o) => o.y);
      const labs = [...new Set(obs.map((o) => o.lab))], li = new Map(labs.map((l, i) => [l, i])), base = obs.map((o) => li.get(o.lab)), dayLab = days.map((d) => base[od.indexOf(di.get(d))]);
      const spreadOf = (lab) => { const s = new Float64Array(labs.length), c = new Int32Array(labs.length); for (let i = 0; i < y.length; i++) { s[lab[i]] += y[i]; c[lab[i]]++; } let mx = -Infinity, mn = Infinity; for (let k = 0; k < labs.length; k++) if (c[k] >= MIN_OBS) { const m = s[k] / c[k]; if (m > mx) mx = m; if (m < mn) mn = m; } return mx === -Infinity || mx === mn ? 0 : mx - mn; };
      const shuffleLab = () => { if (!dayLevel) { const a = base.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const x = a[i]; a[i] = a[j]; a[j] = x; } return a; } const dl = dayLab.slice(); for (let i = dl.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const x = dl[i]; dl[i] = dl[j]; dl[j] = x; } return od.map((d) => dl[d]); };
      const real = spreadOf(base); let ge = 0; for (let k = 0; k < NP; k++) { const s = spreadOf(shuffleLab()); perm[k] += s; if (s >= real) ge++; }
      let p = (ge + 1) / (NP + 1);
      if (p <= REFINE_BELOW) { ge = 0; for (let k = 0; k < NP_REFINE; k++) if (spreadOf(shuffleLab()) >= real) ge++; p = (ge + 1) / (NP_REFINE + 1); }
      const cells = ok.map((l) => { const v = obs.filter((o) => o.lab === l).map((o) => o.y); return { l, m: mean(v), n: v.length }; }).sort((a, b) => b.m - a.m);
      tests.push({ pop, dim, t, status: 'analyzed', n: obs.length, cells: cells.length, spread: real, p, best: cells[0], worst: cells[cells.length - 1] });
    }
    // Benjamini-Hochberg across the analyzed tests of this population and dimension
    const sorted = [...tests].sort((a, b) => a.p - b.p); let kmax = -1; sorted.forEach((x, i) => { if (x.p <= ((i + 1) / sorted.length) * FDR) kmax = i; }); sorted.forEach((x, i) => { x.bh = i <= kmax; });
    const realMean = mean(tests.map((x) => x.spread)), nullMeans = Array.from(perm, (v) => v / Math.max(1, tests.length)).sort((a, b) => a - b), pAll = (nullMeans.filter((v) => v >= realMean).length + 1) / (NP + 1);
    summary.push(`${pop} ${dim}: ${by.size} setup types; ${tests.length} analyzable (>= 2 cells with >= ${MIN_OBS} trades), ${nSingle} only ever in one cell, ${nThin} spread too thinly; average best-minus-worst spread REAL ${realMean.toFixed(1)} vs SHUFFLED ${mean(nullMeans).toFixed(1)} (95% range ${nullMeans[Math.floor(NP * 0.025)].toFixed(1)}-${nullMeans[Math.floor(NP * 0.975)].toFixed(1)}), chance of this by luck ${(100 * pAll).toFixed(1)}%; individually significant after the false-discovery correction (FDR ${FDR}): ${tests.filter((x) => x.bh).length}; raw p<0.05: ${tests.filter((x) => x.p < 0.05).length} (chance alone gives about ${(tests.length * 0.05).toFixed(1)})`);
    out.push(...tests);
  }
}
const hdr = 'population,dimension,setup_type,status,n_trades,cells,spread,p,bh_fdr10,best_cell,best_mean,best_n,worst_cell,worst_mean,worst_n';
fs.mkdirSync(new URL('../scratch/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../scratch/setup_time_dependence_20261108.csv', import.meta.url), [hdr, ...out.map((x) => [x.pop, x.dim, x.t, x.status, x.n, x.cells ?? '', x.spread != null ? x.spread.toFixed(1) : '', x.p != null ? x.p.toFixed(4) : '', x.bh ?? '', x.best?.l ?? '', x.best ? x.best.m.toFixed(1) : '', x.best?.n ?? '', x.worst?.l ?? '', x.worst ? x.worst.m.toFixed(1) : '', x.worst?.n ?? ''].join(','))].join('\n'));
console.log(`${rows.length} trades, ${new Set(rows.map((r) => r.t)).size} setup types in total (LIVE ${POPS.LIVE.length} trades / ${new Set(POPS.LIVE.map((r) => r.t)).size} types; HISTORY ${POPS.HISTORY.length} trades / ${new Set(POPS.HISTORY.map((r) => r.t)).size} types)`);
for (const s of summary) console.log('\n' + s);
const top = out.filter((x) => x.status === 'analyzed').sort((a, b) => a.p - b.p).slice(0, 25);
console.log('\nSMALLEST p-values (all populations and dimensions):');
for (const x of top) console.log(`  ${x.pop.padEnd(7)} ${x.dim.padEnd(10)} ${x.t.padEnd(36)} p ${x.p.toFixed(4)} FDR ${x.bh ? 'PASS' : 'no  '}  best ${x.best.l} ${x.best.m.toFixed(0)} (n${x.best.n})  worst ${x.worst.l} ${x.worst.m.toFixed(0)} (n${x.worst.n})`);
console.log('\nfull per-setup table: scratch/setup_time_dependence_20261108.csv');
process.exit(0);
