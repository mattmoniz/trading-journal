import assert from 'assert';
import { passRace } from './learning_monitor_build.mjs';
// hand-traced: floor starts at -2000 and trails the EOD high-water mark.
let r = passRace([{ date: 'a', pnl: 500 }, { date: 'b', pnl: -600 }, { date: 'c', pnl: -1000 }]);        // eq 500 (peak 500 floor -1500), -100, -1100 (floor -1500 so alive)
assert.equal(r.attempts.length, 0); assert.equal(r.open.equity, -1100); assert.equal(r.open.floor, -1500);
r = passRace([{ date: 'a', pnl: 500 }, { date: 'b', pnl: -2100 }]);                                         // eq 500, then -1600 <= floor -1500: BUST, next attempt starts at 0
assert.deepEqual(r.attempts.map((a) => a.result), ['BUST']); assert.equal(r.open.equity, 0); assert.equal(r.open.episode, 2);
r = passRace([{ date: 'a', pnl: 1800 }, { date: 'b', pnl: 1300 }, { date: 'c', pnl: -50 }]);               // 1800, 3100 >= 3000: PASS; then a fresh episode with -50
assert.deepEqual(r.attempts.map((a) => a.result), ['PASS']); assert.equal(r.attempts[0].days, 2); assert.equal(r.open.equity, -50); assert.equal(r.open.floor, -2000);
r = passRace([{ date: 'a', pnl: -2000 }]); assert.deepEqual(r.attempts.map((a) => a.result), ['BUST']);    // exactly the floor from the start busts
console.log('passRace tests pass');
// bot summary: join decisions to resolved rows, newest decision per id wins, calibration only with >= 20 probabilities
import { botSummary } from './learning_monitor_build.mjs';
const base = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, date: `2026-11-${String(2 + (i % 4)).padStart(2, '0')}`, pnl: i % 2 ? 10 : -10 }));
const dec = base.map((r, i) => ({ setupId: r.id, version: 'v1', decision: i < 20 ? 'TAKE' : 'SKIP', p: i % 2 ? 0.7 : 0.3, frozenAt: '2026-11-03' }));
dec.push({ setupId: 1, version: 'v1', decision: 'SKIP', p: 0.3, frozenAt: '2026-11-03' });                     // later row for id 1 flips TAKE to SKIP
const s = botSummary(dec, base, 1);
assert.equal(s.take.n, 19); assert.equal(s.skip.n, 21); assert.equal(s.decisions, 40);
assert.ok(Math.abs(s.take.perTrade - base.filter((r) => r.id >= 2 && r.id <= 20).reduce((a, r) => a + r.pnl, 0) / 19) < 1e-9);
assert.ok(Math.abs(s.take.perTradeHaircut - (s.take.perTrade - 1)) < 1e-9); assert.ok(s.calibration.length >= 2); assert.equal(botSummary([], base), null);
assert.equal(botSummary(dec.slice(0, 5), base, 1).calibration.length, 0);
console.log('botSummary tests pass');
