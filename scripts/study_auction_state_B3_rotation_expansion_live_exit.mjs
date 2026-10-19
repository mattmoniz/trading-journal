// Stage B3 of the auction-state study: B2's expansion-vs-balance contrast, but scored with the REAL live exit
// instead of an exit-agnostic 30-bar price change. RESEARCH ONLY (no live code touched).
//   Feature (as-of, no lookahead): X = range so far (session high - low from the anchor to the trigger bar), anchor =
//   09:30 for RTH-entry events, 18:00 for Globex-entry events; rank vs the SAME minute of the previous 20 sessions;
//   EXPANSION >= 2/3, BALANCE <= 1/3. Identical to B2 (scripts/study_auction_state_B2_rotation_expansion.mjs).
//   Outcome: the exact POC_ROTATION_JOIN live exit, using the REAL exported stepPocBreakevenHold() from
//   server/services/pocBreakevenHoldWalker.js: 100pt stop, snaps to breakeven after 60 bars, held until the NEXT raw
//   rotation event (either direction) or a 24h cap, then marked to market at the last bar (resolveSetups.js ~383-430).
//   $/trade = points * $2 - $2 commission (server/config/instruments.js).
//   Pre-registered: primary = EXPANSION minus BALANCE realized $/trade, NEGATIVE sign expected, RTH and Globex
//   separately, declustered events (one per leg, none inside the 30-bar window of a kept join). Point estimates are the
//   real per-trade mean sum(pnl)/N (CLAUDE.md day-weighting rule); day-blocking is used only for the CI of the delta
//   (resample days, pool trades of the resampled days per arm). Controls: day-block label permutation, top-5-day drop,
//   chronological halves, within-day paired, and an all-raw-events sensitivity. Fit window ends 2026-10-10; events
//   whose exit boundary falls after the loaded data are dropped (right-censored), not marked.
import { detectSignalEvents } from '../server/services/pocRotationService.js';
import { stepPocBreakevenHold } from '../server/services/pocBreakevenHoldWalker.js';
import { STOP_POINTS, ARM_AT_MINUTES } from '../server/services/pocRotationJoinDetector.js';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { query } from '../server/db.js';

const FROM = '2026-04-01 18:00:00', FIT_END = '2026-10-10';
const REF_DAYS = 20, MIN_REF = 10, HOLD = 30, CAP_MS = 24 * 3600 * 1000, GAP_MS = 2 * 3600 * 1000;
const PPP = LIVE_INSTRUMENT.dollarsPerPoint, COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const tms = (ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16));
console.log(`live exit constants: stop=${STOP_POINTS}pt, arm=${ARM_AT_MINUTES}bars, $/pt=${PPP}, commission=$${COMM}`);

