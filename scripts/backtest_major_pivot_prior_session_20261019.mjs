// backtest_major_pivot_prior_session_20261019.mjs -- do MAJOR_PIVOT_DEFENDED_BREAK trades that go AGAINST the prior RTH session's direction do better, and is that the SETUP or just the market?
//
// PRE-REGISTERED (written before this was run on the long history). Origin: the 2026-10-19 failure studies (1 year: breaks against the prior session succeeded 12/25 = 48% vs 25% with it vs 13% flat;
// 3.5 years, 320 breaks: 13/30 = 43% vs 22% vs 19%) and the user's trend-shift idea ("defended levels / flushes as gates or counter-gates to detect trend shifts; if aligned, even better").
//   Rule: priorMove = (prior completed RTH session close - open) x trade direction / the break's ATR20. AGAINST if priorMove < -T, WITH if > +T, FLAT otherwise. T = 0.25 ATR (primary, fixed in advance
//   from the earlier descriptive study); T = 0.15 and 0.50 reported as SENSITIVITY only (not picked from). Primary population = RTH breaks at zigzag 1.0 (227), live exits (stop 1.5x structural, 720 min hold, no target).
//   Secondary: the live 1.5-threshold RTH population (110), the trial exits (stop 1.0x, 1440 min), and Globex (reported, expected nothing).
// Comparisons (every item guards a known failure of this codebase):
//  * Arms use PER-TRADE means (sum/N), not day-weighted means. Delta CI = DAY-BLOCKED bootstrap of the difference of per-arm per-trade means (resample whole days, pool trades per arm).
//  * SAME-CLOCK CONTROL (the "setup or market" question): every break has 15 control entries on other days at the SAME minute-of-day, SAME direction, SAME stop distance, SAME exit; each control entry is
//    classified AGAINST/WITH/FLAT by ITS OWN prior session. DIFFERENCE-IN-DIFFERENCES = (break AGAINST - break NOT-AGAINST) - (control AGAINST - control NOT-AGAINST), computed as the paired difference
//    (break pnl minus its own control average) with the same day-blocked CI. If controls show the same gap, the pattern is market structure (buy-the-dip), not information in the pivot.
//  * Label PERMUTATION null (5,000 shuffles of the AGAINST label across breaks) for the primary delta.
//  * Split by direction (LONG/SHORT) and by chronological half before believing a pooled number (pooled verdicts hide opposite-signed subgroups).
//  * Context uses only information available at entry (the PRIOR completed session); entry = completed 5-minute bar close; exit/stop rules identical in every arm.
// Run: LOOKBACK_DAYS=1330 node --max-old-space-size=4096 scripts/backtest_major_pivot_prior_session_20261019.mjs [--record]
import { query } from '../server/db.js';
import { computeDefendedBreaks } from '../server/services/majorPivotDefendedBreakDetector.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';

const PT = 2, COMM = 2, LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS) || 1330, N_CONTROL = 15, ITERS = 4000, PERMS = 5000, MAX_HORIZON_MIN = 3000;
const T_PRIMARY = 0.25, T_SENS = [0.15, 0.5];
const CFG = { live: { stop: 1.5, hold: 720 }, trial: { stop: 1.0, hold: 1440 } };
const RECORD = process.argv.includes('--record');
const toMin = (s) => Math.floor(new Date(s.replace(' ', 'T') + 'Z').getTime() / 60000);
const fromMin = (m) => new Date(m * 60000).toISOString().slice(0, 19).replace('T', ' ');
const lowerBound = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const fmt = (x, d = 0) => (x == null || Number.isNaN(x) ? '  n/a' : (x >= 0 ? '+' : '') + x.toFixed(d)).padStart(6);

// ---- bars into typed arrays (monthly chunks) ----
async function loadBars(startDate, endDate) {
  const ts = [], H = [], L = [], C = [], O = [];
  let cur = new Date(startDate + 'T00:00:00Z'); const end = new Date(endDate + 'T00:00:00Z');
  while (cur < end) {
    const nxt = new Date(Math.min(end.getTime(), Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1)));
    const r = await query(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, open::float o, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 AND ts < $2 ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)]);
    for (const x of r.rows) { ts.push(toMin(x.t)); O.push(x.o); H.push(x.h); L.push(x.l); C.push(x.c); }
    cur = nxt;
  }
  return { ts: Float64Array.from(ts), O: Float64Array.from(O), H: Float64Array.from(H), L: Float64Array.from(L), C: Float64Array.from(C) };
}
function sim(B, idx, px, dir, stopDist, hold) {
  const stop = px - dir * stopDist, limit = Math.min(B.ts.length, idx + MAX_HORIZON_MIN), exitAt = B.ts[idx] + hold;
  let last = -1;
  for (let i = idx; i < limit && B.ts[i] < exitAt; i++) { last = i; if (dir === 1 ? B.L[i] <= stop : B.H[i] >= stop) return -stopDist * PT - COMM; }
  return last < 0 ? null : (B.C[last] - px) * dir * PT - COMM;
}

