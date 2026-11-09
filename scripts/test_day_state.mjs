// Unit tests for server/services/dayState.js (pure functions, synthetic bars, seeded). The load-bearing check is NO LOOKAHEAD: the state at bar k must be identical whether the session
// has been evaluated up to bar k only (live) or to its end (replay). Also: crash -> liquidation, mirrored melt-up -> melt-up (never liquidation), warm-up, session mapping.
import assert from 'node:assert/strict';
import { PARAMS, assignSession, buildSessions, evaluateSession, firstActive, isLiquidationState, isMeltUpState } from '../server/services/dayState.js';

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hhmm = (mod) => `${String(Math.floor(mod / 60)).padStart(2, '0')}:${String(mod % 60).padStart(2, '0')}`;
const day = (i) => new Date(Date.UTC(2025, 0, 6 + i)).toISOString().slice(0, 10);
// one synthetic RTH session of 390 one-minute bars; drift(m) adds a deterministic per-bar move
function rthSession(i, seed, drift = () => 0, start = 20000) {
  const r = rng(seed), bars = []; let p = start;
  for (let m = 0; m < 390; m++) { p += (r() - 0.5) * 8 + drift(m); const o = p; bars.push({ t: `${day(i)} ${hhmm(570 + m)}`, mod: 570 + m, high: o + 2 * r(), low: o - 2 * r(), close: o }); }
  return bars;
}
const HIST = 140;
function history(seedBase = 1) { const bars = []; for (let i = 0; i < HIST; i++) bars.push(...rthSession(i, seedBase + i)); return bars; }
function evalLast(histBars, liveBars, opts) {
  const sessions = buildSessions([...histBars, ...liveBars]).filter((s) => s.kind === 'RTH');
  const live = sessions[sessions.length - 1], prior = sessions.slice(0, -1);
  for (let i = 0; i < prior.length; i++) evaluateSession(prior[i], prior.slice(0, i));
  return evaluateSession(live, prior, opts);
}

ok('session mapping: RTH open, last RTH bar, dead hours, Globex evening (next CME date) and morning', () => {
  assert.deepEqual(assignSession('2026-11-09 09:30', 570), { kind: 'RTH', key: '2026-11-09', m: 0 });
  assert.deepEqual(assignSession('2026-11-09 15:59', 959), { kind: 'RTH', key: '2026-11-09', m: 389 });
  assert.equal(assignSession('2026-11-09 16:00', 960), null);
  assert.equal(assignSession('2026-11-09 17:59', 1079), null);
  assert.deepEqual(assignSession('2026-11-08 18:00', 1080), { kind: 'GLOBEX', key: '2026-11-09', m: 0 });   // Sunday evening belongs to Monday's CME session
  assert.deepEqual(assignSession('2026-11-09 02:00', 120), { kind: 'GLOBEX', key: '2026-11-09', m: 480 });
  assert.deepEqual(assignSession('2026-11-09 09:29', 569), { kind: 'GLOBEX', key: '2026-11-09', m: 929 });
});
const H = history();
const calm = rthSession(HIST, 9001);
const atrApprox = (() => { const s = buildSessions(H).filter((x) => x.kind === 'RTH').slice(-20); return s.reduce((a, x) => a + Math.max(...x.bars.map((b) => b.high)) - Math.min(...x.bars.map((b) => b.low)), 0) / 20; })();
const crash = rthSession(HIST, 9001, (m) => (m < 40 ? -(2.5 * atrApprox) / 40 : 0));
const meltUp = rthSession(HIST, 9001, (m) => (m < 40 ? (2.5 * atrApprox) / 40 : 0));

