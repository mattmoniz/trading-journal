// Part A analysis: docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md (+ its dated amendment). Reads scratch/overnight_rth_dataset_20261026.json built by
// scripts/build_overnight_rth_dataset_20261026.mjs. Explore = earliest 60% of valid days, hold-out = the rest. Circular-shift label placebo, BH over explore p-values.
//   node scripts/study_overnight_rth_20261026.mjs [--no-record]
import fs from 'fs';
import { dayBlockedBootstrapCI, dayBlockedBootstrapDeltaCI, hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const ds = JSON.parse(fs.readFileSync(new URL('../scratch/overnight_rth_dataset_20261026.json', import.meta.url)));
const R = ds.rows;
const SHIFTS = 1000, BH_Q = 0.10, MIN_EXPLORE_DAYS = 20, MIN_HOLDOUT_DAYS = 15, TOP5_MAX = 60, VOL_N = 60;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const money = (v) => (v == null ? 'n/a' : `${v < 0 ? '' : '+'}${v.toFixed(3)}`);

// ---- rolling, strictly-prior percentile flags (volume per bar, ON range / ATR) ----
function priorTopFlag(rows, valFn, N) {
  return rows.map((r, i) => {
    const prior = rows.slice(Math.max(0, i - N), i).map(valFn).filter((v) => v != null);
    if (prior.length < Math.min(N, 20)) return null;
    const s = [...prior].sort((a, b) => a - b), cut = s[Math.floor(0.67 * (s.length - 1))];
    const v = valFn(r); return v == null ? null : v >= cut;
  });
}
const onVolPerBar = (r) => r.onVol / r.onBars, fhVolPerBar = (r) => (r.fhBars ? r.fhVol / r.fhBars : null), onRangeAtr = (r) => (r.onH - r.onL) / r.atr;
const hiOnVol = priorTopFlag(R, onVolPerBar, VOL_N), hiFhVol = priorTopFlag(R, fhVolPerBar, VOL_N), hiOnRange = priorTopFlag(R, onRangeAtr, VOL_N);
R.forEach((r, i) => { r.hiOnVol = hiOnVol[i]; r.hiFhVol = hiFhVol[i]; r.hiOnRange = hiOnRange[i]; });

// ---- cells: state(row) -> +1 / -1 (signed state) | 0 (not in state); outcome(row) -> number|null (already in ATR units, unsigned) ----
const ret = { 15: (r) => r.r15, 30: (r) => r.r30, 60: (r) => r.r60, close: (r) => r.rClose };
const shRet = { 60: (r) => (r.sh60 == null || r.shBase == null ? null : (r.sh60 - r.shBase) / r.atr), 180: (r) => (r.sh180 == null || r.shBase == null ? null : (r.sh180 - r.shBase) / r.atr), end: (r) => (r.shEnd == null || r.shBase == null ? null : (r.shEnd - r.shBase) / r.atr) };
const cells = [];
const addSigned = (id, fam, label, stateFn, outFn) => cells.push({ id, fam, label, kind: 'signed', stateFn, outFn });
const addLevel = (id, fam, label, stateFn, outFn) => cells.push({ id, fam, label, kind: 'level', stateFn, outFn });
const inv = (r) => (r.onL >= r.VAH ? 1 : r.onH <= r.VAL ? -1 : 0);
for (const k of [15, 30, 60]) {
  addSigned(`A1_ABOVE_${k}`, 'A1', `ON range above prior VA -> bias-signed (long) RTH return ${k}m`, (r) => (inv(r) === 1 ? 1 : 0), ret[k]);
  addSigned(`A1_BELOW_${k}`, 'A1', `ON range below prior VA -> bias-signed (short) RTH return ${k}m`, (r) => (inv(r) === -1 ? -1 : 0), ret[k]);
  addSigned(`A1_POOLED_${k}`, 'A1', `one-sided inventory (above or below), bias-signed RTH return ${k}m`, (r) => inv(r), ret[k]);
}
const pos = (r) => (r.O - r.onL) / ((r.onH - r.onL) || 1);
for (const k of [15, 30, 60]) {
  addSigned(`A2_UPPER_${k}`, 'A2', `open in upper third of ON range -> long-signed RTH return ${k}m`, (r) => (pos(r) >= 2 / 3 ? 1 : 0), ret[k]);
  addSigned(`A2_LOWER_${k}`, 'A2', `open in lower third of ON range -> short-signed RTH return ${k}m`, (r) => (pos(r) <= 1 / 3 ? -1 : 0), ret[k]);
}
addLevel('A2_ONRANGE_HIGH_RTHRANGE', 'A2', 'ON range/ATR in prior top third -> RTH range/ATR', (r) => (r.hiOnRange == null ? null : r.hiOnRange ? 1 : 0), (r) => r.rthRangeAtr);
for (const k of [15, 30, 60, 'close']) {
  addSigned(`A3_ABOVE_${k}`, 'A3', `open above ON POC -> long-signed RTH return ${k}`, (r) => (r.O > r.onPoc ? 1 : 0), ret[k]);
  addSigned(`A3_BELOW_${k}`, 'A3', `open below ON POC -> short-signed RTH return ${k}`, (r) => (r.O < r.onPoc ? -1 : 0), ret[k]);
}
const onDir = (r) => Math.sign(r.onClose - r.onOpen);
for (const k of [60, 'close']) addSigned(`A4_HIVOL_${k}`, 'A4', `high ON volume/bar -> ON-direction-signed RTH return ${k}`, (r) => (r.hiOnVol ? onDir(r) : r.hiOnVol == null ? null : 0), ret[k]);
addLevel('A4_HIVOL_RTHRANGE', 'A4', 'high ON volume/bar -> RTH range/ATR', (r) => (r.hiOnVol == null ? null : r.hiOnVol ? 1 : 0), (r) => r.rthRangeAtr);
const gInv = (r) => (r.fhL == null ? 0 : r.fhL >= r.VAH ? 1 : r.fhH <= r.VAL ? -1 : 0);
for (const k of [60, 180, 'end']) {
  addSigned(`G1_ABOVE_${k}`, 'G1', `first-half ON range above prior VA -> long-signed second-half drift ${k}`, (r) => (gInv(r) === 1 ? 1 : 0), shRet[k]);
  addSigned(`G1_BELOW_${k}`, 'G1', `first-half ON range below prior VA -> short-signed second-half drift ${k}`, (r) => (gInv(r) === -1 ? -1 : 0), shRet[k]);
  addSigned(`G1_POOLED_${k}`, 'G1', `one-sided first-half inventory, bias-signed second-half drift ${k}`, (r) => gInv(r), shRet[k]);
}
for (const k of [180, 'end']) addSigned(`G4_HIVOL_${k}`, 'G4', `high first-half volume/bar -> first-half-direction-signed second-half drift ${k}`, (r) => (r.hiFhVol ? r.fhDirSign : r.hiFhVol == null ? null : 0), shRet[k]);

// first-half direction (open of 18:00 bar to the 00:00 base) -- computed here from stored fields
R.forEach((r) => { r.fhDirSign = r.shBase != null && r.onOpen != null ? Math.sign(r.shBase - r.onOpen) : 0; });

// ---- statistics ----
function cellStat(rows, cell, seedKey) {
  const usable = rows.map((r) => ({ r, s: cell.stateFn(r), y: cell.outFn(r) })).filter((x) => x.s !== null && x.y != null && Number.isFinite(x.y));
  const mu = mean(usable.map((x) => x.y));
  const inState = usable.filter((x) => x.s !== 0);
  const n = inState.length, days = n;
  if (n < 2) return { n, usable: usable.length, stat: null };
  let stat, ci;
  if (cell.kind === 'signed') {
    const vals = inState.map((x) => ({ date: x.r.date, pnl: x.s * (x.y - mu) }));
    stat = mean(vals.map((v) => v.pnl)); ci = vals.length >= 4 ? dayBlockedBootstrapCI(vals, seedKey, { iters: 2000 }) : { lo: null, hi: null };
    const sorted = [...vals].map((v) => Math.abs(v.pnl)).sort((a, b) => b - a), tot = sorted.reduce((s, v) => s + v, 0);
    const top5 = tot ? 100 * sorted.slice(0, 5).reduce((s, v) => s + v, 0) / tot : null;
    // circular-shift placebo on the (signed) state sequence
    const stateSeq = usable.map((x) => x.s), ys = usable.map((x) => x.y - mu), L = usable.length, rand = mulberry32(hashSeed(seedKey + '|shift'));
    const nulls = [];
    for (let k = 0; k < SHIFTS; k++) { const off = 1 + Math.floor(rand() * (L - 1)); let sum = 0, c = 0; for (let i = 0; i < L; i++) { const s = stateSeq[(i + off) % L]; if (s !== 0) { sum += s * ys[i]; c++; } } nulls.push(c ? sum / c : 0); }
    const pTwo = nulls.filter((v) => Math.abs(v) >= Math.abs(stat)).length / SHIFTS, pOne = nulls.filter((v) => (stat >= 0 ? v >= stat : v <= stat)).length / SHIFTS;
    return { n, usable: usable.length, stat, ci, pTwo, pOne, top5, halfWidth: (ci.hi - ci.lo) / 2 };
  }
  const grp = usable.map((x) => ({ date: x.r.date, pnl: x.y, group: x.s !== 0 ? 'S' : 'R' }));
  const sIn = grp.filter((g) => g.group === 'S').map((g) => g.pnl), sOut = grp.filter((g) => g.group === 'R').map((g) => g.pnl);
  stat = mean(sIn) - mean(sOut);
  ci = sIn.length >= 4 && sOut.length >= 4 ? dayBlockedBootstrapDeltaCI(grp, seedKey, { groupField: 'group', groupA: 'R', groupB: 'S', iters: 2000 }) : { lo: null, hi: null };
  const stateSeq = usable.map((x) => (x.s !== 0 ? 1 : 0)), ys = usable.map((x) => x.y), L = usable.length, rand = mulberry32(hashSeed(seedKey + '|shift'));
  const nulls = [];
  for (let k = 0; k < SHIFTS; k++) { const off = 1 + Math.floor(rand() * (L - 1)); let a = 0, ca = 0, b = 0, cb = 0; for (let i = 0; i < L; i++) { if (stateSeq[(i + off) % L]) { a += ys[i]; ca++; } else { b += ys[i]; cb++; } } nulls.push(ca && cb ? a / ca - b / cb : 0); }
  const pTwo = nulls.filter((v) => Math.abs(v) >= Math.abs(stat)).length / SHIFTS, pOne = nulls.filter((v) => (stat >= 0 ? v >= stat : v <= stat)).length / SHIFTS;
  const abs = sIn.map(Math.abs).sort((a, b) => b - a), tot = abs.reduce((s, v) => s + v, 0);
  return { n, usable: usable.length, stat, ci, pTwo, pOne, top5: tot ? 100 * abs.slice(0, 5).reduce((s, v) => s + v, 0) / tot : null, halfWidth: (ci.hi - ci.lo) / 2 };
}

function main() {
  const noRecord = process.argv.includes('--no-record');
  const cut = Math.floor(R.length * 0.6), explore = R.slice(0, cut), hold = R.slice(cut);
  console.log(`window ${R[0].date}..${R[R.length - 1].date}: ${R.length} days, explore ${explore.length} (..${explore[explore.length - 1].date}), hold-out ${hold.length}; ${cells.length} cells counted`);
  const res = cells.map((c) => ({ c, ex: cellStat(explore, c, `A|${c.id}|ex`) }));
  // BH over evaluable cells' explore two-sided p
  const evalable = res.filter((x) => x.ex.stat != null && x.ex.n >= MIN_EXPLORE_DAYS);
  const sorted = [...evalable].sort((a, b) => a.ex.pTwo - b.ex.pTwo), m = evalable.length;
  let kMax = -1; sorted.forEach((x, i) => { if (x.ex.pTwo <= ((i + 1) / m) * BH_Q) kMax = i; });
  sorted.forEach((x, i) => { x.bh = i <= kMax; });
  console.log(`evaluable ${m}/${cells.length} (explore state days >= ${MIN_EXPLORE_DAYS}); BH survivors at q=${BH_Q}: ${kMax + 1}; expected false positives at 5% before correction ~${(0.05 * m).toFixed(1)}`);
  for (const x of res) {
    const e = x.ex;
    if (e.stat == null || e.n < MIN_EXPLORE_DAYS) { x.verdict = `NOT EVALUATED (explore state days ${e.n} < ${MIN_EXPLORE_DAYS})`; continue; }
    if (!x.bh) { x.verdict = 'NOT SHOWN'; continue; }
    const h = cellStat(hold, x.c, `A|${x.c.id}|ho`); x.ho = h;
    if (h.stat == null || h.n < MIN_HOLDOUT_DAYS) { x.verdict = `BH SURVIVOR, UNDERPOWERED HOLD-OUT (${h.n} days < ${MIN_HOLDOUT_DAYS})`; continue; }
    const sameSign = Math.sign(h.stat) === Math.sign(e.stat);
    x.verdict = sameSign && h.pOne < 0.05 && e.top5 < TOP5_MAX ? 'SHOWN' : 'NOT SHOWN (explore survivor failed hold-out or concentration)';
  }
  for (const x of res) {
    const e = x.ex, h = x.ho;
    console.log(`${x.c.id.padEnd(22)} explore n=${String(e.n).padStart(3)} d=${money(e.stat)} [${money(e.ci?.lo)},${money(e.ci?.hi)}] p=${e.pTwo?.toFixed(3) ?? 'n/a'} top5=${e.top5?.toFixed(0) ?? 'n/a'}%${x.bh ? ' BH' : ''}` +
      (h ? ` | hold n=${h.n} d=${money(h.stat)} p1=${h.pOne?.toFixed(3)}` : '') + ` | ${x.verdict}`);
  }
  const shown = res.filter((x) => x.verdict === 'SHOWN');
  // year split for any SHOWN cell
  for (const x of shown) {
    const byYear = {}; for (const r of R) { const y = r.date.slice(0, 4); (byYear[y] ||= []).push(r); }
    console.log(`YEAR SPLIT ${x.c.id}:`, Object.entries(byYear).map(([y, rows]) => { const s = cellStat(rows, x.c, `A|${x.c.id}|${y}`); return `${y} n=${s.n} d=${money(s.stat)}`; }).join(' | '));
  }
  const resolvable = Math.min(...evalable.map((x) => x.ex.halfWidth));
  console.log(`\nSHOWN ${shown.length} of ${cells.length}. Smallest explore CI half-width among evaluable cells: ${resolvable.toFixed(3)} ATR (effects smaller than roughly this could not be shown); median half-width ${money([...evalable.map((x) => x.ex.halfWidth)].sort((a, b) => a - b)[m >> 1])}`);
  if (!noRecord) {
    const lines = res.map((x) => `${x.c.id}: ${x.verdict}${x.ex.stat != null ? ` (explore n=${x.ex.n}, d=${money(x.ex.stat)}, p=${x.ex.pTwo?.toFixed(3)})` : ''}`).join('; ');
    recordClaim({ slug: 'overnight_rth_context_partA_20261026', sourceFile: 'scripts/study_overnight_rth_20261026.mjs', sourceDate: '2026-10-26', sampleSize: R.length, rigorStatus: 'preregistered_explore_holdout_bh_circular_shift', status: 'PROVISIONAL',
      claimText: `Part A overnight-to-RTH (prereg docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md + amendment). ${R.length} valid days ${R[0].date}..${R[R.length - 1].date} (explore ${explore.length}, hold-out ${hold.length}); ${cells.length} cells; BH survivors ${kMax + 1}; SHOWN ${shown.length}. Smallest resolvable effect about ${resolvable.toFixed(3)} ATR. Per cell: ${lines}. A5 (8:30 release) untestable: macro_events has no history.` }).then(() => console.log('claim recorded')).then(() => process.exit(0));
  } else process.exit(0);
}
main();
