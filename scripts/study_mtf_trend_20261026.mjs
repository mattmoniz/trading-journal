// Part B analysis: docs/BAR_CONTEXT_STUDIES_PREREG_B_20261026.md + Amendment 1. Reads scratch/mtf_touch_events_20261026.json (scripts/build_mtf_touch_events_20261026.mjs).
//   node scripts/study_mtf_trend_20261026.mjs --counts     state counts and overlap tables ONLY (no outcome)
//   node scripts/study_mtf_trend_20261026.mjs [--no-record]
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const J = JSON.parse(fs.readFileSync(new URL('../scratch/mtf_touch_events_20261026.json', import.meta.url)));
const rows = J.rows, BOOT = 5000, BH_Q = 0.10, MIN_STATE = 300, MIN_DATES = 60, PRIOR_SESSIONS = 60, MIN_PRIOR_TOUCHES = 100;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null), med = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f3 = (v) => (v == null ? 'n/a' : `${v < 0 ? '' : '+'}${v.toFixed(3)}`), f1 = (v) => (v == null ? 'n/a' : `${v < 0 ? '' : '+'}${v.toFixed(1)}`);

// ---- thresholds m(d, feature) = median |T| over touches of the previous 60 RTH sessions (daily_rth_stats calendar), strictly prior ----
const cal = (await query(`SELECT trade_date::text d FROM daily_rth_stats ORDER BY trade_date`)).rows.map((r) => r.d), calIdx = new Map(cal.map((d, i) => [d, i]));
const byDate = new Map(); for (const r of rows) (byDate.get(r.d) || byDate.set(r.d, []).get(r.d)).push(r);
const FEATS = ['T15', 'T60', 'T240', 'TS', 'Tp60', 'Tp240'], M = new Map();
for (const d of byDate.keys()) { const i = calIdx.get(d); if (i == null) continue; const pool = []; for (let j = Math.max(0, i - PRIOR_SESSIONS); j < i; j++) for (const r of byDate.get(cal[j]) || []) pool.push(r);
  if (pool.length >= MIN_PRIOR_TOUCHES) { const m = {}; for (const F of FEATS) m[F] = med(pool.map((r) => Math.abs(r[F]))); M.set(d, m); } }
const stOf = (T, m) => (m == null ? null : T >= m ? 'WITH' : T <= -m ? 'AGAINST' : 'MIXED');
for (const r of rows) { const m = M.get(r.d); for (const F of FEATS) r['s_' + F] = m ? stOf(r[F], m[F]) : null; r.s_ALL = r.s_T60 && r.s_T240 && r.s_TS ? (r.s_T60 === 'WITH' && r.s_T240 === 'WITH' && r.s_TS === 'WITH' ? 'WITH' : r.s_T60 === 'AGAINST' && r.s_T240 === 'AGAINST' && r.s_TS === 'AGAINST' ? 'AGAINST' : 'MIXED') : null; }
const live = rows.filter((r) => r.s_T60 !== null);
const dates = [...new Set(live.map((r) => r.d))].sort(), cut = Math.floor(dates.length * 0.6), exploreDates = new Set(dates.slice(0, cut)), isEx = (r) => exploreDates.has(r.d);
console.log(`touches ${rows.length}, with thresholds ${live.length} on ${dates.length} dates (explore ${cut} dates ..${dates[cut - 1]}, hold-out ${dates.length - cut} dates ${dates[cut]}..); events ${J.events}`);
for (const F of ['T15', 'T60', 'T240', 'TS', 'ALL']) { const c = (s) => live.filter((r) => r['s_' + F] === s).length; console.log(`state counts ${F.padEnd(5)} WITH ${c('WITH')} AGAINST ${c('AGAINST')} MIXED ${c('MIXED')}   (explore WITH ${live.filter((r) => isEx(r) && r['s_' + F] === 'WITH').length} AGAINST ${live.filter((r) => isEx(r) && r['s_' + F] === 'AGAINST').length})`); }
const xt = (A, B) => { const o = {}; for (const r of live) { const k = `${r['s_' + A]}|${r[B] === undefined ? 'noRd' : B === 'agree' ? (r.agree ? 'rot-AGREE' : 'rot-DISAGREE') : r['s_' + B]}`; o[k] = (o[k] || 0) + 1; } return o; };
console.log('overlap T60 x T15:', xt('T60', 'T15')); console.log('overlap T240 x T60:', xt('T240', 'T60')); console.log('overlap T60 x rotation agree:', xt('T60', 'agree'));
if (process.argv.includes('--counts')) process.exit(0);