console.log(`Loading breaks (zigzag 1.0 and 1.5, ${LOOKBACK_DAYS} days) and 1-minute bars...`);
const breaks10 = await computeDefendedBreaks(1.0, LOOKBACK_DAYS), breaks15 = await computeDefendedBreaks(1.5, LOOKBACK_DAYS);
const ids15 = new Set(breaks15.map(b => `${b.entryTsStr}|${b.direction}`));
const todayDb = (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d;
const first = breaks10.map(b => b.entryTsStr).sort()[0].slice(0, 10);
const B = await loadBars(fromMin(toMin(first + ' 00:00:00') - 12 * 1440).slice(0, 10), fromMin(toMin(todayDb + ' 00:00:00') + 2 * 1440).slice(0, 10));
console.log(`${B.ts.length} bars loaded.`);

// RTH sessions (open of the 09:30 bar, close of the last bar <= 15:59) per calendar date, in order, for the PRIOR-session lookup
const sessions = [];
{ let curDay = null, o = null, c = null, n = 0;
  for (let i = 0; i < B.ts.length; i++) { const m = B.ts[i], dayStart = Math.floor(m / 1440) * 1440, tod = m - dayStart;
    if (tod < 570 || tod > 959) continue;
    if (dayStart !== curDay) { if (curDay != null && n > 300) sessions.push({ day: curDay, o, c }); curDay = dayStart; o = B.O[i]; n = 0; }
    c = B.C[i]; n++; }
  if (curDay != null && n > 300) sessions.push({ day: curDay, o, c }); }
const sessDays = Float64Array.from(sessions.map(s => s.day));
const priorSession = (entryMin) => { const day = Math.floor(entryMin / 1440) * 1440; const i = lowerBound(sessDays, day) - 1; return i >= 0 ? sessions[i] : null; };   // strictly before the entry's calendar date
const classify = (move, T) => move < -T ? 'AGAINST' : move > T ? 'WITH' : 'FLAT';

const barDayList = []; { let last = -1; for (let i = 0; i < B.ts.length; i += 30) { const d = Math.floor(B.ts[i] / 1440) * 1440; if (d !== last) { barDayList.push(d); last = d; } } }
const breakDays = new Set(breaks10.map(b => Math.floor(toMin(b.closeTsStr) / 1440) * 1440));
const controlDays = barDayList.filter(d => !breakDays.has(d));

const trades = [];
for (const b of breaks10) {
  const entryMin = toMin(b.closeTsStr), idx = lowerBound(B.ts, entryMin);
  if (idx >= B.ts.length || B.ts[idx] - entryMin > 10) continue;
  const dir = b.direction === 'LONG' ? 1 : -1, ps = priorSession(entryMin); if (!ps) continue;
  const m = ((toMin(b.entryTsStr) % 1440) + 1440) % 1440;
  const t = { id: `${b.entryTsStr}|${b.direction}`, date: b.entryTsStr.slice(0, 10), entryMin, idx, px: b.entryPrice, dir, structDist: Math.abs(b.entryPrice - b.stopPrice), atr: b.atr,
    session: (m >= 1080 || m < 510) ? 'GLOBEX' : 'RTH', live15: ids15.has(`${b.entryTsStr}|${b.direction}`), move: (ps.c - ps.o) * dir / b.atr, controls: [] };
  const rand = mulberry32(hashSeed(`priorsession_ctrl|${t.id}`)), tod = ((entryMin % 1440) + 1440) % 1440;
  for (let tries = 0; tries < 500 && t.controls.length < N_CONTROL; tries++) {
    const d = controlDays[Math.floor(rand() * controlDays.length)]; if (d === Math.floor(entryMin / 1440) * 1440) continue;
    const em = d + tod, ci = lowerBound(B.ts, em); if (ci <= 0 || ci >= B.ts.length || B.ts[ci] - em > 2 || B.ts[ci - 1] < em - 3) continue;
    if (t.controls.some(c => c.em === em)) continue;
    const cps = priorSession(em); if (!cps) continue;
    t.controls.push({ em, idx: ci, px: B.C[ci - 1], move: (cps.c - cps.o) * dir / b.atr });
  }
  trades.push(t);
}
console.log(`${trades.length} breaks usable (${trades.filter(t => t.session === 'RTH').length} RTH, ${trades.filter(t => t.session === 'GLOBEX').length} Globex).`);

// ---- day-blocked bootstrap of a difference of two arms' per-trade means ----
function bootDiff(items, isA, valA, key) {            // items: {date, ...}; returns {lo, hi}; arm A = isA(item), arm B = the rest; value = valA(item)
  const byDate = new Map(); for (const it of items) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  const dates = [...byDate.keys()], rnd = mulberry32(hashSeed(key)), diffs = [];
  for (let k = 0; k < ITERS; k++) {
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (let j = 0; j < dates.length; j++) for (const it of byDate.get(dates[Math.floor(rnd() * dates.length)])) { const v = valA(it); if (v == null) continue; if (isA(it)) { sa += v; na++; } else { sb += v; nb++; } }
    if (na && nb) diffs.push(sa / na - sb / nb);
  }
  diffs.sort((a, b) => a - b); return { lo: diffs[Math.floor(0.025 * diffs.length)], hi: diffs[Math.floor(0.975 * diffs.length)] };
}
function permP(rows, isA, val, seed) {
  const vals = rows.map(val), lab = rows.map(isA), obs = mean(vals.filter((_, i) => lab[i])) - mean(vals.filter((_, i) => !lab[i]));
  const rnd = mulberry32(hashSeed(seed)); let ge = 0; const idxs = vals.map((_, i) => i);
  for (let p = 0; p < PERMS; p++) { for (let i = idxs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idxs[i], idxs[j]] = [idxs[j], idxs[i]]; }
    const nA = lab.filter(Boolean).length; let sa = 0, sb = 0; for (let k = 0; k < idxs.length; k++) { if (k < nA) sa += vals[idxs[k]]; else sb += vals[idxs[k]]; }
    const d = sa / nA - sb / (idxs.length - nA); if (Math.abs(d) >= Math.abs(obs)) ge++; }
  return ge / PERMS;
}