ok('warm-up: with fewer than ATR_N prior sessions every bar is WARMUP', () => {
  const few = []; for (let i = 0; i < 10; i++) few.push(...rthSession(i, 100 + i));
  const r = evalLast(few, rthSession(10, 555));
  assert.ok(r.states.every((s) => s === 'WARMUP'));
});
ok('a calm session is not a liquidation or a melt-up at the opening bars', () => {
  const r = evalLast(H, calm); assert.ok(r.cut && r.atr > 0);
  assert.ok(r.states.slice(0, 40).every((s) => s === 'NORMAL' || s === 'WARMUP'), r.states.slice(0, 40).join(','));
});
ok('a steep early crash (2.5 x the typical daily range in 40 minutes) becomes a liquidation, never a melt-up', () => {
  const r = evalLast(H, crash), f = firstActive(r);
  assert.ok(f && isLiquidationState(f.state), JSON.stringify(f));
  assert.ok(!r.states.some((s) => isMeltUpState(s)));
});
ok('the mirrored steep rally becomes a melt-up, never a liquidation (symmetry)', () => {
  const r = evalLast(H, meltUp), f = firstActive(r);
  assert.ok(f && isMeltUpState(f.state), JSON.stringify(f));
  assert.ok(!r.states.some((s) => isLiquidationState(s)));
});
ok('NO LOOKAHEAD: the state at every bar is identical when the session is cut at that bar (live) or run to the end (replay)', () => {
  for (const full of [crash, meltUp, calm]) {
    const ref = evalLast(H, full).states;
    for (const cutAt of [20, 45, 64, 65, 120, 250, 389]) {
      const part = evalLast(H, full.slice(0, cutAt)).states;
      assert.deepEqual(part, ref.slice(0, cutAt), `prefix of ${cutAt} bars differs from the full run`);
    }
  }
});
ok('the history is not read past the current session: a later session never changes an earlier result', () => {
  const sessions = buildSessions([...H, ...crash, ...rthSession(HIST + 1, 777)]).filter((s) => s.kind === 'RTH');
  const a = sessions.slice(0, -1), withLater = sessions;
  for (let i = 0; i < withLater.length; i++) evaluateSession(withLater[i], withLater.slice(0, i));
  const full = withLater[withLater.length - 2];
  const again = buildSessions([...H, ...crash]).filter((s) => s.kind === 'RTH');
  for (let i = 0; i < again.length - 1; i++) evaluateSession(again[i], again.slice(0, i));
  const r2 = evaluateSession(again[again.length - 1], again.slice(0, -1));
  assert.deepEqual(r2.states, evaluateSession(full, withLater.slice(0, withLater.length - 2)).states);
  assert.equal(a.length, again.length);
});
ok('design parameters are what the replay used', () => { assert.equal(PARAMS.Q, 0.97); assert.equal(PARAMS.CUT_N, 120); assert.equal(PARAMS.CONFIRM_FROM_M, 64); });

