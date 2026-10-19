// Unit checks for perfTelemetry's regression judge + one real snapshot round trip (the inserted rows are deleted afterwards).
import assert from 'node:assert/strict';
import { judgeAgainstHistory, etSession, takeSnapshot, getPerfAttention } from '../server/services/perfTelemetry.js';
import { query } from '../server/db.js';
const quiet = Array.from({ length: 100 }, (_, i) => 20 + (i % 7));           // 20..26
assert.equal(judgeAgainstHistory(25, quiet).flagged, false, 'in-range value not flagged');
assert.equal(judgeAgainstHistory(26, quiet).flagged, false, 'max of history not flagged');
assert.equal(judgeAgainstHistory(60, quiet).flagged, true, 'clear outlier flagged');
assert.equal(judgeAgainstHistory(60, quiet.slice(0, 10)), null, 'thin history = learning, no verdict');
assert.equal(judgeAgainstHistory(null, quiet), null, 'null value = no verdict');
const zeros = Array(100).fill(0);                                              // MAD = 0 and mean-abs-dev = 0
assert.equal(judgeAgainstHistory(0, zeros).flagged, false, 'flat zero history, zero value');
assert.equal(judgeAgainstHistory(1, zeros).flagged, true, 'flat zero history, first non-zero value flags (needs 2 consecutive to matter)');
assert.equal(etSession(new Date('2026-10-19T15:00:00Z')), 'RTH');             // Mon 11:00 ET
assert.equal(etSession(new Date('2026-10-19T20:30:00Z')), 'GAP');            // Mon 16:30 ET
assert.equal(etSession(new Date('2026-10-19T23:30:00Z')), 'GLOBEX');         // Mon 19:30 ET
assert.equal(etSession(new Date('2026-10-17T15:00:00Z')), 'CLOSED');         // Sat
const before = (await query(`SELECT COALESCE(MAX(id),0) m FROM perf_snapshots`)).rows[0].m;
const r = await takeSnapshot();
console.log('snapshot cols', JSON.stringify(r.cols), 'flagged', Object.keys(r.report.flagged), 'learning', r.report.learning.length);
const rows = (await query(`SELECT kind, session, deploy_sha, db_time_pct FROM perf_snapshots WHERE id > $1`, [before])).rows;
assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'SNAPSHOT');
assert.equal(getPerfAttention(), null, 'a fresh single snapshot never shows a banner');
await query(`DELETE FROM perf_snapshots WHERE id > $1`, [before]);
console.log('perfTelemetry tests passed');
process.exit(0);
