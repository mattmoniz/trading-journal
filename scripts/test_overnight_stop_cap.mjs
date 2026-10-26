// Test for the overnight order-flow protective stop (2026-10-26): the daily-limit cap, and that the stored calibration carries a data-derived protectiveStopPts.
import assert from 'node:assert/strict';
import { capStopToDailyLimit } from '../server/services/overnightOrderflowEntryDetector.js';
import { query } from '../server/db.js';
assert.equal(capStopToDailyLimit(700, 1000, 2), 500, 'a 700-point stop against a 1,000 dollar limit is capped to 500 points');
assert.equal(capStopToDailyLimit(300, 1000, 2), 300, 'a stop inside the limit is untouched');
assert.equal(capStopToDailyLimit(700, NaN, 2), 700, 'no limit configured: untouched');
assert.equal(capStopToDailyLimit(700, 1000, 0), 700, 'bad dollars-per-point: untouched');
const r = await query(`SELECT notes FROM performance_audit WHERE signal_type='OVERNIGHT_9PM_ENTRY_CALIB' AND signal_name='ALL_SESSIONS' ORDER BY run_date DESC, id DESC LIMIT 1`);
const c = JSON.parse(r.rows[0].notes).chosenCell;
assert.ok(c.stopPts === null ? Number.isFinite(c.protectiveStopPts) : true, 'when the best cell is "no stop" a finite protectiveStopPts must be stored');
console.log('OK, chosenCell', JSON.stringify(c)); process.exit(0);
