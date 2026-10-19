// Stage B2 of the auction-state study (DeepSeek critique scratch/deepseek_response_stageA_critique_20261018.md, Q6).
// RESEARCH ONLY. Tests the user's own statement: "rotation joins fail on trend/expansion days", with an AS-OF
// expansion measure instead of the (weak) volume-profile POC location used in A1/A3.
//   X = range so far = (session high so far - session low so far) over bars [anchor .. trigger bar]
//       anchor = 09:30 RTH open for RTH-entry events, 18:00 Globex open for Globex-entry events.
//   Bucketed by percentile rank against the SAME minute-of-day's X over the previous 20 sessions (rolling, no static
//   cutoff): rank >= 2/3 = EXPANSION, <= 1/3 = BALANCE; MID reported, not tested. Pre-registered sign: NEGATIVE
//   (join worse in expansion). Outcome: exit-agnostic, join-direction-signed change from the open of the entry bar.
// Declustered per DeepSeek: one event per leg (dedupe leg_start), and drop an event whose entry falls inside the
// 30-bar holding window of an earlier kept join in the same session. RTH and Globex entries reported SEPARATELY.
// Controls: day-so-far direction subsets; top-5-day drop; within-day paired delta (days having both arms); and the A3
// volume-profile acceptance feature (L) re-tested INSIDE each expansion stratum (RTH). Fit window ends 2026-10-10.
// No 60-bar-future requirement (that dropped late-day events in A1/A3): each horizon uses events with enough bars left.
import { detectSignalEvents } from '../server/services/pocRotationService.js';
import { computeProfile } from '../server/services/developingValueService.js';
import { dayBlockedBootstrapDeltaCI, dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { query } from '../server/db.js';

const FROM = '2026-04-01 18:00:00', FIT_END = '2026-10-10';
const REF_DAYS = 20, MIN_REF = 10, HOLD = 30;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

const theta = Math.max(0.25, +(await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) m FROM price_bars_primary WHERE symbol='NQ'`)).rows[0].m);
const raw = (await query(`SELECT ts::text ts, open::float open, high::float high, low::float low, close::float close, volume::float volume
  FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < ($2::date + 1)::timestamp ORDER BY ts`, [FROM, FIT_END])).rows;
const sessions = new Map();
for (const b of raw) {
  const hr = +b.ts.slice(11, 13), min = +b.ts.slice(14, 16), mod = hr * 60 + min;
  if (mod >= 1020 && mod < 1080) continue;
  const d = new Date(Date.UTC(+b.ts.slice(0, 4), +b.ts.slice(5, 7) - 1, +b.ts.slice(8, 10) + (hr >= 18 ? 1 : 0))).toISOString().slice(0, 10);
  if (!sessions.has(d)) sessions.set(d, []);
  sessions.get(d).push({ ...b, mod, date: b.ts.slice(0, 10) });
}
const dates = [...sessions.keys()].sort().filter(d => d <= FIT_END && !isInsideNqRollWeek(d) && sessions.get(d).length > 600);
const sessionList = dates.map(d => ({ t: d, bars: sessions.get(d) }));
const { all_signal } = detectSignalEvents(65, 'standard', theta, sessionList, 'fixed');
console.log(`theta=${theta}; sessions: ${dates.length}; raw rotation events: ${all_signal.length}`);

const rthAnchor = (bars, d) => bars.findIndex(b => b.mod >= 570 && b.date === d);
function rangeAt(d, anchorKind, mod, evening) { // range so far in session d up to the bar at minute `mod` (same evening/morning half for Globex)
  const bars = sessions.get(d); if (!bars) return null;
  const a = anchorKind === 'RTH' ? rthAnchor(bars, d) : 0; if (a < 0) return null;
  let idx = -1;
  for (let i = a; i < bars.length; i++) { if (bars[i].mod === mod && (anchorKind === 'RTH' || (bars[i].mod >= 1080) === evening)) { idx = i; break; } }
  if (idx < 0) return null;
  let hi = -Infinity, lo = Infinity; for (let i = a; i <= idx; i++) { if (bars[i].high > hi) hi = bars[i].high; if (bars[i].low < lo) lo = bars[i].low; }
  return hi - lo;
}
const LC = new Map();
function lRth(d, mod) { const k = `${d}|${mod}`; if (LC.has(k)) return LC.get(k);
  const bars = sessions.get(d).filter(b => b.mod >= 570 && b.mod < 960 && b.date === d && b.mod <= mod);
  const p = bars.length >= 5 ? computeProfile(bars.map(b => ({ high: b.high, low: b.low, volume: b.volume }))) : null;
  const L = !p ? null : (p.vah === p.val ? 0.5 : (p.poc - p.val) / (p.vah - p.val)); LC.set(k, L); return L; }

// --- build declustered events ---
const bySession = new Map(); for (const e of all_signal) { if (!bySession.has(e.t)) bySession.set(e.t, []); bySession.get(e.t).push(e); }
const rows = []; let droppedDecluster = 0;
for (const [d, evs] of bySession) {
  evs.sort((a, b) => a.trigger_idx - b.trigger_idx);
  const seenLegs = new Set(); let lastKeptEntry = -1e9; const bars = sessions.get(d);
  for (const ev of evs) {
    if (ev.entry_idx == null) continue;
    if (seenLegs.has(ev.leg_start) || ev.entry_idx < lastKeptEntry + HOLD) { droppedDecluster++; continue; }
    const eb = bars[ev.entry_idx], tb = bars[ev.trigger_idx];
    const isRth = eb.mod >= 570 && eb.mod < 960 && eb.date === d;
    const isGlobex = !isRth && (eb.mod >= 1080 || eb.mod < 570);
    if (!isRth && !isGlobex) continue;
    seenLegs.add(ev.leg_start); lastKeptEntry = ev.entry_idx;
    const arm = isRth ? 'RTH' : 'GLOBEX';
    const evening = tb.mod >= 1080;
    const X = rangeAt(d, arm === 'RTH' ? 'RTH' : 'GLOBEX', tb.mod, evening); if (X == null) continue;
    const di = dates.indexOf(d), ref = [];
    for (const pd of dates.slice(Math.max(0, di - REF_DAYS), di)) { const r = rangeAt(pd, arm === 'RTH' ? 'RTH' : 'GLOBEX', tb.mod, evening); if (r != null) ref.push(r); }
    if (ref.length < MIN_REF) continue;
    const rank = ref.filter(x => x < X).length / ref.length;
    const bucket = rank >= 2 / 3 ? 'EXPANSION' : rank <= 1 / 3 ? 'BALANCE' : 'MID';
    const s = ev.direction === 'UP' ? 1 : -1, entry = eb.open;
    const anchorOpen = arm === 'RTH' ? bars[rthAnchor(bars, d)].open : bars[0].open;
    const withDay = Math.sign(tb.close - anchorOpen) === s;
    const out = {};
    for (const h of [10, 30, 60]) out['ret' + h] = ev.entry_idx + h < bars.length ? s * (bars[ev.entry_idx + h].close - entry) : null;
    let A = null; if (arm === 'RTH') { const L = lRth(d, tb.mod); if (L != null) A = ev.direction === 'UP' ? L : 1 - L; }
    rows.push({ date: d, arm, dir: ev.direction, X, bucket, withDay, A, ...out });
  }
}
console.log(`declustered events used: ${rows.length} (dropped by declustering: ${droppedDecluster}); RTH ${rows.filter(r => r.arm === 'RTH').length}, Globex ${rows.filter(r => r.arm === 'GLOBEX').length}`);

const days = (l) => new Set(l.map(r => r.date)).size;
function table(title, list) {
  console.log(`\n${title}\nbucket      n  days   ret10   ret30   ret60   (join-direction-signed change, points)`);
  for (const b of ['BALANCE', 'MID', 'EXPANSION']) { const l = list.filter(r => r.bucket === b); const v = (k) => mean(l.filter(r => r[k] != null).map(r => r[k]));
    console.log(`${b.padEnd(10)}${String(l.length).padStart(4)}${String(days(l)).padStart(6)}${f(v('ret10')).padStart(8)}${f(v('ret30')).padStart(8)}${f(v('ret60')).padStart(8)}`); }
}
function delta(list, label, key = 'ret30') {
  const ex = list.filter(r => r.bucket === 'EXPANSION' && r[key] != null), ba = list.filter(r => r.bucket === 'BALANCE' && r[key] != null);
  const dx = days(ex), db = days(ba);
  const ev = [...ex.map(r => ({ date: r.date, pnl: r[key], group: 'EXP' })), ...ba.map(r => ({ date: r.date, pnl: r[key], group: 'BAL' }))];
  let ci = ev.length > 4 ? dayBlockedBootstrapDeltaCI(ev, `B2|${label}|${key}`, { groupA: 'EXP', groupB: 'BAL' }) : null;
  if (ci && ci.lo != null) ci = { lo: -ci.hi, hi: -ci.lo }; // helper returns BAL - EXP; flip to EXP - BAL
  const d = mean(ex.map(r => r[key])) - mean(ba.map(r => r[key]));
  // within-day paired delta: only days that have BOTH arms, so day drift cancels
  const perDay = []; for (const dd of new Set(ex.map(r => r.date))) { const a = ex.filter(r => r.date === dd), b = ba.filter(r => r.date === dd); if (a.length && b.length) perDay.push({ date: dd, pnl: mean(a.map(r => r[key])) - mean(b.map(r => r[key])) }); }
  const pci = perDay.length > 4 ? dayBlockedBootstrapCI(perDay, `B2paired|${label}|${key}`) : null;
  console.log(`${label.padEnd(40)} ${key}: EXP n=${ex.length}/${dx}d BAL n=${ba.length}/${db}d delta(EXP-BAL)=${f(d, 2)} CI=${ci ? `[${f(ci.lo, 2)}, ${f(ci.hi, 2)}]` : 'n/a'}  within-day paired: n=${perDay.length}d mean=${f(mean(perDay.map(x => x.pnl)), 2)} CI=${pci ? `[${f(pci.lo, 1)}, ${f(pci.hi, 1)}]` : 'n/a'} ${dx >= 20 && db >= 20 ? '' : '<20 days'}`);
  return { d, ci, dx, db };
}
const out = {};
for (const arm of ['RTH', 'GLOBEX']) {
  const list = rows.filter(r => r.arm === arm);
  table(`--- ${arm} entries ---`, list);
  console.log(`\n=== PRE-REGISTERED B2 (${arm}): EXPANSION minus BALANCE, join-signed forward change. Pre-registered sign: NEGATIVE ===`);
  out[arm] = delta(list, `B2 ${arm}`);
  for (const k of ['ret10', 'ret60']) delta(list, `B2 ${arm}`, k);
  delta(list.filter(r => r.withDay), `B2 ${arm} control: join WITH day-so-far`);
  delta(list.filter(r => !r.withDay), `B2 ${arm} control: join AGAINST day-so-far`);
  for (const dir of ['UP', 'DOWN']) delta(list.filter(r => r.dir === dir), `B2 ${arm} descriptive: ${dir}-leg joins`);
  const wt = {}; for (const r of list.filter(r => r.bucket !== 'MID' && r.ret30 != null)) wt[r.date] = (wt[r.date] || 0) + Math.abs(r.ret30);
  const drop = new Set(Object.entries(wt).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]));
  delta(list.filter(r => !drop.has(r.date)), `B2 ${arm} excluding 5 heaviest days`);
}
// A3's volume-profile acceptance feature inside each expansion stratum (RTH only)
console.log('\n=== Is the A3 acceptance effect (L-based HIGH-LOW) absorbed by expansion?  (RTH, ret30) ===');
for (const b of ['BALANCE', 'EXPANSION']) {
  const l = rows.filter(r => r.arm === 'RTH' && r.bucket === b && r.A != null && r.ret30 != null);
  if (l.length < 12) { console.log(`  ${b}: too few events (${l.length})`); continue; }
  const sorted = [...l].sort((x, y) => x.A - y.A), cut = Math.floor(sorted.length / 3);
  const lo = sorted.slice(0, cut), hi = sorted.slice(-cut);
  console.log(`  inside ${b}: n=${l.length}  A HIGH-third ret30=${f(mean(hi.map(r => r.ret30)))} vs A LOW-third ret30=${f(mean(lo.map(r => r.ret30)))}  (diff ${f(mean(hi.map(r => r.ret30)) - mean(lo.map(r => r.ret30)))}; within-stratum thirds by A, descriptive)`);
}
const r = out.RTH;
console.log(`\nB2 RTH verdict: delta=${f(r.d, 2)} CI=${r.ci ? `[${f(r.ci.lo, 2)}, ${f(r.ci.hi, 2)}]` : 'n/a'} -> ${r.ci && r.ci.hi < 0 && r.dx >= 20 && r.db >= 20 ? 'NEGATIVE AS PRE-REGISTERED, CI EXCLUDES ZERO (check controls)' : r.ci && r.ci.lo > 0 ? 'POSITIVE (opposite sign) -- check controls' : 'CI INCLUDES ZERO / <20 days -> no support for "joins fail in expansion"; stop per kill rule'}`);
process.exit(0);
