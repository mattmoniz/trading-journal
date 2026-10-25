// Part A analysis: docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md + Amendment 1. Reads scratch/overnight_rth_dataset_20261026.json
// (scripts/build_overnight_rth_dataset_20261026.mjs). Explore = earliest 60% of valid days, hold-out = the rest.
// Statistic = conditional minus unconditional excess: mean over state days of s*(y - mu), mu = mean y over ALL valid days of the block.
//   node scripts/study_overnight_rth_20261026.mjs [--no-record]
import fs from 'fs';
import { query } from '../server/db.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const ds = JSON.parse(fs.readFileSync(new URL('../scratch/overnight_rth_dataset_20261026.json', import.meta.url)));
const R = ds.rows;
const BH_Q = 0.10, MIN_EXPLORE = 30, MIN_HOLD = 20, N_OTH = 60, N_MON = 15, K_MATCH = 5;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const med = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f = (v) => (v == null ? 'n/a' : `${v < 0 ? '' : '+'}${v.toFixed(3)}`);

// rolling features, strictly prior, within session type (Monday sessions start Sunday evening)
const typeOf = (r) => (r.dow === 1 ? 'MON' : 'OTH');
function priorStat(valFn, statFn) {
  return R.map((r, i) => {
    const N = typeOf(r) === 'MON' ? N_MON : N_OTH;
    const prior = []; for (let j = i - 1; j >= 0 && prior.length < N; j--) if (typeOf(R[j]) === typeOf(r)) { const v = valFn(R[j]); if (v != null) prior.push(v); }
    return prior.length >= Math.min(N, 12) ? statFn(prior) : null;
  });
}
const q = (p) => (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
const onVolBar = (r) => r.onVol / r.onBars, fhVolBar = (r) => (r.fhBars ? r.fhVol / r.fhBars : null), onRngAtr = (r) => (r.onH - r.onL) / r.atr, onMoveAtr = (r) => Math.abs(r.onClose - r.onOpen) / r.atr;
const cutOnVol = priorStat(onVolBar, q(0.67)), cutFhVol = priorStat(fhVolBar, q(0.67)), cutOnRng = priorStat(onRngAtr, q(0.67)), cutOnRng90 = priorStat(onRngAtr, q(0.9)), cutMove = priorStat(onMoveAtr, med);
R.forEach((r, i) => {
  r.hiOnVol = cutOnVol[i] == null ? null : onVolBar(r) >= cutOnVol[i]; r.hiFhVol = cutFhVol[i] == null || fhVolBar(r) == null ? null : fhVolBar(r) >= cutFhVol[i];
  r.hiOnRng = cutOnRng[i] == null ? null : onRngAtr(r) >= cutOnRng[i]; r.topDecOnRng = cutOnRng90[i] == null ? null : onRngAtr(r) >= cutOnRng90[i];
  r.bigOnMove = cutMove[i] == null ? null : onMoveAtr(r) >= cutMove[i]; r.fhDirSign = r.shBase != null && r.onOpen != null ? Math.sign(r.shBase - r.onOpen) : 0; r.gapAbs = Math.abs(r.gapAtr);
});

const ret = { 15: (r) => r.r15, 30: (r) => r.r30, 60: (r) => r.r60, close: (r) => r.rClose };
const sh = (k) => (r) => { const v = { 60: r.sh60, 180: r.sh180 }[k]; return v == null || r.shBase == null ? null : (v - r.shBase) / r.atr; };
const cells = [];
const add = (id, fam, label, stateFn, outFn) => cells.push({ id, fam, label, stateFn, outFn });
const inv = (r) => (r.onL >= r.VAH ? 1 : r.onH <= r.VAL ? -1 : 0);
for (const k of [15, 30, 60, 'close']) {
  add(`A1_ABOVE_${k}`, 'A1', `ON range above prior VA -> long-signed RTH return ${k}`, (r) => (inv(r) === 1 ? 1 : 0), ret[k]);
  add(`A1_BELOW_${k}`, 'A1', `ON range below prior VA -> short-signed RTH return ${k}`, (r) => (inv(r) === -1 ? -1 : 0), ret[k]);
  add(`A1_POOLED_${k}`, 'A1', `one-sided inventory, bias-signed RTH return ${k}`, (r) => inv(r), ret[k]);
}
const pos = (r) => (r.O - r.onL) / ((r.onH - r.onL) || 1);
for (const k of [15, 30, 60, 'close']) {
  add(`A2_UPPER_${k}`, 'A2', `open in upper third of ON range -> long-signed RTH return ${k}`, (r) => (pos(r) >= 2 / 3 ? 1 : 0), ret[k]);
  add(`A2_LOWER_${k}`, 'A2', `open in lower third of ON range -> short-signed RTH return ${k}`, (r) => (pos(r) <= 1 / 3 ? -1 : 0), ret[k]);
}
add('A2_RANGE_EXPANSION', 'A2', 'ON range/ATR in prior top third -> RTH range/ATR (range expansion)', (r) => (r.hiOnRng == null ? null : r.hiOnRng ? 1 : 0), (r) => r.rthRangeAtr);
for (const k of [15, 30, 60, 'close']) {
  add(`A3_ABOVE_${k}`, 'A3', `open above ON POC -> long-signed RTH return ${k}`, (r) => (r.O > r.onPoc ? 1 : 0), ret[k]);
  add(`A3_BELOW_${k}`, 'A3', `open below ON POC -> short-signed RTH return ${k}`, (r) => (r.O < r.onPoc ? -1 : 0), ret[k]);
}
const onDir = (r) => Math.sign(r.onClose - r.onOpen);
for (const k of [60, 'close']) add(`A4_HIVOL_${k}`, 'A4', `high ON volume/bar & sizable ON move -> ON-direction-signed RTH return ${k}`, (r) => (r.hiOnVol == null || r.bigOnMove == null ? null : r.hiOnVol && r.bigOnMove ? onDir(r) : 0), ret[k]);
add('A4_HIVOL_RANGE', 'A4', 'high ON volume/bar -> RTH range/ATR', (r) => (r.hiOnVol == null ? null : r.hiOnVol ? 1 : 0), (r) => r.rthRangeAtr);
const gInv = (r) => (r.fhL == null ? 0 : r.fhL >= r.VAH ? 1 : r.fhH <= r.VAL ? -1 : 0);
for (const k of [60, 180]) {
  add(`G1_ABOVE_${k}`, 'G1', `first-half ON above prior VA -> long-signed second-half drift ${k}`, (r) => (gInv(r) === 1 ? 1 : 0), sh(k));
  add(`G1_BELOW_${k}`, 'G1', `first-half ON below prior VA -> short-signed second-half drift ${k}`, (r) => (gInv(r) === -1 ? -1 : 0), sh(k));
  add(`G1_POOLED_${k}`, 'G1', `one-sided first-half inventory, bias-signed second-half drift ${k}`, (r) => gInv(r), sh(k));
}
add('G4_HIVOL_180', 'G4', 'high first-half volume/bar -> first-half-direction-signed second-half drift 180', (r) => (r.hiFhVol == null ? null : r.hiFhVol ? r.fhDirSign : 0), sh(180));

// ---- statistics ----
function prep(rows, cell) {
  const u = rows.map((r) => ({ r, s: cell.stateFn(r), y: cell.outFn(r) })).filter((x) => x.s !== null && x.y != null && Number.isFinite(x.y));
  const mu = mean(u.map((x) => x.y));
  return { u, mu };
}
function permNull(u, mu, stat) {
  // exhaustive circular shifts of the signed state sequence within the block
  const L = u.length, S = u.map((x) => x.s), Y = u.map((x) => x.y - mu); let two = 0, one = 0, tot = 0;
  for (let off = 1; off < L; off++) { let sum = 0, c = 0; for (let i = 0; i < L; i++) { const s = S[(i + off) % L]; if (s !== 0) { sum += s * Y[i]; c++; } } const v = c ? sum / c : 0; tot++; if (Math.abs(v) >= Math.abs(stat)) two++; if (stat >= 0 ? v >= stat : v <= stat) one++; }
  return { pTwo: two / tot, pOne: one / tot };
}
function cellStat(rows, cell, withMatch = false) {
  const { u, mu } = prep(rows, cell);
  const st = u.filter((x) => x.s !== 0), n = st.length;
  if (n < 2) return { n, stat: null };
  const vals = st.map((x) => ({ date: x.r.date, pnl: x.s * (x.y - mu), r: x.r, s: x.s, y: x.y }));
  const stat = mean(vals.map((v) => v.pnl)), ci = n >= 4 ? dayBlockedBootstrapCI(vals, `A|${cell.id}|${rows[0].date}`, { iters: 2000 }) : { lo: null, hi: null };
  const { pTwo, pOne } = permNull(u, mu, stat);
  const drop = [...vals].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(5), statDrop = drop.length ? mean(drop.map((v) => v.pnl)) : null;
  const influenceOk = statDrop != null && Math.sign(statDrop) === Math.sign(stat) && Math.abs(statDrop) >= 0.5 * Math.abs(stat);
  const out = { n, nAll: u.length, stat, ci, pTwo, pOne, influenceOk, statDrop, rawState: mean(st.map((x) => x.y)), mu, halfWidth: (ci.hi - ci.lo) / 2 };
  if (withMatch) {
    const ctl = u.filter((x) => x.s === 0), sd = (fn) => { const a = u.map((x) => fn(x.r)), m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))) || 1; };
    const sg = sd((r) => r.gapAbs), sp = sd((r) => r.pdRangeAtr);
    const mv = st.map((x) => { const d = ctl.map((c) => ({ c, d: Math.hypot((c.r.gapAbs - x.r.gapAbs) / sg, (c.r.pdRangeAtr - x.r.pdRangeAtr) / sp) })).sort((a, b) => a.d - b.d).slice(0, K_MATCH); return { date: x.r.date, pnl: x.s * (x.y - mean(d.map((e) => e.c.y))) }; });
    out.matched = { stat: mean(mv.map((v) => v.pnl)), ci: dayBlockedBootstrapCI(mv, `A|${cell.id}|match`, { iters: 2000 }) };
  }
  return out;
}