// ---- statistics: per-date aggregates + day-cluster bootstrap ----
const OUTS = { ret30: (r) => r.ret30, ret60: (r) => r.ret60, ret120: (r) => r.ret120, pnl: (r) => r.pnlSym };
function aggregate(items, stateFn, outFn, stateName) {
  const A = new Map(); for (const r of items) { const s = stateFn(r), y = outFn(r); if (s == null || y == null) continue; let a = A.get(r.d); if (!a) A.set(r.d, a = { nA: 0, sA: 0, nS: 0, sS: 0 }); a.nA++; a.sA += y; if (s === stateName) { a.nS++; a.sS += y; } } return A;
}
function excess(A, pick = null) { let nA = 0, sA = 0, nS = 0, sS = 0; for (const [d, a] of A) { if (pick && !pick.has(d)) continue; nA += a.nA; sA += a.sA; nS += a.nS; sS += a.sS; } return nS && nA ? sS / nS - sA / nA : null; }
function boot(A, seed) {
  const keys = [...A.keys()], arr = keys.map((k) => A.get(k)), L = arr.length, rand = mulberry32(hashSeed(seed)), draws = [];
  for (let b = 0; b < BOOT; b++) { let nA = 0, sA = 0, nS = 0, sS = 0; for (let i = 0; i < L; i++) { const a = arr[Math.floor(rand() * L)]; nA += a.nA; sA += a.sA; nS += a.nS; sS += a.sS; } if (nS && nA) draws.push(sS / nS - sA / nA); }
  draws.sort((x, y) => x - y); const q = (p) => draws[Math.floor(p * (draws.length - 1))], le0 = draws.filter((v) => v <= 0).length / draws.length, ge0 = draws.filter((v) => v >= 0).length / draws.length;
  return { lo: q(0.025), hi: q(0.975), pTwo: Math.min(1, 2 * Math.min(le0, ge0)), pLE0: le0, pGE0: ge0 };
}
function cellEval(items, F, state, out, seed) {
  const A = aggregate(items, (r) => r['s_' + F], OUTS[out], state), x = excess(A); let nS = 0, nA = 0; for (const a of A.values()) { nS += a.nS; nA += a.nA; }
  const dS = [...A.values()].filter((a) => a.nS > 0).length; if (!x && x !== 0) return { nS, nA, dS, x: null };
  return { nS, nA, dS, x, ...boot(A, seed), A };
}
const strat = (items, F, state, out) => {   // stratified excess: mean over state touches of (y - meanAll(stratum)), finest stratum passing >=20 touches and >=40 dates
  const y = OUTS[out], ok = items.filter((r) => r['s_' + F] != null && y(r) != null); const lv = [(r) => `${r.fam}|${r.bucket}|${r.f}`, (r) => `${r.fam}|${r.f}`, (r) => `${r.f}`];
  const maps = lv.map((kf) => { const m = new Map(); for (const r of ok) { const k = kf(r); let e = m.get(k); if (!e) m.set(k, e = { n: 0, s: 0, d: new Set() }); e.n++; e.s += y(r); e.d.add(r.d); } return m; });
  const dev = []; for (const r of ok) if (r['s_' + F] === state) { for (let l = 0; l < 3; l++) { const e = maps[l].get(lv[l](r)); if (e.n >= 20 && e.d.size >= 40) { dev.push(y(r) - e.s / e.n); break; } } }
  return mean(dev);
};

// ---- cells ----
const cells = [];
for (const F of ['T60', 'T240', 'TS']) for (const st of ['WITH', 'AGAINST']) for (const out of Object.keys(OUTS)) cells.push({ id: `${F}_${st}_${out}`, F, st, out });
for (const st of ['WITH', 'AGAINST']) for (const out of Object.keys(OUTS)) cells.push({ id: `ALL_${st}_${out}`, F: 'ALL', st, out });
const ex = live.filter(isEx), ho = live.filter((r) => !isEx(r));
for (const c of cells) c.ex = cellEval(ex, c.F, c.st, c.out, `B|${c.id}|ex`);
const evalable = cells.filter((c) => c.ex.x != null && c.ex.nS >= MIN_STATE && c.ex.dS >= MIN_DATES), m = evalable.length;
const sorted = [...evalable].sort((a, b) => a.ex.pTwo - b.ex.pTwo); let kMax = -1; sorted.forEach((c, i) => { if (c.ex.pTwo <= ((i + 1) / m) * BH_Q) kMax = i; }); sorted.forEach((c, i) => { c.bh = i <= kMax; });
console.log(`\ncells ${cells.length}, evaluable ${m} (explore state touches >= ${MIN_STATE} on >= ${MIN_DATES} dates), BH survivors ${kMax + 1}`);

