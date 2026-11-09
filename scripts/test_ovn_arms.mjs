// Tests for server/services/ovnArmsSummary.js: (1) the arm simulation rules (stop touch, gap fill, 14:30 exit, end of data) on synthetic bars; (2) PARITY of the JS port with the Python research simulation (scripts/tell_context/research_20261103/ovn_sim.py,
// ovn_orderflow_variations.py, ovn_orderflow_live_rule.py, ovn_orderflow_regime.py) on four real nights read from the database (the expected dollars below are the Python outputs for those nights); (3) the forward rules; (4) one live read-only pass of the board.
// Usage: node scripts/test_ovn_arms.mjs   (exit 1 on any failure)
import { simArm, computeNight, forwardStatus, getOvnArmsBoard } from '../server/services/ovnArmsSummary.js';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, t = 0.01) => a != null && b != null && Math.abs(a - b) <= t;
const mk = (m, o, h, l, c) => ({ m, o, h, l, c });
// (1) simulation rules
const flat = Array.from({ length: 10 }, (_, i) => mk(i, 100, 101, 99, 100));
ok(simArm(flat, 1, 100.25, 50).why === 'EOS', 'no stop touched and no exit minute reached: end of data');
ok(simArm([...flat, mk(870, 105, 106, 104, 105)], 1, 100.25, 50).why === 'EXIT' && near(simArm([...flat, mk(870, 105, 106, 104, 105)], 1, 100.25, 50).net, ((105 - 0.25 - 100.25) * 2) - 2), 'exit at the 14:30 bar open minus 1 tick, net in MNQ dollars');
ok(simArm([...flat, mk(10, 100, 100, 40, 45)], 1, 100.25, 50).why === 'STOP' && near(simArm([...flat, mk(10, 100, 100, 40, 45)], 1, 100.25, 50).net, ((50.25 - 0.25 - 100.25) * 2) - 2), 'a touched stop fills at its price minus 1 tick');
ok(simArm([...flat, mk(10, 30, 31, 29, 30)], 1, 100.25, 50).why === 'STOP_GAP', 'a stop already beyond the market at the bar open fills at the open (gap)');
ok(simArm([mk(0, 100, 100, 40, 45)], -1, 99.75, 50).why !== 'STOP_GAP', 'the first bar cannot gap-fill (index 0 only the touch rule)');
// (2) parity with the Python research numbers on real nights (live legs threshold 7 as of 2026-11-02)
const exp = { '2026-10-23': { r: true, l: false, dir: 1, base: 11.5, risk: 11.5, live: 22.5, mom: 11.5 }, '2026-10-26': { r: true, l: true, dir: -1, base: -802.5, risk: -602.5, live: -802.5, mom: -802.5 }, '2026-10-29': { r: true, l: false, dir: 1, base: -210.5, risk: -210.5, live: -195.5, mom: 204.5 }, '2026-09-29': { r: true, l: false, dir: -1, base: -320, risk: -320, live: -343.5, mom: -320 } };
for (const [td, e] of Object.entries(exp)) {
  const n = await computeNight(td, 7);
  ok(n.ok && n.qualifiesResearch === e.r && n.qualifiesLive === e.l && n.dir === e.dir, `${td}: rule flags and direction match (research ${e.r}, live ${e.l}, dir ${e.dir})`);
  ok(n.ok && near(n.research.base.net, e.base) && near(n.research.risk.net, e.risk) && near(n.live.base.net, e.live) && near(n.research.mom.net, e.mom), `${td}: arms match Python (research base ${e.base}, stop 300 ${e.risk}, live-entry base ${e.live}, momentum ${e.mom})`);
}
// (3) the forward rules
ok(forwardStatus(5, [10, -5, 20, 3, 1], [1, 1, 0, 1, 1]).state === 'WATCHING', 'forward rule: WATCHING below the first look');
ok(forwardStatus(16, Array(16).fill(5), Array(16).fill(1)).state === 'FIRST LOOK', 'forward rule: FIRST LOOK at 15 nights');
ok(forwardStatus(20, Array.from({ length: 20 }, (_, i) => (i % 2 ? -50 : 10)), Array(20).fill(1)).state === 'FAILED', 'forward rule: FAILED when the BASE mean is below 0 at 20 nights');
ok(forwardStatus(30, Array.from({ length: 30 }, (_, i) => 100 + (i % 5)), Array.from({ length: 30 }, (_, i) => (i % 4 ? 1 : 0))).state === 'CONFIRMED', 'forward rule: CONFIRMED when the CI is above 0 and the hit rate is above 55 percent at 30 nights');
ok(forwardStatus(30, Array(30).fill(10), Array.from({ length: 30 }, (_, i) => (i % 2))).state === 'FAILED', 'forward rule: FAILED when the hit rate is 50 percent or less at 30 nights');
// (4) live read-only pass
const b = await getOvnArmsBoard();
console.log('live board:', JSON.stringify({ state: b.state, forwardFrom: b.forwardFrom, nightsSeen: b.nightsSeen, liveLegs: b.liveLegsThreshold, research: { q: b.research.qualifyingNights, done: b.research.completeNights, status: b.research.status }, live: { q: b.live.qualifyingNights, done: b.live.completeNights, status: b.live.status }, nights: b.nights.length, fires: b.fires.length }));
ok(b.state === 'OK' && b.nightsSeen >= 1 && b.fires.length >= 2 && !JSON.stringify(b).includes('NaN') && !JSON.stringify(b).includes('undefined'), 'live board: OK, nights seen, the shadow fires listed, no NaN');
console.log(fails ? `${fails} FAILURE(S)` : 'all ovn-arms checks pass'); process.exit(fails ? 1 : 0);
