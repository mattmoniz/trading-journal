// F35 (Fable audit 2026-11-10): ET date helpers must not depend on the process timezone. Run: node scripts/test_date_helpers.mjs  (also under TZ=UTC and TZ=Asia/Tokyo)
import assert from 'node:assert/strict';
import { etDateOf, shiftDays, shiftMonthsClamped } from '../server/lib/dateMath.js';
assert.equal(etDateOf(new Date('2026-11-11T03:30:00Z')), '2026-11-10', '22:30 EST is still Nov 10 in New York (the UTC date is Nov 11)');
assert.equal(etDateOf(new Date('2026-07-11T00:30:00Z')), '2026-07-10', '20:30 EDT');
assert.equal(etDateOf(new Date('2026-11-10T05:00:00Z')), '2026-11-10', '00:00 EST');
assert.equal(etDateOf(new Date('2026-11-10T04:59:00Z')), '2026-11-09', '23:59 EST the day before');
assert.equal(shiftDays('2026-11-10', -1), '2026-11-09'); assert.equal(shiftDays('2026-03-01', -1), '2026-02-28'); assert.equal(shiftDays('2026-12-31', 1), '2027-01-01');
assert.equal(shiftMonthsClamped('2026-03-31', -1), '2026-02-28');
console.log('date helper checks passed (TZ=' + (process.env.TZ || 'default') + ')');