// placebo (random timestamp): excess of the same cell on placebo touches, hold-out dates, 20 draws
const PL = J.placebo.map((draw) => draw.map((p) => { const mm = M.get(p.d); const o = { d: p.d, ret30: p.ret30, ret60: p.ret60, ret120: p.ret120, pnlSym: p.pnlSym, fam: 'x', bucket: 'x', f: p.f }; if (!mm) return o; for (const F of ['T60', 'T240', 'TS']) o['s_' + F] = stOf(p[F], mm[F]); o.s_ALL = o.s_T60 === 'WITH' && o.s_T240 === 'WITH' && o.s_TS === 'WITH' ? 'WITH' : o.s_T60 === 'AGAINST' && o.s_T240 === 'AGAINST' && o.s_TS === 'AGAINST' ? 'AGAINST' : 'MIXED'; return o; }));
const hoDates = new Set(dates.slice(cut));
for (const c of cells) {
  if (!c.bh) { c.verdict = c.ex.x == null || c.ex.nS < MIN_STATE || c.ex.dS < MIN_DATES ? `NOT EVALUATED (explore state touches ${c.ex.nS}, dates ${c.ex.dS})` : 'NOT SHOWN'; continue; }
  c.ho = cellEval(ho, c.F, c.st, c.out, `B|${c.id}|ho`);
  const sameSign = c.ho.x != null && Math.sign(c.ho.x) === Math.sign(c.ex.x), p1 = c.ho.x == null ? 1 : (c.ex.x > 0 ? c.ho.pLE0 : c.ho.pGE0);
  const plac = PL.map((d) => { const items = d.filter((r) => hoDates.has(r.d) && r['s_' + c.F] !== undefined); const A = aggregate(items, (r) => r['s_' + c.F], OUTS[c.out], c.st); return excess(A); }).filter((v) => v != null).map(Math.abs).sort((a, b) => a - b);
  c.plac95 = plac[Math.floor(0.95 * (plac.length - 1))]; c.beatsPlacebo = c.ho.x != null && Math.abs(c.ho.x) > c.plac95;
  c.stratEx = strat(ex, c.F, c.st, c.out); c.stratHo = strat(ho, c.F, c.st, c.out);
  c.stratOk = c.stratHo != null && Math.sign(c.stratHo) === Math.sign(c.ho.x) && Math.abs(c.stratHo) >= 0.5 * Math.abs(c.ho.x);
  // disjoint variant for T60/T240
  if (c.F === 'T60' || c.F === 'T240') { const sw = (r) => r['s_' + (c.F === 'T60' ? 'Tp60' : 'Tp240')]; const A = aggregate(ho, sw, OUTS[c.out], c.st); const xd = excess(A); c.disjointOk = xd != null && Math.sign(xd) === Math.sign(c.ho.x); } else c.disjointOk = true;
  // influence: drop 5 most influential dates (hold-out)
  const A = c.ho.A, contrib = [...A].map(([d, a]) => ({ d, v: Math.abs(a.sS - a.nS * (excess(A) + 0) - 0) })).sort((p, q) => q.v - p.v), drop = new Set(contrib.slice(0, 5).map((e) => e.d)), keep = new Set([...A.keys()].filter((d) => !drop.has(d))); const xi = excess(A, keep); c.influenceOk = xi != null && Math.sign(xi) === Math.sign(c.ho.x);
  const ok = sameSign && p1 < 0.05 && c.beatsPlacebo && c.stratOk && c.disjointOk && c.influenceOk;
  c.verdict = ok ? 'SHOWN' : sameSign && p1 < 0.05 ? `NOT SHOWN (failed: ${[!c.beatsPlacebo && 'placebo', !c.stratOk && 'stratified', !c.disjointOk && 'disjoint', !c.influenceOk && 'influence'].filter(Boolean).join(',')})` : 'NOT SHOWN (explore survivor failed hold-out)';
}
for (const c of cells) console.log(`${c.id.padEnd(18)} ex nS=${String(c.ex.nS).padStart(5)} d=${String(c.ex.dS).padStart(3)} excess ${f3(c.ex.x)} [${f3(c.ex.lo)},${f3(c.ex.hi)}] p=${c.ex.pTwo?.toFixed(3) ?? 'n/a'}${c.bh ? ' BH' : ''}` + (c.ho ? ` | ho nS=${c.ho.nS} ${f3(c.ho.x)} placebo95 ${f3(c.plac95)} strat ${f3(c.stratHo)} | ` : ' | ') + c.verdict);

