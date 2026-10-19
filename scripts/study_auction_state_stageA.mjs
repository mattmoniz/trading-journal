// Stage A of the auction-state study (docs/POC_ROTATION_TPO_CONTEXT_SPEC.md v2, DeepSeek critique
// scratch/deepseek_response_auction_state_v2_20261018.md). RESEARCH ONLY -- nothing here is wired live.
//
// Question (A1): at an RTH touch of a defended level, does ONE as-of state feature -- "acceptance" A, how far the
// developing value area has FOLLOWED price toward the level -- predict whether the fade works?
//   L = (POC - VAL) / (VAH - VAL) from computeProfile(bars[session_open .. touch bar]) -- as-of, never full-session.
//   A = L for a SHORT fade (price came from below, value skewed up = value following), 1 - L for a LONG fade.
//   Bucketed HIGH / MID / LOW by percentile rank against the SAME minute-of-day's A over the previous 20 sessions
//   (rolling, no static cutoff). Primary contrast = HIGH vs LOW only (MID reported, not tested).
// Touch population: the real scan in scripts/level_fade_audit.mjs (imported, not reimplemented). Fit window ends
// 2026-10-10 (confound boundary: three mechanisms changed 2026-10-11/12).
// Outcome (future bars used as OUTCOME only): entry = open of the bar AFTER the touch bar; signed (toward the fade)
// forward change at 10/30/60 bars; MFE/MAE; stop-vs-target arrival order at the level's own calibrated
// OPTIMAL_STOP pair (descriptive only -- that pair was calibrated on overlapping data).
// Controls: day-so-far direction (the effect must survive inside the "price extended into the level" subset),
// a label-shuffle placebo, the gambler's-ruin baseline for arrival order, >=20 distinct days per arm, top-5-day drop.
// Kill rule: if the pre-registered HIGH-vs-LOW delta does not survive, the answer is "no usable state split".
import { loadData, getLevels, replayDay } from './level_fade_audit.mjs';
import { computeProfile } from '../server/services/developingValueService.js';
import { dayBlockedBootstrapDeltaCI, mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { query } from '../server/db.js';

const FIT_END = '2026-10-10';
const REF_DAYS = 20;
const MIN_REF = 10;
const H = [10, 30, 60];
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

const { barsByDate, allDates, vaByDate, acdByDate, tradingDates } = await loadData();
const stopTarget = {};
for (const r of (await query(`SELECT DISTINCT ON (signal_name) signal_name, optimal_stop::float s, optimal_target::float t
  FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND optimal_stop IS NOT NULL AND optimal_target IS NOT NULL
  ORDER BY signal_name, run_date DESC, id DESC`)).rows) stopTarget[r.signal_name] = r;

const profCache = new Map(); // `${date}|${i}` -> L
function lAt(date, i) {
  const key = `${date}|${i}`;
  if (profCache.has(key)) return profCache.get(key);
  const bars = barsByDate[date];
  const p = computeProfile(bars.slice(0, i + 1).map(b => ({ high: b.high, low: b.low, volume: Number(b.vol) })));
  const L = !p ? null : (p.vah === p.val ? 0.5 : (p.poc - p.val) / (p.vah - p.val));
  profCache.set(key, L);
  return L;
}
const orient = (L, fadeDir) => (fadeDir === 'SHORT' ? L : 1 - L);
const dates = tradingDates.filter(d => d <= FIT_END);
const medianRange = (d) => { const r = (barsByDate[d] || []).map(b => b.high - b.low).sort((a, b) => a - b); return r.length ? r[Math.floor(r.length / 2)] : null; };

const rows = [];
let skippedNoRef = 0;
for (const date of dates) {
  const bars = barsByDate[date];
  if (!bars || bars.length < 100) continue;
  const di = allDates.indexOf(date);
  if (di < REF_DAYS + 1) continue;
  const levels = getLevels(date, allDates[di - 1], vaByDate, acdByDate, barsByDate);
  if (!levels.length) continue;
  const prior = allDates.slice(di - REF_DAYS, di);
  const B = 3 * (prior.map(medianRange).filter(Boolean).sort((a, b) => a - b)[Math.floor(REF_DAYS / 2)] || NaN);
  for (const t of replayDay(date, bars, levels, acdByDate[date]?.day_type, null)) {
    const i = t.entryBarIdx;
    if (i + 61 >= bars.length) continue; // need the full 60-bar future for every touch (equal samples across horizons)
    const L = lAt(date, i);
    if (L == null) continue;
    const A = orient(L, t.fadeDir);
    const ref = [];
    for (const pd of prior) {
      const pb = barsByDate[pd]; const j = pb ? pb.findIndex(b => b.et_min === bars[i].et_min) : -1;
      if (j >= 0) { const Lp = lAt(pd, j); if (Lp != null) ref.push(orient(Lp, t.fadeDir)); }
    }
    if (ref.length < MIN_REF) { skippedNoRef++; continue; }
    const rank = ref.filter(x => x < A).length / ref.length;
    const bucket = rank >= 2 / 3 ? 'HIGH' : rank <= 1 / 3 ? 'LOW' : 'MID';
    const s = t.fadeDir === 'LONG' ? 1 : -1;
    const entry = bars[i + 1].open;
    const out = {};
    for (const h of H) {
      let mfe = 0, mae = 0;
      for (let j = 1; j <= h; j++) { const b = bars[i + j]; mfe = Math.max(mfe, s * ((s > 0 ? b.high : b.low) - entry)); mae = Math.max(mae, -s * ((s > 0 ? b.low : b.high) - entry)); }
      out['ret' + h] = s * (bars[i + h].close - entry); out['mfe' + h] = mfe; out['mae' + h] = mae;
    }
    // arrival order at the level's calibrated pair; same-bar double hit counts as STOP first (conservative)
    const st = stopTarget[`${t.levelName}_FADE_${t.fadeDir}`];
    let arrival = 'NA';
    if (st) { arrival = 'NEITHER'; for (let j = 1; j <= 60; j++) { const b = bars[i + j]; const adv = -s * ((s > 0 ? b.low : b.high) - entry), fav = s * ((s > 0 ? b.high : b.low) - entry); if (adv >= st.s) { arrival = 'STOP'; break; } if (fav >= st.t) { arrival = 'TARGET'; break; } } }
    // reporting-only HOLD/BREAK with B from PRIOR sessions only (never this touch's own range)
    let label = 'UNRESOLVED';
    for (let j = 1; j <= 60 && Number.isFinite(B); j++) { const b = bars[i + j]; const adv = -s * ((s > 0 ? b.low : b.high) - entry), fav = s * ((s > 0 ? b.high : b.low) - entry); if (fav >= B && adv >= B) break; if (fav >= B) { label = 'HOLD'; break; } if (adv >= B) { label = 'BREAK'; break; } }
    const dayDir = Math.sign(bars[i].close - bars[0].open);
    const extended = (t.fadeDir === 'LONG' && dayDir < 0) || (t.fadeDir === 'SHORT' && dayDir > 0); // price already ran INTO the level
    rows.push({ date, level: t.levelName, fadeDir: t.fadeDir, A, bucket, extended, arrival, label, stopTargetBase: st ? st.s / (st.s + st.t) : null, ...out });
  }
}
console.log(`touches used: ${rows.length} over ${new Set(rows.map(r => r.date)).size} days (skipped, too little same-minute history: ${skippedNoRef}); fit window ends ${FIT_END}`);

const describe = (list) => ({ n: list.length, days: new Set(list.map(r => r.date)).size, ...Object.fromEntries(H.flatMap(h => [['ret' + h, mean(list.map(r => r['ret' + h]))], ['mfe' + h, mean(list.map(r => r['mfe' + h]))], ['mae' + h, mean(list.map(r => r['mae' + h]))]])),
  targetFirst: list.filter(r => r.arrival === 'TARGET').length / Math.max(1, list.filter(r => r.arrival !== 'NA').length),
  stopFirst: list.filter(r => r.arrival === 'STOP').length / Math.max(1, list.filter(r => r.arrival !== 'NA').length),
  base: mean(list.filter(r => r.stopTargetBase != null).map(r => r.stopTargetBase)),
  hold: list.filter(r => r.label === 'HOLD').length / list.length, brk: list.filter(r => r.label === 'BREAK').length / list.length, unres: list.filter(r => r.label === 'UNRESOLVED').length / list.length });
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
function table(title, subset) {
  console.log(`\n${title}`);
  console.log('bucket   n   days  ret10   ret30   ret60   mfe30  mae30  target1st stop1st gamblerBase  HOLD/BREAK/UNRES');
  for (const b of ['LOW', 'MID', 'HIGH']) { const d = describe(subset.filter(r => r.bucket === b)); if (!d.n) continue;
    console.log(`${b.padEnd(6)}${String(d.n).padStart(5)}${String(d.days).padStart(6)}${f(d.ret10).padStart(8)}${f(d.ret30).padStart(8)}${f(d.ret60).padStart(8)}${f(d.mfe30).padStart(8)}${f(d.mae30).padStart(7)}${(f(100 * d.targetFirst, 0) + '%').padStart(10)}${(f(100 * d.stopFirst, 0) + '%').padStart(8)}${(f(100 * d.base, 0) + '%').padStart(11)}   ${f(100 * d.hold, 0)}/${f(100 * d.brk, 0)}/${f(100 * d.unres, 0)}`); }
}
table('ALL touches', rows);
table('Only touches where price had already RUN INTO the level (day-so-far control subset)', rows.filter(r => r.extended));
table('Only touches where price had NOT run into it', rows.filter(r => !r.extended));

function delta(list, label, key = 'ret30') {
  const hi = list.filter(r => r.bucket === 'HIGH'), lo = list.filter(r => r.bucket === 'LOW');
  const dh = new Set(hi.map(r => r.date)).size, dl = new Set(lo.map(r => r.date)).size;
  const ev = [...hi.map(r => ({ date: r.date, pnl: r[key], group: 'HIGH' })), ...lo.map(r => ({ date: r.date, pnl: r[key], group: 'LOW' }))];
  let ci = ev.length ? dayBlockedBootstrapDeltaCI(ev, `stageA|${label}|${key}`, { groupA: 'HIGH', groupB: 'LOW' }) : null;
  // dayBlockedBootstrapDeltaCI returns the CI of mean(groupB) - mean(groupA) = LOW - HIGH; flip it to HIGH - LOW.
  if (ci && ci.lo != null) ci = { lo: -ci.hi, hi: -ci.lo };
  const d = mean(hi.map(r => r[key])) - mean(lo.map(r => r[key]));
  // label-shuffle placebo: permute HIGH/LOW labels across touches, same counts
  const rand = mulberry32(hashSeed(`stageA-placebo|${label}|${key}`)); const vals = ev.map(e => e.pnl); let ge = 0; const N = 2000;
  for (let k = 0; k < N; k++) { const sh = [...vals]; for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    const m1 = mean(sh.slice(0, hi.length)), m2 = mean(sh.slice(hi.length)); if (Math.abs(m1 - m2) >= Math.abs(d)) ge++; }
  console.log(`${label.padEnd(44)} ${key}: HIGH n=${hi.length}/${dh}d  LOW n=${lo.length}/${dl}d  delta(HIGH-LOW)=${f(d, 2)}  CI=${ci ? `[${f(ci.lo, 2)}, ${f(ci.hi, 2)}]` : 'n/a'}  placebo p=${f(ge / N, 3)}  ${dh >= 20 && dl >= 20 ? '' : '<20 days'}`);
  return { d, ci, p: ge / N, dh, dl };
}
console.log('\n=== PRE-REGISTERED A1: HIGH-acceptance minus LOW-acceptance, fade-direction-signed forward change (points) ===');
const a1 = delta(rows, 'A1 all RTH touches');
for (const k of ['ret10', 'ret60']) delta(rows, 'A1 all RTH touches', k);
delta(rows.filter(r => r.extended), 'A1 control: price ran INTO level');
delta(rows.filter(r => !r.extended), 'A1 control: price had not run in');
// top-5-day drop: remove the 5 days with the largest total |ret30| contribution to either arm
const dayWeight = {}; for (const r of rows.filter(r => r.bucket !== 'MID')) dayWeight[r.date] = (dayWeight[r.date] || 0) + Math.abs(r.ret30);
const drop = new Set(Object.entries(dayWeight).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]));
delta(rows.filter(r => !drop.has(r.date)), 'A1 excluding the 5 heaviest days');
// raw-L (not direction-oriented) split by fade direction -- descriptive, pooled verdicts hide opposite signs
for (const dir of ['LONG', 'SHORT']) delta(rows.filter(r => r.fadeDir === dir), `A1 descriptive: ${dir} fades only`);
console.log(`\nVERDICT RULE: A1 passes only if CI excludes zero AND placebo p small AND >=20 days/arm AND survives the day-so-far control and the 5-day drop. Result for the primary contrast: delta=${f(a1.d, 2)} CI=${a1.ci ? `[${f(a1.ci.lo, 2)}, ${f(a1.ci.hi, 2)}]` : 'n/a'} -> ${a1.ci && (a1.ci.lo > 0 || a1.ci.hi < 0) && a1.dh >= 20 && a1.dl >= 20 ? 'CI EXCLUDES ZERO (check controls above)' : 'NO USABLE SPLIT on the primary contrast'}`);
process.exit(0);