// ---- tests added after Argon's code review (2026-11-09): regression cases for the first-hour tautology, the V-reversal, the missing minute-64 bar, flapping and the history count
import * as DS from '../server/services/dayState.js';
const day2 = (i) => new Date(Date.UTC(2025, 0, 6 + i)).toISOString().slice(0, 10);
function rthSession2(i, seed, drift = () => 0, start = 20000, drop = []) {
  const r = rng(seed), bars = []; let p = start;
  for (let m = 0; m < 390; m++) { p += (r() - 0.5) * 8 + drift(m); if (drop.includes(m)) continue; const o = p; bars.push({ t: `${day2(i)} ${hhmm(570 + m)}`, mod: 570 + m, high: o + 2 * r(), low: o - 2 * r(), close: o }); }
  return bars;
}
const H2 = (() => { const b = []; for (let i = 0; i < HIST; i++) b.push(...rthSession2(i, 1 + i)); return b; })();
const atr2 = (() => { const s = DS.buildSessions(H2).filter((x) => x.kind === 'RTH').slice(-20); return s.reduce((a, x) => a + Math.max(...x.bars.map((q) => q.high)) - Math.min(...x.bars.map((q) => q.low)), 0) / 20; })();
const sess = (drift, drop) => rthSession2(HIST, 9001, drift, 20000, drop);
function evalLast2(M, histBars, liveBars) {
  const sessions = M.buildSessions([...histBars, ...liveBars]).filter((s) => s.kind === 'RTH');
  const live = sessions[sessions.length - 1], prior = sessions.slice(0, -1);
  for (let i = 0; i < prior.length; i++) M.evaluateSession(prior[i], prior.slice(0, i));
  return M.evaluateSession(live, prior);
}
const stateAt = (r, m) => { const k = r.bars.findIndex((b) => b.m === m); return k < 0 ? null : r.states[k]; };
const isDown = (s) => s && s.startsWith('DOWN'), isUp = (s) => s && s.startsWith('UP');
// a crash that then bounces a little inside the first hour (the bounce lowers the drawdown z for a few bars)
const crashBounce = sess((m) => (m < 40 ? -(2.5 * atr2) / 40 : m < 50 ? (2.2 * atr2) / 10 : 0));
ok('REGRESSION #3: an early liquidation alarm survives a dip of its z-score during the first hour (the old rule cancelled it and blocked re-arming)', () => {
  const rNew = evalLast2(DS, H2, crashBounce);
  const firstNew = rNew.states.findIndex(isDown);
  assert.ok(firstNew >= 0, 'new module never flagged the crash');
  const mFirst = rNew.bars[firstNew].m;
  for (let m = mFirst; m < 60; m++) assert.notEqual(stateAt(rNew, m), 'NORMAL', `new module cancelled the alarm at minute ${m}`);
  const changes = rNew.states.slice(0, 60).filter((x, k, a) => k > 0 && x !== a[k - 1]).length;
  assert.ok(changes <= 3, `the state flapped ${changes} times in the first hour: ${rNew.states.slice(0, 60).join(',')}`);
});
ok('a false early alarm (spike down, full recovery before the balance completes) is cleared at the first bar at or after minute 64', () => {
  const falseAlarm = sess((m) => (m < 15 ? -(2.6 * atr2) / 15 : m < 55 ? (2.7 * atr2) / 40 : 0));
  const r = evalLast2(DS, H2, falseAlarm);
  assert.ok(r.states.some(isDown), 'the spike was not flagged, test setup invalid');
  assert.equal(stateAt(r, 64), 'NORMAL'); assert.equal(stateAt(r, 100), 'NORMAL');
});
ok('REGRESSION #5: the same false alarm is still cleared when the minute-64 bar is MISSING from the feed (the old exact-minute test never ran)', () => {
  const falseAlarm = sess((m) => (m < 15 ? -(2.6 * atr2) / 15 : m < 55 ? (2.7 * atr2) / 40 : 0), [64]);
  const r = evalLast2(DS, H2, falseAlarm);
  assert.equal(stateAt(r, 64), null); assert.equal(stateAt(r, 65), 'NORMAL');
});
ok('REGRESSION #4: a V-reversal goes from liquidation straight to melt-up with no NORMAL bar in between', () => {
  const v = sess((m) => (m < 40 ? -(2.5 * atr2) / 40 : m < 110 ? (4.5 * atr2) / 70 : 0));
  const r = evalLast2(DS, H2, v);
  const seq = r.states.filter((s) => s !== 'WARMUP');
  assert.ok(seq.some(isDown) && seq.some(isUp), `expected both sides, got ${[...new Set(seq)].join(',')}`);
  for (let k = 1; k < seq.length - 1; k++) if (seq[k] === 'NORMAL') assert.ok(!(isDown(seq[k - 1]) && isUp(seq[k + 1])), 'a one-bar NORMAL separates DOWN from UP');
});
ok('NO LOOKAHEAD (new module): the state at every bar is identical when the session is cut at that bar or run to the end, for every scenario above', () => {
  for (const full of [crashBounce, sess((m) => (m < 40 ? -(2.5 * atr2) / 40 : m < 110 ? (4.5 * atr2) / 70 : 0)), sess(() => 0), sess((m) => (m < 15 ? -(2.6 * atr2) / 15 : m < 55 ? (2.7 * atr2) / 40 : 0), [64])]) {
    const ref = evalLast2(DS, H2, full).states, bars = full.length;
    for (const cutAt of [20, 45, 59, 60, 64, 65, 120, 250, bars]) assert.deepEqual(evalLast2(DS, H2, full.slice(0, cutAt)).states, ref.slice(0, cutAt), `prefix ${cutAt} differs`);
  }
});
ok('a calm session is not flagged in the opening hour and the crash / melt-up symmetry still holds', () => {
  const calm = evalLast2(DS, H2, sess(() => 0));
  assert.ok(calm.states.slice(0, 60).every((s) => s === 'NORMAL'), calm.states.slice(0, 60).join(','));
  const crash = evalLast2(DS, H2, sess((m) => (m < 40 ? -(2.5 * atr2) / 40 : 0))), up = evalLast2(DS, H2, sess((m) => (m < 40 ? (2.5 * atr2) / 40 : 0)));
  assert.ok(crash.states.some(isDown) && !crash.states.some(isUp)); assert.ok(up.states.some(isUp) && !up.states.some(isDown));
});
ok('isValidSession is exported and agrees with the minimum-bar rule', () => {
  assert.equal(typeof DS.isValidSession, 'function');
  assert.equal(DS.isValidSession({ kind: 'RTH', bars: new Array(200).fill(0) }), true); assert.equal(DS.isValidSession({ kind: 'RTH', bars: new Array(199).fill(0) }), false);
});
console.log(`all ${n} day-state checks passed`);