// ---- splits for SHOWN cells ----
const shown = cells.filter((c) => c.verdict === 'SHOWN'); const dt = shown.length ? Object.fromEntries((await query(`SELECT trade_date::text d, day_type FROM acd_daily_log WHERE day_type IS NOT NULL`)).rows.map((r) => [r.d, r.day_type])) : {};
for (const c of shown) {
  const sp = (label, fn) => { const e = cellEval(live.filter(fn), c.F, c.st, c.out, `B|${c.id}|${label}`); return `${label} nS=${e.nS} ${f3(e.x)}`; };
  console.log(`SPLITS ${c.id}: ${sp('LONG', (r) => r.f > 0)} | ${sp('SHORT', (r) => r.f < 0)} | ${['SAME_DAY_OR_IB', 'PD', 'WEEKLY', 'MONTHLY', 'CAM', 'FLOOR', 'OTHER'].map((fm) => sp(fm, (r) => r.fam === fm)).join(' | ')} | ${sp('pre-2025-06', (r) => r.d < '2025-06-01')} | ${sp('post', (r) => r.d >= '2025-06-01')} | ${['TREND', 'BALANCE', 'TURBULENT'].map((t) => sp(t, (r) => dt[r.d] === t)).join(' | ')} | ${['ABOVE_OR', 'INSIDE_OR', 'BELOW_OR', 'FORMING'].map((o) => sp(o, (r) => r.orPos === o)).join(' | ')} | ${sp('9:31-10:00', (r) => r.mod < 600)}`);
}
// ---- Globex descriptive table (real fills, NOT comparable to the simulated RTH replay) ----
const gm = (d) => { let best = null; for (const k of M.keys()) if (k <= d && (best === null || k > best)) best = k; return best ? M.get(best) : null; };
const gl = J.globex.map((g) => { const mm = gm(g.d); return mm ? { ...g, s_T60: stOf(g.T60, mm.T60), s_T240: stOf(g.T240, mm.T240) } : null; }).filter(Boolean);
console.log(`\nGLOBEX descriptive (real fills, ret60 in ATR units, n=${gl.length}, all-mean ${f3(mean(gl.map((g) => g.ret60)))}):`);
for (const F of ['T60', 'T240']) for (const s of ['WITH', 'AGAINST']) { const a = gl.filter((g) => g['s_' + F] === s); console.log(`  ${F} ${s}: n=${a.length} mean ret60 ${f3(mean(a.map((g) => g.ret60)))} (excess vs all ${f3(mean(a.map((g) => g.ret60)) - mean(gl.map((g) => g.ret60)))})`); }
const hw = evalable.map((c) => (c.ex.hi - c.ex.lo) / 2).sort((a, b) => a - b);
console.log(`\nSHOWN ${shown.length} of ${cells.length}; BH survivors ${kMax + 1}; explore CI half-width (excess in ATR units / dollars for pnl cells) median ${f3(hw[hw.length >> 1])}, min ${f3(hw[0])}`);
if (!process.argv.includes('--no-record')) {
  const lines = cells.map((c) => `${c.id}: ${c.verdict}${c.ex.x != null ? ` (explore nS=${c.ex.nS}, excess ${f3(c.ex.x)}, p=${c.ex.pTwo?.toFixed(3)})` : ''}`).join('; ');
  await recordClaim({ slug: 'mtf_trend_context_partB_20261026', sourceFile: 'scripts/study_mtf_trend_20261026.mjs', sourceDate: '2026-10-26', sampleSize: live.length, rigorStatus: 'preregistered_explore_holdout_bh_day_cluster_bootstrap_random_timestamp_placebo_stratified', status: 'PROVISIONAL',
    claimText: `Part B multi-timeframe trend at level touches (prereg docs/BAR_CONTEXT_STUDIES_PREREG_B_20261026.md + Amendment 1). ${live.length} touches (collapsed from ${J.events} events) on ${dates.length} dates 2023-03..2026-10-23 with the sparse window and roll weeks excluded; explore ${cut} dates, hold-out ${dates.length - cut}; ${cells.length} RTH cells, ${m} evaluable, BH survivors ${kMax + 1}, SHOWN ${shown.length}. Median explore CI half-width ${f3(hw[hw.length >> 1])}. Per cell: ${lines}. Globex arm descriptive only (n=${gl.length}). Framing: re-test of MomFade at 60/240 bars and of isTrendCounterFade.` });
  console.log('claim recorded');
}
process.exit(0);
