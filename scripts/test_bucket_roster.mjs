// Unit checks for server/services/bucketRoster.js (run before any outcome is read, docs/BUCKET_ROSTER_PREREG_20261108.md section 2). Usage: node scripts/test_bucket_roster.mjs
import { fitBucketModel, cellDecision, cellDayObservations, bucketOfMinute, minuteOfText, Z80 } from '../server/services/bucketRoster.js';
import assert from 'assert';
assert.equal(bucketOfMinute(minuteOfText('2026-11-04 09:34:59')), null); assert.equal(bucketOfMinute(minuteOfText('2026-11-04 09:35:00')), 'RTH_OPEN');
assert.equal(bucketOfMinute(minuteOfText('2026-11-04 15:59:59')), 'RTH_LATE'); assert.equal(bucketOfMinute(minuteOfText('2026-11-04 16:30:00')), null); assert.equal(bucketOfMinute(minuteOfText('2026-11-04 18:29:00')), null);
assert.equal(bucketOfMinute(minuteOfText('2026-11-04 18:30:00')), 'GLOBEX_EVE'); assert.equal(bucketOfMinute(minuteOfText('2026-11-05 00:00:00')), 'GLOBEX_NIGHT'); assert.equal(bucketOfMinute(minuteOfText('2026-11-05 09:29:00')), 'GLOBEX_NIGHT');
// deterministic pseudo-noise so the test is reproducible; noise SD about 87 dollars per cell-day (realistic against a +60 effect), MANY null types as in the real roster population (262 types)
let s = 12345; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 - 0.5; };
const rows = []; const day = (i) => `d${i}`; const NOISE = 300;
// A: a real consistent winner in RTH_MID (60 days, +60); D: a loser (-40); C: only 2 days of +150 in GLOBEX_NIGHT (a lucky streak); 40 null types with 20 days each
for (let i = 0; i < 60; i++) { rows.push({ type: 'A', date: day(i), minute: 700, pnl: 60 + NOISE * rnd(), cluster_touch_id: null }); rows.push({ type: 'D', date: day(i), minute: 700, pnl: -40 + NOISE * rnd(), cluster_touch_id: null }); }
for (let n = 0; n < 40; n++) for (let i = 0; i < 20; i++) rows.push({ type: 'N' + n, date: day((i * 3 + n) % 60), minute: 700, pnl: NOISE * rnd(), cluster_touch_id: null });
for (let n = 0; n < 40; n++) for (let i = 0; i < 6; i++) rows.push({ type: 'N' + n, date: day((i * 5 + n) % 60), minute: 60, pnl: NOISE * rnd(), cluster_touch_id: null });   // every bucket holds many types, as in the real data
rows.push({ type: 'C', date: 'x1', minute: 60, pnl: 150 + NOISE * rnd(), cluster_touch_id: null }); rows.push({ type: 'C', date: 'x2', minute: 60, pnl: 150 + NOISE * rnd(), cluster_touch_id: null });
const obs = cellDayObservations(rows), m = fitBucketModel(obs);
const dA = cellDecision(m, 'A', 'RTH_MID'), dC = cellDecision(m, 'C', 'GLOBEX_NIGHT'), dD = cellDecision(m, 'D', 'RTH_MID'), dAn = cellDecision(m, 'A', 'GLOBEX_NIGHT');
const nullPass = Array.from({ length: 40 }, (_, n) => cellDecision(m, 'N' + n, 'RTH_MID').pass).filter(Boolean).length;
const rawC = (obs.filter((o) => o.t === 'C').reduce((a, o) => a + o.y, 0)) / 2;
console.log({ A: dA.pass, D: dD.pass, C: dC.pass, nullTypesPassing: nullPass + ' of 40', A_unseen_bucket_blocked: !dAn.pass, tauT2: m.tauT2.toFixed(0), tauC2: m.tauC2.toFixed(0), s2: m.s2.toFixed(0), thetaA: dA.theta.toFixed(1), thetaC: dC.theta.toFixed(1), rawC: rawC.toFixed(1), sdC: dC.sd.toFixed(1) });
assert.equal(dA.pass, true, 'a real consistent winner must pass'); assert.equal(dAn.pass, false, 'a bucket where the type never fired must NOT be promoted by inheritance (A1)'); assert.equal(dAn.reason, 'no_own_data'); assert.equal(dD.pass, false, 'a loser must not pass'); assert.ok(nullPass <= 8, 'at most about 20 percent of pure-noise types may pass an 80 percent bound, and shrinkage should keep it far lower');
assert.ok(dC.theta < 0.6 * rawC, 'the 2-day streak must be shrunk well below its own mean'); assert.equal(dC.pass, false, 'two lucky days must not pass');
// cluster collapse: two rows of one type sharing a cluster count once
const o2 = cellDayObservations([{ type: 'A', date: 'd1', minute: 700, pnl: 10, cluster_touch_id: 5 }, { type: 'A', date: 'd1', minute: 701, pnl: 30, cluster_touch_id: 5 }]); assert.equal(o2.length, 1); assert.equal(o2[0].y, 20);
console.log('bucketRoster tests passed'); process.exit(0);