const results = {};
function analyse(pop, label, cfg, T, detail = true) {
  const rows = [];
  for (const t of pop) {
    const sd = t.structDist * cfg.stop, p = sim(B, t.idx, t.px, t.dir, sd, cfg.hold); if (p == null) continue;
    const cs = t.controls.map(c => ({ v: sim(B, c.idx, c.px, t.dir, sd, cfg.hold), cls: classify(c.move, T) })).filter(c => c.v != null);
    rows.push({ date: t.date, dir: t.dir, cls: classify(t.move, T), pnl: p, ctrl: cs.length ? mean(cs.map(c => c.v)) : null, cAgainst: cs.filter(c => c.cls === 'AGAINST').map(c => c.v), cNot: cs.filter(c => c.cls !== 'AGAINST').map(c => c.v), entryMin: t.entryMin });
  }
  const A = rows.filter(r => r.cls === 'AGAINST'), N = rows.filter(r => r.cls !== 'AGAINST');
  const delta = mean(A.map(r => r.pnl)) - mean(N.map(r => r.pnl));
  const ci = bootDiff(rows, r => r.cls === 'AGAINST', r => r.pnl, `ps|${label}|${cfg.stop}|${T}`);
  const withC = rows.filter(r => r.ctrl != null), pair = withC.map(r => ({ ...r, d: r.pnl - r.ctrl }));
  const did = mean(pair.filter(r => r.cls === 'AGAINST').map(r => r.d)) - mean(pair.filter(r => r.cls !== 'AGAINST').map(r => r.d));
  const dci = bootDiff(pair, r => r.cls === 'AGAINST', r => r.d, `psdid|${label}|${cfg.stop}|${T}`);
  const cA = mean(rows.flatMap(r => r.cAgainst)), cN = mean(rows.flatMap(r => r.cNot));
  const p = detail ? permP(rows, r => r.cls === 'AGAINST', r => r.pnl, `psperm|${label}|${cfg.stop}|${T}`) : null;
  const byCls = (c) => { const x = rows.filter(r => r.cls === c); return `${c} N=${String(x.length).padStart(3)} days=${String(new Set(x.map(r => r.date)).size).padStart(3)} mean ${fmt(mean(x.map(r => r.pnl)))} median ${fmt(x.map(r => r.pnl).sort((a, b) => a - b)[x.length >> 1])} win ${(100 * x.filter(r => r.pnl > 0).length / (x.length || 1)).toFixed(0)}% ctrl ${fmt(mean(x.filter(r => r.ctrl != null).map(r => r.ctrl)))}`; };
  console.log(`\n--- ${label} | exits stop ${cfg.stop}x hold ${cfg.hold}m | T=${T} ATR ---`);
  console.log('   ' + byCls('AGAINST')); console.log('   ' + byCls('FLAT')); console.log('   ' + byCls('WITH'));
  console.log(`   AGAINST minus NOT-AGAINST: ${fmt(delta)} /trade  day-blocked 95% CI [${fmt(ci.lo)}, ${fmt(ci.hi)}]${p != null ? `  permutation p=${p.toFixed(3)}` : ''}`);
  console.log(`   SAME-CLOCK CONTROL, same split: control AGAINST ${fmt(cA)} vs control NOT ${fmt(cN)} => the market's own gap = ${fmt(cA - cN)}`);
  console.log(`   DIFFERENCE-IN-DIFFERENCES (pivot effect beyond the market): ${fmt(did)} /trade  CI [${fmt(dci.lo)}, ${fmt(dci.hi)}]`);
  if (detail) {
    for (const [nm, f] of [['LONG', r => r.dir === 1], ['SHORT', r => r.dir === -1]]) { const sub = rows.filter(f); const a = sub.filter(r => r.cls === 'AGAINST'), n = sub.filter(r => r.cls !== 'AGAINST');
      console.log(`   ${nm.padEnd(5)} AGAINST N=${a.length} mean ${fmt(mean(a.map(r => r.pnl)))}  vs not N=${n.length} mean ${fmt(mean(n.map(r => r.pnl)))}  delta ${fmt(mean(a.map(r => r.pnl)) - mean(n.map(r => r.pnl)))}`); }
    const sorted = [...rows].sort((x, y) => x.entryMin - y.entryMin), h = sorted.length >> 1;
    for (const [nm, sub] of [['1st half', sorted.slice(0, h)], ['2nd half', sorted.slice(h)]]) { const a = sub.filter(r => r.cls === 'AGAINST'), n = sub.filter(r => r.cls !== 'AGAINST');
      console.log(`   ${nm} AGAINST N=${a.length} mean ${fmt(mean(a.map(r => r.pnl)))}  vs not N=${n.length} mean ${fmt(mean(n.map(r => r.pnl)))}  delta ${fmt(mean(a.map(r => r.pnl)) - mean(n.map(r => r.pnl)))}`); }
  }
  results[`${label}|${cfg.stop}|${cfg.hold}|${T}`] = { nA: A.length, nN: N.length, delta, ci, did, dci, cA, cN, p };
}
const rth = trades.filter(t => t.session === 'RTH');
analyse(rth, 'RTH threshold1.0 (PRIMARY)', CFG.live, T_PRIMARY);
for (const T of T_SENS) analyse(rth, 'RTH threshold1.0 (sensitivity)', CFG.live, T, false);
analyse(rth.filter(t => t.live15), 'RTH threshold1.5 (live population)', CFG.live, T_PRIMARY);
analyse(rth, 'RTH threshold1.0, trial exits', CFG.trial, T_PRIMARY, false);
analyse(trades.filter(t => t.session === 'GLOBEX'), 'GLOBEX threshold1.0', CFG.live, T_PRIMARY, false);
console.log('\nDone.');

