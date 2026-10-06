// Race test for order-update processing (2026-10-06). Reproduces the Oct 5 exit: three updates
// for one order arrive together (PENDING_OPEN, OPEN, FILLED). Each does a check-then-write on a
// shared "row" with async I/O in between, the same shape as handleOrderUpdate. Without
// serialization the final state is wrong; with runSerializedByKey it must end FILLED.
// Run: node scripts/test_order_update_race.mjs
import { runSerializedByKey } from '../server/services/sierraChart/orderUpdateQueue.js';

const RANK = { PENDING_OPEN: 1, OPEN: 2, FILLED: 3 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Shared row, like order_placements. The "DB" read and write each take real time.
function makeRow() { return { status: 'PENDING_OPEN' }; }
async function applyUpdate(row, incoming, latencyMs) {
  const current = row.status;                   // read
  await sleep(latencyMs);                        // I/O between read and write (varies per call, as in production)
  if (current === 'FILLED') return;              // absorbing state
  if (RANK[incoming] >= RANK[current]) row.status = incoming; // write
}
// Arrival order as in the Oct 5 incident: PENDING_OPEN, OPEN, FILLED. The database writes
// finished out of order: the stale PENDING_OPEN write landed last, after FILLED.
const incoming = [
  { status: 'PENDING_OPEN', latencyMs: 40 },
  { status: 'OPEN', latencyMs: 20 },
  { status: 'FILLED', latencyMs: 5 },
];

async function runWithout() {
  const row = makeRow();
  await Promise.all(incoming.map(u => applyUpdate(row, u.status, u.latencyMs)));
  return row.status;
}
async function runWith() {
  const row = makeRow();
  await Promise.all(incoming.map(u => runSerializedByKey('X131237', () => applyUpdate(row, u.status, u.latencyMs))));
  return row.status;
}

let pass = 0, fail = 0;
const check = (name, got, want) => { got === want ? pass++ : fail++; console.log(`${got === want ? 'PASS' : 'FAIL'}  ${name} (got ${got}, want ${want})`); };

const without = await runWithout();
check('without serialization the race reproduces (ends NOT FILLED)', without, 'PENDING_OPEN');
const withQ = await runWith();
check('with per-order serialization, final state is FILLED', withQ, 'FILLED');

// different orders must not block each other
const t0 = Date.now();
await Promise.all(['A', 'B', 'C'].map(k => runSerializedByKey(k, () => sleep(100))));
check('different orders still run in parallel (under 250ms for three 100ms tasks)', Date.now() - t0 < 250, true);

// a failing update must not stall the queue
const after = await runSerializedByKey('F', async () => { throw new Error('boom'); }).catch(() => 'caught');
const next = await runSerializedByKey('F', async () => 'ran');
check('a failed update does not block later updates for the same order', next, 'ran');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