async function dayTypes() { return Object.fromEntries((await query(`SELECT trade_date::text d, day_type FROM acd_daily_log WHERE day_type IS NOT NULL`)).rows.map((x) => [x.d, x.day_type])); }

async function main() {
  const noRecord = process.argv.includes('--no-record');
  const cut = Math.floor(R.length * 0.6), explore = R.slice(0, cut), hold = R.slice(cut);
  console.log(`window ${R[0].date}..${R[R.length - 1].date}: ${R.length} days, explore ${explore.length} (..${explore[explore.length - 1].date}), hold-out ${hold.length} (${hold[0].date}..); ${cells.length} cells`);
  const res = cells.map((c) => ({ c, ex: cellStat(explore, c) }));
  const evalable = res.filter((x) => x.ex.stat != null && x.ex.n >= MIN_EXPLORE), m = evalable.length;
  const sorted = [...evalable].sort((a, b) => a.ex.pTwo - b.ex.pTwo); let kMax = -1;
  sorted.forEach((x, i) => { if (x.ex.pTwo <= ((i + 1) / m) * BH_Q) kMax = i; }); sorted.forEach((x, i) => { x.bh = i <= kMax; });
  console.log(`evaluable ${m}/${cells.length} (explore state days >= ${MIN_EXPLORE}); BH survivors at q=${BH_Q}: ${kMax + 1}`);
  for (const x of res) {
    const e = x.ex;
    if (e.stat == null || e.n < MIN_EXPLORE) { x.verdict = `NOT EVALUATED (explore state days ${e.n} < ${MIN_EXPLORE})`; continue; }
    if (!x.bh) { x.verdict = 'NOT SHOWN'; continue; }
    x.ex = cellStat(explore, x.c, true);
    const h = cellStat(hold, x.c, true); x.ho = h;
    if (h.stat == null || h.n < MIN_HOLD) { x.verdict = `BH SURVIVOR, UNDERPOWERED HOLD-OUT (${h.n} days < ${MIN_HOLD})`; continue; }
    const ok = Math.sign(h.stat) === Math.sign(x.ex.stat) && h.pOne < 0.05 && x.ex.influenceOk;
    if (!ok) { x.verdict = 'NOT SHOWN (explore survivor failed hold-out / influence check)'; continue; }
    const gm = h.matched && Math.sign(h.matched.stat) === Math.sign(h.stat) && (h.matched.stat > 0 ? h.matched.ci.lo > 0 : h.matched.ci.hi < 0);
    x.verdict = gm ? 'SHOWN (gap-controlled)' : 'SHOWN (gap-confounded)';
  }
  for (const x of res) {
    const e = x.ex, h = x.ho;
    console.log(`${x.c.id.padEnd(20)} ex n=${String(e.n).padStart(3)} excess ${f(e.stat)} [${f(e.ci?.lo)},${f(e.ci?.hi)}] raw ${f(e.rawState)} vs all ${f(e.mu)} p=${e.pTwo?.toFixed(3) ?? 'n/a'}${x.bh ? ' BH' : ''}` +
      (h ? ` | ho n=${h.n} ${f(h.stat)} p1=${h.pOne?.toFixed(3)} match ${f(h.matched?.stat)}` : '') + ` | ${x.verdict}`);
  }
  const shown = res.filter((x) => x.verdict.startsWith('SHOWN'));
  const dt = shown.length ? await dayTypes() : {};
  for (const x of shown) {
    const part = (label, rows) => { const s = cellStat(rows, x.c); return `${label} n=${s.n} ${f(s.stat)}`; };
    const byYear = {}; for (const r of R) (byYear[r.date.slice(0, 4)] ||= []).push(r);
    console.log(`SPLITS ${x.c.id}: ${Object.entries(byYear).map(([y, rows]) => part(y, rows)).join(' | ')} | ${part('ex-2023H1H2(03-09)', R.filter((r) => r.date >= '2023-10-01'))} | ${part('top-decile ON range (8:30 proxy)', R.filter((r) => r.topDecOnRng))} | ${part('rest', R.filter((r) => r.topDecOnRng === false))} | ${['TREND', 'BALANCE', 'TURBULENT'].map((t) => part(t, R.filter((r) => dt[r.date] === t))).join(' | ')}`);
  }
  const hw = evalable.map((x) => x.ex.halfWidth).sort((a, b) => a - b);
  console.log(`\nSHOWN ${shown.length} of ${cells.length}; BH survivors ${kMax + 1}; explore CI half-width among evaluable cells: min ${f(hw[0])}, median ${f(hw[hw.length >> 1])} ATR (effects smaller than roughly that could not be shown)`);
  if (!noRecord) {
    const lines = res.map((x) => `${x.c.id}: ${x.verdict}${x.ex.stat != null ? ` (explore n=${x.ex.n}, excess ${f(x.ex.stat)}, p=${x.ex.pTwo?.toFixed(3)})` : ''}`).join('; ');
    await recordClaim({ slug: 'overnight_rth_context_partA_20261026', sourceFile: 'scripts/study_overnight_rth_20261026.mjs', sourceDate: '2026-10-26', sampleSize: R.length, rigorStatus: 'preregistered_explore_holdout_bh_circular_shift_matched_control', status: 'PROVISIONAL',
      claimText: `Part A overnight-to-RTH (prereg docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md + Amendment 1). ${R.length} valid days ${R[0].date}..${R[R.length - 1].date} (explore ${explore.length}, hold-out ${hold.length}); ${cells.length} cells, ${m} evaluable; BH survivors ${kMax + 1}; SHOWN ${shown.length}. Smallest resolvable effect about ${f(hw[hw.length >> 1])} ATR (median CI half-width). Per cell: ${lines}. A5 (8:30 release) untestable: macro_events has no history.` });
    console.log('claim recorded');
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
