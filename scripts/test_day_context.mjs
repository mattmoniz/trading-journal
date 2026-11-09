// Tests for server/services/dayContextSummary.js: (1) the JS TPO port equals the Python research code (scripts/tell_context/research_20261103/tpo_lib.py) on 7 real RTH sessions incl. poor high / poor low days and 3 row sizes (fixture
// server/test_fixtures/day_context_tpo_fixture.json, generated from the Python output); (2) Python's round-half-even for the row size; (3) the IB day-type states on synthetic bars; (4) one live read-only pass of getDayContextBoard() against the real schema.
// Usage: node scripts/test_day_context.mjs   (exit 1 on any failure)
import fs from 'fs';
import { tpoLevels, ibState, pyRound, getDayContextBoard } from '../server/services/dayContextSummary.js';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-6);
const fx = JSON.parse(fs.readFileSync(new URL('../server/test_fixtures/day_context_tpo_fixture.json', import.meta.url), 'utf8'));
for (const [d, f] of Object.entries(fx)) {
  const t = tpoLevels(f.bars.map(([m, h, l]) => ({ m, h, l })));
  const zonesOk = t && t.zones.length === f.zones.length && t.zones.every((z, i) => near(z[0], f.zones[i][0]) && near(z[1], f.zones[i][1]));
  ok(t && near(t.poorHigh, f.poorHigh) && near(t.poorLow, f.poorLow) && zonesOk, `${d}: TPO port matches Python (zones ${f.zones.length}, poor high ${f.poorHigh != null}, poor low ${f.poorLow != null}, row ${f.rs} pts)`);
}
ok([[0.5, 0], [1.5, 2], [2.5, 2], [3.5, 4], [2.4, 2], [2.6, 3], [0.49, 0], [4.5, 4]].every(([x, y]) => pyRound(x) === y), 'pyRound is round-half-to-even like Python');
const mk = (m, h, l) => ({ m, h, l });
const base = Array.from({ length: 60 }, (_, i) => mk(i, 100 + (i % 3), 90 + (i % 2)));                                  // IB 90..102 (range 12)
ok(ibState(base.slice(0, 40)) === null, 'IB state is null before the first RTH hour completes');
ok(ibState([...base, mk(60, 102.5, 95)]).state === 'NORMAL', 'IB NORMAL when neither side is extended beyond 0.1 IBR');
ok(ibState([...base, mk(60, 108, 95)]).state === 'VARIATION', 'IB VARIATION for one side extended up to 2 IBR');
ok(ibState([...base, mk(60, 140, 95)]).state === 'TREND', 'IB TREND for one side beyond 2 IBR');
ok(ibState([...base, mk(60, 108, 95), mk(61, 100, 80)]).state === 'NEUTRAL', 'IB NEUTRAL when both sides are extended');
const board = await getDayContextBoard();
console.log('live board:', JSON.stringify({ state: board.state, asOf: board.asOf, ageMin: board.ageMin, price: board.price, adr: board.adr, overnight: board.overnight && { range: board.overnight.range, rangeAdr: board.overnight.rangeAdr, net: board.overnight.net }, ib: board.ib && board.ib.state, ibNote: board.ibNote, watcher: board.watcher, above: board.above.slice(0, 2), below: board.below.slice(0, 2), unfilledTotal: board.unfilledTotal }));
ok(board.state === 'OK' && typeof board.price === 'number' && board.adr > 50 && board.adr < 2000, 'live board: OK state, a price and a sane ADR');
ok(Array.isArray(board.above) && Array.isArray(board.below) && board.notes.length >= 2, 'live board: lists and notes present');
console.log(fails ? `${fails} FAILURE(S)` : 'all day-context checks pass'); process.exit(fails ? 1 : 0);