const theta = Math.max(0.25, +(await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) m FROM price_bars_primary WHERE symbol='NQ'`)).rows[0].m);
const raw = (await query(`SELECT ts::text ts, open::float open, high::float high, low::float low, close::float close, volume::float volume
  FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < ($2::date + 1)::timestamp ORDER BY ts`, [FROM, FIT_END])).rows;
const loadedEndMs = raw.length ? tms(raw[raw.length - 1].ts) : 0;
const sessions = new Map();
for (const b of raw) {
  const hr = +b.ts.slice(11, 13), min = +b.ts.slice(14, 16), mod = hr * 60 + min;
  if (mod >= 1020 && mod < 1080) continue;
  const d = new Date(Date.UTC(+b.ts.slice(0, 4), +b.ts.slice(5, 7) - 1, +b.ts.slice(8, 10) + (hr >= 18 ? 1 : 0))).toISOString().slice(0, 10);
  if (!sessions.has(d)) sessions.set(d, []);
  sessions.get(d).push({ ...b, mod, date: b.ts.slice(0, 10), ms: tms(b.ts) });
}
const dates = [...sessions.keys()].sort().filter(d => d <= FIT_END && !isInsideNqRollWeek(d) && sessions.get(d).length > 600);
const sessionList = dates.map(d => ({ t: d, bars: sessions.get(d) }));
const { all_signal } = detectSignalEvents(65, 'standard', theta, sessionList, 'fixed');
// one flat, time-ordered bar array so a position can be walked across the session boundary (24h cap)
const flat = [], offset = new Map();
for (const d of dates) { offset.set(d, flat.length); for (const b of sessions.get(d)) flat.push(b); }
const rawEvents = all_signal.filter(e => e.entry_idx != null).map(e => ({ ...e, g: offset.get(e.t) + e.entry_idx }))
  .sort((a, b) => a.g - b.g);
console.log(`theta=${theta}; sessions=${dates.length}; raw events=${rawEvents.length}`);

function liveExit(ev, nextG) { // returns { pnl, kind, holdBars } or null if censored
  const eb = flat[ev.g], long = ev.direction === 'UP', entry = eb.open;
  const nextMs = nextG != null ? flat[nextG].ms : Infinity, boundMs = Math.min(nextMs, eb.ms + CAP_MS);
  if (boundMs > loadedEndMs) return null; // right-censored
  let st = { barsElapsed: 0, armed: false }, last = null, k = 0;
  for (let i = ev.g + 1; i < flat.length && flat[i].ms <= boundMs; i++) {
    if (last && flat[i].ms - last.ms > GAP_MS && flat[i].ms - last.ms < 40 * 3600 * 1000) break; // unloaded gap (excluded session): stop, MTM at last loaded bar
    const b = flat[i]; k++;
    const step = stepPocBreakevenHold(st, b, { entry, long, stop: STOP_POINTS, armAtBars: ARM_AT_MINUTES });
    st = step.state; last = b;
    if (step.resolution) { const px = step.resolution.priceAtRes; return { pnl: (long ? px - entry : entry - px) * PPP - COMM, kind: st.armed ? 'BE_STOP' : 'WIDE_STOP', holdBars: k }; }
  }
  if (!last) return null;
  return { pnl: (long ? last.close - entry : entry - last.close) * PPP - COMM, kind: 'TIMEOUT', holdBars: k };
}

const rthAnchor = (bars, d) => bars.findIndex(b => b.mod >= 570 && b.date === d);
function rangeAt(d, arm, mod, evening) {
  const bars = sessions.get(d); if (!bars) return null;
  const a = arm === 'RTH' ? rthAnchor(bars, d) : 0; if (a < 0) return null;
  let idx = -1;
  for (let i = a; i < bars.length; i++) if (bars[i].mod === mod && (arm === 'RTH' || (bars[i].mod >= 1080) === evening)) { idx = i; break; }
  if (idx < 0) return null;
  let hi = -Infinity, lo = Infinity; for (let i = a; i <= idx; i++) { if (bars[i].high > hi) hi = bars[i].high; if (bars[i].low < lo) lo = bars[i].low; }
  return hi - lo;
}
function classify(ev) { // -> {arm, X, bucket} or null (as-of, B2-identical)
  const d = ev.t, bars = sessions.get(d), eb = bars[ev.entry_idx], tb = bars[ev.trigger_idx];
  const isRth = eb.mod >= 570 && eb.mod < 960 && eb.date === d, isGlobex = !isRth && (eb.mod >= 1080 || eb.mod < 570);
  if (!isRth && !isGlobex) return null;
  const arm = isRth ? 'RTH' : 'GLOBEX', evening = tb.mod >= 1080;
  const X = rangeAt(d, arm, tb.mod, evening); if (X == null) return null;
  const di = dates.indexOf(d), ref = [];
  for (const pd of dates.slice(Math.max(0, di - REF_DAYS), di)) { const r = rangeAt(pd, arm, tb.mod, evening); if (r != null) ref.push(r); }
  if (ref.length < MIN_REF) return null;
  const rank = ref.filter(x => x < X).length / ref.length;
  return { arm, X, bucket: rank >= 2 / 3 ? 'EXPANSION' : rank <= 1 / 3 ? 'BALANCE' : 'MID' };
}

// declustering identical to B2 (per session: one event per leg_start; none inside HOLD bars of the last kept entry)
const keptG = new Set(); const bySess = new Map();
for (const e of rawEvents) { if (!bySess.has(e.t)) bySess.set(e.t, []); bySess.get(e.t).push(e); }
for (const [, evs] of bySess) { evs.sort((a, b) => a.trigger_idx - b.trigger_idx); const seen = new Set(); let lastKept = -1e9;
  for (const ev of evs) { if (seen.has(ev.leg_start) || ev.entry_idx < lastKept + HOLD) continue; seen.add(ev.leg_start); lastKept = ev.entry_idx; keptG.add(ev.g + ':' + ev.direction); } }

const rows = []; let censored = 0;
for (let i = 0; i < rawEvents.length; i++) {
  const ev = rawEvents[i], c = classify(ev); if (!c) continue;
  let j = i + 1; while (j < rawEvents.length && rawEvents[j].g <= ev.g) j++;
  const ex = liveExit(ev, j < rawEvents.length ? rawEvents[j].g : null);
  if (!ex) { censored++; continue; }
  rows.push({ date: ev.t, arm: c.arm, bucket: c.bucket, declustered: keptG.has(ev.g + ':' + ev.direction), dir: ev.direction, ...ex });
}
console.log(`scored events: ${rows.length} (right-censored dropped: ${censored}); declustered: ${rows.filter(r => r.declustered).length}`);

const days = (l) => new Set(l.map(r => r.date)).size;
function bootDelta(a, b, tag, N = 3000) { // CI of mean(a)-mean(b) with pooled trades from resampled days per arm
  const byA = new Map(), byB = new Map();
  for (const r of a) { if (!byA.has(r.date)) byA.set(r.date, []); byA.get(r.date).push(r.pnl); }
  for (const r of b) { if (!byB.has(r.date)) byB.set(r.date, []); byB.get(r.date).push(r.pnl); }
  const ds = [...new Set([...byA.keys(), ...byB.keys()])]; if (ds.length < 8 || !a.length || !b.length) return null;
  const rand = mulberry32(hashSeed('B3|' + tag)), out = [];
  for (let k = 0; k < N; k++) { let sa = 0, na = 0, sb = 0, nb = 0;
    for (let q = 0; q < ds.length; q++) { const d = ds[Math.floor(rand() * ds.length)]; for (const x of byA.get(d) || []) { sa += x; na++; } for (const x of byB.get(d) || []) { sb += x; nb++; } }
    if (na && nb) out.push(sa / na - sb / nb); }
  out.sort((x, y) => x - y); return { lo: out[Math.floor(out.length * 0.025)], hi: out[Math.floor(out.length * 0.975)] };
}
function permP(list, tag, N = 3000) { // day-block label permutation: shuffle which DAYS carry EXPANSION-vs-BALANCE labels
  const ex = list.filter(r => r.bucket === 'EXPANSION'), ba = list.filter(r => r.bucket === 'BALANCE'); if (!ex.length || !ba.length) return NaN;
  const obs = mean(ex.map(r => r.pnl)) - mean(ba.map(r => r.pnl)), pool = [...ex, ...ba], ds = [...new Set(pool.map(r => r.date))];
  const rand = mulberry32(hashSeed('B3perm|' + tag)); let ge = 0;
  for (let k = 0; k < N; k++) { const lab = new Map(); for (const d of ds) lab.set(d, rand() < 0.5);
    const A = pool.filter(r => lab.get(r.date)).map(r => r.pnl), B = pool.filter(r => !lab.get(r.date)).map(r => r.pnl);
    if (A.length && B.length && Math.abs(mean(A) - mean(B)) >= Math.abs(obs)) ge++; }
  return ge / N;
}
function table(title, list) {
  console.log(`\n${title}\nbucket      n  days  $/trade  median    WR%  wideStop%  beStop%  timeout%  avgHoldMin`);
  for (const b of ['BALANCE', 'MID', 'EXPANSION']) { const l = list.filter(r => r.bucket === b); const p = (k) => 100 * l.filter(r => r.kind === k).length / (l.length || 1);
    console.log(`${b.padEnd(10)}${String(l.length).padStart(4)}${String(days(l)).padStart(6)}${f(mean(l.map(r => r.pnl)), 2).padStart(9)}${f(median(l.map(r => r.pnl)), 1).padStart(8)}${f(100 * l.filter(r => r.pnl > 0).length / (l.length || 1), 0).padStart(7)}${f(p('WIDE_STOP'), 0).padStart(10)}${f(p('BE_STOP'), 0).padStart(9)}${f(p('TIMEOUT'), 0).padStart(10)}${f(mean(l.map(r => r.holdBars)), 0).padStart(11)}`); }
}
function delta(list, label) {
  const ex = list.filter(r => r.bucket === 'EXPANSION'), ba = list.filter(r => r.bucket === 'BALANCE');
  const d = mean(ex.map(r => r.pnl)) - mean(ba.map(r => r.pnl)), ci = bootDelta(ex, ba, label);
  const pd = []; for (const dd of new Set(ex.map(r => r.date))) { const a = ex.filter(r => r.date === dd), b = ba.filter(r => r.date === dd); if (a.length && b.length) pd.push(mean(a.map(r => r.pnl)) - mean(b.map(r => r.pnl))); }
  console.log(`${label.padEnd(42)} EXP n=${ex.length}/${days(ex)}d BAL n=${ba.length}/${days(ba)}d  delta(EXP-BAL)=$${f(d, 2)}  CI=${ci ? `[${f(ci.lo, 1)}, ${f(ci.hi, 1)}]` : 'n/a'}  within-day paired n=${pd.length}d mean=$${f(mean(pd), 1)}${days(ex) >= 20 && days(ba) >= 20 ? '' : '  <20 days'}`);
  return { d, ci, dx: days(ex), db: days(ba) };
}
const verdict = {};
for (const arm of ['RTH', 'GLOBEX']) {
  const all = rows.filter(r => r.arm === arm), L = all.filter(r => r.declustered);
  table(`--- ${arm}, declustered, REAL LIVE EXIT ---`, L);
  console.log(`\n=== PRE-REGISTERED B3 (${arm}): EXPANSION minus BALANCE, realized $/trade, pre-registered sign NEGATIVE ===`);
  verdict[arm] = delta(L, `B3 ${arm} (declustered)`);
  console.log(`  day-block label permutation p = ${f(permP(L, arm), 3)}`);
  const wt = {}; for (const r of L.filter(r => r.bucket !== 'MID')) wt[r.date] = (wt[r.date] || 0) + Math.abs(r.pnl);
  const drop = new Set(Object.entries(wt).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]));
  delta(L.filter(r => !drop.has(r.date)), `B3 ${arm} excluding 5 heaviest days`);
  const ds = [...new Set(L.map(r => r.date))].sort(), half = ds[Math.floor(ds.length / 2)];
  delta(L.filter(r => r.date < half), `B3 ${arm} first chronological half`); delta(L.filter(r => r.date >= half), `B3 ${arm} second chronological half`);
  for (const dir of ['UP', 'DOWN']) delta(L.filter(r => r.dir === dir), `B3 ${arm} descriptive: ${dir}-leg joins`);
  delta(all, `B3 ${arm} sensitivity: ALL raw events`);
}
for (const arm of ['RTH', 'GLOBEX']) { const v = verdict[arm];
  console.log(`\nB3 ${arm} verdict: delta=$${f(v.d, 2)} CI=${v.ci ? `[${f(v.ci.lo, 1)}, ${f(v.ci.hi, 1)}]` : 'n/a'} -> ${v.ci && v.ci.hi < 0 && v.dx >= 20 && v.db >= 20 ? 'NEGATIVE AS PRE-REGISTERED, CI EXCLUDES ZERO (check controls)' : v.ci && v.ci.lo > 0 ? 'POSITIVE (opposite sign) -- check controls' : 'CI INCLUDES ZERO / <20 days -> kill rule: no support'}`); }
process.exit(0);
