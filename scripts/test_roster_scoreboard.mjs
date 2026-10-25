// Tests for server/services/rosterScoreboard.js (no DB). Run: node scripts/test_roster_scoreboard.mjs
import assert from 'node:assert/strict';
import { buildRosterLookup, computeScoreboard, armStats, maxDrawdown, deriveFirstLookDays, lookStatus } from '../server/services/rosterScoreboard.js';

const H = 3600000, D = 24 * H, T0 = Date.UTC(2026, 9, 26, 14, 0, 0);
let id = 0;
const row = (o) => ({ id: ++id, date: o.date, firedMs: o.t, resolvedMs: o.t + 30 * 60000, setupType: o.type, origin: o.origin || 'ACTIVE', pnl: o.pnl, isRth: o.isRth !== false, clusterId: null, isPrimary: o.isPrimary !== false });
const day = (n) => new Date(T0 + n * D).toISOString().slice(0, 10);

// roster history: A on the roster from day 0; B joins on day 1 midday; A dropped on day 2 midday
const hist = [{ createdMs: T0 - H, types: ['A'] }, { createdMs: T0 + D + 12 * H, types: ['A', 'B'] }, { createdMs: T0 + 2 * D + 12 * H, types: ['B'] }];
const lk = buildRosterLookup(hist);
assert.deepEqual([...lk.typesAt(T0)], ['A']);
assert.deepEqual([...lk.typesAt(T0 + D + 13 * H)].sort(), ['A', 'B']);
assert.deepEqual([...lk.typesAt(T0 + 3 * D)], ['B']);
assert.equal(lk.typesAt(T0 - 2 * H).size, 0, 'before the first roster row nothing is on the roster');
assert.equal(lk.membershipStartAt('B', T0 + 3 * D), T0 + D + 12 * H);
assert.equal(lk.membershipStartAt('A', T0 + 3 * D), null);

// day-correct roster join: A on the roster day 0 and day 1, NOT after the day-2 midday drop
const rows = [
  row({ date: day(0), t: T0 + H, type: 'A', pnl: 100 }),            // A on roster
  row({ date: day(0), t: T0 + 2 * H, type: 'X', pnl: -50 }),        // not on roster
  row({ date: day(1), t: T0 + D + 2 * H, type: 'B', pnl: 40 }),     // B not yet on roster (joins midday)
  row({ date: day(1), t: T0 + D + 13 * H, type: 'B', pnl: 60 }),    // B on roster
  row({ date: day(2), t: T0 + 2 * D + 2 * H, type: 'A', pnl: 30 }), // A still on roster before midday drop
  row({ date: day(2), t: T0 + 2 * D + 13 * H, type: 'A', pnl: -70 }), // A dropped -> not on roster
  row({ date: day(2), t: T0 + 2 * D + 14 * H, type: 'X', pnl: 10, origin: 'SHADOW' }),
  row({ date: day(2), t: T0 + 2 * D + 15 * H, type: 'POC_ROTATION_JOIN_LONG', pnl: 999 }), // separate
  row({ date: day(2), t: T0 + 2 * D + 16 * H, type: 'A', pnl: 500, isPrimary: false }),    // cluster sibling: excluded
];
const sb = computeScoreboard(rows, hist, { iters: 200 });
const A = sb.arms.ALL;
assert.equal(A.TAKE_ALL.n, 7, 'POC join and the sibling are not in the headline');
assert.equal(A.TAKE_ALL.sum, 100 - 50 + 40 + 60 + 30 - 70 + 10);
assert.equal(A.ROSTER_WOULD_BE.n, 3, 'A day0, B day1 late, A day2 early');
assert.equal(A.ROSTER_WOULD_BE.sum, 100 + 60 + 30);
assert.equal(A.TAKE_ALL_EX_ROSTER.sum, -50 + 40 - 70 + 10);
assert.equal(A.ROSTER_LIVE.n, 6, 'ACTIVE-origin rows only');
assert.equal(sb.separate.POC_ROTATION_JOIN.sum, 999);
assert.equal(A.TAKE_ALL.winRate, null, 'win rate withheld below N=20');
assert.equal(sb.window.days, 3);
assert.equal(sb.comparison.dailyDiff.series.length, 3);
// day 0: roster 100 - all 50 = 50; day 1: 60 - 100 = -40; day 2: 30 - (30-70+10) = 60
assert.deepEqual(sb.comparison.dailyDiff.series.map((x) => x.pnl), [50, -40, 60]);
assert.equal(sb.comparison.verdict, 'NOT_SHOWN_YET', 'needs 4+ days before any verdict');
assert.deepEqual(sb.churn.map((c) => [c.added, c.dropped]), [[['A'], []], [['B'], []], [[], ['A']]]);

// promotion lag: B's trade at +1h after joining is "first five days"; a trade 6 days in is "after"
const lagRows = [row({ date: day(1), t: T0 + D + 13 * H, type: 'B', pnl: 10 }), row({ date: day(7), t: T0 + 7 * D, type: 'B', pnl: 20 })];
const lag = computeScoreboard(lagRows, [{ createdMs: T0 + D + 12 * H, types: ['B'] }], { iters: 50 }).promotionLag;
assert.equal(lag.firstFiveDays.n, 1); assert.equal(lag.after.n, 1);

// drawdown on resolve-time order
assert.equal(maxDrawdown([{ pnl: 10, resolvedMs: 1, firedMs: 1 }, { pnl: -30, resolvedMs: 2, firedMs: 2 }, { pnl: 5, resolvedMs: 3, firedMs: 3 }, { pnl: -10, resolvedMs: 4, firedMs: 4 }]), 35);
assert.equal(armStats([]).n, 0);

// verdict PASS and FAIL on synthetic multi-day series (roster steadily better / worse than take-all)
function series(rosterPnl, otherPnl, nDays) {
  const r = [], h = [{ createdMs: T0 - H, types: ['A'] }];
  for (let i = 0; i < nDays; i++) { r.push(row({ date: day(i), t: T0 + i * D + H, type: 'A', pnl: rosterPnl + (i % 2) })); r.push(row({ date: day(i), t: T0 + i * D + 2 * H, type: 'X', pnl: otherPnl - (i % 3) })); }
  return computeScoreboard(r, h, { iters: 400 }).comparison;
}
// roster-only minus take-all = -(other) per day: other negative -> roster better
assert.equal(series(10, -30, 12).verdict, 'PASS');
assert.equal(series(10, 30, 12).verdict, 'FAIL');

// first look derivation and schedule
const dd = deriveFirstLookDays([100, -200, 300, -100, 50, 0], [400, -300, 500, 100, -200, 300]);
assert.ok(dd.days >= 2 && Number.isInteger(dd.days));
assert.deepEqual(lookStatus(5, 14), { due: false, nextAt: 14, lookNumber: 0 });
assert.equal(lookStatus(14, 14).lookNumber, 1);
assert.equal(lookStatus(23, 14).lookNumber, 1);
assert.equal(lookStatus(24, 14).lookNumber, 2);
assert.equal(lookStatus(24, 14).nextAt, 34);
assert.equal(lookStatus(3, null).due, false);

console.log('roster scoreboard tests: all passed');
