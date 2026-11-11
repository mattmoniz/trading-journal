// Unit checks for server/services/jobHealth.js pure functions + one live read-only call. Run: node scripts/test_job_health.mjs
import assert from 'node:assert/strict';
import { summarizeJobs, digestAlerts, getJobHealth } from '../server/services/jobHealth.js';
const r = (name, status, started, err = null) => ({ process_name: name, status, started, error_message: err });
const jobs = summarizeJobs([
  r('A', 'FAILED', '2026-11-10 16:10:00', 'ETIMEDOUT'), r('A', 'FAILED', '2026-11-09 16:10:00', 'ETIMEDOUT'), r('A', 'SUCCESS', '2026-11-06 16:10:00'),
  r('B', 'SUCCESS', '2026-11-10 08:00:00'), r('B', 'FAILED', '2026-11-09 08:00:00', 'x'),
  r('C', 'RUNNING', '2026-11-09 11:00:00'), r('C', 'SUCCESS', '2026-11-06 11:00:00'),
]);
const a = jobs.find((j) => j.name === 'A'), b = jobs.find((j) => j.name === 'B'), c = jobs.find((j) => j.name === 'C');
assert.equal(a.consecutiveFailures, 2); assert.equal(a.latestStatus, 'FAILED'); assert.equal(a.lastSuccessAt, '2026-11-06 16:10:00'); assert.equal(a.lastError, 'ETIMEDOUT');
assert.equal(b.consecutiveFailures, 0); assert.equal(b.latestStatus, 'SUCCESS'); assert.equal(b.failed, 1);
assert.equal(c.latestStatus, 'RUNNING');
const lines = [
  '[2026-11-10 10:02:32 p.m. ET] [INVARIANT_WARN] X_TRAIL: 6/6 real fires in the last 14 days had runner_trail_width IS NULL',
  '[2026-11-10 10:07:32 p.m. ET] [INVARIANT_WARN] X_TRAIL: 7/7 real fires in the last 14 days had runner_trail_width IS NULL',
  '[2026-11-10 10:07:33 p.m. ET] [FRESHNESS] bars stale 12 min', 'garbage line',
];
const d = digestAlerts(lines);
assert.equal(d.distinct, 2); assert.equal(d.lines, 3); assert.equal(d.groups[0].count, 2); assert.equal(d.groups[0].lastAt, '2026-11-10 10:07:32 p.m. ET');
const live = await getJobHealth();
assert.equal(live.state, 'OK'); assert.ok(Array.isArray(live.failing) && Array.isArray(live.stuck));
console.log('live:', live.jobsTracked, 'jobs tracked;', 'failing', live.failing.map((j) => `${j.name}x${j.consecutiveFailures}`).join(','), '; stuck', live.stuck.map((j) => j.name).join(','), '; alerts', live.alerts.state, live.alerts.distinct, 'distinct in', live.alerts.lines, 'lines');
console.log('job health checks passed'); process.exit(0);
