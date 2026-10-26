// Pre-registered in docs/STUFFED_AT_DEFENDED_PIVOT_PREREG_20261026.md (+ Amendment 1 if present) -- committed before this ran.
// A STUFFED big order (60 s later price is >= 2 ticks back against its last print; same tsv and definition as the 10-20 test) whose last print sits inside the band of an ACTIVE, DEFENDED minute-scale pivot of the matching orientation
// (SELL at a LOW pivot, BUY at a HIGH pivot): does price keep going the other way over the next 5/15/30 minutes? Matched excess over all other same-side big orders (C), plus controls A (followed at a defended pivot) and B (stuffed, not at a pivot).
import fs from 'fs';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, sessionIndex } from './lib/pocJoinLoader.mjs';
import { SPARSE, emOf, mean } from './lib/floorEngine.mjs';
import { load5m, pivotTimeline, indexByDate, pivotAt, SW } from './lib/pivotContext.mjs';
import { findSwingPoints } from '../server/services/swingPivots.js';
import { walkZigZagAcceptance } from '../server/services/acdShared.js';
import { buildRollWeekDateSet } from '../server/services/acdShared.js';

const FROM = '2023-03-06', TO = '2026-10-19', SPLIT = '2025-06-01', SIZE = 70, TICKS = 2, T = 0.25, TD = process.env.TICKS_TEST ? +process.env.TICKS_TEST : TICKS;
const BANDX = +(process.env.BAND_MULT || 0.02), f = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : 'n/a');
const HZ = [['5m', 'p360'], ['15m', 'p960'], ['30m', 'p1860']];
async function main() {
  const D = await loadBars(FROM, TO), S = sessionIndex(D);
  const { bars5m, atr: atrCal } = await load5m('2023-02-01', TO), rollDates = buildRollWeekDateSet(bars5m);
  const { piv, same, nAccepted, nEntries } = await pivotTimeline(bars5m, atrCal, { bandMult: BANDX });
  console.log(`5-minute bars ${bars5m.length}; accepted ZigZag pivots ${nAccepted} (entries incl. replaced ${nEntries}); incremental walk equals the shared walkZigZagAcceptance(): ${same ? 'YES' : 'NO'}; pivots with at least one completed test ${piv.filter((p) => p.tests.length).length}`);
  if (!same) throw new Error('incremental ZigZag walk does not match the shared function');
  { // causal check (Amendment 1, finding 1): the accepted un-replaced pivot set at a random time T from the incremental timeline equals a fresh re-run of the shared walk on the bars completed before T
    const r = mulberry32(hashSeed('truncation')), ends = bars5m.map((b) => emOf(b.tsStr) + 5); let ok = 0, tried = 0;
    while (tried < 25) { const k = 3000 + Math.floor(r() * (bars5m.length - 3500)), Tm = ends[k]; if (rollDates.has(bars5m[k].dateStr)) continue; tried++;
      const sub = bars5m.slice(0, k + 1), { highs, lows } = findSwingPoints(sub, SW), mg = [...highs.map((p) => ({ ...p, type: 'HIGH' })), ...lows.map((p) => ({ ...p, type: 'LOW' }))].sort((a, b) => a.idx - b.idx);
      const acc = await walkZigZagAcceptance(mg, sub, rollDates, 0.25, (idx) => atrCal[sub[idx].dateStr]), mine = piv.filter((p) => p.confirmT <= Tm && p.replT > Tm).map((p) => p.idx + ':' + p.price);
      const a1 = acc.map((p) => p.idx + ':' + p.price).sort().join(','), a2 = mine.sort().join(','); if (a1 === a2) ok++; else console.log(`  MISMATCH at ${bars5m[k].tsStr}: truncated ${acc.length} vs timeline ${mine.length}`); }
    console.log(`causal truncation check: ${ok} of ${tried} random times give an identical active pivot set`); if (ok !== tried) throw new Error('timeline is not causal'); }
  const OD = 'scratch/stuffed_20261020', ORD = new Map(); let nOrders = 0, skipped = 0;
  for (const fn of fs.readdirSync(OD).sort()) { if (!fn.endsWith('.tsv')) continue; const d = fn.slice(0, 10); if (d < FROM || d > TO || !S.rth.get(d)) continue; if (rollDates.has(d) || SPARSE(d)) { skipped++; continue; }
    const arr = []; for (const line of fs.readFileSync(`${OD}/${fn}`, 'utf8').split('\n')) { if (!line) continue; const c = line.split('\t'), n = (x) => (x === '' || x == null ? NaN : +x); arr.push({ side: c[0], t0: +c[1], te: +c[2], size: +c[3], pl: +c[6], p60: n(c[8]), p360: n(c[10]), p960: n(c[12]), p1860: n(c[14]), vw: +c[7] }); }
    ORD.set(d, arr); nOrders += arr.length; }
  console.log(`sessions ${ORD.size} (skipped roll/sparse ${skipped}); big orders ${nOrders}`);
  const byDate = indexByDate(piv, [...ORD.keys()]), all = [];
  for (const [d, arr] of ORD) { const atr = S.atr20(d); if (!atr) continue; const cands = byDate.get(d) || [], base = emOf(d + ' 00:00:00');
    for (const o of arr) { const sgn = o.side === 'S' ? 1 : -1, ref = o.te + 60; if (ref < 36000 || ref >= 55800 || !Number.isFinite(o.p60)) continue;
      const aTicks = (o.p60 - o.pl) * sgn / T, lab = aTicks >= TD ? 'STUFFED' : aTicks <= -TD ? 'FOLLOWED' : 'NEUTRAL', Tt = base + ref / 60, type = o.side === 'S' ? 'LOW' : 'HIGH';
      const hit = pivotAt(cands, type, o.pl, Tt), mir = pivotAt(cands, type === 'LOW' ? 'HIGH' : 'LOW', o.pl, Tt), hv = pivotAt(cands, type, o.vw, Tt); const y = {}; for (const [hn, key] of HZ) y[hn] = Number.isFinite(o[key]) ? sgn * (o[key] - o.p60) / atr : NaN;
      all.push({ d, side: o.side, lab, y, ref, sb: o.size >= 150 ? 2 : o.size >= 100 ? 1 : 0, bucket: Math.floor((ref - 36000) / 1800), at: !!hit, tests: hit ? hit.tests : 0, defended: !!hit && hit.tests >= 1, pk: hit ? type + hit.p.price : null, nearDead: !hit && cands.some((p) => p.type === type && p.confirmT + 30 <= Tt && Tt >= p.endT && Math.abs(o.pl - p.price) <= p.band), mirDef: !!mir && mir.tests >= 1, vwDef: !!hv && hv.tests >= 1, t0: o.t0 }); } }
  const cnt = (g) => all.filter(g).length;
  console.log(`orders in window ${all.length}; STUFFED ${cnt((x) => x.lab === 'STUFFED')}, FOLLOWED ${cnt((x) => x.lab === 'FOLLOWED')}; at an active pivot of the matching orientation ${cnt((x) => x.at)} (defended ${cnt((x) => x.defended)}); STUFFED at a defended pivot: sells at lows ${cnt((x) => x.lab === 'STUFFED' && x.defended && x.side === 'S')}, buys at highs ${cnt((x) => x.lab === 'STUFFED' && x.defended && x.side === 'B')}`);
  if (process.env.COUNT_ONLY) return; // counts only (no outcome has been printed at this point): used to debug the pipeline before the pre-registered run
  const rng = mulberry32(hashSeed('stuffedpivot'));
  const cellOf = (x) => `${x.side}|${x.bucket}|${x.sb}`;
  function matched(items) { const t = new Map(); for (const x of items) { const c = t.get(x.cell) || t.set(x.cell, [0, 0, 0, 0]).get(x.cell); if (x.lab) { c[0]++; c[1] += x.y; } else { c[2]++; c[3] += x.y; } } let w = 0, s = 0; for (const c of t.values()) if (c[0] && c[2] >= 5) { w += c[0]; s += c[0] * (c[1] / c[0] - c[3] / c[2]); } return w ? s / w : NaN; }
  function boot(items, lo) { const g = new Map(); for (const x of items) (g.get(x.d) || g.set(x.d, []).get(x.d)).push(x); const ds = [...g.values()], o = []; for (let b = 0; b < 1500; b++) { const pick = []; for (let k = 0; k < ds.length; k++) pick.push(...ds[Math.floor(rng() * ds.length)]); const v = matched(pick); if (Number.isFinite(v)) o.push(v); } o.sort((a, b) => a - b); return [o[Math.floor(o.length * lo)], o[Math.floor(o.length * (1 - lo)) - 1]]; }
  const mk = (cell, hn, treated, control, collapse = true) => { const out = [], grp = new Map(); for (const x of all) { if (x.side !== cell.side) continue; const y = x.y[hn]; if (!Number.isFinite(y)) continue; const tr = treated(x); if (!tr && !control(x)) continue; if (tr && collapse && x.pk) { const k = `${x.d}|${x.side}|${x.pk}|${Math.floor(x.ref / 900)}`; const g = grp.get(k); if (g) { g.ys.push(y); continue; } const o = { d: x.d, ys: [y], lab: 1, cell: cellOf(x), ref: x.ref, sb: x.sb }; grp.set(k, o); out.push(o); continue; } out.push({ d: x.d, y, lab: tr ? 1 : 0, cell: cellOf(x), ref: x.ref, sb: x.sb }); } for (const o of grp.values()) { o.y = o.ys.reduce((a, b) => a + b, 0) / o.ys.length; } return out; };
  const CELLS = [{ name: 'SELL-STUFFED-AT-DEFENDED-LOW (then up)', side: 'S' }, { name: 'BUY-STUFFED-AT-DEFENDED-HIGH (then down)', side: 'B' }];
  const isT = (x) => x.lab === 'STUFFED' && x.defended, isA = (x) => x.lab === 'FOLLOWED' && x.defended, isB = (x) => x.lab === 'STUFFED' && !x.at;
  const cutoff = (items, lo, hi) => items.filter((x) => x.d >= lo && x.d < hi);
  let cands = 0, surv = 0; const R = {};
  for (const cell of CELLS) {
    console.log(`\n=== ${cell.name} (outcome: ATR20-normalised price change opposite to the order from t_ref, positive = reversal continues) ===`);
    for (const [hn] of HZ) {
      const C = mk(cell, hn, isT, (x) => !isT(x)), A = mk(cell, hn, isT, isA), B = mk(cell, hn, isT, isB), nT = C.filter((x) => x.lab).length, dts = new Set(C.filter((x) => x.lab).map((x) => x.d)).size;
      if (nT < 10) { console.log(`  ${hn}: too few (${nT})`); continue; }
      const diff = matched(C), ex = cutoff(C, '0', SPLIT), ho = cutoff(C, SPLIT, '9'), exD = matched(ex), hoD = matched(ho), ci = boot(ex, 0.00625), ciAll = boot(C, 0.00625);
      const tdays = new Map(); for (const x of C.filter((x) => x.lab)) tdays.set(x.d, (tdays.get(x.d) || 0) + x.y); const topDay = [...tdays.entries()].sort((a, b) => b[1] - a[1])[0]?.[0], noTop = matched(C.filter((x) => !(x.lab && x.d === topDay)));
      R[`${cell.side}|${hn}`] = { diff, exD, hoD, ci, nT, dts, A: matched(A), B: matched(B), noTop, exN: ex.filter((x) => x.lab).length, hoN: ho.filter((x) => x.lab).length, exDates: new Set(ex.filter((x) => x.lab).map((x) => x.d)).size, hoDates: new Set(ho.filter((x) => x.lab).map((x) => x.d)).size, exA: matched(cutoff(A, '0', SPLIT)), hoA: matched(cutoff(A, SPLIT, '9')), exB: matched(cutoff(B, '0', SPLIT)), hoB: matched(cutoff(B, SPLIT, '9')) };
      const am = matched(C.filter((x) => x.ref < 39600)), pm = matched(C.filter((x) => x.ref >= 39600));
      console.log(`  ${hn}: n ${nT} on ${dts} dates | treated mean ${f(mean(C.filter((x) => x.lab).map((x) => x.y)))} vs all-other ${f(mean(C.filter((x) => !x.lab).map((x) => x.y)))} | matched excess vs C ${f(diff)} CI98.75 all dates [${f(ciAll[0])},${f(ciAll[1])}] | explore ${f(exD)} [${f(ci[0])},${f(ci[1])}] n${R[`${cell.side}|${hn}`].exN}/${R[`${cell.side}|${hn}`].exDates}d | hold-out ${f(hoD)} n${R[`${cell.side}|${hn}`].hoN}/${R[`${cell.side}|${hn}`].hoDates}d | vs A (followed at a defended pivot) ${f(matched(A))} | vs B (stuffed, not at a pivot) ${f(matched(B))} | without top date ${f(noTop)} | before 11:00 ${f(am)} later ${f(pm)} | half-width ${f((ciAll[1] - ciAll[0]) / 2)}`);
    }
    const g = (hn) => R[`${cell.side}|${hn}`], ok = (hn) => g(hn) && g(hn).ci[0] > 0, under = (hn) => !g(hn) || g(hn).exN < 30 || g(hn).exDates < 20 || g(hn).hoN < 30 || g(hn).hoDates < 20;
    const cand = ok('15m'); if (cand) cands++; // single primary horizon (Amendment 1, finding 6)
    const r = g('15m'), survives = cand && r && r.hoD > 0 && r.hoN >= 0.5 * r.exN && r.noTop > 0 && r.exA > 0 && r.hoA > 0 && r.exB > 0 && r.hoB > 0;
    if (survives) surv++;
    console.log(`  verdict: ${under('15m') ? 'UNDERPOWERED in a half (fewer than 30 events or 20 dates); ' : ''}${cand ? (survives ? 'SCREEN-SURVIVOR' : 'candidate, not a survivor') : 'no'}`);
  }
  console.log(`\nCOUNTED CELLS 2, CANDIDATES ${cands}, SCREEN-SURVIVORS ${surv}, expected by chance about ${(2 * 0.0125).toFixed(2)} (2 cells x 0.0125, a floor)`);
  // descriptive: at a pivot but not yet defended; clustering of events
  console.log('\nDESCRIPTIVE (not citable): at-level but not yet defended, mean outcome 15m, treated vs other');
  for (const cell of CELLS) { const C = mk(cell, '15m', (x) => x.lab === 'STUFFED' && x.at && !x.defended, (x) => !(x.lab === 'STUFFED' && x.at)); console.log(`  ${cell.name}: n ${C.filter((x) => x.lab).length} matched excess ${f(matched(C))}`); }
  console.log(`orders whose last print is inside the band of a pivot that was already replaced or broken at t_ref (excluded by the active rule): ${cnt((x) => x.nearDead)} of ${all.length}`);
  console.log('\nDESCRIPTIVE (not citable) at 15 minutes: mirror placebo, VWAP anchor, un-collapsed, control sizes');
  for (const cell of CELLS) { const mirT = (x) => x.lab === 'STUFFED' && x.mirDef, vwT = (x) => x.lab === 'STUFFED' && x.vwDef;
    const M2 = mk(cell, '15m', mirT, (x) => !mirT(x)), V2 = mk(cell, '15m', vwT, (x) => !vwT(x)), U2 = mk(cell, '15m', isT, (x) => !isT(x), false), A2 = mk(cell, '15m', isT, isA), B2 = mk(cell, '15m', isT, isB);
    console.log(`  ${cell.name}: mirror placebo (stuffed at the OPPOSITE pivot type) n ${M2.filter((x) => x.lab).length} excess ${f(matched(M2))} | VWAP anchor n ${V2.filter((x) => x.lab).length} excess ${f(matched(V2))} | un-collapsed treated n ${U2.filter((x) => x.lab).length} excess ${f(matched(U2))} (collapsed ${mk(cell, '15m', isT, (x) => !isT(x)).filter((x) => x.lab).length}) | control A n ${A2.filter((x) => !x.lab).length}, control B n ${B2.filter((x) => !x.lab).length}`); }
  const T0 = all.filter(isT).map((x) => x.d + '|' + Math.floor(x.ref / 300)), uniq = new Set(T0); console.log(`  treated events falling in the same 5-minute window as another treated event: ${(100 * (T0.length - uniq.size) / Math.max(1, T0.length)).toFixed(0)} percent`);
  fs.writeFileSync('scratch/stuffed_at_defended_pivot_20261026.json', JSON.stringify({ cands, surv, R }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