if (RECORD) {
  const { recordClaim } = await import('./record_claim.mjs');
  const P = results[`RTH threshold1.0 (PRIMARY)|1.5|720|0.25`];
  await recordClaim({ slug: 'major_pivot_prior_session_against_20261019', sourceFile: 'scripts/backtest_major_pivot_prior_session_20261019.mjs', sourceDate: '2026-10-19', sampleSize: P.nA + P.nN,
    evPerTrade: P.delta, rigorStatus: 'preregistered+dayblockedCI+sameclock_DiD+permutation', status: 'PROVISIONAL',
    claimText: `MAJOR_PIVOT prior-session condition, pre-registered, RTH zigzag 1.0 (N=${P.nA + P.nN}), live exits. AGAINST (n=${P.nA}) minus NOT-AGAINST (n=${P.nN}) = ${P.delta.toFixed(0)} per trade, day-blocked CI [${P.ci.lo.toFixed(0)}, ${P.ci.hi.toFixed(0)}], permutation p=${P.p.toFixed(3)}. Same-clock control gap (control AGAINST ${P.cA.toFixed(0)} vs NOT ${P.cN.toFixed(0)}); difference-in-differences ${P.did.toFixed(0)} CI [${P.dci.lo.toFixed(0)}, ${P.dci.hi.toFixed(0)}].` });
  console.log('claim recorded');
}
process.exit(0);
